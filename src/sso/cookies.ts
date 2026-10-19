export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  expiresAt?: number;
}

export class CookieJar {
  private readonly cookies = new Map<string, SessionCookie>();

  public clear(): void {
    this.cookies.clear();
  }

  public add(response: Response, responseUrl: string): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const values = headers.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    const url = new URL(responseUrl);
    for (const raw of values) {
      const [first, ...attributes] = raw.split(";");
      const delimiter = first.indexOf("=");
      if (delimiter <= 0) continue;
      const cookie: SessionCookie = {
        name: first.slice(0, delimiter).trim(), value: first.slice(delimiter + 1).trim(),
        domain: url.hostname, path: url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/",
        hostOnly: true, secure: false,
      };
      let maxAge: number | undefined;
      for (const attribute of attributes) {
        const delimiter = attribute.indexOf("=");
        const name = (delimiter >= 0 ? attribute.slice(0, delimiter) : attribute).trim().toLowerCase();
        const value = delimiter >= 0 ? attribute.slice(delimiter + 1).trim() : "";
        if (name === "domain" && value) {
          cookie.domain = value.replace(/^\./, "").toLowerCase();
          cookie.hostOnly = false;
        }
        if (name === "path" && value.startsWith("/")) cookie.path = value;
        if (name === "secure") cookie.secure = true;
        if (name === "expires" && Number.isFinite(Date.parse(value))) cookie.expiresAt = Date.parse(value);
        if (name === "max-age" && /^-?\d+$/.test(value) && Number.isFinite(Number(value))) maxAge = Number(value);
      }
      if (!domainMatches(url.hostname, cookie.domain)) continue;
      if (maxAge !== undefined) cookie.expiresAt = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;
      const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }

  public header(url: URL): string | undefined {
    const values = [...this.cookies.values()]
      .filter((cookie) => (cookie.hostOnly ? url.hostname === cookie.domain : domainMatches(url.hostname, cookie.domain))
        && (!cookie.secure || url.protocol === "https:") && pathMatches(url.pathname, cookie.path)
        && (cookie.expiresAt === undefined || cookie.expiresAt > Date.now()))
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`);
    return values.length > 0 ? values.join("; ") : undefined;
  }

  public snapshot(url: URL): SessionCookie[] {
    // Persist only this service's cookies, never the CAS ticket-granting cookie.
    return [...this.cookies.values()].filter((cookie) => cookie.domain === url.hostname
      && (cookie.expiresAt === undefined || cookie.expiresAt > Date.now()));
  }

  public restore(value: unknown, url: URL): boolean {
    if (!Array.isArray(value) || value.length > 100 || !value.every((cookie) =>
      cookie && typeof cookie.name === "string" && /^[!#$%&'*+.^_`|~\w-]+$/.test(cookie.name)
      && typeof cookie.value === "string" && !/[;\r\n]/.test(cookie.value)
      && cookie.domain === url.hostname && typeof cookie.path === "string" && cookie.path.startsWith("/")
      && typeof cookie.hostOnly === "boolean" && typeof cookie.secure === "boolean"
      && (cookie.expiresAt === undefined || Number.isFinite(cookie.expiresAt)))) return false;
    for (const cookie of value as SessionCookie[]) {
      if (cookie.expiresAt === undefined || cookie.expiresAt > Date.now()) {
        this.cookies.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
      }
    }
    return Boolean(this.header(url));
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function pathMatches(pathname: string, path: string): boolean {
  return pathname === path || (pathname.startsWith(path) && (path.endsWith("/") || pathname[path.length] === "/"));
}
