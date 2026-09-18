/**
 * Which of `mmorpg_spells` a **player** can actually put on the bar.
 *
 * The registry is one flat list of 432 entries and only 266 of them are the player's. The rest
 * are three other things wearing the same display names, and a picker that offers all 432 is
 * offering the wrong one about a third of the time — silently, because the row that is wrong
 * and the row that is right are the same words:
 *
 *   - **116 retired entries**, which the pack author marked by renaming the `identifier` in
 *     place: `arrow_barrage.json` declares `"identifier": "arrow_barrage_deprecated"`, and the
 *     live spell moved to `0_4_hunter/arrow_barrage.json`. Both are "Arrow Barrage".
 *   - **30 mercenary skills**, which belong to the hired companion. Both are "Hunter's Focus".
 *   - **12 wizard spells**, which belong to the four hostile wizards. Both are "Meteor".
 *
 * None is inferable from a spell's own fields — a retired spell is a complete, well-formed
 * spell, and so are the other two — so each has its own rule below, and all three are read off
 * something the pack states rather than guessed from shape.
 *
 * ## A perk that teaches one is not a way to get one
 *
 * Ten of the twelve wizard spells have a `learn_witch_<x>` perk, and eleven of the mercenary
 * ones do too. That looks like player reachability and is not: every one of those perks is
 * jar-side (`data/mmorpg/mmorpg_perk/`) and appears in **no** `mmorpg_spell_school` grid and no
 * `mmorpg_talent_tree`. They are how the mod hands the spell to the entity that casts it, not a
 * node anybody can allocate. Checked against the 2.0.2 snapshot; if a pack ever put one in a
 * school, this is the assumption that would need revisiting.
 *
 * ## What "excluded" does and does not mean
 *
 * It means "do not offer this". It does not mean the engine refuses to evaluate one: a document
 * that already names an excluded spell is computed exactly as it asks, and the Skills tab says
 * what it has found and offers the swap. Rewriting somebody's build on load would be the worse
 * bug of the two, and a planner that silently disagreed with its own document would be worse
 * again.
 */

import type { Snapshot } from "@cte2/extractor";

import { CATEGORY, entry, ids } from "./queries.js";

/**
 * Why a spell is not on the player's roster.
 *
 * The two never overlap in this pack, and that is a fact about the mercenary registry rather
 * than a coincidence: a class's skill grid lists the spell it actually slots, so the seven
 * retired `merc_*_deprecated` entries are in no grid and come back `deprecated`. The precedence
 * below is for a pack that ever did list one — whose skill it is explains more than when it was
 * retired — and is otherwise unreachable.
 */
export type SpellExclusion = "mercenary" | "wizard" | "deprecated";

/** The suffix the pack author appends to an `identifier` to retire the file it lives in. */
const DEPRECATED_SUFFIX = "_deprecated";

/**
 * The prefixes the pack puts on a spell it has copied for somebody else to cast. Used to find a
 * twin, never to classify — whose spell it is comes off the registry that claims it.
 */
const SHADOW_PREFIXES = ["merc_", "witch_"] as const;

/** Cached per snapshot: three registry entries, but a picker asks once per keystroke. */
const MERC_CACHE = new WeakMap<Snapshot, Set<string>>();

/**
 * Every spell some `mmorpg_mercenary` class lists in its skill grid.
 *
 * `MercenaryClass.skills` is a `HashMap<String, PointData>` of **spell GUID to grid position** —
 * the companion's own skill tree, one entry per class — and that map is the game's own statement
 * of which spells a mercenary may slot. Three classes list ten each.
 *
 * Reading the registry rather than matching the id prefix matters in both directions. A pack
 * that renamed its companion spells would still be answered correctly; and the eight
 * `merc_`-prefixed spells in **no** class are not claimed by this. Seven of those are retired
 * and the eighth, `merc_wolf_basic`, is the summoned wolf's swing rather than a slottable skill.
 *
 * The union across classes rather than a per-class answer, because the question a player-facing
 * list asks is "is this mine or the companion's", and no surface in this planner models a
 * specific mercenary.
 */
export function mercenarySpellIds(snapshot: Snapshot): ReadonlySet<string> {
  const cached = MERC_CACHE.get(snapshot);
  if (cached) return cached;

  const found = new Set<string>();
  for (const id of ids(snapshot, CATEGORY.mercenary)) {
    const skills = entry(snapshot, CATEGORY.mercenary, id)?.data["skills"];
    if (skills === null || typeof skills !== "object" || Array.isArray(skills)) continue;
    for (const spellId of Object.keys(skills as Record<string, unknown>)) found.add(spellId);
  }
  MERC_CACHE.set(snapshot, found);
  return found;
}

