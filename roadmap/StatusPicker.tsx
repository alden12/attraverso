/**
 * The ticket's status in the detail pane, as a control rather than a label (VIEW-17).
 *
 * This is the cheapest write the viewer has and close to the most valuable: clicking an item to `done` is most
 * of what a person wants from a board, and unlike prose it needs no editing surface, no validation to explain
 * in the browser and - because it is one enum on one row - no conflict story. A wrong status is visible
 * immediately and one click to fix, which is exactly why it ships before `VIEW-18`'s guard rather than after.
 *
 * **The selected value is the fetched plan's, never this component's.** The uploader learned that the hard
 * way: local state that shadows fetched state is only right until something remounts, and the pane unmounts
 * every time the ticket is closed. So a change writes, then refetches, and the control renders whatever comes
 * back - which also means a status Claude changes in the same conversation appears here.
 *
 * **Read-only without a token**, like every other write in the viewer: under `yarn viewer` the page is served
 * by a second process on the same file, and letting that write would be the two-writer failure of 2026-07-30.
 * It renders as the plain label it always was rather than as a disabled control, because there is nothing to
 * enable and a greyed-out dropdown invites a click that can never work.
 */
import { useEffect, useState } from "react";
import { STATUSES, type Status } from "../scripts/tickets";
import { canWrite, setTicketStatus } from "./store";

interface Props {
  projectKey: string;
  /** The ticket's ref. The pane is reused between tickets, so this is what identifies the row. */
  ref_: string;
  /** Straight from the fetched plan - this component never keeps its own copy. */
  status: Status;
  /** Refetch the plan, so the graph node recolours too rather than only this control. */
  reload: () => void;
}

const label = (status: Status): string => `${STATUSES[status].icon} ${STATUSES[status].label}`;

export function StatusPicker({ projectKey, ref_, status, reload }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A failure carried over from the previous ticket would read as a complaint about this one.
  useEffect(() => setError(null), [ref_]);

  if (!canWrite()) return <span className="detail__status">{label(status)}</span>;

  async function choose(next: Status): Promise<void> {
    if (next === status) return;
    setBusy(true);
    setError(null);
    try {
      await setTicketStatus(projectKey, ref_, next);
    } catch (problem) {
      // The server's message is already written for a person ("MCP-3 is done, and done is terminal"), so
      // show it rather than a generic failure.
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
      reload();
    }
  }

  return (
    <>
      <select
        className="detail__status detail__status--edit"
        value={status}
        disabled={busy}
        aria-label="Status"
        onChange={(event) => void choose(event.target.value as Status)}
      >
        {(Object.keys(STATUSES) as Status[]).map((key) => (
          <option key={key} value={key}>
            {label(key)}
          </option>
        ))}
      </select>
      {error !== null && <span className="detail__status-error">{error}</span>}
    </>
  );
}
