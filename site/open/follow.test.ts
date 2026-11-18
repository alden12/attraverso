/**
 * The folder page's schedule (`DIST-9.1`), on vitest's fake clock: 2s, then 10s when quiet, nothing while hidden,
 * and paused after long inactivity until someone comes back, which checks at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { follow, type Page } from "./follow";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const page: Page = { window: new EventTarget(), document: Object.assign(new EventTarget(), { visibilityState: "visible" }) };
  const check = vi.fn(async () => {});
  const paused: boolean[] = [];
  const stop = follow(check, (p) => paused.push(p), page);
  const fire = (name: string) => page.window.dispatchEvent(new Event(name));
  const show = async (visible: boolean) => {
    page.document.visibilityState = visible ? "visible" : "hidden";
    page.document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { check, paused, stop, fire, show, wait: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
}

describe("following the plan folder (DIST-9.1)", () => {
  it("checks every 2s, then every 10s once nobody has been active for 5 minutes", async () => {
    const { check, wait } = setup();
    await wait(10_000);
    expect(check).toHaveBeenCalledTimes(5);
    await wait(5 * 60_000);
    const atFive = check.mock.calls.length;
    await wait(60_000);
    expect(check.mock.calls.length - atFive).toBe(6);
  });

  it("checks at once and goes back to 2s when someone is active after a quiet spell", async () => {
    const { check, fire, wait } = setup();
    await wait(6 * 60_000);
    const before = check.mock.calls.length;
    fire("keydown");
    await wait(10_000);
    expect(check.mock.calls.length - before).toBe(6); // one straight away, then one a 2s
  });

  it("runs no timer while the tab is hidden, and checks at once when it is shown", async () => {
    const { check, show, wait } = setup();
    await wait(4_000);
    await show(false);
    expect(vi.getTimerCount()).toBe(0);
    await wait(60 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
    await show(true);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("pauses after 15 minutes without activity, and resumes with a check the moment someone is back", async () => {
    const { check, paused, fire, wait } = setup();
    await wait(15 * 60_000 + 10_000);
    expect(paused).toEqual([true]);
    expect(vi.getTimerCount()).toBe(0);
    const atPause = check.mock.calls.length;
    await wait(60 * 60_000);
    expect(check.mock.calls.length).toBe(atPause);
    fire("pointermove");
    await wait(0);
    expect(paused).toEqual([true, false]);
    expect(check.mock.calls.length).toBe(atPause + 1);
    await wait(4_000);
    expect(check.mock.calls.length).toBe(atPause + 3);
  });

  it("never pauses someone who keeps using the page", async () => {
    const { paused, fire, wait } = setup();
    for (let minute = 0; minute < 60; minute++) {
      await wait(60_000);
      fire("pointerdown");
    }
    expect(paused).toEqual([]);
  });

  it("stops for good when told to", async () => {
    const { check, stop, fire, wait } = setup();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    fire("keydown");
    await wait(60_000);
    expect(check).not.toHaveBeenCalled();
  });
});
