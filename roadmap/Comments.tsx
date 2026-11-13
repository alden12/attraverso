/**
 * An item's comments, at the end of the detail pane (`VIEW-5`): the running record of why it moved, which until
 * now could only be read through `list_comments`.
 *
 * **Newest first**, matching `list_comments`, since the latest remark is the one most likely to still be true.
 *
 * **Agent comments are counted and folded, never withheld.** `CLAUDE.md`: Claude's own working comments are kept
 * off the surface a person looks at by default, are not secret, and "the viewer gets a toggle to show them". So
 * the section says how many there are and one click shows them, marked as Claude's.
 *
 * Read-only: writing comments from the viewer is `VIEW-19`'s argument, not this one's.
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Section } from "./Section";
import type { ItemComment } from "./store";

interface Props {
  comments: ItemComment[];
  open: boolean;
  onToggle: () => void;
}

const when = (at: string): string => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function Comments({ comments, open, onToggle }: Props) {
  const [showAgent, setShowAgent] = useState(false);
  const agent = comments.filter((comment) => comment.audience === "agent").length;
  const shown = showAgent ? comments : comments.filter((comment) => comment.audience !== "agent");

  return (
    <Section title="Comments" count={comments.length} open={open} onToggle={onToggle}>
      {shown.length === 0 && agent === 0 && <p className="comments__empty">No comments on this item yet.</p>}
      <ul className="comments">
        {shown.map((comment) => (
          <li key={comment.id} className="comment" data-agent={comment.audience === "agent"}>
            <div className="comment__meta">
              <span>{comment.actor}</span>
              <span>{when(comment.at)}</span>
              {comment.audience === "agent" && <span className="comment__tag">Claude's note</span>}
            </div>
            <div className="comment__body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
            </div>
          </li>
        ))}
      </ul>
      {agent > 0 && (
        <button className="comments__toggle" onClick={() => setShowAgent((on) => !on)}>
          {showAgent ? `Hide Claude's ${agent === 1 ? "note" : `${agent} notes`}` : `Show Claude's ${agent === 1 ? "note" : `${agent} notes`}`}
        </button>
      )}
    </Section>
  );
}
