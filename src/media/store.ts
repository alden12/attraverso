/**
 * The blob store behind an attachment (MEDIA-1): bytes in, hash out.
 *
 * This is the seam the cloud move turns on. Locally the bytes are files under `.apm/media/` beside the plan;
 * at `OPS-11` the same interface is an object store, and nothing in `domain/` or the tool layer knows which -
 * the same shape, and the same justification, as the `SearchIndex` seam.
 *
 * **Content-addressed, and that is load-bearing rather than tidy.** A blob is named by the hash of its own
 * bytes, so: the same photo stored twice is one file; a blob is immutable and therefore safe to cache
 * forever; moving or renaming can never break a reference; and the local directory and a future bucket agree
 * on a name for free, which makes migration a copy rather than a rewrite.
 *
 * **What deliberately does not live here.** Any notion of a ticket, a project or a user: this stores bytes.
 * Authorisation over *reading* a blob is the caller's problem, and it is a real one once the store is shared -
 * a content-addressed name is guessable, so remote serving needs signed URLs or an authenticated route
 * (`MEDIA-2`). Locally the host is loopback-only and the question does not arise.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What may be uploaded. Deliberately a short list of things every browser can render: an image nobody can
 *  display is worse than a rejected upload, and HEIC from an iPhone is exactly that case. */
export const ACCEPTED: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** A cap, so one upload cannot fill a disk. Generous for a phone photo, and small enough that the whole file
 *  is comfortably held in memory while it is hashed. */
export const MAX_BYTES = 12 * 1024 * 1024;

export interface Stored {
  hash: string;
  bytes: number;
}

export interface MediaStore {
  /** Store bytes and return their content address. Storing the same bytes twice is a no-op that returns the
   *  same hash, which is what makes an accidental re-upload free rather than a duplicate. */
  put(data: Uint8Array, mime: string): Promise<Stored>;
  /** The bytes for a hash, or null if this store does not hold them. */
  read(hash: string, mime: string): Promise<Uint8Array | null>;
  /** Why this store cannot hold anything, if it cannot. Set means "refuse uploads and say this"; a caller
   *  checks it *before* reading a request body, so a refusal costs no upload. Absent on a working store. */
  readonly unavailable?: string;
}

export const hashOf = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * Reject anything we would not be able to show, before it reaches storage. Returns the reason rather than
 * throwing, because both callers (the upload endpoint and the domain) want to phrase it themselves.
 */
export function unacceptable(mime: string, bytes: number): string | null {
  if (!(mime in ACCEPTED)) return `unsupported image type "${mime}" - accepted: ${Object.keys(ACCEPTED).join(", ")}`;
  if (bytes > MAX_BYTES) return `image is ${(bytes / 1024 / 1024).toFixed(1)}MB, over the ${MAX_BYTES / 1024 / 1024}MB limit`;
  if (bytes === 0) return "that file is empty";
  return null;
}

/**
 * Blobs as files in one flat directory, named `<hash><ext>`.
 *
 * The extension is derived from the mime rather than stored, so the name is a pure function of the content
 * and the type - which keeps `read` deterministic without a second lookup, and keeps the folder browsable by
 * a human, which matters when the whole point is that it sits next to a file they already open by hand.
 */
export function createFileMediaStore(dir: string): MediaStore {
  const nameFor = (hash: string, mime: string): string => `${hash}${ACCEPTED[mime] ?? ""}`;

  return {
    async put(data, mime) {
      const hash = hashOf(data);
      await mkdir(dir, { recursive: true });
      const path = join(dir, nameFor(hash, mime));
      // Written unconditionally rather than checked first: identical bytes produce identical content, so a
      // rewrite is harmless, and one syscall beats a stat plus a conditional write.
      await writeFile(path, data);
      return { hash, bytes: data.byteLength };
    },

    async read(hash, mime) {
      try {
        return await readFile(join(dir, nameFor(hash, mime)));
      } catch {
        // Fall back to any extension: a blob written under one mime and recorded under another (a corrected
        // row, a hand-moved file) should still be findable rather than silently missing.
        try {
          const match = (await readdir(dir)).find((name) => name.startsWith(hash));
          return match === undefined ? null : await readFile(join(dir, match));
        } catch {
          return null;
        }
      }
    },
  };
}

/** Where blobs live for a given plan file: `.apm/media/` beside it, per the split-by-volatility rule that
 *  already puts the journal and the event log there (`IMP-7`). */
export const mediaDirFor = (storePath: string): string => join(storePath, "..", ".apm", "media");

/**
 * A store that holds nothing and says so (`OPS-11`).
 *
 * Used in cloud mode, where blobs would otherwise go to the machine's own filesystem - which on a hosted
 * machine is ephemeral, so an upload would appear to work and then vanish on the next deploy. That is the worst shape a
 * bug can take here: it looks fine until the moment the file is wanted. Object storage is the eventual answer
 * and is deliberately not half-built in the meantime, so uploads are refused outright instead.
 *
 * `read` returns null rather than throwing, because it is the same answer a working store gives for a hash it
 * does not hold, and an attachment row that predates this mode should render as a missing image rather than
 * take the page down. Only `put` is an error, and callers are expected to check `unavailable` first.
 */
export function createUnavailableMediaStore(reason: string): MediaStore {
  return {
    unavailable: reason,
    async put() {
      throw new Error(reason);
    },
    async read() {
      return null;
    },
  };
}
