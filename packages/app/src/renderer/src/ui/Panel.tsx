/**
 * A card that folds, and remembers whether you folded it.
 *
 * The Damage tab was fourteen cards in one column and the Defence tab four, every one of them
 * always open, so reading the Sustain table meant scrolling past the rate card and reading the
 * layer trace meant scrolling past everything. Neither tab used its width at all. These two
 * things are the same problem — a screen with no way to put anything away has to show all of it
 * at once, and then has nowhere to put it.
 *
 * So a card states whether it is worth opening before you open it. `summary` is the one line
 * that goes on the head beside the title: the Sustain card says "every pool keeps up" and the
 * Overlap card says "nothing outlives the cast", and for most builds most of the time that is
 * the whole answer and the table underneath is the working. A card whose summary is a warning
 * opens itself.
 *
 * ## Why the open/closed state is keyed and persisted
 *
 * A card you closed has to stay closed when you change tab and come back, or folding anything is
 * pointless — the state belongs to the reader, not to the render. It is per `id`, in
 * `localStorage`, because it is a preference about the app rather than anything about the build:
 * putting it in the document would make "I collapsed the summon table" a change to save.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

/** Where the fold state lives. One key for every card, so a rename is a reset and nothing worse. */
const STORE_KEY = "cte2.panels.open";

function readStore(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as Record<string, boolean>;
  } catch {
    // A blocked or corrupt store is not a reason to render nothing; every card just opens to
    // its default, which is the behaviour these had before they could fold at all.
    return {};
  }
}

function writeStore(next: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Nothing to do and nothing worth saying: the fold still works for this session.
  }
}

/**
 * Whether a card is open, persisted under `id`.
 *
 * Exported because the two panels want to drive every card at once — "collapse all" is what makes
 * a fourteen-card tab navigable on the first visit — and that needs a writer that goes through
 * the same store rather than around it.
 */
export function usePanelOpen(id: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => readStore()[id] ?? defaultOpen);

  // Another card writing the store does not notify this one, and neither does `setAllPanels`, so
  // the event is what keeps fourteen independent `useState`s in step with one write.
  useEffect(() => {
    const onChange = (): void => setOpen(readStore()[id] ?? defaultOpen);
    window.addEventListener(PANELS_CHANGED, onChange);
    return () => window.removeEventListener(PANELS_CHANGED, onChange);
  }, [id, defaultOpen]);

  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      writeStore({ ...readStore(), [id]: next });
    },
    [id],
  );

  return [open, set];
}

const PANELS_CHANGED = "cte2:panels-changed";

/** Opens or closes every card whose id is given, in one write. */
export function setAllPanels(ids: readonly string[], open: boolean): void {
  const next = readStore();
  for (const id of ids) next[id] = open;
  writeStore(next);
  window.dispatchEvent(new Event(PANELS_CHANGED));
}

export function Panel({
  id,
  title,
  summary,
  tone,
  defaultOpen = true,
  children,
}: {
  /** Stable across renames of the title — it is the localStorage key. */
  id: string;
  title: string;
  /**
   * The answer, on the head, for the reader who does not need the working.
   *
   * A `ReactNode` rather than a string because most of these are already badges.
   */
  summary?: ReactNode;
  /** A card whose summary is a warning opens regardless of what the reader last chose. */
  tone?: "warn" | undefined;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = usePanelOpen(id, defaultOpen);
  // A build that has just become unsustainable must not hide that because the card was folded
  // three sessions ago. The reader can still close it; it reopens if the warning comes back.
  const shown = open || tone === "warn";

  return (
    <div className={`panel-card${shown ? " open" : ""}${tone === "warn" ? " warn" : ""}`}>
      <div className="panel-card-head" onClick={() => setOpen(!shown)}>
        <span className="caret">{shown ? "▾" : "▸"}</span>
        <span className="card-title">{title}</span>
        {summary !== undefined && <span className="panel-card-summary">{summary}</span>}
      </div>
      {shown && <div className="panel-card-body">{children}</div>}
    </div>
  );
}
