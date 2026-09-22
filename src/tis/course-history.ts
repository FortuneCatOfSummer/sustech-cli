import { semesterFromCurrentTerm, type Semester } from "../core/semester.js";
import type { TisClient } from "./client.js";
import type { GradeRecord, PersonalScheduleEntry } from "./types.js";

export type CourseHistorySource = "current-enrollment" | "grade-history";

export interface CourseHistoryCourse {
  semester?: string;
  semesterLabel: string;
  code: string;
  name: string;
  nameEn?: string;
  credits?: number;
  nature?: string;
  department?: string;
  teachingTeam: string[];
  rwhs: string[];
  sources: CourseHistorySource[];
}

export interface CourseHistorySourceStatus {
  state: "available" | "error" | "unavailable";
  count?: number;
  code?: "CURRENT_TERM_UNAVAILABLE" | "ENROLLMENT_UNAVAILABLE" | "GRADE_HISTORY_UNAVAILABLE";
}

export interface TisCourseHistory {
  currentSemester?: Semester;
  courses: CourseHistoryCourse[];
  semesters: {
    semester?: string;
    label: string;
    courses: CourseHistoryCourse[];
    total: number;
  }[];
  total: number;
  complete: boolean;
  sourceStatuses: {
    currentTerm: CourseHistorySourceStatus;
    enrolled: CourseHistorySourceStatus;
    grades: CourseHistorySourceStatus;
  };
  reportedAt: string;
}

/** A course inventory only: no scores, GPA, completion inference, or raw records. */
export async function readCourseHistory(
  client: Pick<TisClient, "currentTerm" | "enrolled" | "grades">,
): Promise<TisCourseHistory> {
  const sourceStatuses: TisCourseHistory["sourceStatuses"] = {
    currentTerm: { state: "unavailable", code: "CURRENT_TERM_UNAVAILABLE" },
    enrolled: { state: "unavailable", code: "CURRENT_TERM_UNAVAILABLE" },
    grades: { state: "unavailable", code: "GRADE_HISTORY_UNAVAILABLE" },
  };
  let currentSemester: Semester | undefined;
  const [enrolled, grades] = await Promise.all([
    (async (): Promise<PersonalScheduleEntry[]> => {
      try {
        currentSemester = semesterFromCurrentTerm(await client.currentTerm());
        sourceStatuses.currentTerm = { state: "available" };
      } catch {
        sourceStatuses.currentTerm = { state: "error", code: "CURRENT_TERM_UNAVAILABLE" };
        return [];
      }
      try {
        const rows = await client.enrolled(currentSemester);
        sourceStatuses.enrolled = { state: "available", count: rows.length };
        return rows;
      } catch {
        sourceStatuses.enrolled = { state: "error", code: "ENROLLMENT_UNAVAILABLE" };
        return [];
      }
    })(),
    (async (): Promise<GradeRecord[]> => {
      try {
        const rows = await client.grades();
        sourceStatuses.grades = { state: "available", count: rows.length };
        return rows;
      } catch {
        sourceStatuses.grades = { state: "error", code: "GRADE_HISTORY_UNAVAILABLE" };
        return [];
      }
    })(),
  ]);
  const courses = mergeCourseHistory(currentSemester, enrolled, grades);
  const groups = new Map<string, TisCourseHistory["semesters"][number]>();
  for (const course of courses) {
    const key = semesterKey(course);
    const group = groups.get(key) ?? {
      ...(course.semester ? { semester: course.semester } : {}),
      label: course.semester ?? course.semesterLabel,
      courses: [],
      total: 0,
    };
    group.courses.push(course);
    group.total++;
    groups.set(key, group);
  }
  return {
    ...(currentSemester ? { currentSemester } : {}),
    courses,
    semesters: [...groups.values()],
    total: courses.length,
    complete: Object.values(sourceStatuses).every((status) => status.state === "available"),
    sourceStatuses,
    reportedAt: new Date().toISOString(),
  };
}

