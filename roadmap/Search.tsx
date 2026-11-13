import { useEffect, useRef, useState } from "react";
import { searchPlan, type SearchHit } from "./store";

/**
 * The search box (`VIEW-25`), in the right-hand pane with the rest of what you open over the graph, so the canvas
 * stays the graph's.
 *
 * **The server matches, the browser does not.** Every keystroke (debounced) goes to `/api/search`, the same
 * index `search_plan` reads, so the human and the agent get one ranking for one question. Filtering the feed
 * here would be a second matching rule, and would stop working once a plan is too big to send whole.
 *
 * **Picking a hit selects; it does not navigate.** What happens on a pick is the caller's (`onPick`): an item is
 * selected and panned to in place, a context section opens in the pane. The query is the caller's too, so going
 * back from the item to the search finds it as it was left.
 */
export function Search({
  projectKey,
  colours,
  hidden,
  titleOf,
  query,
  onQuery,
  onPick,
  onClose,
}: {
  projectKey: string;
  colours: Record<string, string>;
  /** Refs the filters hide, so a hit on one can say so before it is picked. */
  hidden: Set<string>;
  /** An item's title by ref: a comment's hit carries its item's ref but not its title. */
  titleOf: (ref: string) => string | undefined;
  query: string;
  onQuery: (query: string) => void;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [relaxed, setRelaxed] = useState(false);
  const [state, setState] = useState<"idle" | "searching" | "done" | "unavailable">("idle");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (query.trim() === "") {
      setHits([]);
      setState("idle");
      return;
    }
    // A short pause so a word typed quickly is one request, and each new keystroke cancels the last one's, so a
    // slow answer to "col" can never land on top of the answer to "collapse".
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setState("searching");
      searchPlan(projectKey, query, abort.signal)
        .then((result) => {
          if (result === null) return setState("unavailable");
          setHits(result.hits);
          setRelaxed(result.relaxed);
          setActive(0);
          setState("done");
        })
        .catch((error: unknown) => {
          if ((error as Error).name !== "AbortError") setState("unavailable");
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [projectKey, query]);

  // Only a hit that leads somewhere can be picked: a comment on the project itself has no item to select.
  const pickable = (hit: SearchHit) => hit.source === "context" || hit.ref !== null;
  const pick = (hit: SearchHit | undefined) => {
    if (hit === undefined || !pickable(hit)) return;
    onPick(hit);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, hits.length - 1));
    else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
    else if (event.key === "Enter") pick(hits[active]);
    else return;
    event.preventDefault();
  };

  return (
    <aside className="detail search" aria-label="Search">
      <div className="detail__head">
        <span className="detail__id">Search</span>
        <button className="detail__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
        <input
          ref={input}
          className="search__input"
          type="search"
          placeholder="Search items, comments and context, or type a ref"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search"
        />
        {state === "unavailable" && <div className="search__note">This server cannot search. Reconnect it to pick up the newer code.</div>}
        {state === "done" && hits.length === 0 && <div className="search__note">Nothing matches.</div>}
        {state === "done" && relaxed && hits.length > 0 && <div className="search__note">Nothing has every word, so these have some of them.</div>}
        {hits.length > 0 && (
          <ul className="search__hits" role="listbox">
            {hits.map((hit, index) => (
              <li key={`${hit.source}:${hit.id}`} role="option" aria-selected={index === active}>
                <button
                  className="search__hit"
                  data-active={index === active}
                  disabled={!pickable(hit)}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(hit)}
                >
                  <span className="search__line">
                    <span className="search__source">{hit.source === "context" ? "context" : hit.source === "comment" ? (hit.audience === "agent" ? "agent comment" : "comment") : "item"}</span>
                    {hit.ref !== null && (
                      <span className="search__ref" style={{ color: colours[hit.ref.split("-")[0] ?? ""] }}>
                        {hit.ref}
                      </span>
                    )}
                    <span className="search__title">{hit.source === "context" ? hit.id : (hit.title ?? (hit.ref === null ? "" : titleOf(hit.ref)))}</span>
                    {hit.ref !== null && hidden.has(hit.ref) && <span className="search__hidden">hidden</span>}
                  </span>
                  {hit.snippet !== "" && <span className="search__snippet">{marked(hit.snippet)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
    </aside>
  );
}

/**
 * The snippet with its matched words highlighted, as text rather than markdown: a snippet is a fragment cut out of
 * the middle of a body, so its markdown is half a list or half a link. The matches come bracketed `⟦like this⟧`
 * (see `MATCH_OPEN` in the search), and the body's own emphasis markers are dropped, since rendered as text they
 * are only noise.
 */
function marked(snippet: string): React.ReactNode[] {
  return snippet
    .replace(/\*\*|__/g, "")
    .split(/⟦|⟧/)
    .map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part));
}
