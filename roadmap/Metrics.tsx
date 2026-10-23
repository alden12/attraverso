/**
 * An item's measurements in the detail pane (`METRIC-4`, MVP slice).
 *
 * **A summary per metric, never a series.** How a reading should be *read* depends on what it is - an average
 * is right for a benchmark and misleading for a daily total, a latest value is right for a body weight and
 * meaningless for one set of a lift - so this reports what is true of any metric (the most recent reading,
 * how many there are, the span they cover) and interprets nothing. Choosing an aggregate is
 * `query_measurements`' job, and drawing a shape is the sparkline's.
 *
 * That is also what makes it affordable: the feed carries one row per (item, metric) however long the series
 * gets, so a year of per-meal nutrition costs the page nothing. Raw points stay behind a windowed request
 * that only a chart would make.
 *
 * **This exists because the alternative was writing the number into the prose**, which is what one
 * project's agent did (`CTX-15`), and what this project's own agent did to `IMP-16` hours after writing that up. A
 * body should carry the number that justified a decision; the current value belongs beside it, not in it.
 */
import { Section } from "./Section";
import type { MetricSummary } from "./store";

/** `2026-09-03T16:18:27.109Z` -> `3 Sep`. Enough to see staleness at a glance without a date library. */
const day = (at: string): string =>
  new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/**
 * The reading as text: a number with its unit, or the categorical value, or **nothing at all** for a group
 * node.
 *
 * A group is an occurrence rather than a measurement - "a workout happened" - so it has no reading of its own
 * and a dash would imply a missing one. Its row is still worth showing, because the count *is* the fact
 * ("3 runs, to 3 Sep"); it is the value column that has nothing to say.
 */
/** Whether a metric carries no reading at all - which makes it an occurrence rather than a measurement. */
const isOccurrence = (metric: MetricSummary): boolean => metric.latest === null && metric.latestText === null;

function reading(metric: MetricSummary): string {
  if (metric.latest !== null) {
    // Trimmed rather than rounded to a fixed place: 726 and 13.666666666666666 both have to read well, and a
    // fixed precision gets one of them wrong.
    const value = Number.isInteger(metric.latest) ? String(metric.latest) : metric.latest.toFixed(2).replace(/\.?0+$/, "");
    return metric.units.length > 0 ? `${value} ${metric.units.join("/")}` : value;
  }
  // A categorical reads as its distribution, not its latest: "restless" alone says almost nothing about a
  // sleep log where "restless x8, sound x3" is the shape of it. One value renders as just that value, so the
  // common case stays plain.
  if (metric.values.length > 1) {
    const shown = metric.values.map((v) => `${v.text} x${v.count}`).join(", ");
    const rest = metric.distinctValues - metric.values.length;
    return rest > 0 ? `${shown}, +${rest} more` : shown;
  }
  return metric.latestText ?? "";
}

export function Metrics({ metrics, open, onToggle }: { metrics: MetricSummary[]; open: boolean; onToggle: () => void }) {
  if (metrics.length === 0) return null;
  return (
    <Section title="Metrics" count={metrics.length} open={open} onToggle={onToggle}>
      <table className="metrics__table">
        <tbody>
          {metrics.map((metric) => (
            <tr key={metric.metric}>
              <td className="metrics__name">{metric.metric}</td>
              {/* Mixed units are called out rather than silently joined: kg beside lb is a 2.2x step change,
                  and the same warning the query layer gives should not be missing from the surface a human
                  reads (METRIC-1). */}
              {/* Wrapping allowed only for a distribution: a number stays on one line, and a long tail of
                  categorical values is more useful readable than truncated. */}
              <td className="metrics__value" data-mixed={metric.units.length > 1} data-wrap={metric.values.length > 1}>
                {reading(metric)}
              </td>
              {/* "3 readings" is simply wrong for a row that has no readings, and the blank value cell then
                  looks like a bug rather than a fact. An occurrence says how many times it happened, which is
                  the whole of what it knows - and it is kept rather than hidden because "there were 3 benchmark
                  runs" is information that vanishes with it, leaving two metrics with no sign they were grouped. */}
              <td className="metrics__count">
                {isOccurrence(metric)
                  ? `${metric.count} ${metric.count === 1 ? "occurrence" : "occurrences"}, to ${day(metric.latestAt)}`
                  : metric.count === 1
                    ? day(metric.latestAt)
                    : `${metric.count} readings, to ${day(metric.latestAt)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
