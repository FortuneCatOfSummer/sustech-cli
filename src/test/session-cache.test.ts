import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCache } from "../core/session-cache.js";
import { deleteStoredCredentials } from "../core/keyring.js";

const credentials = { sid: "12345678", password: "test-password", source: "environment" as const, profile: "personal" };
const service = "https://bb.sustech.edu.cn/sso";

test("session cache encrypts cookies, restricts file permissions and isolates accounts, profiles, services and passwords", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-session-cache-"));
  try {
    const cache = new SessionCache(credentials, service, directory);
    const cookies = [{ name: "session", value: "private-session-token" }];
    await cache.save(cookies);
    assert.deepEqual(await new SessionCache(credentials, service, directory).load(), cookies);
    const [profile] = await readdir(join(directory, "sessions"));
    const [file] = await readdir(join(directory, "sessions", profile));
    const path = join(directory, "sessions", profile, file);
    assert.doesNotMatch(await readFile(path, "utf8"), /private-session-token|test-password|12345678/);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, "sessions", profile))).mode & 0o777, 0o700);
    }
    for (const change of [{ sid: "other" }, { profile: "other" }, { password: "changed" }]) {
      assert.equal(await new SessionCache({ ...credentials, ...change }, service, directory).load(), undefined);
    }
    assert.equal(await new SessionCache(credentials, "https://ws.sustech.edu.cn/sso", directory).load(), undefined);
    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.tag = Buffer.alloc(16).toString("base64");
    await writeFile(path, JSON.stringify(tampered));
    assert.equal(await cache.load(), undefined);
    await cache.save(cookies);
    await writeFile(path, "{corrupt");
    assert.equal(await cache.load(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session cache expires after seven days and logout clears only the selected profile even without stored credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-session-expiry-"));
  const originalNow = Date.now;
  try {
    await new SessionCache(credentials, service, directory).save(["session"]);
    await new SessionCache({ ...credentials, profile: "other" }, service, directory).save(["other"]);
    Date.now = () => originalNow() + 8 * 24 * 60 * 60_000;
    assert.equal(await new SessionCache(credentials, service, directory).load(), undefined);
    Date.now = originalNow;
    await deleteStoredCredentials("personal", { configDir: directory });
    assert.equal(await new SessionCache(credentials, service, directory).load(), undefined);
    assert.deepEqual(await new SessionCache({ ...credentials, profile: "other" }, service, directory).load(), ["other"]);
  } finally {
    Date.now = originalNow;
    await rm(directory, { recursive: true, force: true });
  }
});
