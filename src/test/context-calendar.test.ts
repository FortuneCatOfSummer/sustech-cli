import assert from "node:assert/strict";
import test from "node:test";
import { AcademicCalendar } from "../calendar/client.js";
import { loadContextCalendar } from "../context/calendar.js";
import { buildContextSchedule } from "../context/schedule.js";
import type { CalendarLevel } from "../calendar/types.js";

function calendar(year: number, level: CalendarLevel = "undergraduate"): AcademicCalendar {
  const term = (start: string, end: string) => ({
    sign_in: start, teaching_start: start, total_teaching_weeks: 19,
    midterm: { start, end: start, equivalent_weeks: [8] },
    final: { start: end, end, equivalent_weeks: [19] },
    compensatories: [],
  });
  const payload = {
    spring_semester: term(`${year}-02-23`, `${year}-06-30`),
    fall_semester: term(`${year}-09-07`, `${year + 1}-01-15`),
  };
  return AcademicCalendar.fromPayloads(year, level, {
    undergraduate: payload, graduate: payload,
    general: { holidays: [{ name: "New Year's Day", start: `${year}-01-01`, end: `${year}-01-01` }] },
  });
}

test("context resolves January to the preceding fall and keeps the current year's holidays", async () => {
  const calls: string[] = [];
  const loaded = await loadContextCalendar("2027-01-01", "graduate", {
    loadYear: async (year, level = "undergraduate") => { calls.push(`${year}:${level}`); return calendar(year, level); },
  });
  assert.deepEqual(calls, ["2027:graduate", "2026:graduate"]);
  const day = loaded.day("2027-01-01");
  assert.equal(day.semester?.semester.value, "2026-2027-1");
  assert.equal(day.holiday?.name, "New Year's Day");
  const schedule = buildContextSchedule([{
    rwh: "fixture", key: "xq5_jc1", courseCode: "CS101", courseName: "Fixture",
    teacher: "Teacher", room: "101", description: "", descriptionEn: "",
    day: 5, periodStart: 1, periodEnd: 2, weeks: [17, 18],
  }], loaded.fall, new Date("2027-01-01T08:30:00+08:00"));
  assert.deepEqual(schedule.todayClasses, []);
  assert.equal(schedule.nextClass?.startAt, "2027-01-08T00:00:00Z");
});

test("context can use the preceding fall if the new year's calendar is unavailable", async () => {
  const loaded = await loadContextCalendar("2027-01-04", "undergraduate", {
    loadYear: async (year) => { if (year === 2027) throw new Error("Calendar not published"); return calendar(year); },
  });
  assert.equal(loaded.day("2027-01-04").semester?.semester.value, "2026-2027-1");
});

test("context keeps a successfully loaded vacation calendar and does not fetch a fallback during a term", async () => {
  const calls: number[] = [];
  const client = { loadYear: async (year: number) => { calls.push(year); return calendar(year); } };
  const current = await loadContextCalendar("2026-09-22", "undergraduate", client);
  assert.deepEqual(calls, [2026]);
  assert.equal(current.year, 2026);
  const vacation = await loadContextCalendar("2026-08-01", "undergraduate", client);
  assert.equal(vacation.year, 2026);
  assert.equal(vacation.day("2026-08-01").semester, undefined);
});

test("context reports the original calendar failure when no calendar covers the date", async () => {
  const failure = new Error("Current-year outage");
  await assert.rejects(loadContextCalendar("2027-05-01", "undergraduate", {
    loadYear: async (year) => { if (year === 2027) throw failure; return calendar(year); },
  }), (error) => error === failure);
});
