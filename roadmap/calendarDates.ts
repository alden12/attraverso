/**
 * Where an item sits on the calendar (`CAL-3`), kept apart from the component so the date rules are tested in
 * node rather than only through a browser.
 *
 * The dates are calendar days (`CAL-1`), so all arithmetic here is on `YYYY-MM-DD` strings in UTC. Local time
 * never enters: a day is not an instant, and the calendar library is told the same (`timeZone: "UTC"`).
 */
import type { RoadmapItem } from "../scripts/tickets";

/** One item's place on the calendar. `end` is exclusive, the convention the calendar library uses for all-day
 *  spans, so a one-day item ends the day after it starts. */
export interface Span {
  start: string;
  end: string;
}

/** The day after `day`, as `YYYY-MM-DD`. */
export function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * The local calendar day an instant fell on. The one place local time is right: `closed_at` records when
 * something happened, so an item finished at 11pm in California was finished that evening, not the next UTC day.
 */
export function localDay(instant: string): string {
  const at = new Date(instant);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * The days an item covers, or null for an undated one - which is most of them, and never an error.
 *
 * - **start and due**: the span between them, inclusive of both.
 * - **due only**: that day. A due date is a deadline, and drawing it as a span from today would invent a
 *   start nobody chose.
 * - **start only**: that day, for the same reason in reverse.
 * - **neither, but done**: the day it closed. Derived rather than written as a due date, so finished work shows
 *   up without anyone backfilling dates, and `due` keeps meaning "planned". A planned date wins when there is
 *   one, since that is what the item was put on the calendar for.
 */
export function spanOf(item: Pick<RoadmapItem, "start" | "due" | "closed">): Span | null {
  const first = item.start ?? item.due;
  const last = item.due ?? item.start;
  if (first !== undefined && last !== undefined) return { start: first, end: nextDay(last) };
  if (item.closed === undefined) return null;
  const day = localDay(item.closed);
  return { start: day, end: nextDay(day) };
}

/** How many of a project's items have a date, for the notice that explains an empty calendar. */
export const countDated = (items: Pick<RoadmapItem, "start" | "due" | "closed">[]): number => items.filter((item) => spanOf(item) !== null).length;
