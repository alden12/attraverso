/**
 * Images on a ticket, in the detail pane (MEDIA-2).
 *
 * This is the viewer's first *write*, and the whole reason it is worth doing here rather than through a tool:
 * a photo is on the device, not at a path anyone can type, and the bytes must never go through the model
 * (see `MEDIA-2`). Dropping a file on this panel sends it straight to the loopback server, which stores it
 * beside the plan and hands back its content address.
 *
 * **Read-only when there is no token.** Under `yarn viewer` the page is served by a second process, and
 * letting that write would be the two-writer failure that lost a ticket on 2026-07-30. No token, no drop
 * zone - and it says so rather than failing on drop.
 *
 * **Two different reasons the drop zone can be absent.** No write token means this *page* may not write (the
 * dev server case above). `uploadsDisabled` means no page can: cloud mode has nowhere durable to put bytes,
 * so the server refuses with 501 (`OPS-11`). Offering the control and letting it fail would be the worse
 * version of both, so the reason is shown in its place.
 *
 * **The list is the fetched plan's, not this component's.** An earlier version held it locally and appended on
 * success, on the reasoning that an upload changes exactly one thing and the server has already said what.
 * That is true and it was still wrong: the panel unmounts when the ticket is closed, so the upload vanished
 * until a full page reload. Local state that shadows fetched state is only ever right until something
 * remounts. So a write refetches the plan, which is what `VIEW-17` said to do and what also keeps the page
 * honest when Claude changes something in the same conversation.
 */
import { useEffect, useRef, useState } from "react";
import { Section } from "./Section";
import { canWrite as mayWrite, deleteAttachment, uploadAttachment, type Attachment } from "./store";

interface Props {
  projectKey: string;
  /** The ticket's ref. Attachments belong to a ticket, not to the pane, which is reused between them. */
  ref_: string;
  /** Straight from the fetched plan - this component never keeps its own copy. */
  images: Attachment[];
  /** Why this deployment cannot store uploads, or null when it can (OPS-11). */
  uploadsDisabled: string | null;
  /** Refetch the plan, so a write is reflected everywhere rather than only here. */
  reload: () => void;
  /** Collapse state, owned by the pane so it survives switching item (see `Section`). */
  open: boolean;
  onToggle: () => void;
}

const readable = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function Attachments({ projectKey, ref_, images, uploadsDisabled, reload, open, onToggle }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const canWrite = mayWrite();
  // Two independent reasons not to offer the control, and they say different things: no token means *this
  // page* may not write, while `uploadsDisabled` means *no page* can, because the server has nowhere to put
  // the bytes. Offering a drop zone that answers 501 would be a worse version of both.
  const canUpload = canWrite && uploadsDisabled === null;

  // A stale error from the previous ticket would read as a complaint about this one.
  useEffect(() => setError(null), [ref_]);

  /** Run a write, surface its message if it fails, and refetch either way. */
  async function write(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (problem) {
      // The server's message is already written for a person, so show it rather than a generic failure.
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
      reload();
    }
  }

  const accept = (files: FileList | null): Promise<void> =>
    files === null || files.length === 0
      ? Promise.resolve()
      : write(async () => {
          for (const file of Array.from(files)) await uploadAttachment(projectKey, ref_, file);
        });

  return (
    <Section title="Images" count={images.length} open={open} onToggle={onToggle}>
      {images.length > 0 && (
        <div className="attachments__grid">
          {images.map((image) => (
            <div key={image.hash} className="attachments__item">
              <a href={`/media/${image.hash}`} target="_blank" rel="noreferrer">
                {/* Lazy, because a plant photographed monthly is a long strip of megabytes nobody has scrolled to. */}
                <img className="attachments__thumb" src={`/media/${image.hash}`} alt={image.caption ?? "attachment"} loading="lazy" />
              </a>
              <span className="attachments__meta">{readable(image.bytes)}</span>
              {canWrite && (
                <button
                  className="attachments__remove"
                  title="Remove this image from the ticket"
                  disabled={busy}
                  onClick={() => void write(() => deleteAttachment(projectKey, image.hash))}
                >
                  x
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canUpload ? (
        <div
          className={`attachments__drop${over ? " attachments__drop--over" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            void accept(event.dataTransfer.files);
          }}
          onClick={() => picker.current?.click()}
        >
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              void accept(event.target.files);
              event.target.value = ""; // so the same file can be chosen twice in a row
            }}
          />
          {busy ? "Uploading..." : `Drop an image on ${ref_}, or click to choose`}
        </div>
      ) : uploadsDisabled !== null ? (
        // Shown even when there are images, unlike the read-only note: this one explains a control that used
        // to be here and is not, which is worth a line whether or not the ticket already has attachments.
        <p className="attachments__readonly">{uploadsDisabled}</p>
      ) : (
        images.length === 0 && <p className="attachments__readonly">Open the viewer with the open_viewer tool to add images.</p>
      )}

      {error !== null && <p className="attachments__error">{error}</p>}
    </Section>
  );
}
