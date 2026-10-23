import { defineConfig, devices } from "@playwright/test";
import { delimiter } from "node:path";

/**
 * End-to-end tests for the viewer. Separate from vitest on purpose: vitest covers the pure logic in Node
 * (including the viewer's own, e.g. which project to render), this drives a real browser against the built
 * app. The two never collide because vitest's `include` only matches `*.test.ts` and these are `*.spec.ts`.
 *
 * The value here is not only regression cover. The viewer is a visual artefact, and a screenshot from a real
 * render is the only honest way to check that a graph of 74 nodes actually reads as a graph rather than
 * merely producing the right DOM node count.
 */

/**
 * Its own port, not `yarn viewer`'s 5176. The suite starts a server and refuses to reuse one, so running it
 * while a dev server is open used to fail outright with "port already in use" - and having a dev server open
 * is the normal state while working on the viewer. Reuse is not the fix: an unrelated server on the port
 * would be silently accepted and the whole suite would run against the wrong application (that happened, and
 * it looked like five real failures). A port nothing else claims is the fix. `strictPort` in the viewer's vite
 * config still applies to this one, so a genuine collision here fails loudly rather than drifting elsewhere.
 */
const PORT = 5188;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `yarn viewer --port ${PORT}`,
    // The fixture store, not whatever the dev server would discover: in the development workspace that is this
    // repo's own (private) plan, and in a checkout of the public repo it is nothing at all (DIST-3).
    //
    // `demo` last on purpose: the subtitle names only the last of a multi-file store's paths (VIEW-32), and the
    // suite asserts it names the file of the project on screen. This repo's plan passed by the same accident,
    // with `roadmap.apm.yaml` sorting after `cloud.apm.yaml`.
    env: { APM_STORE_PATH: ["e2e/fixture/other.apm.yaml", "e2e/fixture/demo.apm.yaml"].join(delimiter) },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