export function isMercenarySpell(snapshot: Snapshot, spellId: string): boolean {
  return mercenarySpellIds(snapshot).has(spellId);
}

/** Cached per snapshot, for the same reason `MERC_CACHE` is. */
const WIZARD_CACHE = new WeakMap<Snapshot, Set<string>>();

/**
 * Every spell some `mmorpg_wizard` casts.
 *
 * `WizardType.spells` is a plain list of spell GUIDs and `WizardSpellCaster` picks from it on a
 * timer, so this is the same kind of statement `MercenaryClass.skills` is: the registry naming
 * what a non-player entity casts. Four wizards, three spells each, twelve distinct.
 *
 * Read off the registry rather than off the `witch_` prefix for the same reason the mercenary
 * rule is — and here it matters more, because the prefix alone would also claim the twelve
 * `witch_*_deprecated` entries, which no wizard casts.
 */
export function wizardSpellIds(snapshot: Snapshot): ReadonlySet<string> {
  const cached = WIZARD_CACHE.get(snapshot);
  if (cached) return cached;

  const found = new Set<string>();
  for (const id of ids(snapshot, CATEGORY.wizard)) {
    const spells = entry(snapshot, CATEGORY.wizard, id)?.data["spells"];
    if (!Array.isArray(spells)) continue;
    for (const spellId of spells) if (typeof spellId === "string") found.add(spellId);
  }
  WIZARD_CACHE.set(snapshot, found);
  return found;
}

export function isWizardSpell(snapshot: Snapshot, spellId: string): boolean {
  return wizardSpellIds(snapshot).has(spellId);
}

/**
 * A spell the pack has retired.
 *
 * The suffix is the pack's own mark, not a convention read into it: the id comes from the
 * `identifier` field inside each file, and 116 of them end this way while the file they sit in
 * does not. It is a statement, and it is the only one available — a retired spell is otherwise a
 * complete spell with a full component tree, and nothing about its data says it is dead.
 *
 * It is corroborated rather than taken on trust. Across the whole snapshot, **nothing**
 * references any of the 116: no perk carries their `learn_<id>` stat, no `summon_spells` list
 * names one, no proc, no unique, no runeword. They are reachable from exactly one place, which
 * is a picker that walks the registry — and that is the thing this exists to stop.
 */
export function isDeprecatedSpell(_snapshot: Snapshot, spellId: string): boolean {
  return spellId.endsWith(DEPRECATED_SUFFIX);
}

/** Why this spell is off the player's roster, or `undefined` when it is on it. */
export function spellExclusion(snapshot: Snapshot, spellId: string): SpellExclusion | undefined {
  if (isMercenarySpell(snapshot, spellId)) return "mercenary";
  if (isWizardSpell(snapshot, spellId)) return "wizard";
  if (isDeprecatedSpell(snapshot, spellId)) return "deprecated";
  return undefined;
}

/** Every spell a player may put on the bar, sorted. The list every picker should read. */
export function playerSpellIds(snapshot: Snapshot): string[] {
  return ids(snapshot, CATEGORY.spell)
    .filter((id) => spellExclusion(snapshot, id) === undefined)
    .sort();
}

/**
 * The live player spell an excluded one shadows, where there is one.
 *
 * The markers are affixes on the twin's id and this strips them until something on the roster
 * falls out — which is what makes a doubly-marked id resolvable at all:
 * `witch_meteor_deprecated` → `witch_meteor`, still the wizard's → `meteor`, which is yours. A
 * single pass would have handed back another spell the picker does not offer.
 *
 * `undefined` where nothing does: `merc_summon_wolf` and `merc_hunters_potion` have no player
 * equivalent, and `test_spell_deprecated` never had one. A guess would be worse than a blank —
 * the caller's next move is to offer this as a one-click swap, and a swap to the wrong skill is
 * the bug this whole module exists to prevent.
 */
export function playerSpellFor(snapshot: Snapshot, spellId: string): string | undefined {
  let candidate = spellId;

  // A suffix and at most one prefix, so two strips does it; the bound is belt and braces against
  // a pack that ever doubles one up.
  for (let step = 0; step < 4; step++) {
    const prefix = SHADOW_PREFIXES.find((p) => candidate.startsWith(p));
    if (candidate.endsWith(DEPRECATED_SUFFIX)) {
      candidate = candidate.slice(0, -DEPRECATED_SUFFIX.length);
    } else if (prefix !== undefined) {
      candidate = candidate.slice(prefix.length);
    } else {
      break;
    }

    if (candidate === spellId) break;
    if (entry(snapshot, CATEGORY.spell, candidate) === undefined) continue;
    if (spellExclusion(snapshot, candidate) === undefined) return candidate;
  }
  return undefined;
}
