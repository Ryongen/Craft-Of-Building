/**
 * The outer reader: what arrives when a player presses Ctrl+Shift+C in game.
 *
 * The payloads below are the envelope `ItemCopy.envelope` writes, field for field. That is the
 * point of testing at this level — the mod and the planner agree on a shape, and nothing else
 * checks that they still do. Each case pins one of the five kinds, and the two failure modes that
 * matter: an id this snapshot does not have, and something that is not an envelope at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { importPaste } from "./import-paste.js";
import { affixEntry, includesAny, makeSnapshot, RARITIES } from "./test-support.js";

function snapshot() {
  return makeSnapshot({
    mmorpg_gear_rarity: RARITIES,
    mmorpg_stat: { dexterity: { id: "dexterity", ser: "core_stat" } },
    mmorpg_affixes: {
      jewel_dex: affixEntry("jewel_dex", "jewel", [includesAny(["any_jewel"])], {
        stats: [{ type: "FLAT", stat: "dexterity", min: 5, max: 16 }],
      }),
    },
    mmorpg_omen: { omen_of_flames: { id: "omen_of_flames" } },
    mmorpg_spells: { fireball: { identifier: "fireball" } },
    mmorpg_support_gem: { added_fire: { id: "added_fire" } },
    mmorpg_aura: { wrath: { id: "wrath" } },
  });
}

function envelope(kind: string, data: Record<string, unknown>): string {
  return JSON.stringify({ cob: "item", exporter: "0.4.0", kind, name: "Test Item", data });
}

test("an item copied by an exporter from before the rename still reads", () => {
  const old = JSON.stringify({
    cte2pob: "item",
    exporter: "0.4.0",
    kind: "jewel",
    name: "Test Item",
    data: { rarity: "epic", itemLevel: 62, style: "dex", affixes: [] },
  });
  const result = importPaste(old, snapshot());
  assert.equal(result.format, "copied-item");
  assert.equal(result.thing?.kind, "jewel");
});

test("a copied jewel keeps its style, its rolls and the name the game gave it", () => {
  const result = importPaste(
    envelope("jewel", {
      rarity: "epic",
      itemLevel: 62,
      style: "dex",
      affixes: [{ affixId: "jewel_dex", tier: "epic", rollPercent: 61.5 }],
    }),
    snapshot(),
  );

  assert.equal(result.format, "copied-item");
  assert.equal(result.name, "Test Item");
  assert.equal(result.thing?.kind, "jewel");
  assert.deepEqual(result.thing?.kind === "jewel" ? result.thing.jewel : undefined, {
    rarity: "epic",
    itemLevel: 62,
    style: "dex",
    affixes: [{ affixId: "jewel_dex", rollPercent: 61.5, tier: "epic" }],
  });
});

test("an affix this snapshot does not have is dropped and reported, not fatal", () => {
  const result = importPaste(
    envelope("jewel", {
      rarity: "epic",
      itemLevel: 62,
      style: "dex",
      affixes: [
        { affixId: "jewel_dex", tier: "epic", rollPercent: 61.5 },
        { affixId: "jewel_from_a_newer_pack", tier: "epic", rollPercent: 40 },
      ],
    }),
    snapshot(),
  );

  assert.equal(result.thing?.kind, "jewel");
  const affixes = result.thing?.kind === "jewel" ? (result.thing.jewel.affixes ?? []) : [];
  assert.deepEqual(affixes.map((a) => a.affixId), ["jewel_dex"]);
  assert.ok(result.issues.some((i) => i.code === "affix-missing" && i.severity === "warning"));
});

test("a jewel whose rarity is gone is not an item at all", () => {
  const result = importPaste(
    envelope("jewel", { rarity: "ultra", itemLevel: 62, style: "dex" }),
    snapshot(),
  );

  assert.equal(result.thing, undefined);
  assert.ok(result.issues.some((i) => i.severity === "error" && i.code === "jewel-rarity"));
});

test("a copied omen carries its requirements as well as its affixes", () => {
  const result = importPaste(
    envelope("omen", {
      id: "omen_of_flames",
      itemLevel: 80,
      rarity: "mythic",
      requires: { NORMAL: 3 },
      slotRequirements: [{ slot: "sword", rarityType: "UNIQUE" }],
    }),
    snapshot(),
  );

  assert.equal(result.thing?.kind, "omen");
  const omen = result.thing?.kind === "omen" ? result.thing.omen : undefined;
  assert.deepEqual(omen?.requires, { NORMAL: 3 });
  assert.deepEqual(omen?.slotRequirements, [{ slot: "sword", rarityType: "UNIQUE" }]);
});

test("a support gem keeps its own roll, which is the reason to copy one", () => {
  const result = importPaste(
    envelope("support", { id: "added_fire", rollPercent: 93, rarity: "mythic" }),
    snapshot(),
  );

  assert.equal(result.thing?.kind, "support");
  assert.deepEqual(result.thing?.kind === "support" ? result.thing.support : undefined, {
    id: "added_fire",
    rollPercent: 93,
    rarity: "mythic",
  });
});

test("an Augment lands enabled, because copying one is asking to run it", () => {
  const result = importPaste(envelope("aura", { id: "wrath", rollPercent: 71, rarity: "legendary" }), snapshot());

  assert.equal(result.thing?.kind, "aura");
  assert.equal(result.thing?.kind === "aura" ? result.thing.aura.enabled : undefined, true);
});

test("a Skill says its rank comes from the class allocation rather than from the gem", () => {
  const result = importPaste(envelope("skill", { spellId: "fireball", level: 3, gemPercent: 44 }), snapshot());

  assert.equal(result.thing?.kind, "skill");
  assert.equal(result.thing?.kind === "skill" ? result.thing.skill.level : undefined, 3);
  assert.ok(result.issues.some((i) => i.code === "skill-rank-from-classes"));
});

test("a spell this snapshot has never heard of is an error, not a skill", () => {
  const result = importPaste(envelope("skill", { spellId: "meteor_swarm" }), snapshot());

  assert.equal(result.thing, undefined);
  assert.ok(result.issues.some((i) => i.severity === "error" && i.code === "skill-id"));
});

test("a kind from a newer exporter says so rather than failing silently", () => {
  const result = importPaste(envelope("mercenary", { id: "whoever" }), snapshot());

  assert.equal(result.thing, undefined);
  assert.ok(result.issues.some((i) => i.code === "copy-unknown-kind"));
});

test("anything that is not an envelope still goes to the item reader", () => {
  // Not an envelope, not gear, not a tooltip: what matters is that it reached `importItem` and
  // was judged there, rather than being rejected here for not being a copy.
  const result = importPaste("just some text a player pasted", snapshot());

  assert.equal(result.thing, undefined);
  assert.notEqual(result.format, "copied-item");
});
