/**
 * Where a modifier on a drill-down row actually came from, in *this* document.
 *
 * ## The problem this solves
 *
 * A stat breakdown bottoms out in rows like `Attack Damage +3.00%`, three of them in a row under
 * `Talents (4)`. Those are three different nodes — the pack repeats a perk id at many positions
 * in the grid, which is exactly why `collectPerks` allocates by `[row, col]` and not by id — and
 * the rows were indistinguishable. "Sword +42 Armor" has the same problem with two swords.
 *
 * ## Why the path is the answer and the id is not
 *
 * Every `StatContext` carries a **document path** as well as a registry id, built by the
 * collector that made it and shaped like the validator's diagnostic paths: `gear[3]`,
 * `jewels[1].affixes[0]`, `tree.talents[47]`, `skills[0].supports[2]`. The index in it is the
 * position in the open build, so it identifies the individual thing rather than its kind. That
 * is the whole mechanism here: parse the index, read the document, hand back something a card
 * can be drawn from.
 *
 * ## What has no answer
 *
 * Five context kinds are properties of the character rather than of anything you could point at —
 * `BASE_STAT`, `NEWBIE_RESISTS`, `STAT_POINTS`, `VANILLA_STAT_COMPAT`, `MISC`. Those return
 * `undefined`, and the row stays a plain row: an empty card would be a worse answer than no
 * card, because it reads as a lookup that failed.
 *
 * `STAT_CTX_MODIFIER_BONUS` used to be the sixth and no longer is: the engine records which
 * context granted the `aura_effect` (or `jewel_effect`, or `more_food_stats`) line behind each
 * share, so the row points at that — the rune, the corruption, the perk.
 *
 * ## The buff case, which is not a document position at all
 *
 * A `POTION_EFFECT` row is Frenzy Charge, Fighter Stance, Eighth Gate, Brutalizer — the buffs
 * that carry most of a finished build's MORE multipliers. None of them is a thing you own: the
 * gamechanger or the skill that applies one is, and the effect itself is only an id and a roll.
 * That is why they were the largest group of dead rows on the damage trace, and why they resolve
 * against the *registry* rather than the document. `config.effects.<id>` and
 * `exileEffects.<id>` are both that id, so the path is only consulted for which side it landed
 * on, and the roll comes from the `EffectState` the engine already resolved.
 */

import type { BuildDoc, TreeCoord, TreeKey } from "@cte2/schema";
import { supportLinks } from "@cte2/schema";

import type { ModContribution } from "../state/derived.js";

/** A thing in the open document that a hover card can be built from. */
export type Provenance =
  | { kind: "item"; index: number }
  | { kind: "jewel"; index: number }
  /** A tree node, identified by its cell rather than by its perk id. See the header. */
  | { kind: "perk"; tree: TreeKey; coord: TreeCoord; perkId: string }
  /**
   * A support gem or an Augment. `rollPercent` is `undefined` where the document records none,
   * which is not the same as 0% — the card floors it into the rarity's band, exactly as
   * `gemRoll` does for the number the sheet was actually computed with.
   */
  | { kind: "gem"; id: string; rollPercent: number | undefined; rarity: string | undefined }
  | { kind: "aura"; id: string; rollPercent: number | undefined; rarity: string | undefined }
  | { kind: "spell"; id: string; skillIndex: number }
  /** An exile effect — a buff on you or a debuff you put on the mob. See the header. */
  | { kind: "effect"; id: string };

/**
 * The thing behind one modifier row, or `undefined` where there is nothing to point at.
 *
 * Resolved against the document rather than against the snapshot: the question is "which of my
 * things is this", and the answer stops being true the moment the build changes — which is
 * correct, because so does the row.
 */
