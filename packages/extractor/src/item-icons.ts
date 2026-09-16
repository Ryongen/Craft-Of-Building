/**
 * Item textures for gear bases, resolved across every mod in the pack.
 *
 * A gear base names the Minecraft items it can roll as — `roe_weapons:bow_3`,
 * `cte_essentials:cloth_0_boots` — and those items belong to other mods. Getting a sprite for
 * one therefore means what the game does at model-bake time: read the item model, follow its
 * parent chain, and take a texture reference off whichever model in the chain declares one.
 *
 * ## Why the parent chain is not optional
 *
 * The two mods that supply almost all of CTE2's gear do it in the two different ways vanilla
 * allows, and only one of them is the easy case:
 *
 *     cte_essentials:cloth_0_boots
 *       { "parent": "item/generated", "textures": { "layer0": "cte_essentials:item/c_boots0" } }
 *
 *     roe_weapons:bow_3
 *       { "parent": "roe_weapons:custom/bow_3", "textures": { "2": "roe_weapons:block/bow_3" } }
 *
 * The second names no `layer0` at all — it is a block model wearing a texture under an
 * arbitrary key, in the `block/` folder despite being an item. Anything that only reads
 * `textures.layer0` finds a sprite for the armour and none of the 90 weapons.
 *
 * ## What is not resolved is reported
 *
 * Some items are vanilla (`minecraft:*`), whose textures live in the client jar rather than in
 * `mods/`, and some models point at atlases this cannot flatten. Those come back in
 * `unresolved` and the app renders the same placeholder the missing perk icons get. That is
 * the same rule the rest of extraction follows: report the gap, never invent the sprite.
 */

import { openArchive, type ResourceArchive } from "./zip.js";

/** How deep to follow `parent` before giving up. Vanilla chains are two or three long. */
const MAX_PARENT_DEPTH = 6;

/** Texture keys worth preferring, in order. */
const PREFERRED_KEYS = ["layer0", "0", "all", "texture"];

/**
 * Tried last, however early it appears.
 *
 * `particle` is a fallback sprite for break effects and is routinely a *vanilla* texture even
 * on a modded item — `roe_weapons:greatsword_0` declares
 * `{ "sword_0": "roe_weapons:block/sword_0", "particle": "minecraft:item/iron_sword" }`. Vanilla
 * textures are in the client jar, not under `mods/`, so preferring `particle` would trade a
 * resolvable sprite for an unresolvable one.
 */
const LAST_RESORT_KEYS = ["particle"];

export type ItemIconResult = {
  /** `"roe_weapons:bow_3"` -> path relative to the asset dir, e.g. `"items/roe_weapons/bow_3.png"`. */
  icons: Record<string, string>;
  /** Item ids no texture could be found for, sorted. */
  unresolved: string[];
  bytes: number;
};

/** Where an extracted item sprite is filed, relative to the asset directory. */
export function itemIconPath(itemId: string): string {
  const [namespace, path] = splitId(itemId);
  return `items/${namespace}/${path.replace(/\//g, "_")}.png`;
}

/**
 * Resolves each item id to a PNG, reading every jar at most once.
 *
 * @param jars every jar in `mods/`, plus any resource packs that override them — later
 *   archives win, matching resource-pack precedence.
 */
