import assert from "node:assert/strict";
import test from "node:test";
import { formatCourseHistory, readCourseHistory } from "../tis/course-history.js";
import { normalisePersonalScheduleEntry } from "../tis/normalise.js";
import type { GradeRecord } from "../tis/types.js";

function grade(overrides: Partial<GradeRecord> = {}): GradeRecord {
  return {
    code: "CS101", name: "Programming", nameEn: "", semester: "2026秋季", credits: 3,
    letterGrade: "A", numericScore: 93, gpaPoints: 3.94, nature: "Required", department: "CSE",
    ...overrides,
  };
}

function enrollment(code = "CS101", name = "Programming", section = "001") {
  return normalisePersonalScheduleEntry({
    RWH: `2026-2027-1-${code}-${section}`, KEY: "xq1_jc1", KCWZSM: name,
    SKJS: "Fixture Teacher", KSJC: 1, JSJC: 2, ZC: "01111",
  });
}

const currentTerm = async () => ({ p_dqxn: "2026-2027", p_dqxq: "1" });

test("course history merges uniquely matched current courses and preserves grade-free historical terms", async () => {
  const result = await readCourseHistory({
    currentTerm,
    enrolled: async (semester) => {
      assert.equal(semester.value, "2026-2027-1");
      return [enrollment(), enrollment(), enrollment("CS202", "New course")];
    },
    grades: async () => [grade(), grade(), grade({ code: "MA101", name: "Math", semester: "2026春季" })],
  });
  assert.equal(result.complete, true);
  assert.equal(result.total, 3);
  assert.deepEqual(result.semesters.map((group) => [group.semester, group.total]), [
    ["2026-2027-1", 2], ["2025-2026-2", 1],
  ]);
  const combined = result.courses.find((course) => course.code === "CS101")!;
  assert.deepEqual(combined.sources, ["grade-history", "current-enrollment"]);
  assert.deepEqual(combined.rwhs, ["2026-2027-1-CS101-001"]);
  assert.equal(combined.credits, 3);
  assert.equal(result.courses.find((course) => course.code === "CS202")!.credits, undefined);
  assert.equal(result.sourceStatuses.enrolled.count, 3);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["letterGrade", "numericScore", "gpaPoints", "password", "studentId", "raw"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  }
  assert.match(formatCourseHistory(result), /2025-2026-2 · 1 courses/);
});

test("course history preserves ambiguous same-code records and does not merge missing-code names", async () => {
  const withoutCode = { ...enrollment(), rwh: "opaque-task", courseCode: "" };
  const result = await readCourseHistory({
    currentTerm,
    enrolled: async () => [enrollment(), withoutCode],
    grades: async () => [grade(), grade({ name: "Different course", credits: 2 }), grade({ code: "" })],
  });
  assert.equal(result.total, 5);
  assert.equal(result.courses.every((course) => course.sources.length === 1), true);
});

test("course history preserves lecture and lab rows when both share a code", async () => {
  const result = await readCourseHistory({
    currentTerm,
    enrolled: async () => [enrollment(), enrollment("CS101", "Programming lab", "002")],
    grades: async () => [grade()],
  });
  assert.equal(result.total, 3);
  assert.equal(result.courses.every((course) => course.sources.length === 1), true);
});

test("course history normalizes known term labels and leaves unrecognized labels unguessed", async () => {
  const labels = ["2026春", "2026夏季", "2026-2027-1", "2026-20271", "2026-2025-1", "Special term"];
  const result = await readCourseHistory({
    currentTerm,
    enrolled: async () => [],
    grades: async () => labels.map((semester, index) => grade({ semester, code: `CS${index}`, credits: 0 })),
  });
  const byCode = new Map(result.courses.map((course) => [course.code, course]));
  assert.equal(byCode.get("CS0")!.semester, "2025-2026-2");
  assert.equal(byCode.get("CS1")!.semester, "2025-2026-3");
  assert.equal(byCode.get("CS2")!.semester, "2026-2027-1");
  assert.equal(byCode.get("CS3")!.semester, "2026-2027-1");
  assert.equal(byCode.get("CS4")!.semester, undefined);
  assert.equal(byCode.get("CS5")!.semesterLabel, "Special term");
  assert.equal(result.courses.every((course) => course.credits === undefined), true);
});

test("course history keeps historical courses when current-term discovery fails without leaking errors", async () => {
  const result = await readCourseHistory({
    currentTerm: async () => { throw new Error("private-cookie-password"); },
    enrolled: async () => { throw new Error("must not call enrolled without a verified term"); },
    grades: async () => [grade({ semester: "2025秋季" })],
  });
  assert.equal(result.complete, false);
  assert.equal(result.currentSemester, undefined);
  assert.equal(result.total, 1);
  assert.deepEqual(result.sourceStatuses.currentTerm, { state: "error", code: "CURRENT_TERM_UNAVAILABLE" });
  assert.deepEqual(result.sourceStatuses.enrolled, { state: "unavailable", code: "CURRENT_TERM_UNAVAILABLE" });
  assert.equal(JSON.stringify(result).includes("private-cookie-password"), false);
  assert.match(formatCourseHistory(result), /Incomplete sources:/);
});

test("course history reports either source failure and keeps the other source", async () => {
  const gradesFailed = await readCourseHistory({
    currentTerm, enrolled: async () => [enrollment()],
    grades: async () => { throw new Error("fixture"); },
  });
  assert.equal(gradesFailed.complete, false);
  assert.equal(gradesFailed.total, 1);
  assert.equal(gradesFailed.sourceStatuses.grades.code, "GRADE_HISTORY_UNAVAILABLE");
  const enrollmentFailed = await readCourseHistory({
    currentTerm, enrolled: async () => { throw new Error("fixture"); }, grades: async () => [grade()],
  });
  assert.equal(enrollmentFailed.complete, false);
  assert.equal(enrollmentFailed.total, 1);
  assert.equal(enrollmentFailed.sourceStatuses.enrolled.code, "ENROLLMENT_UNAVAILABLE");
});
