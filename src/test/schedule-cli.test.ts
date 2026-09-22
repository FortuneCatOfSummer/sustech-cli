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

test("schedule date returns only the requested day's deduplicated classes and loads the calendar once", () => {
  const result = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-15", "--json",
  ], { schedule: "duplicates" });
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const data = result.envelope.data;
  assert.equal(data.date, "2026-09-15");
  assert.equal(data.week, 2);
  assert.equal(data.total, 1);
  assert.equal(data.entries[0].day, 2);
  assert.equal(data.entries[0].startAt, "2026-09-15T14:00:00+08:00");
  assert.deepEqual(result.calls, ["calendar:2026", "schedule:2026-2027-1:undefined"]);
});

test("schedule date applies a different week's Friday timetable on a Sunday makeup day", () => {
  const result = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-20", "--json",
  ], { schedule: "makeup" });
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const data = result.envelope.data;
  assert.equal(data.week, 2);
  assert.equal(data.total, 1);
  assert.equal(data.entries[0].day, 5);
  assert.equal(data.entries[0].startAt, "2026-09-20T14:00:00+08:00");
  assert.equal(data.entries[0].endAt, "2026-09-20T15:50:00+08:00");
  assert.equal(data.entries[0].makeupFor, "2026-09-25");
  assert.deepEqual(result.calls, ["calendar:2026", "schedule:2026-2027-1:undefined"]);
});

test("schedule date does not report the holiday's regular Friday classes", () => {
  const result = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-25", "--json",
  ], { schedule: "makeup" });
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(result.envelope.data.total, 0);
  assert.deepEqual(result.envelope.data.entries, []);
  assert.deepEqual(result.calls, ["calendar:2026", "schedule:2026-2027-1:undefined"]);
});

test("schedule date distinguishes incomplete timetable rows from a verified empty date", () => {
  const result = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-15", "--json",
  ], { schedule: "incomplete" });
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(result.envelope.data.total, 0);
  assert.equal(result.envelope.data.omissionCount, 1);
});

test("cross-year date queries keep the explicit fall semester and apply the target year's holidays", () => {
  const holiday = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2027-01-01", "--json",
  ], { schedule: "new-year" });
  assert.equal(holiday.status, 0, JSON.stringify(holiday.envelope));
  assert.equal(holiday.envelope.data.semester.value, "2026-2027-1");
  assert.equal(holiday.envelope.data.week, 17);
  assert.equal(holiday.envelope.data.total, 0);
  assert.equal(holiday.envelope.data.omissionCount, 0);
  assert.deepEqual(holiday.calls, ["calendar:2026", "calendar:2027", "schedule:2026-2027-1:undefined"]);

  const ordinaryFriday = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-12-25", "--json",
  ], { schedule: "new-year" });
  assert.equal(ordinaryFriday.status, 0, JSON.stringify(ordinaryFriday.envelope));
  assert.equal(ordinaryFriday.envelope.data.total, 1);
  assert.equal(ordinaryFriday.envelope.data.entries[0].startAt, "2026-12-25T14:00:00+08:00");
});

test("cross-year date queries require target-year holidays and never silently change an explicit semester", () => {
  const unavailable = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2027-01-01", "--json",
  ], { calendar: "date-outage", schedule: "new-year" });
  assert.notEqual(unavailable.status, 0);
  assert.equal(unavailable.envelope.ok, false);
  assert.deepEqual(unavailable.calls, ["calendar:2026", "calendar:2027"]);

  const wrongSemester = runFixture([
    "tis", "schedule", "--semester", "2025-2026-1", "--date", "2027-01-01", "--json",
  ], { schedule: "new-year" });
  assert.notEqual(wrongSemester.status, 0);
  assert.equal(wrongSemester.envelope.error.code, "DATE_OUT_OF_SEMESTER");
  assert.deepEqual(wrongSemester.calls, ["calendar:2025"]);
});

