/**
 * A draggable horizontal divider between two stacked panes.
 *
 * The drill-down needs this rather than a taller fixed height. A stat like fire resist has eight
 * named contributions across six kinds of source plus a transfer, and the 45% of a 380px column
 * it used to get showed about four rows — so the panel that exists to explain a number could not
 * show the explanation without scrolling inside a box inside a scrolling sidebar. How much room
 * that deserves depends on the stat and on what the reader is doing, which is exactly the kind of
 * question to hand back to them.
 *
 * Height is held by the caller so it survives selecting a different stat; the handle only reports
 * the drag.
 */

import { useEffect, useRef, type ReactNode } from "react";

export function Splitter({
  height,
  onChange,
  min = 80,
  max = 900,
}: {
  /** Current height of the pane *below* the handle, in pixels. */
  height: number;
  onChange: (height: number) => void;
  min?: number;
  max?: number;
}): ReactNode {
  /**
   * Where the drag started, and how tall the pane was then.
   *
   * The movement is measured against this rather than against the window, because the pane's
   * bottom edge is not the window's: the status bar sits below it. Anchoring to the start of the
   * drag makes the handle track the pointer exactly whatever else is on screen.
   */
  const drag = useRef<{ y: number; height: number } | null>(null);
  const latest = useRef({ onChange, min, max });
  latest.current = { onChange, min, max };

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const start = drag.current;
      if (start === null) return;
      const { onChange: set, min: lo, max: hi } = latest.current;
      // Grows as the pointer moves up, because it is the lower of the two panes.
      const next = start.height + (start.y - event.clientY);
      set(Math.max(lo, Math.min(hi, next)));
    };
    const up = (): void => {
      drag.current = null;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
  }, []);

  return (
    <div
      className="splitter"
      onPointerDown={(event) => {
        drag.current = { y: event.clientY, height };
        // Without this the cursor flickers between resize and text as it crosses the panes, and
        // a fast drag selects whatever it passes over.
        document.body.classList.add("resizing");
        event.preventDefault();
      }}
      title="Drag to resize"
      role="separator"
      aria-orientation="horizontal"
    />
  );
}
