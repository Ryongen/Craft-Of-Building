import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyBuild, type BuildDoc } from "./build-doc.js";
import { addStage } from "./stages.js";
import { buildIndexData, summarizeBuild, summaryFacets, type IndexData } from "./summarize.js";
import { makeSnapshot } from "./test-support.js";

/**
 * A talent tree with a class start, a stat node and a keystone in a row, and an ascendancy tree
 * with two ascendancies. Connectors are `o`, as in the real grids.
 */
const snapshot = makeSnapshot({
  mmorpg_talent_tree: {
    talents: { perks: "e,e,e,e,e\ne,warrior_start,o,crit_node,e\ne,e,e,o,e\ne,e,e,big_keystone,e" },
    ascendancy: { perks: "e,e,e\ne,blood_mage,e\ne,frost_lord,e" },
  },
  mmorpg_perk: {
    warrior_start: { type: "START", is_entry: true, one_kind: "start" },
    crit_node: { type: "STAT" },
    big_keystone: { type: "MAJOR" },
    blood_mage: { type: "ASC", is_entry: true, one_kind: "ascendancy" },
    frost_lord: { type: "ASC", is_entry: true, one_kind: "ascendancy" },
  },
  mmorpg_spell_school: {
    fire: { perks: { fireball_perk: { x: 0, y: 0 }, fire_passive: { x: 1, y: 0 } } },
    ice: { perks: { frostbolt_perk: { x: 0, y: 0 } } },
  },
});

const index: IndexData = buildIndexData(snapshot);

function build(): BuildDoc {
  return {
    ...emptyBuild(60),
    tree: {
      talents: [[1, 1], [1, 3], [3, 3]],
      ascendancy: [[2, 1]],
    },
    character: { level: 60, ascendancy: "blood_mage", schools: { fireball_perk: 3, frostbolt_perk: 0 } },
    skills: [
      { spellId: "protection", level: 1, supports: ["more_duration"] },
      { spellId: "fireball", level: 10, main: true, supports: [{ id: "added_fire" }, { id: "pierce", enabled: false }] },
      { spellId: "frostbolt", level: 5, enabled: false, supports: ["chill"] },
    ],
    auras: [{ id: "wrath" }, { id: "haste", enabled: false }],
    gear: [
      { base: "sword", rarity: "unique", itemLevel: 60, unique: "doomblade" },
      { base: "plate_chest", rarity: "rare", itemLevel: 60, runeword: "enigma" },
      { base: "sword", rarity: "rare", itemLevel: 60 },
    ],
    jewels: [{ rarity: "unique", itemLevel: 60, unique: { id: "watchers_eye", rollPercent: 50 } }],
    omen: { id: "omen_of_flames", itemLevel: 60, rarity: "rare" },
  };
}

test("the index keeps only the perks a summary reports, and where they are", () => {
  assert.deepEqual(index.trees.talents, { "1,1": "warrior_start", "3,3": "big_keystone" });
  assert.deepEqual(index.trees.ascendancy, { "1,1": "blood_mage", "2,1": "frost_lord" });
  assert.equal(index.perkRoles["crit_node"], undefined);
  assert.equal(index.schoolOfPerk["fire_passive"], "fire");
});

test("the ascendancy comes from the tree, not the field", () => {
  // The document claims Blood Mage; the allocation at (2,1) is Frost Lord, and that is what the
  // game uses.
  assert.equal(summarizeBuild(build(), index).ascendancy, "frost_lord");
});

test("a build with no ascendancy allocated falls back to the field", () => {
  const doc = { ...build(), tree: { talents: build().tree!.talents! } };
  assert.equal(summarizeBuild(doc, index).ascendancy, "blood_mage");
});

test("a summary reads what is enabled and worn, and nothing else", () => {
  const summary = summarizeBuild(build(), index);
  assert.equal(summary.start, "warrior_start");
  assert.deepEqual(summary.keystones, ["big_keystone"]);
  assert.deepEqual(summary.schools, ["fire"]);
  assert.deepEqual(summary.skills, ["protection", "fireball"]);
  assert.deepEqual(summary.supports, ["added_fire", "more_duration"]);
  assert.deepEqual(summary.augments, ["wrath"]);
  assert.deepEqual(summary.uniques, ["doomblade", "watchers_eye"]);
  assert.deepEqual(summary.runewords, ["enigma"]);
  assert.deepEqual(summary.bases, ["plate_chest", "sword"]);
  assert.equal(summary.omen, "omen_of_flames");
  assert.equal(summary.stageCount, 1);
});

test("the main skill is the marked one, then the first enabled, then the engine's word", () => {
  assert.equal(summarizeBuild(build(), index).mainSkill, "fireball");

  const unmarked = { ...build(), skills: build().skills!.map(({ main: _main, ...rest }) => rest) };
  assert.equal(summarizeBuild(unmarked, index).mainSkill, "protection");
  assert.equal(summarizeBuild(unmarked, index, { mainSkill: "fireball" }).mainSkill, "fireball");
});

test("stages are counted", () => {
  assert.equal(summarizeBuild(addStage(build(), "Levelling"), index).stageCount, 2);
});

test("facets list each thing a filter can match", () => {
  const facets = summaryFacets(summarizeBuild(build(), index));
  assert.ok(facets.some((f) => f.kind === "ascendancy" && f.value === "frost_lord"));
  assert.ok(facets.some((f) => f.kind === "unique" && f.value === "watchers_eye"));
  assert.ok(!facets.some((f) => f.kind === "support" && f.value === "pierce"));
  assert.equal(facets.filter((f) => f.kind === "skill").length, 2);
});

test("an empty build summarises to nothing in particular", () => {
  const summary = summarizeBuild(emptyBuild(1), index);
  assert.equal(summary.ascendancy, undefined);
  assert.deepEqual(summaryFacets(summary), []);
});
