/**
 * The last ten builds opened or saved, one click each.
 *
 * The whole path already existed and was reachable from nothing: main remembered a build on
 * every open and save, `liveRecentBuilds` pruned the ones deleted on disk, `openBuildAt`
 * reopened one without a dialog, and the renderer never called any of it. So this is a menu
 * over machinery that was already there rather than a new feature.
 *
 * The list is fetched when the menu opens rather than held in state: it changes in main (a save
 * writes to it) and a stale copy would offer a file that has since been deleted.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { RecentBuild } from "@shared/ipc";

export function RecentBuilds({
  onOpen,
}: {
  onOpen: (path: string) => void | Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<RecentBuild[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was) void window.cte2.recentBuilds().then(setEntries);
      return !was;
    });
  }, []);

  // Dismiss on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={box}>
      <button onClick={toggle} title="Builds you have opened or saved" aria-expanded={open}>
        Recent ▾
      </button>

      {open && (
        <div className="menu">
          {entries === null ? (
            <div className="menu-empty">Reading…</div>
          ) : entries.length === 0 ? (
            <div className="menu-empty">
              Nothing yet. A build joins this list when you open or save it.
            </div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                className="menu-item"
                title={entry.path}
                onClick={() => {
                  setOpen(false);
                  void onOpen(entry.path);
                }}
              >
                <span className="ellipsis">{entry.name}</span>
                <span className="faint ellipsis text-xs">
                  {entry.path}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