function mergeCourseHistory(
  currentSemester: Semester | undefined,
  enrolled: readonly PersonalScheduleEntry[],
  grades: readonly GradeRecord[],
): CourseHistoryCourse[] {
  const historical = new Map<string, CourseHistoryCourse>();
  for (const row of grades) {
    const semesterLabel = row.semester.trim() || "Unknown semester";
    const semester = normaliseSemesterLabel(semesterLabel);
    const course: CourseHistoryCourse = {
      ...(semester ? { semester } : {}),
      semesterLabel,
      code: row.code.trim().toUpperCase(),
      name: row.name.trim() || row.nameEn.trim(),
      ...(row.nameEn.trim() ? { nameEn: row.nameEn.trim() } : {}),
      // Grade normalization cannot distinguish absent credits from zero.
      ...(Number.isFinite(row.credits) && row.credits > 0 ? { credits: row.credits } : {}),
      ...(row.nature.trim() ? { nature: row.nature.trim() } : {}),
      ...(row.department.trim() ? { department: row.department.trim() } : {}),
      teachingTeam: [],
      rwhs: [],
      sources: ["grade-history"],
    };
    historical.set(JSON.stringify(course), course);
  }

  const current = new Map<string, CourseHistoryCourse>();
  if (currentSemester) {
    for (const row of enrolled) {
      const code = row.courseCode.trim().toUpperCase();
      const name = row.courseName.trim();
      // Missing codes cannot safely identify separate classes by name alone.
      const key = JSON.stringify(code ? [code, name] : [code, name, row.rwh || row.key]);
      const course = current.get(key) ?? {
        semester: currentSemester.value,
        semesterLabel: currentSemester.value,
        code,
        name,
        teachingTeam: [],
        rwhs: [],
        sources: ["current-enrollment"],
      };
      course.teachingTeam = unique([...course.teachingTeam, row.teacher]);
      course.rwhs = unique([...course.rwhs, row.rwh]);
      current.set(key, course);
    }
  }
  const courses = [...historical.values()];
  for (const course of current.values()) {
    const candidates = courses.filter((candidate) => course.code && candidate.code === course.code
      && candidate.semester === course.semester && candidate.sources.includes("grade-history"));
    const currentMatches = [...current.values()].filter((candidate) => candidate.code === course.code);
    if (candidates.length === 1 && currentMatches.length === 1) {
      candidates[0].teachingTeam = course.teachingTeam;
      candidates[0].rwhs = course.rwhs;
      candidates[0].sources = ["grade-history", "current-enrollment"];
    } else {
      courses.push(course);
    }
  }
  return courses.sort((left, right) => semesterKey(right).localeCompare(semesterKey(left))
    || left.code.localeCompare(right.code) || left.name.localeCompare(right.name));
}

function semesterKey(course: CourseHistoryCourse): string {
  return course.semester ?? `unknown:${course.semesterLabel}`;
}

function normaliseSemesterLabel(label: string): string | undefined {
  const code = /^(\d{4})-(\d{4})-?([123])$/.exec(label);
  if (code && Number(code[2]) === Number(code[1]) + 1) return `${code[1]}-${code[2]}-${code[3]}`;
  const chinese = /^(\d{4})\s*([春秋夏])(?:季|学期)?$/.exec(label);
  if (!chinese) return undefined;
  const year = Number(chinese[1]);
  return chinese[2] === "秋" ? `${year}-${year + 1}-1`
    : `${year - 1}-${year}-${chinese[2] === "春" ? "2" : "3"}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function formatCourseHistory(history: TisCourseHistory): string {
  const lines = [`Course history · ${history.total} courses · ${history.semesters.length} semesters`];
  if (!history.complete) {
    lines.push(`Incomplete sources: ${Object.entries(history.sourceStatuses)
      .filter(([, status]) => status.state !== "available").map(([name, status]) => `${name} (${status.code})`).join(", ")}`);
  }
  for (const group of history.semesters) {
    lines.push("", `${group.label} · ${group.total} courses`);
    for (const course of group.courses) {
      lines.push(`  ${course.code || "?"} ${course.name || "Unnamed course"}`
        + (course.credits !== undefined ? ` · ${course.credits} credits` : "")
        + (course.teachingTeam.length ? ` · ${course.teachingTeam.join(", ")}` : "")
        + ` · ${course.sources.join(" + ")}`);
    }
  }
  return lines.join("\n");
}
