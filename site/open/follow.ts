/**
 * When `/open` looks at the plan folder for a change (`DIST-9.1`), with a stop condition rather than a timer that
 * runs for ever (agreed with Alden, 2026-11-18):
 *
 * - **every 2s**, or **every 10s** once nobody has touched the page for 5 minutes;
 * - **nothing while the tab is hidden**, and a check the moment it is shown;
 * - **paused after 15 minutes without activity**, which `onPaused(true)` shows; the next pointer, key, scroll or
 *   focus checks at once, clears it, and starts again at 2s.
 *
 * A chained `setTimeout` rather than an interval, so a slow check can never overlap the next one.
 */

export const FOLLOW = { fast: 2_000, slow: 10_000, slowAfter: 5 * 60_000, pauseAfter: 15 * 60_000 };

/** What someone looking at the page does. */
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "focus"];

/** The two things events come from, passed in so a test can use plain `EventTarget`s. */
export interface Page {
  window: EventTarget;
  document: EventTarget & { visibilityState: string };
}

/** Start following; returns how to stop. */
export function follow(check: () => Promise<unknown>, onPaused: (paused: boolean) => void, page: Page = { window, document }): () => void {
  let lastActive = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let paused = false;
  let stopped = false;
  const hidden = () => page.document.visibilityState === "hidden";
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  async function tick() {
    clear();
    if (stopped || running || hidden()) return;
    const idle = Date.now() - lastActive;
    if (idle >= FOLLOW.pauseAfter) {
      paused = true;
      return onPaused(true);
    }
    running = true;
    try {
      await check();
    } catch {
      // A file mid-write, or the permission withdrawn: try again next time.
    } finally {
      running = false;
    }
    if (!stopped && !hidden() && timer === undefined) timer = setTimeout(tick, idle >= FOLLOW.slowAfter ? FOLLOW.slow : FOLLOW.fast);
  }

  /** Someone is here: note it, and check now if the schedule had paused or slowed. */
  const active = () => {
    const wasSlow = Date.now() - lastActive >= FOLLOW.slowAfter;
    lastActive = Date.now();
    if (paused) {
      paused = false;
      onPaused(false);
    }
    if (wasSlow) void tick();
  };
  const visibility = () => {
    if (hidden()) return clear();
    lastActive = 0; // coming back to the tab counts as activity, and always checks at once
    active();
  };

  for (const name of ACTIVITY) page.window.addEventListener(name, active, { passive: true, capture: true });
  page.document.addEventListener("visibilitychange", visibility);
  timer = setTimeout(tick, FOLLOW.fast);
  return () => {
    stopped = true;
    clear();
    for (const name of ACTIVITY) page.window.removeEventListener(name, active, { capture: true });
    page.document.removeEventListener("visibilitychange", visibility);
  };
}
