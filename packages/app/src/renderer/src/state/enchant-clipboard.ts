/**
 * Enchantments copied off one piece, waiting to be pasted onto another.
 *
 * A player re-crafting a chestplate wants the same Protection and Unbreaking they always put on
 * one, without picking each again. Kept in the app rather than on the system clipboard: it is
 * only ever pasted back into this editor, and the item JSON on the system clipboard is a
 * different thing the Gear tab already copies.
 */

import { create } from "zustand";

type EnchantClipboard = {
  /** Enchantment id -> level, as on `Item.enchantments`. Undefined when nothing is copied. */
  copied: Record<string, number> | undefined;
  copy(enchantments: Record<string, number>): void;
  clear(): void;
};

export const useEnchantClipboard = create<EnchantClipboard>((set) => ({
  copied: undefined,
  copy: (enchantments) =>
    set({ copied: Object.keys(enchantments).length === 0 ? undefined : { ...enchantments } }),
  clear: () => set({ copied: undefined }),
}));
