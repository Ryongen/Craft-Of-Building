/**
 * Whose spell is it, and is it still alive.
 *
 * Both rules are read off something the pack states — the mercenary registry's skill grid, and
 * the `_deprecated` suffix the pack author writes into an `identifier` — so what these pin is
 * that neither is read off a spell's *shape*, and that the twin resolution never hands back
 * another spell the picker does not offer.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Snapshot } from "@cte2/extractor";

import {
  isDeprecatedSpell,
  isMercenarySpell,
  isWizardSpell,
  mercenarySpellIds,
  playerSpellFor,
  playerSpellIds,
  spellExclusion,
  wizardSpellIds,
} from "./spell-roster.js";

function spell(id: string): Record<string, unknown> {
  return { identifier: id, loc_name: id, config: {} };
}

const SNAPSHOT = {
  snapshotVersion: 1,
  registries: {
    mmorpg_spells: Object.fromEntries(
      [
        "protection",
        "merc_protection",
        "hunters_focus",
        "merc_hunters_focus",
        "fireball",
        "merc_fireball",
        "merc_fireball_deprecated",
        "arrow_barrage",
        "arrow_barrage_deprecated",
        "merc_summon_wolf",
        "test_spell_deprecated",
        "merc_wolf_basic",
        "meteor",
        "witch_meteor",
        "witch_meteor_deprecated",
      ].map((id) => [id, { id, origin: "test", source: { kind: "pack" }, data: spell(id) }]),
    ),
    mmorpg_wizard: {
      fire_wizard: {
        id: "fire_wizard",
        origin: "test",
        source: { kind: "jar" },
        data: { id: "fire_wizard", spells: ["witch_meteor"] },
      },
    },
    mmorpg_mercenary: {
      fighter: {
        id: "fighter",
        origin: "test",
        source: { kind: "jar" },
        data: { id: "fighter", skills: { merc_protection: { x: 0, y: 0 } } },
      },
      hunter: {
        id: "hunter",
        origin: "test",
        source: { kind: "jar" },
        data: {
          id: "hunter",
          skills: { merc_hunters_focus: { x: 0, y: 0 }, merc_summon_wolf: { x: 1, y: 0 } },
        },
      },
      elementalist: {
        id: "elementalist",
        origin: "test",
        source: { kind: "jar" },
        data: { id: "elementalist", skills: { merc_fireball: { x: 0, y: 0 } } },
      },
    },
  },
  registryLists: {},
  lang: {},
} as unknown as Snapshot;

test("a mercenary spell is one some class's skill grid lists, not one whose id starts merc_", () => {
  assert.equal(isMercenarySpell(SNAPSHOT, "merc_protection"), true);
  assert.equal(isMercenarySpell(SNAPSHOT, "protection"), false);
  // In no class's grid: the summoned wolf's swing, which is a summon spell rather than a skill
  // anything can slot. The prefix is there and the answer is still no.
  assert.equal(isMercenarySpell(SNAPSHOT, "merc_wolf_basic"), false);
});

test("the skill grids are unioned across classes", () => {
  assert.deepEqual(
    [...mercenarySpellIds(SNAPSHOT)].sort(),
    ["merc_fireball", "merc_hunters_focus", "merc_protection", "merc_summon_wolf"],
  );
});

test("a retired spell is marked by the suffix the pack writes into its identifier", () => {
  assert.equal(isDeprecatedSpell(SNAPSHOT, "arrow_barrage_deprecated"), true);
  assert.equal(isDeprecatedSpell(SNAPSHOT, "arrow_barrage"), false);
});

test("a retired mercenary spell reads as retired, because no grid lists it", () => {
  // The grid names `merc_fireball`, the one the companion actually slots. Its retired twin is in
  // no grid at all, so the mercenary rule does not claim it and the suffix is what answers.
  assert.equal(spellExclusion(SNAPSHOT, "merc_fireball_deprecated"), "deprecated");
  assert.equal(spellExclusion(SNAPSHOT, "merc_fireball"), "mercenary");
  assert.equal(spellExclusion(SNAPSHOT, "arrow_barrage_deprecated"), "deprecated");
  assert.equal(spellExclusion(SNAPSHOT, "protection"), undefined);
});

test("a wizard spell is one some `mmorpg_wizard` casts, not one whose id starts witch_", () => {
  assert.equal(isWizardSpell(SNAPSHOT, "witch_meteor"), true);
  assert.equal(spellExclusion(SNAPSHOT, "witch_meteor"), "wizard");
  // The prefix is there and no wizard casts it, so the suffix is what answers.
  assert.equal(spellExclusion(SNAPSHOT, "witch_meteor_deprecated"), "deprecated");
  assert.deepEqual([...wizardSpellIds(SNAPSHOT)], ["witch_meteor"]);
});

test("the roster is everything no rule excludes", () => {
  assert.deepEqual(playerSpellIds(SNAPSHOT), [
    "arrow_barrage",
    "fireball",
    "hunters_focus",
    "merc_wolf_basic",
    "meteor",
    "protection",
  ]);
});

test("the twin is the player's spell, however many markers stand between", () => {
  assert.equal(playerSpellFor(SNAPSHOT, "merc_hunters_focus"), "hunters_focus");
  assert.equal(playerSpellFor(SNAPSHOT, "arrow_barrage_deprecated"), "arrow_barrage");
  assert.equal(playerSpellFor(SNAPSHOT, "witch_meteor"), "meteor");
  // Two markers: stripping one leaves `merc_fireball`, which is still the companion's.
  assert.equal(playerSpellFor(SNAPSHOT, "merc_fireball_deprecated"), "fireball");
  // And the other way round: `witch_meteor` is still the wizard's.
  assert.equal(playerSpellFor(SNAPSHOT, "witch_meteor_deprecated"), "meteor");
});

test("no twin is a blank, never a guess", () => {
  // The companion's wolf has no player equivalent at all.
  assert.equal(playerSpellFor(SNAPSHOT, "merc_summon_wolf"), undefined);
  // `test_spell` was never registered.
  assert.equal(playerSpellFor(SNAPSHOT, "test_spell_deprecated"), undefined);
  // A spell already on the roster is not shadowing anything.
  assert.equal(playerSpellFor(SNAPSHOT, "protection"), undefined);
});
