import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { normaliseClaim, parsePointers } from "../scripts/references";
import type { ItemReference } from "./store";

const PLUGINS = [remarkGfm];
/** The name the claim's range is registered under for `::highlight()` in the stylesheet. */
const CLAIM_HIGHLIGHT = "ref-claim";
/** Space between a reference's line and its popover, in pixels. */
const GAP = 6;

/** An element's text with its reference numbers taken out: empty for a paragraph that holds only pointers. */
const withoutReferences = (element: Element): string => {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll(".ref-link").forEach((ref) => ref.remove());
  return (copy.textContent ?? "").trim();
};

/**
 * The words a reference stands behind, as the page shows them: from just after the previous reference in the same
 * block (or the block's start) to just before this one, less the punctuation and space the previous sentence left at
 * its start - the parser's `covers`, found in rendered text rather than in source offsets.
 */
function claimRange(block: Element, link: Element): Range {
  const range = document.createRange();
  const refs = [...block.querySelectorAll(".ref-link")];
  const previous = refs[refs.indexOf(link) - 1];
  if (previous === undefined) range.setStart(block, 0);
  else range.setStartAfter(previous);
  range.setEndBefore(link);
  const texts: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if (range.intersectsNode(node)) texts.push(node as Text);
  // Trim the start past the previous sentence's punctuation and space, and the end back past the space before the number.
  for (const node of texts) {
    const text = node.data;
    let at = node === range.startContainer ? range.startOffset : 0;
    while (at < text.length && /[\s.,;:!?)]/.test(text[at]!)) at++;
    if (at < text.length) {
      range.setStart(node, at);
      break;
    }
  }
  for (const node of [...texts].reverse()) {
    const text = node.data;
    let at = node === range.endContainer ? range.endOffset : text.length;
    while (at > 0 && /\s/.test(text[at - 1]!)) at--;
    if (at > 0) {
      range.setEnd(node, at);
      break;
    }
  }
  return range;
}

/**
 * An item's body with its source references (`CTX-13`) as numbered references: `[ref r7k2]` in the stored text
 * renders as a small [1], numbered in reading order, and clicking one highlights the claim it stands behind and
 * opens its sources in a popover beside it - below the line, or above when the line sits low on the screen.
 *
 * - **The numbers are display only.** They are assigned per render in order of first appearance, so they renumber
 *   themselves as references come and go while the stored keys never change.
 * - **The highlight is the claim's own words** where the browser can paint a range (the CSS Custom Highlight API):
 *   the text between the previous reference in the same block, or the block's start, and this one - the same span
 *   the parser says the pointer covers, found in the rendered page rather than in offsets markdown does not keep.
 *   A pointer on a line of its own covers the whole block above it, so that block is what lights up; and so does
 *   the claim's block in a browser without the API.
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
      else if (behind.some((r) => r.codeChanged === true)) reasons.set(key, "the code it points at has changed since");
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
    if (link === null) return;
    const block = link.closest("li, tr, h1, h2, h3, h4, h5, h6, p");
    const ownLine = block !== null && block.tagName === "P" && withoutReferences(block) === "";
    // The claim's own words, painted without touching the markup, where the browser can.
    if (!ownLine && block !== null && "highlights" in CSS && typeof Highlight !== "undefined") {
      const range = claimRange(block, link);
      CSS.highlights.set(CLAIM_HIGHLIGHT, new Highlight(range));
      return () => void CSS.highlights.delete(CLAIM_HIGHLIGHT);
    }
    // Otherwise the block: the claim's own, or for a pointer on a line of its own, the block above it.
    let target: Element | null = block;
    while (target !== null && target.tagName === "P" && withoutReferences(target) === "") target = target.previousElementSibling;
    target?.classList.add("ref-highlight");
    return () => target?.classList.remove("ref-highlight");
  }, [active, markdown]);

  // The popover sits beside the reference it explains: below its line, or above when there is not room beneath
  // and there is more above. It is rendered into the page body and placed against the screen, because the prose
  // scrolls sideways for wide tables, and a scrolling box clips whatever is positioned inside it. Measured after it
  // renders, so it is placed by its real height (hidden until then), and again as the pane scrolls or the window
  // resizes, so it stays with its line.
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number; above: boolean } | null>(null);
  const place = useCallback(() => {
    const root = container.current;
    const link = active === null ? null : root?.querySelector(`[data-ref="${active}"]`);
    if (root === null || !link || panel.current === null) {
      setPlacement(null);
      return;
    }
    const at = link.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const height = panel.current.offsetHeight;
    const below = window.innerHeight - at.bottom;
    const above = below < height + GAP && at.top > below;
    setPlacement({ top: above ? at.top - height - GAP : at.bottom + GAP, left: origin.left, width: origin.width, above });
  }, [active]);
  useLayoutEffect(place, [place, markdown]);
  useEffect(() => {
    if (active === null) return;
    window.addEventListener("scroll", place, true); // capture: the pane scrolls, not the window
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [active, place]);

  // Escape, or a click anywhere but a reference or the popover, closes it.
  useEffect(() => {
    if (active === null) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setActive(null);
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(".ref-link, .refs-panel") === null) setActive(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [active]);

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
    <div ref={container} className="refs-body">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {markdown}
      </ReactMarkdown>
      {active !== null &&
        createPortal(
          <aside
            ref={panel}
            className="refs-panel"
            data-above={placement?.above ?? false}
            style={{ top: placement?.top ?? 0, left: placement?.left ?? 0, width: placement?.width, visibility: placement === null ? "hidden" : "visible" }}
            aria-label={`Reference ${numbers.get(active)}`}
          >
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
                    {s.codeChanged === true && (
                      <p className="refs-panel__changed">
                        These lines have changed since that commit: <code>git diff {s.detail.split("@")[1]} -- {s.detail.split(":")[0]}</code>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </aside>,
          document.body,
        )}
    </div>
  );
}