export function provenanceOf(doc: BuildDoc, mod: ModContribution): Provenance | undefined {
  switch (mod.ctxType) {
    case "GEAR": {
      const index = indexIn(mod.path, "gear");
      return index === undefined || doc.gear?.[index] === undefined
        ? undefined
        : { kind: "item", index };
    }
    case "JEWEL": {
      const index = indexIn(mod.path, "jewels");
      return index === undefined || doc.jewels?.[index] === undefined
        ? undefined
        : { kind: "jewel", index };
    }
    case "TALENT":
      return perkAt(doc, "talents", mod);
    case "ASCENDANCY":
      return perkAt(doc, "ascendancy", mod);
    case "ATLAS":
      return perkAt(doc, "atlas", mod);
    case "SUPPORT_GEM": {
      /*
        `skills[0].supports[2]`, read back through `supportLinks`.

        The link carries its own roll and the card has to be priced at it: a gem shown at 0%
        beside a socket holding a 96% mythic is a different gem. Reading `doc.skills[i].supports`
        raw got this wrong three ways at once — a bare string entry has no `rollPercent` at all,
        one recorded as `undefined` inherits the Skill's `gemPercent`, and neither falls to the
        rarity band the collector floors to. `supportLinks` is the same normalisation
        `collectSupportGems` reads, so the card and the sheet cannot disagree about which number
        the gem rolled at.
      */
      const skillIndex = indexIn(mod.path, "skills");
      const slot = indexIn(mod.path, "supports");
      const skill = skillIndex === undefined ? undefined : doc.skills?.[skillIndex];
      const link = skill === undefined || slot === undefined ? undefined : supportLinks(skill)[slot];
      return { kind: "gem", id: mod.source, rollPercent: link?.rollPercent, rarity: link?.rarity };
    }
    case "AURA": {
      const index = indexIn(mod.path, "auras");
      const aura = index === undefined ? undefined : doc.auras?.[index];
      return { kind: "aura", id: mod.source, rollPercent: aura?.rollPercent, rarity: aura?.rarity };
    }
    /*
      Both spellings of the path, because they mean the same effect and differ only in where the
      build's answer about it came from — `exileEffects.<id>` is a capture's reading,
      `config.effects.<id>` is the planner's. The card is the same either way.
    */
    case "POTION_EFFECT":
      return { kind: "effect", id: mod.source };
    case "INNATE_SPELL": {
      const skillIndex = indexIn(mod.path, "skills");
      return skillIndex === undefined || doc.skills?.[skillIndex] === undefined
        ? undefined
        : { kind: "spell", id: mod.source, skillIndex };
    }
    /*
      A share resolves to whatever granted the stat that took it.

      `STAT_CTX_MODIFIER_BONUS` has no position of its own — the game appends it after the fact
      — but the `aura_effect` line behind each row does, and the engine now records it: a row
      worth 6.69% of an Augment is a row about the Yun rune in your spear, and hovering it
      should show that spear rather than nothing. The recursion is one level deep by
      construction, since the grantor is an ordinary gear, jewel or perk context.
    */
    case "STAT_CTX_MODIFIER_BONUS": {
      const by = mod.from?.kind === "share" ? mod.from.by : undefined;
      if (by === undefined) return undefined;
      const { from: _share, ...rest } = mod;
      const ctxType = by.ctxType as ModContribution["ctxType"];
      return provenanceOf(doc, { ...rest, ctxType, source: by.source, path: by.path });
    }
    default:
      // Every remaining kind is the character itself — base stats, the level's resist grant,
      // allocated points, vanilla attribute compat, misc. There is no "where".
      return undefined;
  }
}

/**
 * The perk cell an allocation index names.
 *
 * `tree.talents[47]` indexes `doc.tree.talents`, which is a list of `[row, col]` pairs — see
 * `collectPerks`, which walks that same list in that same order. The coordinate is what makes
 * this worth doing: it is the one fact that tells two allocations of the same perk apart.
 */
function perkAt(doc: BuildDoc, tree: TreeKey, mod: ModContribution): Provenance | undefined {
  const index = indexIn(mod.path, `tree.${tree}`);
  if (index === undefined) return undefined;
  const coord = doc.tree?.[tree]?.[index];
  if (coord === undefined) return undefined;
  // `collectPerks` puts the perk id in `source`, so the grid does not have to be asked twice.
  return { kind: "perk", tree, coord, perkId: mod.source };
}

/**
 * The index a document path gives for one segment.
 *
 * Matched on the segment name rather than by splitting, because a path can nest — an affix roll
 * is `jewels[1].affixes[0]` and asking it for `jewels` has to get 1 and not 0.
 */
function indexIn(path: string, segment: string): number | undefined {
  const escaped = segment.replace(/[.[\]]/g, "\\$&");
  const match = new RegExp(`(?:^|\\.)${escaped}\\[(\\d+)\\]`).exec(path);
  if (match === null) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}
