import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { normaliseClaim, parsePointers } from "../scripts/references";
import type { ItemReference } from "./store";

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

/** A markdown tree node, as much of mdast as the plugin below needs. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** The pointer syntax as it appears in a rendered text node: the parser's, less the code it has already skipped. */
const IN_TEXT = /\[ref ([a-z0-9]+)(?::[^\]\n]{0,3000})?\](?![(:])/g;

/**
 * A remark plugin turning each pointer into a link the `a` renderer makes a reference button of, `#ref-<key>-<n>`
 * for the key's nth appearance. Done on the markdown tree rather than the source text, so code (fenced, indented or
 * inline) is never touched, a pointer inside a link's text leaves the link whole, and a `!` before one cannot turn
 * it into an image - all of which a text substitution got wrong. Only keys the shared parser found are replaced.
 */
const remarkPointers = (keys: ReadonlySet<string>) => () => (tree: MdNode) => {
  const seen = new Map<string, number>();
  const walk = (node: MdNode, inLink: boolean) => {
    if (node.children === undefined) return;
    const linkish = inLink || node.type === "link" || node.type === "linkReference";
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== "text" || linkish || child.value === undefined) {
        walk(child, linkish);
        return [child];
      }
      const out: MdNode[] = [];
      let last = 0;
      for (const match of child.value.matchAll(IN_TEXT)) {
        const key = match[1]!;
        if (!keys.has(key)) continue;
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        if (match.index > last) out.push({ type: "text", value: child.value.slice(last, match.index) });
        out.push({ type: "link", url: `#ref-${key}-${n}`, children: [{ type: "text", value: key }] });
        last = match.index + match[0].length;
      }
      if (last === 0) return [child];
      if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
      return out;
    });
  };
  walk(tree, false);
};

/** What each reference button reads, through context rather than its renderer's closure: the renderer then stays the
 *  same function while a reference opens and closes, so React keeps every button (and the focus on it). */
interface RefState {
  active: string | null;
  numbers: ReadonlyMap<string, number>;
  doubt: ReadonlyMap<string, string>;
  toggle: (id: string, opener: HTMLElement) => void;
}
const RefContext = createContext<RefState | null>(null);

/** An occurrence id, `<key>-<n>`, back to its key. */
const keyOf = (id: string): string => id.slice(0, id.lastIndexOf("-"));

function RefButton({ id }: { id: string }): ReactNode {
  const state = useContext(RefContext)!;
  const key = keyOf(id);
  return (
    <button
      type="button"
      className="ref-link"
      data-ref={key}
      data-ref-id={id}
      data-active={state.active === id}
      data-doubt={state.doubt.has(key)}
      aria-expanded={state.active === id}
      aria-controls={state.active === id ? "refs-panel" : undefined}
      aria-label={`Reference ${state.numbers.get(key)}: ${state.doubt.get(key) ?? "where this came from"}`}
      title={state.doubt.get(key)}
      onClick={(event) => state.toggle(id, event.currentTarget)}
    >
      [{state.numbers.get(key)}
      {state.doubt.has(key) && <span className="ref-link__doubt">?</span>}]
    </button>
  );
}

/** The nearest ancestor that scrolls vertically: the pane, whose visible area a reference must be in to be pointed at. */
function scroller(element: Element): Element {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  }
  return document.documentElement;
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
 *
 * `references` is undefined when the server sent none (one older than `CTX-13`): the numbers still show, but nothing
 * is called doubtful, since nothing is known.
 */
