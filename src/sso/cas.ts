import type { Credentials } from "../core/credentials.js";
import { CliError } from "../core/errors.js";
import { USER_AGENT } from "../core/version.js";
import { SessionCache } from "../core/session-cache.js";
import { CookieJar, type SessionCookie } from "./cookies.js";

const CAS_BASE = "https://cas.sustech.edu.cn/cas";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CasServiceConfig {
  name: string;
  baseUrl: string;
  serviceUrl: string;
  submitValue?: string | null;
  allowedRedirectHosts?: readonly string[];
  timeoutMs?: number;
  sessionCache?: { validationPath: string; configDir?: string };
}

export class CasSession {
  private readonly cookies = new CookieJar();
  private readonly baseUrl: URL;
  private readonly serviceUrl: URL;
  private readonly allowedRedirectHosts: ReadonlySet<string>;
  private authenticated = false;
  private readonly cache?: SessionCache;
  private loginPromise?: Promise<void>;
  private cacheWrite: Promise<boolean> = Promise.resolve(false);

  public constructor(
    private readonly credentials: Credentials,
    private readonly config: CasServiceConfig,
  ) {
    this.baseUrl = httpsUrl(config.baseUrl, "baseUrl");
    this.serviceUrl = httpsUrl(config.serviceUrl, "serviceUrl");
    if (config.sessionCache) {
      const validationUrl = new URL(config.sessionCache.validationPath, this.baseUrl);
      if (validationUrl.origin !== this.baseUrl.origin) {
        throw new CliError("Session validation must stay on the service origin.", "UNSAFE_SERVICE_URL", 1);
      }
      this.cache = new SessionCache(credentials, this.serviceUrl.toString(), config.sessionCache.configDir);
    }
    const casHost = new URL(CAS_BASE).hostname;
    this.allowedRedirectHosts = new Set([
      casHost,
      this.baseUrl.hostname,
      this.serviceUrl.hostname,
      ...(config.allowedRedirectHosts ?? []),
    ].map((host) => host.toLowerCase()));
  }

  public async login(): Promise<void> {
    if (this.authenticated) return;
    if (!this.loginPromise) {
      this.loginPromise = this.loginOnce().finally(() => { this.loginPromise = undefined; });
    }
    return this.loginPromise;
  }

