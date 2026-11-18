/**
 * The folder page's schedule (`DIST-9.1`), against a fake clock: fast while things move, slower when quiet, nothing
 * while hidden, and stopped after long inactivity until someone comes back, which checks at once.
 */
import { describe, expect, it } from "vitest";
import { follow, type FollowEnvironment } from "./follow";

/** A fake browser: a clock you advance, timers that fire as it passes them, and events you fire by hand. */
function fakeBrowser() {
  let time = 0;
  let visible = true;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let nextId = 1;
  const listeners = { activity: [] as (() => void)[], visibility: [] as (() => void)[] };
  const env: FollowEnvironment = {
    now: () => time,
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.push({ at: time + ms, run, id });
      return id;
    },
    clearTimer: (id) => (timers = timers.filter((t) => t.id !== id)),
    visible: () => visible,
    on: (event, run) => {
      listeners[event].push(run);
      return () => (listeners[event] = listeners[event].filter((r) => r !== run));
    },
  };
  /** Move the clock on, firing each timer due on the way and letting its check settle. */
  const advance = async (ms: number) => {
    const end = time + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers = timers.filter((t) => t !== due);
      time = due.at;
      due.run();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    time = end;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    env,
    advance,
    settle,
    pending: () => timers.length,
    fire: (event: "activity" | "visibility") => listeners[event].forEach((run) => run()),
    setVisible: (v: boolean) => (visible = v),
  };
}

function setup(changes: () => boolean = () => false) {
  const browser = fakeBrowser();
  const log: string[] = [];
  let checks = 0;
  const stop = follow(
    {
      check: async () => {
        checks++;
        return changes();
      },
      onPause: () => log.push("paused"),
      onResume: () => log.push("resumed"),
    },
    browser.env,
  );
  return { browser, log, stop, checks: () => checks };
}

describe("following the plan folder (DIST-9.1)", () => {
  it("checks every 2s, then every 10s once nothing has changed and nobody has been active for 5 minutes", async () => {
    const { browser, checks } = setup();
    await browser.advance(10_000);
    expect(checks()).toBe(5);
    await browser.advance(5 * 60_000 - 10_000); // five quiet minutes
    const atFive = checks();
    await browser.advance(60_000);
    expect(checks() - atFive).toBe(6); // one a 10s
  });

  it("goes back to every 2s as soon as someone is active again", async () => {
    const { browser, checks } = setup();
    await browser.advance(6 * 60_000);
    browser.fire("activity");
    const before = checks();
    await browser.advance(10_000);
    expect(checks() - before).toBe(5);
  });

  it("keeps the fast pace while files keep changing, with nobody active", async () => {
    let n = 0;
    const { browser, checks } = setup(() => ++n % 10 === 0); // a change every tenth check
    await browser.advance(10 * 60_000);
    expect(checks()).toBeGreaterThan(250); // close to one a 2s for ten minutes, never slowed
  });

  it("runs no timer at all while the tab is hidden, and checks at once when it is shown", async () => {
    const { browser, checks } = setup();
    await browser.advance(4_000);
    browser.setVisible(false);
    browser.fire("visibility");
    expect(browser.pending()).toBe(0);
    await browser.advance(60 * 60_000);
    expect(checks()).toBe(2);
    browser.setVisible(true);
    browser.fire("visibility");
    await browser.settle();
    expect(checks()).toBe(3);
  });

  it("stops after 15 minutes without activity, says so, and resumes with a check the moment someone is back", async () => {
    const { browser, log, checks } = setup();
    await browser.advance(15 * 60_000 + 10_000);
    expect(log).toEqual(["paused"]);
    expect(browser.pending()).toBe(0); // nothing left running
    const atPause = checks();
    await browser.advance(60 * 60_000);
    expect(checks()).toBe(atPause);
    browser.fire("activity");
    await browser.settle();
    expect(log).toEqual(["paused", "resumed"]);
    expect(checks()).toBe(atPause + 1);
    await browser.advance(4_000);
    expect(checks()).toBe(atPause + 3); // fast again
  });

  it("does not pause someone who keeps using the page, however long", async () => {
    const { browser, log } = setup();
    for (let minute = 0; minute < 60; minute++) {
      await browser.advance(60_000);
      browser.fire("activity");
    }
    expect(log).toEqual([]);
  });

  it("stops for good when told to", async () => {
    const { browser, stop, checks } = setup();
    stop();
    expect(browser.pending()).toBe(0);
    browser.fire("activity");
    await browser.advance(60_000);
    expect(checks()).toBe(0);
  });
});
