import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const PDF = "%PDF-1.4\nFixture syllabus\n%%EOF\n";

test("syllabus CLI exposes anonymous links, checks, and guarded downloads", () => {
  withFixture((run, root) => {
    const links = run(["mirror", "syllabus", "url", "cs109", "--json"]);
    assert.equal(links.status, 0, links.stderr);
    assert.equal(JSON.parse(links.stdout).data.availability, "unchecked");
    assert.match(JSON.parse(links.stdout).data.pdfUrl, /\/CS109\.pdf$/);

    const checked = run(["mirror", "syllabus", "check", "CS109", "--json"]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).data.availability, "available");
    const described = run(["describe", "mirror", "syllabus", "download", "--json"]);
    assert.equal(described.status, 0, described.stderr);
    assert.equal(JSON.parse(described.stdout).data.capability.kind, "mutation");
    assert.equal(JSON.parse(described.stdout).data.consequences[0].operation, "mirror.syllabus.download");

    const destination = join(root, "course syllabus.pdf");
    const args = ["mirror", "syllabus", "download", "CS109", "--destination", destination, "--json"];
    const saved = run(args);
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(readFileSync(destination, "utf8"), PDF);
    assert.equal(JSON.parse(saved.stdout).data.sha256, createHash("sha256").update(PDF).digest("hex"));
    const repeated = run(args);
    assert.equal(repeated.status, 2);
    assert.equal(JSON.parse(repeated.stdout).error.code, "SYLLABUS_DOWNLOAD_DESTINATION_EXISTS");

    const invalid = run(["mirror", "syllabus", "check", "../private", "--json"]);
    assert.equal(invalid.status, 2);
    assert.equal(JSON.parse(invalid.stdout).error.code, "SYLLABUS_COURSE_CODE_INVALID");
    const missingDestination = run(["mirror", "syllabus", "download", "CS109", "--json"]);
    assert.equal(missingDestination.status, 2);
    assert.equal(JSON.parse(missingDestination.stdout).error.code, "USAGE");
  });
});

test("enrolled --all combines course sources with grade-free JSON and JSONL", () => {
  withFixture((run) => {
    for (const mode of ["--json", "--jsonl"]) {
      const result = run(["tis", "enrolled", "--all", mode], true);
      assert.equal(result.status, 0, result.stderr);
      for (const field of ["numericScore", "letterGrade", "gpaPoints", "raw", "password"]) {
        assert.equal(result.stdout.includes(`"${field}"`), false, field);
      }
      if (mode === "--json") {
        const report = JSON.parse(result.stdout).data;
        assert.equal(report.total, 2);
        assert.equal(report.complete, true);
        assert.equal(report.semesters.length, 2);
        assert.deepEqual(report.courses[0].sources, ["grade-history", "current-enrollment"]);
      } else {
        const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(records.filter((record) => record.type === "item").length, 2);
        assert.equal(records.at(-1).data.complete, true);
      }
    }
    const conflict = run(["tis", "enrolled", "--all", "--semester", "2026-2027-1", "--json"]);
    assert.equal(conflict.status, 2);
    assert.equal(JSON.parse(conflict.stdout).error.code, "USAGE");
  });
});

function withFixture(callback: (run: (args: string[], credentials?: boolean) => SpawnSyncReturns<string>, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "sustech-upstream-cli-"));
  const fixture = join(root, "fixture.mjs");
  writeFileSync(fixture, `
import { TisClient } from ${JSON.stringify(new URL("../tis/client.js", import.meta.url).href)};
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://mirrors.sustech.edu.cn/courses/syllabus/CS109.pdf") {
    throw new Error("Unexpected request in offline fixture");
  }
  return new Response(init?.method === "HEAD" ? null : ${JSON.stringify(PDF)}, {
    headers: { "content-type": "application/pdf" },
  });
};
TisClient.prototype.currentTerm = async () => ({ p_dqxn: "2026-2027", p_dqxq: "1" });
TisClient.prototype.enrolled = async () => [{
  courseCode: "CS109", courseName: "Programming", teacher: "Fixture teacher", rwh: "2026-2027-1-CS109-001", key: "xq1_jc1",
}];
TisClient.prototype.grades = async () => ["2026秋季", "2026春季"].map((semester, index) => ({
  code: index ? "MA101" : "CS109", name: index ? "Mathematics" : "Programming", nameEn: "", semester,
  credits: 3, nature: "Required", department: "Fixture department", numericScore: 97, letterGrade: "A+", gpaPoints: 4,
}));
`);
  try {
    callback((args, credentials = false) => spawnSync(process.execPath, ["--import", pathToFileURL(fixture).href, CLI_PATH, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: root,
        SUSTECH_SID: credentials ? "fixture-student" : "",
        SUSTECH_PASSWORD: credentials ? "fixture-password" : "",
        SUSTECH_CREDENTIALS_FILE: "",
        SUSTECH_DISABLE_SYSTEM_KEYRING: "1",
        SUSTECH_DISABLE_UPDATE_CHECK: "1",
      },
    }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
