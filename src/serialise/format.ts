/**
 * How every store file is laid out as text (`IMP-19`). One definition, shared by the plan writer and the
 * measurement writer, because a file's layout is part of its identity: two writers with two opinions about
 * it produce a diff every time either one saves.
 *
 * **`lineWidth: 0`, so prose is stored exactly as it was written.** The `yaml` default folds long strings at
 * 80 columns into `>-` blocks, which meant the *serialiser* owned the line breaks in every body. That cost
 * twice over:
 *
 * - **A hand edit re-flowed at the next save.** Text edited outside the tools - a rename done by find and
 *   replace, a ticket added by hand - kept its own line breaks until the next write re-folded it, and one
 *   changed word could ripple through the rest of its paragraph. One project's first cloud round trip changed
 *   two lines of data and 1,740 lines of text, all of it re-wrapping (2026-09-23).
 * - **A written newline became a blank line.** A folded block reads a single newline as a space, so the
 *   emitter has to double every real newline to preserve it - which is `IMP-11`'s mid-sentence blank lines,
 *   and why every list in the committed file had a blank line between its items.
 *
 * Unfolded, a multi-line string is written as a literal `|-` block, where a newline is a newline: whatever
 * line breaks the text has, it keeps, on every save. The serialiser stops having an opinion about prose, and
 * that is what makes a file edited by hand and a file written by the tools converge rather than fight.
 *
 * **The cost, accepted:** a paragraph written without wraps is one long line in the file. GitHub highlights
 * the changed words within a line, so review is unharmed, and it is the price of never rewriting text that
 * did not change.
 */
import type { ToStringOptions } from "yaml";

export const YAML_FORMAT: ToStringOptions = { lineWidth: 0 };