export function resolveItemIcons(
  jars: readonly string[],
  itemIds: readonly string[],
  write: (relativePath: string, bytes: Buffer) => void,
): ItemIconResult {
  const wanted = [...new Set(itemIds)].sort();
  if (wanted.length === 0) return { icons: {}, unresolved: [], bytes: 0 };

  // One pass over the archives, holding only what is asked for. A modpack's `mods/` is a few
  // hundred megabytes; keeping a whole jar's file table per archive is fine, keeping its
  // contents is not.
  const models = new Map<string, Record<string, unknown>>();
  const textures = new Map<string, Buffer>();

  for (const jar of jars) {
    let archive: ResourceArchive;
    try {
      archive = openArchive(jar);
    } catch {
      continue; // an unreadable jar is not this pass's problem to fail on
    }
    try {
      for (const name of archive.find("assets/", ".json")) {
        if (!name.includes("/models/")) continue;
        const key = modelKeyOf(name);
        if (key === undefined) continue;
        try {
          const parsed: unknown = JSON.parse(archive.read(name).toString("utf8"));
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            models.set(key, parsed as Record<string, unknown>);
          }
        } catch {
          // A model that does not parse is a mod's bug, not a reason to stop.
        }
      }
      for (const name of archive.find("assets/", ".png")) {
        const key = textureKeyOf(name);
        if (key !== undefined) textures.set(key, archive.read(name));
      }
    } finally {
      archive.close();
    }
  }

  const icons: Record<string, string> = {};
  const unresolved: string[] = [];
  let bytes = 0;

  for (const itemId of wanted) {
    // Every candidate the chain offers, in preference order, and the first that resolves to a
    // PNG actually present in `mods/` wins. Taking only the single best-named reference would
    // discard a working sprite whenever a model's tidiest key points outside the pack.
    let png: Buffer | undefined;
    for (const reference of textureCandidates(itemId, models)) {
      png = textures.get(normalise(reference));
      if (png !== undefined) break;
    }
    if (png === undefined) {
      unresolved.push(itemId);
      continue;
    }
    const relative = itemIconPath(itemId);
    write(relative, png);
    icons[itemId] = relative;
    bytes += png.length;
  }

  return { icons, unresolved, bytes };
}

/**
 * Every texture reference `item/<id>` and its parents offer, best-named first.
 *
 * Preference order within one model matters more than it looks: a model can declare several
 * textures, the one a player recognises is almost always `layer0`, and `particle` is usually
 * something else entirely.
 */
function textureCandidates(
  itemId: string,
  models: ReadonlyMap<string, Record<string, unknown>>,
): string[] {
  const [namespace, path] = splitId(itemId);
  let key = `${namespace}:item/${path}`;
  const seen = new Set<string>();
  const out: string[] = [];

  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(key)) break; // a cycle: some packs do this
    seen.add(key);

    const model = models.get(key);
    if (model === undefined) break;

    out.push(...pickTextures(model["textures"]));

    const parent = model["parent"];
    if (typeof parent !== "string" || parent.length === 0) break;
    key = normaliseModelRef(parent);
  }
  return out;
}

function pickTextures(node: unknown): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return [];
  const textures = node as Record<string, unknown>;

  // A `#name` value is a reference to another key in the same map, resolved only at bake time.
  // Skipping it lets the parent chain supply a real path instead.
  const usable = (key: string): string | undefined => {
    const value = textures[key];
    return typeof value === "string" && !value.startsWith("#") ? value : undefined;
  };

  const ordered = [
    ...PREFERRED_KEYS,
    ...Object.keys(textures)
      .filter((key) => !PREFERRED_KEYS.includes(key) && !LAST_RESORT_KEYS.includes(key))
      .sort(),
    ...LAST_RESORT_KEYS,
  ];

  const out: string[] = [];
  for (const key of ordered) {
    const value = usable(key);
    if (value !== undefined && !out.includes(value)) out.push(value);
  }
  return out;
}

/** `assets/<ns>/models/<path>.json` -> `<ns>:<path>`. */
function modelKeyOf(name: string): string | undefined {
  const match = /^assets\/([^/]+)\/models\/(.+)\.json$/.exec(name);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

/** `assets/<ns>/textures/<path>.png` -> `<ns>:<path>`. */
function textureKeyOf(name: string): string | undefined {
  const match = /^assets\/([^/]+)\/textures\/(.+)\.png$/.exec(name);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

function normalise(reference: string): string {
  return reference.includes(":") ? reference : `minecraft:${reference}`;
}

/** A parent reference may omit the namespace, in which case vanilla assumes `minecraft`. */
function normaliseModelRef(reference: string): string {
  return reference.includes(":") ? reference : `minecraft:${reference}`;
}

function splitId(itemId: string): [string, string] {
  const colon = itemId.indexOf(":");
  return colon === -1 ? ["minecraft", itemId] : [itemId.slice(0, colon), itemId.slice(colon + 1)];
}
