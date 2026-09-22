/**
 * Put something on the clipboard as JSON.
 *
 * Gear copies its own document shape, which is what `fixtures/` holds and what Import reads back.
 * A jewel or an Augment is not gear, and pasted bare it would be read as a broken item; so those
 * copy inside the same envelope the in-game exporter writes —
 * `{ "cob": "item", "kind": "jewel", "data": { … } }` — which `importPaste` recognises and
 * routes to the right list. Every kind of thing the planner holds moves between builds the same
 * way.
 *
 * It confirms in place rather than with a notification: at this size a button that does nothing
 * visible reads as a broken button.
 */

import { useEffect, useState, type ReactNode } from "react";

/** What `importPaste` routes on. Gear is copied bare and never needs one. */
export type CopyKind = "jewel" | "aura";

/** The exporter's envelope, so the paste box reads a copied jewel or Augment as what it is. */
export function copyEnvelope(kind: CopyKind, name: string, data: unknown): unknown {
  return { cob: "item", kind, name, data };
}

export function CopyJsonButton({
  value,
  title,
  compact = false,
}: {
  value: unknown;
  title: string;
  /** A glyph the size of the row's ✕, for collapsed rows where "⧉ JSON" would not fit. */
  compact?: boolean;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(JSON.stringify(value, null, 2)).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {compact ? (copied ? "✓" : "⧉") : copied ? "copied" : "⧉ JSON"}
    </button>
  );
}
