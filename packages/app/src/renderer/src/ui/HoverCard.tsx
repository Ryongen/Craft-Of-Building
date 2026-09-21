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

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

  const track = useCallback((event: React.MouseEvent) => {
    setAt({ x: event.clientX, y: event.clientY });
  }, []);
  const clear = useCallback(() => setAt(null), []);

  if (render === undefined) return { props: {}, clear, node: null };

  return {
    props: { onMouseEnter: track, onMouseMove: track, onMouseLeave: clear },
    clear,
    node: at === null ? null : createPortal(render(at), document.body),
  };
}
