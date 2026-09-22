import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

test("schedule date option is discoverable and invalid selectors fail before credentials", () => {
  const described = runFixture(["describe", "tis", "schedule", "--json"]);
  assert.equal(described.status, 0, described.stderr);
  assert.ok(described.envelope.data.options.some((option: { name: string }) => option.name === "--date"));

  for (const selectors of [
    ["--date", "2026-02-30"],
    ["--date", "2026-9-15"],
    ["--week", "37"],
    ["--date", "2026-09-15", "--all"],
    ["--date", "2026-09-15", "--week", "2"],
    ["--week", "2", "--all"],
  ]) {
    const result = runFixture(["tis", "schedule", ...selectors, "--json"], { credentials: false });
    assert.equal(result.status, 2, JSON.stringify(result.envelope));
    assert.equal(result.envelope.error.code, "USAGE");
    assert.deepEqual(result.calls, []);
  }
});

test("schedule date returns only the requested weekday and loads the calendar once", () => {
  const result = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-15", "--json",
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const data = result.envelope.data;
  assert.equal(data.date, "2026-09-15");
  assert.equal(data.week, 2);
  assert.equal(data.total, 1);
  assert.equal(data.entries[0].day, 2);
  assert.equal(data.entries[0].startAt, "2026-09-15T14:00:00+08:00");
  assert.deepEqual(result.calls, ["calendar:2026", "schedule:2026-2027-1:2"]);
});

test("spring and summer schedule dates load their calendar year and preserve historical period times", () => {
  for (const [semester, date] of [["2025-2026-2", "2026-03-03"], ["2025-2026-3", "2026-07-07"]]) {
    const result = runFixture(["tis", "schedule", "--semester", semester!, "--date", date!, "--json"]);
    assert.equal(result.status, 0, JSON.stringify(result.envelope));
    assert.equal(result.envelope.data.week, 2);
    assert.equal(result.envelope.data.entries[0].startAt, `${date}T13:30:00+08:00`);
    assert.deepEqual(result.calls, ["calendar:2026", `schedule:${semester}:2`]);
  }
});

test("calendar outages preserve current-week and explicit-week schedules while all skips the calendar", () => {
  for (const selectors of [[], ["--week", "2"], ["--all"]]) {
    const result = runFixture([
      "tis", "schedule", "--semester", "2026-2027-1", ...selectors, "--json",
    ], { calendar: "outage" });
    assert.equal(result.status, 0, JSON.stringify(result.envelope));
    assert.equal(result.envelope.data.total, 2);
    assert.equal(result.envelope.data.entries[0].startAt, undefined);
    assert.equal(result.calls.includes("calendar:2026"), !selectors.includes("--all"));
  }
});

test("date queries still require a matching calendar and fail before requesting a schedule", () => {
  for (const calendar of ["outage", "missing"] as const) {
    const result = runFixture([
      "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-15", "--json",
    ], { calendar });
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.ok, false);
    if (calendar === "missing") assert.equal(result.envelope.error.code, "CALENDAR_TERM_NOT_FOUND");
    assert.deepEqual(result.calls, ["calendar:2026"]);
  }
});

function runFixture(args: string[], options: { credentials?: boolean; calendar?: "outage" | "missing" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sustech-schedule-cli-"));
  const callsPath = join(root, "calls.json");
  const fixturePath = join(root, "fixture.mjs");
  try {
    writeFileSync(callsPath, "[]");
    writeFileSync(fixturePath, `
import { writeFileSync } from "node:fs";
import { CalendarClient, AcademicCalendar } from ${JSON.stringify(new URL("../calendar/client.js", import.meta.url).href)};
import { TisClient } from ${JSON.stringify(new URL("../tis/client.js", import.meta.url).href)};
const calls = [];
function record(value) {
  calls.push(value);
  writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
}
globalThis.fetch = async () => { throw new Error("Unexpected network request in schedule fixture"); };
TisClient.prototype.currentWeek = async () => { record("currentWeek"); return 2; };
TisClient.prototype.schedule = async (semester, week) => {
  record("schedule:" + semester.value + ":" + week);
  return [1, 2].map(day => ({
    rwh: "course-" + day, key: "xq" + day + "_jc5", courseCode: "CS10" + day,
    courseName: "Fixture course", teacher: "Fixture teacher", room: "Fixture room",
    description: "", descriptionEn: "", day, periodStart: 5, periodEnd: 6, weeks: [1, 2, 3],
  }));
};
function term(start, end) {
  return {
    teaching_start: start, sign_in: start, total_teaching_weeks: 18,
    midterm: { start, end: start, equivalent_weeks: [8] },
    final: { start: end, end, equivalent_weeks: [18] },
    compensatories: [], extra_breaks: [],
  };
}
CalendarClient.prototype.loadYear = async (year) => {
  record("calendar:" + year);
  if (${JSON.stringify(options.calendar)} === "outage") throw new Error("Synthetic calendar outage");
  if (${JSON.stringify(options.calendar)} === "missing") return { terms: () => [] };
  const payload = {
    spring_semester: term(year + "-02-25", year + "-06-26"),
    summer_semester: term(year + "-06-29", year + "-08-07"),
    fall_semester: term(year + "-09-07", (year + 1) + "-01-08"),
  };
  return AcademicCalendar.fromPayloads(year, "undergraduate", {
    undergraduate: payload, graduate: payload, general: { holidays: [] },
  });
};
`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(fixturePath).href, CLI_PATH, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SUSTECH_SID: options.credentials === false ? "" : "fixture-student",
        SUSTECH_PASSWORD: options.credentials === false ? "" : "fixture-password",
        SUSTECH_CREDENTIALS_FILE: "",
        SUSTECH_DISABLE_SYSTEM_KEYRING: "1",
        SUSTECH_DISABLE_UPDATE_CHECK: "1",
        SUSTECH_PROFILE: "",
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: join(root, "cache"),
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      envelope: JSON.parse(result.stdout),
      calls: JSON.parse(readFileSync(callsPath, "utf8")) as string[],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