  private async loginOnce(): Promise<void> {
    if (this.cache) {
      if (this.cookies.restore(await this.cache.load(), this.baseUrl) && await this.validateCachedSession()) {
        this.authenticated = true;
        await this.persistCookies();
        return;
      }
      await this.invalidateCache();
    }
    const loginUrl = `${CAS_BASE}/login?service=${encodeURIComponent(this.serviceUrl.toString())}`;
    const loginPage = await this.requestRaw(loginUrl);
    if (!loginPage.ok) {
      throw new CliError("CAS login page could not be loaded.", "CAS_UNAVAILABLE", 1, {
        service: this.config.name,
        status: loginPage.status,
      });
    }
    const page = await loginPage.text();
    // A CAS SSO redirect may already have completed the service login.
    if (loginPage.url && new URL(loginPage.url).origin === this.baseUrl.origin) {
      this.authenticated = true;
      await this.persistCookies();
      return;
    }
    const execution = /name=["']execution["']\s+value=["']([^"']+)["']/.exec(page)?.[1];
    if (!execution) {
      throw new CliError("CAS login page did not include an execution token.", "CAS_PROTOCOL_ERROR", 1, {
        service: this.config.name,
      });
    }
    if (requiresInteractiveCaptcha(page)) {
      throw new CliError(
        "CAS currently requires an interactive CAPTCHA that the CLI will not bypass.",
        "CAS_INTERACTIVE_CHALLENGE_REQUIRED",
        2,
        {
          service: this.config.name,
          remediation: "Sign in through the official SUSTech browser page. Password-only CLI authentication is unavailable while this challenge is enabled.",
          passwordSubmitted: false,
        },
      );
    }

    const form = new URLSearchParams({
      username: this.credentials.sid,
      password: this.credentials.password,
      execution,
      _eventId: "submit",
    });
    if (this.config.submitValue !== null) form.set("submit", this.config.submitValue ?? "提交");

    const result = await this.requestRaw(loginUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const finalUrl = new URL(result.url);
    if (!result.ok || finalUrl.hostname !== this.baseUrl.hostname) {
      throw new CliError(
        `CAS rejected the credentials or did not complete the ${this.config.name} login.`,
        "AUTHENTICATION_FAILED",
        2,
        { service: this.config.name, status: result.status },
      );
    }
    this.authenticated = true;
    await this.persistCookies();
  }

  /** Seed the same encrypted cache after a user completes the official browser login. */
  public async saveBrowserSession(cookies: SessionCookie[], verifiedUsername: string): Promise<boolean> {
    if (!this.cache || verifiedUsername !== this.credentials.sid || !this.cookies.restore(cookies, this.baseUrl)) {
      throw new CliError("The browser session does not match the selected account.", "AUTHENTICATION_FAILED", 2);
    }
    return this.persistCookies();
  }

  private async validateCachedSession(): Promise<boolean> {
    const url = new URL(this.config.sessionCache!.validationPath, this.baseUrl);
    const response = await this.requestRaw(url.toString(), { redirect: "manual", headers: { accept: "application/json" } });
    if (response.status >= 500 || response.status === 429) {
      throw new CliError(`${this.config.name} session check is unavailable.`, "SERVICE_HTTP_ERROR", 1, {
        service: this.config.name, status: response.status,
      });
    }
    if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) return false;
    const user = await response.json().catch(() => undefined) as { userName?: unknown } | undefined;
    return user?.userName === this.credentials.sid;
  }

  private async persistCookies(): Promise<boolean> {
    // Storage is an optimization: an unavailable cache must not break a live session.
    this.cacheWrite = this.cacheWrite.then(async () => {
      if (!this.cache) return false;
      const cookies = this.cookies.snapshot(this.baseUrl);
      if (cookies.length === 0) {
        await this.cache.clear();
        return false;
      }
      await this.cache.save(cookies);
      return true;
    }).catch(() => false);
    return this.cacheWrite;
  }

  private async invalidateCache(): Promise<void> {
    this.authenticated = false;
    this.cookies.clear();
    await this.cache?.clear().catch(() => undefined);
  }

  public async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.requestService(path, { headers });
  }

  public async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    return this.requestService(input, init);
  }

  public async getJson(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const relative = `${url.pathname}${url.search}`;
    return this.parseJson(await this.get(relative, { accept: "application/json" }), relative);
  }

  public async getText(path: string): Promise<string> {
    const response = await this.get(path);
    return response.text();
  }

