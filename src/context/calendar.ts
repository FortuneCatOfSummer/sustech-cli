import { AcademicCalendar, CalendarClient } from "../calendar/client.js";
import type { CalendarLevel } from "../calendar/types.js";

/** January can still belong to the preceding calendar file's fall semester. */
export async function loadContextCalendar(
  date: string,
  level: CalendarLevel,
  client: Pick<CalendarClient, "loadYear"> = new CalendarClient(),
): Promise<AcademicCalendar> {
  const year = Number(date.slice(0, 4));
  let current: AcademicCalendar | undefined;
  let currentError: unknown;
  try {
    current = await client.loadYear(year, level);
    if (current.day(date).semester) return current;
  } catch (error) {
    currentError = error;
  }
  try {
    const previous = await client.loadYear(year - 1, level);
    if (previous.day(date).semester) {
      if (!current) return previous;
      return new AcademicCalendar(previous.year, level, {
        spring: previous.spring.snapshot,
        fall: previous.fall.snapshot,
        ...(previous.summer ? { summer: previous.summer.snapshot } : {}),
        // The current year's holiday dates can fall inside the previous fall term.
        holidays: [...current.holidays(), ...previous.holidays()],
      });
    }
  } catch {
    // An unrelated or unavailable previous year must not discard a loaded calendar.
  }
  if (current) return current;
  throw currentError;
}
