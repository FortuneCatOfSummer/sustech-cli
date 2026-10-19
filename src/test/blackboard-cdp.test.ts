import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { chromium } from "playwright-core";
import {
  PlaywrightBlackboardBrowserRuntime,
  validateBlackboardBrowserOptions,
} from "../services/blackboard-browser.js";

function browserFixture(cas = false) {
  const counts = { pageClosed: 0, contextClosed: 0, disconnected: 0, newContexts: 0, connected: 0 };
  let connectedOptions: unknown;
  let launchOptions: unknown;
  let endpoint: string | undefined;
  const page = {
    async goto() {}, async waitForLoadState() {},
    url: () => cas ? "https://cas.sustech.edu.cn/cas/login" : "https://bb.sustech.edu.cn/ultra/institution-page",
    async close() { counts.pageClosed++; },
  };
  const context = {
    async newPage() { return page; },
    async cookies(url: string) {
      assert.equal(url, "https://bb.sustech.edu.cn");
      return [
        { name: "session", value: "synthetic-bb-cookie", domain: ".bb.sustech.edu.cn", path: "/", secure: true, expires: -1 },
        { name: "CAS", value: "must-not-export", domain: ".sustech.edu.cn", path: "/", secure: true, expires: -1 },
      ];
    },
    async close() { counts.contextClosed++; },
  };
  const browser = {
    contexts: () => [context],
    async newContext() { counts.newContexts++; return context; },
    async close() { counts.disconnected++; },
  };
  const browserType = {
    async connectOverCDP(url: string, options: unknown) {
      counts.connected++; endpoint = url; connectedOptions = options;
      return browser;
    },
    async launch(options: unknown) { launchOptions = options; return browser; },
  } as unknown as typeof chromium;
  return { counts, browserType, get connectedOptions() { return connectedOptions; },
    get launchOptions() { return launchOptions; }, get endpoint() { return endpoint; } };
}

test("CDP reuses the default context, scopes cookies to BB, and closes only its own page", async () => {
  const fixture = browserFixture();
  const session = await new PlaywrightBlackboardBrowserRuntime(fixture.browserType).authenticate({
    cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
  });
  assert.deepEqual(session.cookies.map((cookie) => cookie.name), ["session"]);
  assert.deepEqual(fixture.counts, { pageClosed: 1, contextClosed: 0, disconnected: 1, newContexts: 0, connected: 1 });
  assert.equal((fixture.connectedOptions as { noDefaults: boolean }).noDefaults, true);
});

test("CDP cleanup preserves the shared context when authentication needs manual login", async () => {
  const fixture = browserFixture(true);
  await assert.rejects(new PlaywrightBlackboardBrowserRuntime(fixture.browserType).authenticate({
    cdpUrl: "ws://localhost:9222/devtools/browser/test",
  }), { code: "MANUAL_AUTH_REQUIRED" });
  assert.equal(fixture.counts.pageClosed, 1);
  assert.equal(fixture.counts.contextClosed, 0);
  assert.equal(fixture.counts.disconnected, 1);
});

test("Chrome and Edge channel selection launches exactly the selected browser", async () => {
  for (const channel of ["chrome", "msedge", "chromium"] as const) {
    const fixture = browserFixture();
    await new PlaywrightBlackboardBrowserRuntime(fixture.browserType).authenticate({ channel, interactive: true });
    assert.deepEqual(fixture.launchOptions, { channel, headless: false });
    assert.equal(fixture.counts.connected, 0);
    assert.equal(fixture.counts.contextClosed, 1);
  }
});

test("browser options reject remote, credential-bearing and ambiguous CDP endpoints before connecting", () => {
  for (const cdpUrl of ["https://evil.example:9222", "file:///tmp/cdp", "http://0.0.0.0:9222",
    "http://user:secret@localhost:9222", "http://localhost:9222/?token=secret", "http://localhost:9222/#secret",
    "ws://localhost:9222/devtools/page/test", "http://localhost:9222/path"]) {
    assert.throws(() => validateBlackboardBrowserOptions({ cdpUrl }), { code: "BROWSER_CDP_INVALID" });
  }
  assert.throws(() => validateBlackboardBrowserOptions({ channel: "invalid" as "chrome" }), { code: "USAGE" });
  assert.throws(() => validateBlackboardBrowserOptions({ channel: "chrome", cdpUrl: "http://127.0.0.1:9222" }), { code: "USAGE" });
});

test("HTTP CDP discovery validates the advertised endpoint and refuses redirects", async () => {
  let mode = "valid";
  const server = createServer((_request, response) => {
    if (mode === "redirect") { response.writeHead(302, { location: "http://evil.example/json/version" }).end(); return; }
    const port = (server.address() as AddressInfo).port;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ webSocketDebuggerUrl: mode === "remote"
      ? "ws://evil.example:9222/devtools/browser/test" : `ws://127.0.0.1:${port}/devtools/browser/test` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const cdpUrl = `http://127.0.0.1:${port}`;
    const fixture = browserFixture();
    await new PlaywrightBlackboardBrowserRuntime(fixture.browserType).authenticate({ cdpUrl });
    assert.equal(fixture.endpoint, `ws://127.0.0.1:${port}/devtools/browser/test`);
    mode = "remote";
    await assert.rejects(new PlaywrightBlackboardBrowserRuntime(fixture.browserType).authenticate({ cdpUrl }), { code: "BROWSER_CDP_INVALID" });
    mode = "redirect";
    await assert.rejects(new PlaywrightBlackboardBrowserRuntime(fixture.browserType).authenticate({ cdpUrl }), { code: "BROWSER_CDP_UNAVAILABLE" });
    assert.equal(fixture.counts.connected, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("CDP connection failures never expose diagnostics containing cookies or endpoint secrets", async () => {
  const fixture = browserFixture();
  fixture.browserType.connectOverCDP = async () => { throw new Error("cookie=private-session-value"); };
  await assert.rejects(new PlaywrightBlackboardBrowserRuntime(fixture.browserType).authenticate({
    cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
  }), (error: unknown) => {
    assert.equal((error as { code: string }).code, "BROWSER_CDP_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(error), /private-session-value/);
    return true;
  });
});
