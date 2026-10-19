import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("separate CLI processes reuse a BB session, honor explicit profiles and clear it on logout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sustech-session-cli-"));
  const fixture = join(directory, "fetch.mjs");
  const statePath = join(directory, "counts.json");
  await writeFile(statePath, JSON.stringify({ logins: 0, probes: 0 }));
  await writeFile(fixture, `
    import { readFileSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const state = JSON.parse(readFileSync(process.env.SUSTECH_TEST_STATE, 'utf8'));
      const service = 'https://bb.sustech.edu.cn/webapps/bb-sso-BBLEARN/index.jsp';
      let body = '';
      let status = 200;
      let headers = {};
      if (url.startsWith('https://cas.sustech.edu.cn/cas/login?')) {
        if (method === 'GET') body = '<input name="execution" value="test">';
        else { state.logins++; status = 302; headers.location = service; }
      } else if (url === service) {
        headers['set-cookie'] = 'BbRouter=synthetic-session; Path=/; Secure';
      } else if (url.endsWith('/users/me')) {
        state.probes++;
        if (!new Headers(init?.headers).get('cookie')?.includes('BbRouter=synthetic-session')) status = 401;
        body = JSON.stringify({ id: '_1_1', userName: '12345678', name: 'Test Student' });
        headers['content-type'] = 'application/json';
      } else throw new Error('Unexpected test request');
      writeFileSync(process.env.SUSTECH_TEST_STATE, JSON.stringify(state));
      const response = new Response(status === 302 ? null : body, { status, headers });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    };
  `);
  const env = {
    ...process.env, XDG_CONFIG_HOME: directory, SUSTECH_TEST_STATE: statePath,
    SUSTECH_SID: "12345678", SUSTECH_PASSWORD: "synthetic-password", SUSTECH_PROFILE: "environment-profile",
    SUSTECH_DISABLE_SYSTEM_KEYRING: "1",
  };
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  function run(...args: string[]): Record<string, unknown> {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(fixture).href, cli, ...args, "--json"], {
      env, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).data;
  }
  try {
    run("auth", "check", "--service", "bb", "--profile", "explicit");
    run("auth", "check", "--service", "bb", "--profile", "explicit");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).logins, 1);
    run("auth", "check", "--service", "bb", "--profile", "other");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).logins, 2);
    run("auth", "logout", "--profile", "explicit");
    run("auth", "check", "--service", "bb", "--profile", "explicit");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).logins, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
