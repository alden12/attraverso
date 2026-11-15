import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { normaliseClaim, parsePointers } from "../scripts/references";
import type { ItemReference } from "./store";

const PLUGINS = [remarkGfm];

/**
 * An item's body with its source references (`CTX-13`) as numbered references: `[ref r7k2]` in the stored text
 * renders as a small [1], numbered in reading order, and clicking one highlights the claim it stands behind and
 * lists its sources beneath the prose.
 *
 * - **The numbers are display only.** They are assigned per render in order of first appearance, so they renumber
 *   themselves as references come and go while the stored keys never change.
 * - **The highlight is the claim's block** - the paragraph, list item, table row or heading - or, for a pointer on
 *   a line of its own, the block above it. Rendered markdown keeps no character offsets, so this is the finest
 *   grain the page can mark without a markdown parser of its own; the panel quotes the exact text regardless.
 * - **A changed claim says so**, with the text its source vouched for, which is the comparison worth having when
 *   deciding whether the source still holds - and its number carries a "?", [2?], so it shows without a click.
 */
export function ReferencedBody({ body, references }: { body: string; references: ItemReference[] }) {
  const [active, setActive] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);

  const { markdown, numbers, covers } = useMemo(() => {
    const { pointers } = parsePointers(body);
    const numbers = new Map<string, number>();
    for (const p of [...pointers].sort((a, b) => a.at - b.at)) if (!numbers.has(p.key)) numbers.set(p.key, numbers.size + 1);
    // Replaced from the end, so earlier offsets stay true. A link is the one inline construct markdown will render
    // anywhere a pointer can sit, table cells included, and the `a` renderer below turns it back into a button.
    let markdown = body;
    for (const p of [...pointers].sort((a, b) => b.at - a.at)) {
      markdown = `${markdown.slice(0, p.at)}[${numbers.get(p.key)}](#ref-${p.key})${markdown.slice(p.at + p.written.length)}`;
    }
    return { markdown, numbers, covers: new Map(pointers.map((p) => [p.key, p.covers])) };
  }, [body]);

  // Why a reference deserves a second look, like Wikipedia's "dubious" marks: its claim was edited after a source
  // vouched for it, or nothing stands behind it at all. Absent for a reference whose sources all still match.
  const doubt = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const [key, claim] of covers) {
      const behind = references.filter((r) => r.key === key);
      if (behind.length === 0) reasons.set(key, "no source is recorded for this claim");
      else if (behind.some((r) => normaliseClaim(r.text) !== claim)) reasons.set(key, "the claim has changed since its source vouched for it");
    }
    return reasons;
  }, [covers, references]);

  // A body edited elsewhere can drop the open reference; close the panel rather than show sources for nothing.
  useEffect(() => {
    if (active !== null && !numbers.has(active)) setActive(null);
  }, [active, numbers]);

  useEffect(() => {
    const root = container.current;
    if (root === null || active === null) return;
    const link = root.querySelector(`[data-ref="${active}"]`);
    let block = link?.closest("li, tr, h1, h2, h3, h4, h5, h6, p") ?? null;
    // A paragraph holding only pointers stands behind the block above it.
    while (block !== null && block.tagName === "P" && (block.textContent ?? "").replace(/\[?\d+\]?/g, "").trim() === "") {
      block = block.previousElementSibling;
    }
    block?.classList.add("ref-highlight");
    return () => block?.classList.remove("ref-highlight");
  }, [active, markdown]);

  // Made once per numbering and open reference, not on every render: a renderer given a new component each time
  // remounts every link in the body, and the pane re-renders often enough that a link would never hold still to
  // be clicked.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, node: _node, ...rest }) => {
        const key = href?.startsWith("#ref-") ? href.slice("#ref-".length) : null;
        if (key === null || !numbers.has(key)) {
          return (
            <a href={href} {...rest}>
              {children}
            </a>
          );
        }
        return (
          <button
            type="button"
            className="ref-link"
            data-ref={key}
            data-active={active === key}
            data-doubt={doubt.has(key)}
            aria-label={`Reference ${numbers.get(key)}: ${doubt.get(key) ?? "where this came from"}`}
            title={doubt.get(key)}
            onClick={() => setActive((open) => (open === key ? null : key))}
          >
            [{numbers.get(key)}
            {doubt.has(key) && <span className="ref-link__doubt">?</span>}]
          </button>
        );
      },
    }),
    [numbers, active, doubt],
  );

  const sources = active === null ? [] : references.filter((r) => r.key === active);
  const claim = active === null ? "" : (covers.get(active) ?? "");

  return (
    <div ref={container}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {markdown}
      </ReactMarkdown>
      {active !== null && (
        <aside className="refs-panel" aria-label={`Reference ${numbers.get(active)}`}>
          <div className="refs-panel__head">
            <span>Reference {numbers.get(active)}</span>
            <button type="button" className="refs-panel__close" onClick={() => setActive(null)} aria-label="Close">
              ✕
            </button>
          </div>
          {sources.length === 0 ? (
            <p className="refs-panel__none">No source is recorded for this claim.</p>
          ) : (
            <ul className="refs-panel__list">
              {sources.map((s, index) => (
                <li key={`${s.at}-${index}`}>
                  <span className="refs-panel__kind">{s.source}</span>
                  <span className="refs-panel__date">{s.at.slice(0, 10)}</span>
                  <span className="refs-panel__detail">
                    {/^https?:\/\//.test(s.detail) ? (
                      <a href={s.detail} target="_blank" rel="noreferrer">
                        {s.detail}
                      </a>
                    ) : s.source === "user" ? (
                      <q>{s.detail}</q>
                    ) : (
                      <code>{s.detail}</code>
                    )}
                  </span>
                  {normaliseClaim(s.text) !== claim && (
                    <p className="refs-panel__changed">
                      The claim has changed since. This source vouched for: <q>{s.text}</q>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}