  public async postForm(
    path: string,
    data: Record<string, string | number | string[]>,
  ): Promise<unknown> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        for (const item of value) form.append(key, item);
      } else {
        form.set(key, String(value));
      }
    }
    const response = await this.requestService(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: form.toString(),
    });
    return this.parseJson(response, path);
  }

  public async postJson(path: string, data: Record<string, unknown>): Promise<unknown> {
    const response = await this.requestService(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify(data),
    });
    return this.parseJson(response, path);
  }

  public async postText(
    path: string,
    data: Record<string, string | number> = {},
  ): Promise<string> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) form.set(key, String(value));
    const response = await this.requestService(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: form.toString(),
    });
    return response.text();
  }

  protected async requestService(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new CliError("A service request attempted to leave its configured origin.", "UNSAFE_SERVICE_URL", 1, {
        service: this.config.name,
        host: url.hostname,
      });
    }
    if (!this.authenticated) await this.login();
    let response = await this.requestRaw(url.toString(), init);
    if (this.cache && this.isExpiredResponse(response)) {
      await this.invalidateCache();
      const method = (init.method ?? "GET").toUpperCase();
      if ((method === "GET" || method === "HEAD") && init.body === undefined) {
        await this.login();
        response = await this.requestRaw(url.toString(), init);
      }
      if (this.isExpiredResponse(response)) {
        await this.invalidateCache();
        throw new CliError(`${this.config.name} session expired.`, "SERVICE_SESSION_EXPIRED", 1, { service: this.config.name });
      }
    }
    await this.persistCookies();
    if (!response.ok) {
      const bodySample = await response.clone().text()
        .then((text) => collapseText(text).slice(0, 160))
        .catch(() => undefined);
      throw new CliError(`${this.config.name} request failed.`, "SERVICE_HTTP_ERROR", 1, {
        service: this.config.name,
        path: url.pathname,
        status: response.status,
        ...(bodySample ? { bodySample } : {}),
      });
    }
    return response;
  }

  private isExpiredResponse(response: Response): boolean {
    if (response.status === 401) return true;
    const url = response.headers.get("location") ?? response.url;
    if (!url) return false;
    const target = new URL(url, this.baseUrl);
    return target.hostname === new URL(CAS_BASE).hostname
      || (target.origin === this.baseUrl.origin && target.pathname.startsWith("/webapps/login/"));
  }

  private async parseJson(response: Response, path: string): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new CliError(
        `${this.config.name} returned non-JSON content; the session may have expired.`,
        "SERVICE_SESSION_EXPIRED",
        1,
        { service: this.config.name, path },
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new CliError(`${this.config.name} returned invalid JSON.`, "SERVICE_PROTOCOL_ERROR", 1, {
        service: this.config.name,
        path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async requestRaw(url: string, init: RequestInit = {}): Promise<Response> {
    let currentUrl = url;
    let method = init.method ?? "GET";
    let body = init.body;
    let headers = new Headers(init.headers);
    const signal = init.signal ?? AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    for (let redirects = 0; redirects < 8; redirects += 1) {
      const parsedUrl = new URL(currentUrl);
      const cookie = this.cookies.header(parsedUrl);
      headers.delete("cookie");
      if (cookie) headers.set("cookie", cookie);
      headers.set("user-agent", USER_AGENT);

      let response: Response;
      try {
        response = await fetch(currentUrl, { method, headers, body, redirect: "manual", signal });
      } catch (error) {
        const timedOut = signal.aborted;
        throw new CliError(
          timedOut ? `${this.config.name} request timed out.` : `Could not reach ${this.config.name}.`,
          timedOut ? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
          1,
          { service: this.config.name, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      this.cookies.add(response, currentUrl);

      if (init.redirect === "manual") return response;
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== "https:" || !this.allowedRedirectHosts.has(nextUrl.hostname.toLowerCase())) {
        throw new CliError("CAS/service attempted an unsafe redirect.", "UNSAFE_REDIRECT", 1, {
          service: this.config.name,
          from: parsedUrl.hostname,
          to: nextUrl.hostname,
        });
      }
      // Let the caller handle expiration before following a service request back to CAS.
      if (this.cache && new URL(url).origin === this.baseUrl.origin && nextUrl.hostname === new URL(CAS_BASE).hostname) {
        return response;
      }
      currentUrl = nextUrl.toString();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers = new Headers();
      }
    }
    throw new CliError("CAS/service redirected too many times.", "TOO_MANY_REDIRECTS", 1, {
      service: this.config.name,
    });
  }
}

function requiresInteractiveCaptcha(page: string): boolean {
  return /name=["']g-recaptcha-response["']/i.test(page)
    && /(?:slideVerify|captchaVerification|su-recaptcha)/i.test(page);
}

function collapseText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function httpsUrl(value: string, field: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new CliError(`CAS ${field} must use HTTPS.`, "UNSAFE_SERVICE_URL", 1, { field, protocol: url.protocol });
  }
  return url;
}