test("date queries ignore unsupported periods on other dates and report them only on the requested date", () => {
  const valid = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-14", "--json",
  ], { schedule: "unsupported" });
  assert.equal(valid.status, 0, JSON.stringify(valid.envelope));
  assert.equal(valid.envelope.data.total, 1);
  assert.equal(valid.envelope.data.omissionCount, 0);
  assert.equal(valid.envelope.data.entries[0].startAt, "2026-09-14T08:00:00+08:00");

  const partial = runFixture([
    "tis", "schedule", "--semester", "2026-2027-1", "--date", "2026-09-22", "--json",
  ], { schedule: "unsupported" });
  assert.equal(partial.status, 0, JSON.stringify(partial.envelope));
  assert.equal(partial.envelope.data.total, 1);
  assert.equal(partial.envelope.data.omissionCount, 1);
  assert.equal(partial.envelope.data.entries[0].startAt, "2026-09-22T14:00:00+08:00");
});

test("spring and summer schedule dates load their calendar year and preserve historical period times", () => {
  for (const [semester, date] of [["2025-2026-2", "2026-03-03"], ["2025-2026-3", "2026-07-07"]]) {
    const result = runFixture(["tis", "schedule", "--semester", semester!, "--date", date!, "--json"]);
    assert.equal(result.status, 0, JSON.stringify(result.envelope));
    assert.equal(result.envelope.data.week, 2);
    assert.equal(result.envelope.data.entries[0].startAt, `${date}T13:30:00+08:00`);
    assert.deepEqual(result.calls, ["calendar:2026", `schedule:${semester}:undefined`]);
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

function runFixture(args: string[], options: { credentials?: boolean; calendar?: "outage" | "missing" | "date-outage"; schedule?: "makeup" | "duplicates" | "incomplete" | "new-year" | "unsupported" } = {}) {
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
  const entries = [1, 2].map(day => ({
    rwh: "course-" + day, key: "xq" + day + "_jc5", courseCode: "CS10" + day,
    courseName: "Fixture course", teacher: "Fixture teacher", room: "Fixture room",
    description: "", descriptionEn: "", day, periodStart: 5, periodEnd: 6, weeks: [1, 2, 3],
  }));
  if (${JSON.stringify(options.schedule)} === "duplicates") return [...entries, { ...entries[1], key: "xq2_jc6" }];
  if (${JSON.stringify(options.schedule)} === "incomplete") return [{ ...entries[1], weeks: [] }];
  if (${JSON.stringify(options.schedule)} === "new-year") return [{ ...entries[0], day: 5, weeks: [16, 17], key: "xq5_jc1" }];
  if (${JSON.stringify(options.schedule)} === "unsupported") return [
    { ...entries[0], periodStart: 1, periodEnd: 2 },
    { ...entries[1], weeks: [3] },
    { ...entries[1], rwh: "unsupported", key: "xq2_jc13", weeks: [3], periodStart: 13, periodEnd: 13 },
  ];
  if (${JSON.stringify(options.schedule)} === "makeup") return [
    { ...entries[0], day: 5, weeks: [3], key: "xq5_jc1" },
    { ...entries[0], day: 5, weeks: [3], key: "xq5_jc2" },
    { ...entries[1], day: 7, weeks: [2], key: "xq7_jc1" },
  ];
  return entries;
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
  if (${JSON.stringify(options.calendar)} === "date-outage" && year === 2027) throw new Error("Synthetic target-year calendar outage");
  if (${JSON.stringify(options.calendar)} === "missing") return { terms: () => [] };
  const payload = {
    spring_semester: term(year + "-02-25", year + "-06-26"),
    summer_semester: term(year + "-06-29", year + "-08-07"),
    fall_semester: term(year + "-09-07", (year + 1) + "-01-08"),
  };
  payload.fall_semester.compensatories = [{ date: "2026-09-20", week_type: "odd", workday_type: "Friday" }];
  return AcademicCalendar.fromPayloads(year, "undergraduate", {
    undergraduate: payload, graduate: payload, general: { holidays: [
      { name: "New Year's Day", start: year + "-01-01", end: year + "-01-01" },
      { name: "Mid-Autumn Festival", start: "2026-09-25", end: "2026-09-27" },
    ] },
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
