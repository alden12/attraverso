/**
 * What a plan file is called (`IMP-20`), apart from `paths.ts` so code with no Node can share it: the library
 * (`DIST-6`) runs in a browser, and exports these so a program finds a plan by the same rule the server does.
 */

/** The plan file's name. */
export const STORE_FILE = "attraverso.yaml";

/** The suffix plan files had before `IMP-20`, still recognised wherever a plan is looked for. */
export const LEGACY_STORE_SUFFIX = ".apm.yaml";

/** Whether a file of this name is a plan file, under either naming. */
export const isStoreFile = (name: string): boolean => name === STORE_FILE || name.endsWith(LEGACY_STORE_SUFFIX);
