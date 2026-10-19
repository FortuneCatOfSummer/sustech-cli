import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CasSession } from "../sso/cas.js";
import { casServiceConfig } from "../core/auth-check.js";

const credentials = { sid: "12345678", password: "secret", source: "environment" as const, profile: "test" };

class Fixture {
  public passwordPosts = 0;
  public loginPages = 0;
  public probes = 0;
  public writes = 0;
  public validCookie = "none";
  public username = credentials.sid;
  public unavailable = false;
  public captcha = false;
  public rotate = false;
  public readonly config;

  public constructor(configDir: string) {
    this.config = { ...casServiceConfig("bb"), sessionCache: { validationPath: "/learn/api/public/v1/users/me", configDir } };
  }

  public session(): CasSession {
    return new CasSession(credentials, this.config);
  }

  public fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    if (url.startsWith("https://cas.sustech.edu.cn/cas/login?")) {
      assert.doesNotMatch(cookie, /BbRouter/);
      if (method === "GET") {
        this.loginPages++;
        return response('<input name="execution" value="e1">'
          + (this.captcha ? '<input name="g-recaptcha-response"><div id="su-recaptcha"></div>' : ""), 200, url,
        { "set-cookie": "TGC=cas-secret; Path=/cas; Secure" });
      }
      this.passwordPosts++;
      this.validCookie = `session-${this.passwordPosts}`;
      this.username = credentials.sid;
      return response(null, 302, url, { location: this.config.serviceUrl });
    }
    assert.doesNotMatch(cookie, /TGC=/);
    if (url === this.config.serviceUrl) {
      return response("signed in", 200, url, { "set-cookie": `BbRouter=${this.validCookie}; Path=/; Secure; Max-Age=3600` });
    }
    if (url.endsWith("/users/me")) {
      this.probes++;
      if (this.unavailable) return response("unavailable", 503, url);
      if (!cookie.includes(`BbRouter=${this.validCookie}`)) return response("expired", 401, url);
      return response(JSON.stringify({ userName: this.username }), 200, url, { "content-type": "application/json" });
    }
    if (method === "POST") this.writes++;
    if (!cookie.includes(`BbRouter=${this.validCookie}`)) {
      return response(null, 302, url, { location: "https://cas.sustech.edu.cn/cas/login" });
    }
    if (this.rotate) {
      this.validCookie += "-rotated";
      this.rotate = false;
      return response("read", 200, url, { "set-cookie": `BbRouter=${this.validCookie}; Path=/; Secure` });
    }
    return response("read", 200, url);
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sustech-cas-session-"));
  const original = globalThis.fetch;
  const fixture = new Fixture(directory);
  globalThis.fetch = fixture.fetch;
  try {
    await run(fixture);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
}

test("separate CAS clients reuse cached Blackboard cookies and save cookie rotation without visiting CAS", async () => {
  await withFixture(async (fixture) => {
    const first = fixture.session();
    await first.get("/read");
    assert.equal(fixture.passwordPosts, 1);
    fixture.captcha = true;
    fixture.rotate = true;
    assert.equal(await (await fixture.session().get("/read")).text(), "read");
    assert.equal(await (await fixture.session().get("/read")).text(), "read");
    assert.equal(fixture.passwordPosts, 1);
    assert.equal(fixture.loginPages, 1);
    assert.equal(fixture.probes, 2);
  });
});

test("an expired cached session is reauthenticated once before a command", async () => {
  await withFixture(async (fixture) => {
    await fixture.session().get("/read");
    fixture.validCookie = "expired";
    await fixture.session().get("/read");
    assert.equal(fixture.passwordPosts, 2);
    assert.equal(fixture.probes, 1);
  });
});

test("concurrent requests share one login instead of submitting the password repeatedly", async () => {
  await withFixture(async (fixture) => {
    const session = fixture.session();
    await Promise.all([session.get("/read"), session.get("/read"), session.get("/read")]);
    assert.equal(fixture.passwordPosts, 1);
    const reused = fixture.session();
    await Promise.all([reused.get("/read"), reused.get("/read")]);
    assert.equal(fixture.probes, 1);
    assert.equal(fixture.passwordPosts, 1);
  });
});

test("an expired session still stops before password submission when CAS requires CAPTCHA", async () => {
  await withFixture(async (fixture) => {
    await fixture.session().get("/read");
    fixture.validCookie = "expired";
    fixture.captcha = true;
    await assert.rejects(fixture.session().get("/read"), { code: "CAS_INTERACTIVE_CHALLENGE_REQUIRED" });
    assert.equal(fixture.passwordPosts, 1);
    assert.equal(fixture.loginPages, 2);
  });
});

test("an upstream outage retains cached cookies and never triggers a fresh password login", async () => {
  await withFixture(async (fixture) => {
    await fixture.session().get("/read");
    fixture.unavailable = true;
    await assert.rejects(fixture.session().get("/read"), { code: "SERVICE_HTTP_ERROR" });
    fixture.unavailable = false;
    await fixture.session().get("/read");
    assert.equal(fixture.passwordPosts, 1);
    assert.equal(fixture.probes, 2);
  });
});

test("cached identity must match the selected account before the session can be reused", async () => {
  await withFixture(async (fixture) => {
    await fixture.session().get("/read");
    fixture.username = "different-account";
    await fixture.session().get("/read");
    assert.equal(fixture.passwordPosts, 2);
  });
});

test("mid-command expiration can retry a read once but never replays a write", async () => {
  await withFixture(async (fixture) => {
    const session = fixture.session();
    await session.login();
    fixture.validCookie = "expired";
    assert.equal(await (await session.get("/read")).text(), "read");
    assert.equal(fixture.passwordPosts, 2);
    fixture.validCookie = "expired-again";
    await assert.rejects(session.fetch("/write", { method: "POST", body: "assignment" }), { code: "SERVICE_SESSION_EXPIRED" });
    assert.equal(fixture.writes, 1);
    assert.equal(fixture.passwordPosts, 2);
  });
});

function response(body: string | null, status: number, url: string, headers?: Record<string, string>): Response {
  const value = new Response(body, { status, headers });
  Object.defineProperty(value, "url", { value: url });
  return value;
}
