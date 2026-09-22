import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

test("explicit update checks in pipes report an available release without prompting or installing", () => {
  const directory = mkdtempSync(join(tmpdir(), "sustech-update-cli-"));
  const fixture = join(directory, "registry.mjs");
  writeFileSync(fixture, `
    globalThis.fetch = async (url) => {
      if (String(url) !== "https://registry.npmjs.org/sustech-cli/latest") {
        throw new Error("Unexpected request in offline update fixture");
      }
      return new Response(JSON.stringify({ version: "99.0.0" }), {
        headers: { "content-type": "application/json" },
      });
    };
  `);
  try {
    for (const outputArgs of [[], ["--json"]]) {
      const result = spawnSync(process.execPath, [
        "--import", pathToFileURL(fixture).href, CLI_PATH, "update", ...outputArgs,
      ], {
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: directory, SUSTECH_DISABLE_UPDATE_CHECK: "1" },
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
      if (outputArgs.length) {
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.ok, true);
        assert.equal(envelope.data.updateAvailable, true);
        assert.equal(envelope.data.updated, false);
      } else {
        assert.match(result.stdout, /99\.0\.0 is available/);
        assert.match(result.stdout, /sustech update --yes/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