export function ReferencedBody({ body, references }: { body: string; references: ItemReference[] | undefined }) {
  const [active, setActive] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const { numbers, covers, plugins } = useMemo(() => {
    const { pointers } = parsePointers(body);
    const numbers = new Map<string, number>();
    const covers = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const p of [...pointers].sort((a, b) => a.at - b.at)) {
      if (!numbers.has(p.key)) numbers.set(p.key, numbers.size + 1);
      const n = seen.get(p.key) ?? 0;
      seen.set(p.key, n + 1);
      covers.set(`${p.key}-${n}`, p.covers);
    }
    return { numbers, covers, plugins: [remarkGfm, remarkPointers(new Set(numbers.keys()))] };
  }, [body]);

  // Why a reference deserves a second look, like Wikipedia's "dubious" marks: its claim was edited after its newest
  // source vouched for it, or nothing stands behind it at all. Absent for a reference whose sources still match.
  const doubt = useMemo(() => {
    const reasons = new Map<string, string>();
    if (references === undefined) return reasons;
    for (const [id, claim] of covers) {
      const key = keyOf(id);
      const behind = references.filter((r) => r.key === key);
      if (behind.length === 0) reasons.set(key, "no source is recorded for this claim");
      else if (normaliseClaim(behind[behind.length - 1]!.text) !== claim) reasons.set(key, "the claim has changed since its source vouched for it");
      else if (behind.some((r) => r.codeChanged === true)) reasons.set(key, "the code it points at has changed since");
    }
    return reasons;
  }, [covers, references]);

  /** Close, handing focus back to the reference that opened it when the close came from the keyboard or the button. */
  const close = useCallback((restoreFocus: boolean) => {
    setActive(null);
    if (restoreFocus) opener.current?.focus();
  }, []);
  const toggle = useCallback((id: string, from: HTMLElement) => {
    opener.current = from;
    setActive((open) => (open === id ? null : id));
  }, []);
  const state = useMemo<RefState>(() => ({ active, numbers, doubt, toggle }), [active, numbers, doubt, toggle]);

  // A body edited elsewhere can drop the open reference; close the panel rather than show sources for nothing.
  useEffect(() => {
    if (active !== null && !covers.has(active)) setActive(null);
  }, [active, covers]);

  useEffect(() => {
    const root = container.current;
    if (root === null || active === null) return;
    const link = root.querySelector(`[data-ref-id="${active}"]`);
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
  }, [active, body]);

  // The popover sits beside the reference it explains: below its line, or above when there is not room beneath and
  // there is more above. It is rendered into the page body and placed against the screen, because the prose scrolls
  // sideways for wide tables, and a scrolling box clips whatever is positioned inside it. Its width is set before it
  // is measured, so its height is the height it will have; it never leaves the screen, taking at most the room on
  // its side and scrolling within that; and it hides while its reference is scrolled out of the pane, rather than
  // floating over the toolbar.
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number; width: number; room: number; above: boolean; hidden: boolean } | null>(null);
  const place = useCallback(() => {
    const root = container.current;
    const link = active === null ? null : root?.querySelector(`[data-ref-id="${active}"]`);
    const element = panel.current;
    if (root === null || !link || element === null) {
      setPlacement(null);
      return;
    }
    const at = link.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const view = scroller(root).getBoundingClientRect();
    element.style.width = `${origin.width}px`;
    const height = element.scrollHeight;
    const below = window.innerHeight - at.bottom - 2 * GAP;
    const aboveRoom = at.top - 2 * GAP;
    const above = below < height && aboveRoom > below;
    const room = Math.max(80, above ? aboveRoom : below);
    const shown = Math.min(height, room);
    setPlacement({
      top: above ? Math.max(GAP, at.top - GAP - shown) : Math.min(at.bottom + GAP, window.innerHeight - GAP - shown),
      left: origin.left,
      width: origin.width,
      room,
      above,
      hidden: at.bottom < view.top || at.top > view.bottom,
    });
  }, [active]);
  useLayoutEffect(place, [place, body, references]);
  useEffect(() => {
    if (active === null) return;
    window.addEventListener("scroll", place, true); // capture: the pane scrolls, not the window
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [active, place]);

  // Focus moves into the popover as it opens, so its links and close button are next in the tab order rather than
  // at the very end of the page, where a portal puts them.
  // Once it is placed and visible, that is: a hidden element cannot take focus.
  const focusPending = useRef(false);
  useEffect(() => {
    focusPending.current = active !== null;
  }, [active]);
  const visible = placement !== null && !placement.hidden;
  useEffect(() => {
    if (!visible || !focusPending.current) return;
    focusPending.current = false;
    panel.current?.querySelector<HTMLElement>(".refs-panel__close")?.focus({ preventScroll: true });
  }, [visible, active]);

  // Escape, or a click anywhere but a reference or the popover, closes it; Escape hands focus back.
  useEffect(() => {
    if (active === null) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close(true);
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(".ref-link, .refs-panel") === null) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [active, close]);

  // Made once per numbering, not per open reference or render: a renderer given a new component remounts every
  // link in the body, which loses the focus on the one just pressed. What changes as references open lives in
  // `RefContext` instead.
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, node: _node, ...rest }) => {
        const id = href?.startsWith("#ref-") ? href.slice("#ref-".length) : null;
        if (id === null || !numbers.has(keyOf(id))) {
          return (
            <a href={href} {...rest}>
              {children}
            </a>
          );
        }
        return <RefButton id={id} />;
      },
    }),
    [numbers],
  );

  const activeKey = active === null ? null : keyOf(active);
  const sources = activeKey === null ? [] : (references ?? []).filter((r) => r.key === activeKey);
  const claim = active === null ? "" : (covers.get(active) ?? "");

  return (
    <div ref={container} className="refs-body">
      <RefContext.Provider value={state}>
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {body}
        </ReactMarkdown>
      </RefContext.Provider>
      {activeKey !== null &&
        createPortal(
          <aside
            ref={panel}
            id="refs-panel"
            role="dialog"
            className="refs-panel"
            data-above={placement?.above ?? false}
            style={{
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              width: placement?.width,
              maxHeight: placement?.room,
              visibility: placement === null || placement.hidden ? "hidden" : "visible",
            }}
            aria-label={`Reference ${numbers.get(activeKey)}`}
          >
            <div className="refs-panel__head">
              <span>Reference {numbers.get(activeKey)}</span>
              <button type="button" className="refs-panel__close" onClick={() => close(true)} aria-label="Close">
                ✕
              </button>
            </div>
            {references === undefined ? (
              <p className="refs-panel__none">This server does not send sources.</p>
            ) : sources.length === 0 ? (
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
                        These lines are no longer in the file as they were at that commit: <code>git diff {s.detail.split("@")[1]} -- {s.detail.split(":")[0]}</code>
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
