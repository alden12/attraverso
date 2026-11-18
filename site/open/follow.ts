/**
 * When `/open` looks at the plan folder for a change (`DIST-9.1`): often while someone is there and things are
 * moving, less often when nothing has changed for a while, never while the tab is hidden, and **not at all once
 * nobody has touched the page for a long time**, so there is no timer that runs for ever. Agreed with Alden,
 * 2026-11-18: a sensible stop condition rather than a cheap check repeated indefinitely.
 *
 * - **Every `fast` ms** while a file changed or someone was active in the last `slowAfter` ms; **every `slow` ms**
 *   after that.
 * - **Hidden tab: no timer at all.** Showing it again checks at once.
 * - **`pauseAfter` ms without activity: stopped**, and `onPause` shows the user it is. Any activity checks at once,
 *   calls `onResume`, and starts again at `fast`.
 *
 * Activity is a pointer, a key, a scroll or the window gaining focus: what someone looking at the page does. Timers
 * are chained (`setTimeout`, never an interval), so a slow check can never overlap the next. Everything the browser
 * provides is passed in, so the schedule is tested with a fake clock rather than by waiting fifteen minutes.
 */

export interface FollowOptions {
  /** Look at the files; true when something changed (and has been loaded). */
  check: () => Promise<boolean>;
  onPause: () => void;
  onResume: () => void;
  fast?: number;
  slow?: number;
  slowAfter?: number;
  pauseAfter?: number;
}

/** What the schedule needs from the browser, so a test can stand in for it. */
export interface FollowEnvironment {
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  visible: () => boolean;
  /** Listen for an event on the window or the document; returns how to stop. */
  on: (event: "activity" | "visibility", run: () => void) => () => void;
}

export const FOLLOW_DEFAULTS = { fast: 2_000, slow: 10_000, slowAfter: 5 * 60_000, pauseAfter: 15 * 60_000 };

/** What someone at the page does: each is activity, and keeps the page following. */
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "focus"] as const;

export const browserEnvironment = (): FollowEnvironment => ({
  now: () => Date.now(),
  setTimer: (run, ms) => window.setTimeout(run, ms),
  clearTimer: (timer) => window.clearTimeout(timer as number),
  visible: () => document.visibilityState === "visible",
  on: (event, run) => {
    if (event === "visibility") {
      document.addEventListener("visibilitychange", run);
      return () => document.removeEventListener("visibilitychange", run);
    }
    for (const name of ACTIVITY) window.addEventListener(name, run, { passive: true, capture: true });
    return () => ACTIVITY.forEach((name) => window.removeEventListener(name, run, { capture: true }));
  },
});

/** Start following; returns how to stop for good. */
export function follow(options: FollowOptions, env: FollowEnvironment = browserEnvironment()): () => void {
  const { fast, slow, slowAfter, pauseAfter } = { ...FOLLOW_DEFAULTS, ...options };
  let lastActivity = env.now();
  let lastChange = env.now();
  let timer: unknown = null;
  let checking = false;
  let paused = false;
  let stopped = false;

  const clear = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (stopped || paused || !env.visible()) return; // hidden: no timer until it is shown again
    const quietFor = env.now() - Math.max(lastActivity, lastChange);
    timer = env.setTimer(tick, quietFor >= slowAfter ? slow : fast);
  };
  async function tick() {
    timer = null;
    if (stopped || paused || checking || !env.visible()) return;
    if (env.now() - lastActivity >= pauseAfter) {
      paused = true;
      options.onPause();
      return; // nothing scheduled: it waits for someone to come back
    }
    checking = true;
    try {
      if (await options.check()) lastChange = env.now();
    } catch {
      // A file mid-write, or the permission withdrawn: try again next time.
    } finally {
      checking = false;
    }
    schedule();
  }
  /** Check now rather than at the next tick: someone came back, or the tab was shown. */
  const now = () => {
    clear();
    void tick();
  };

  const offActivity = env.on("activity", () => {
    const wasQuiet = env.now() - lastActivity >= slowAfter;
    lastActivity = env.now();
    if (paused) {
      paused = false;
      options.onResume();
      now();
    } else if (wasQuiet) schedule(); // back from slow to fast without waiting out the slow tick
  });
  const offVisibility = env.on("visibility", () => {
    if (!env.visible()) return clear();
    lastActivity = env.now();
    if (paused) {
      paused = false;
      options.onResume();
    }
    now();
  });

  schedule();
  return () => {
    stopped = true;
    clear();
    offActivity();
    offVisibility();
  };
}
