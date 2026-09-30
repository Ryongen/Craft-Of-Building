/**
 * A card that follows the pointer, portalled out of whatever is clipping it.
 *
 * Four surfaces grew their own copy of this — the item tooltip, the delta tip, the tree tooltip
 * and now the skill, gem and provenance cards — and every copy has the same two non-obvious
 * parts: the card is `position: fixed` and rendered into `document.body`, because the row it
 * belongs to is inside a scrolled panel that would clip it, and it flips towards the inside of
 * the window near an edge, because a tooltip half off the screen is one you have to move the
 * mouse to read.
 *
 * Deliberately knows nothing about what it is showing. The caller renders its own card; this
 * only decides whether one is up and where it goes.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useNarrow } from "./narrow.js";

export type At = { x: number; y: number };

/** Roughly how big the card is, for the edge flip. */
export type CardSize = { width: number; height: number };

/**
 * Where to put a floating card, given the pointer.
 *
 * The size is **assumed rather than measured**, the same bargain every copy of this made:
 * measuring means a second render on every mouse move, and being a few dozen pixels out only
 * ever matters within a card's width of an edge.
 */
export function floatingStyle(at: At, size: CardSize): CSSProperties {
  const flipX = at.x > window.innerWidth - size.width - 24;
  const flipY = at.y > window.innerHeight - size.height;
  return {
    left: flipX ? undefined : at.x + 16,
    right: flipX ? window.innerWidth - at.x + 16 : undefined,
    top: flipY ? undefined : at.y + 16,
    bottom: flipY ? window.innerHeight - at.y + 16 : undefined,
  };
}

/**
 * Hover handlers and the card they put up.
 *
 * `render` is called only while the pointer is over the row, so an expensive card — one that
 * runs the engine, or draws a canvas — costs nothing on the rows nobody hovers. Pass `undefined`
 * for a row with nothing to show and the handlers become inert.
 */
export function useHoverCard(render: ((at: At) => ReactNode) | undefined): {
  props: {
    onMouseEnter?: (event: React.MouseEvent) => void;
    onMouseMove?: (event: React.MouseEvent) => void;
    onMouseLeave?: () => void;
    onPointerDown?: (event: React.PointerEvent) => void;
  };
  /**
   * Take the card down without the pointer having left.
   *
   * `onMouseLeave` does not fire when the element carrying these handlers is *unmounted* under
   * the cursor — which is what a row does when it swaps itself for something else — and the card
   * then hangs around over a position the pointer left long ago.
   */
  clear: () => void;
  node: ReactNode;
} {
  const [at, setAt] = useState<At | null>(null);
  // A tap on a phone. The browser's emulated mouseenter opens the card as it would for a mouse;
  // this only changes where it goes (docked along the bottom, see `.touch-dock`) and that a
  // scroll takes it down, since no mouseleave ever comes from a finger that has lifted.
  // A mouse never sets it, and nor does anything on a desktop-sized window.
  const narrow = useNarrow();
  const [touch, setTouch] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const lastTouchRef = useRef(0);

  const track = useCallback((event: React.MouseEvent) => {
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  const clear = useCallback(() => {
    setAt(null);
    setTouch(false);
  }, []);
  const pointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "mouse" || !narrow) return;
      lastTouchRef.current = Date.now();
      setTouch(true);
    },
    [narrow],
  );

  // The end of a tap can send the emulated mouse back to wherever a real one is, and with it a
  // mouseleave that would close the card the tap just opened. Same guard as `TreeCanvas`.
  const leave = useCallback(() => {
    if (Date.now() - lastTouchRef.current < 800) return;
    clear();
  }, [clear]);

  const open = at !== null;
  useEffect(() => {
    if (!touch || !open) return;
    const onScroll = (event: Event): void => {
      // Reading a long card scrolls the dock itself, which must not close it.
      if (event.target instanceof Node && dockRef.current?.contains(event.target)) return;
      clear();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [touch, open, clear]);

  // `floatingStyle` guesses the card's size, and on a short window the guess loses: a card taller
  // than the room above the pointer flips up and runs off the top. So once it is on screen, measure
  // it and nudge it back inside. `translate` rather than top/bottom, because those belong to React
  // and it would not know to clear an override on the next move.
  const wrapRef = useRef<HTMLDivElement>(null);
  const docked = touch && narrow;
  useLayoutEffect(() => {
    const el = wrapRef.current?.firstElementChild;
    if (!(el instanceof HTMLElement)) return;
    el.style.translate = "";
    el.style.maxHeight = "";
    el.style.overflow = "";
    const margin = 8;
    const room = window.innerHeight - margin * 2;
    let rect = el.getBoundingClientRect();
    if (rect.height > room) {
      el.style.maxHeight = `${room}px`;
      el.style.overflow = "hidden";
      rect = el.getBoundingClientRect();
    }
    const dx =
      rect.left < margin
        ? margin - rect.left
        : rect.right > window.innerWidth - margin
          ? Math.max(margin - rect.left, window.innerWidth - margin - rect.right)
          : 0;
    const dy =
      rect.top < margin
        ? margin - rect.top
        : rect.bottom > window.innerHeight - margin
          ? Math.max(margin - rect.top, window.innerHeight - margin - rect.bottom)
          : 0;
    if (dx !== 0 || dy !== 0) el.style.translate = `${dx}px ${dy}px`;
  });

  if (render === undefined) return { props: {}, clear, node: null };

  const card = at === null ? null : render(at);
  return {
    props: { onMouseEnter: track, onMouseMove: track, onMouseLeave: leave, onPointerDown: pointerDown },
    clear,
    node:
      card === null
        ? null
        : createPortal(
            docked ? (
              <div className="touch-dock" ref={dockRef}>
                {card}
              </div>
            ) : (
              <div ref={wrapRef} style={{ display: "contents" }}>
                {card}
              </div>
            ),
            document.body,
          ),
  };
}
