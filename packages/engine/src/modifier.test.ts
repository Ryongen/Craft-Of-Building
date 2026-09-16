import assert from "node:assert/strict";
import { test } from "node:test";

import { balance } from "./balance.js";
import { levelScale, modTypeFromString, rollToExact, sourceToExact } from "./modifier.js";
import { statIndex } from "./stat-def.js";
import { engineSnapshot, statEntry } from "./test-support.js";

const snapshot = engineSnapshot({
  mmorpg_stat: {
    armor: statEntry("armor", { scaling: "NORMAL" }),
    accuracy: statEntry("accuracy"),
  },
});
const index = statIndex(snapshot);
const bal = balance(snapshot);

test("an unrecognised modifier type becomes FLAT rather than an error", () => {
  // `ModType.fromString` falls through to `return FLAT;` — ModType.java:37-54. The pack
  // relies on the case-insensitive half of this and ships "flat" and "MORE" side by side.
  assert.equal(modTypeFromString("MORE"), "MORE");
  assert.equal(modTypeFromString("more"), "MORE");
  assert.equal(modTypeFromString("PeRcEnT"), "PERCENT");
  assert.equal(modTypeFromString("multiplicative"), "FLAT");
  assert.equal(modTypeFromString(""), "FLAT");
});

test("only FLAT modifiers scale with level", () => {
  // `if (mod.isFlat()) { return getScaling().scale(stat, lvl); } return stat;`
  // — Stat.java:197-202. A "+20% increased armor" is worth the same at level 1 and 100.
  const armor = index.shapeOf("armor");

  assert.equal(levelScale("FLAT", 100, 1, armor, bal), 100);
  assert.equal(levelScale("FLAT", 100, 11, armor, bal), 300); // 1 + 0.2 * 10
  assert.equal(levelScale("PERCENT", 100, 11, armor, bal), 100);
  assert.equal(levelScale("MORE", 100, 11, armor, bal), 100);
});

test("a stat with NONE scaling ignores level entirely", () => {
  assert.equal(levelScale("FLAT", 100, 50, index.shapeOf("accuracy"), bal), 100);
});

test("a roll interpolates between min and max", () => {
  // `data.v1 = (mod.min + (mod.max - mod.min) * percent / 100F)` — ExactStatData.java:51.
  const mod = { statId: "accuracy", type: "FLAT", min: 10, max: 20 } as const;
  const shape = index.shapeOf("accuracy");

  assert.equal(rollToExact(mod, 0, 1, shape, bal).value, 10);
  assert.equal(rollToExact(mod, 50, 1, shape, bal).value, 15);
  assert.equal(rollToExact(mod, 100, 1, shape, bal).value, 20);
});

test("a rolled FLAT modifier is scaled after it is interpolated", () => {
  const mod = { statId: "armor", type: "FLAT", min: 10, max: 20 } as const;
  // 15 at 50%, then * (1 + 0.2 * 10) at level 11.
  assert.equal(rollToExact(mod, 50, 11, index.shapeOf("armor"), bal).value, 45);
});

test("scale_to_lvl decides whether a fixed modifier sees the level at all", () => {
  // `x.scale_to_lvl ? data.getLevel() : 1` — BonusStatPerEffectStacks.java:73-79.
  const shape = index.shapeOf("armor");
  const scaled = { statId: "armor", type: "FLAT", v1: 10, scaleToLvl: true } as const;
  const flat = { statId: "armor", type: "FLAT", v1: 10, scaleToLvl: false } as const;

  assert.equal(sourceToExact(scaled, 11, shape, bal).value, 30);
  assert.equal(sourceToExact(flat, 11, shape, bal).value, 10);
});

test("a capped scaling curve stops at MAX_LEVEL, an uncapped one does not", () => {
  // `if (cap_to_max_lvl) { lvl = Mth.clamp(lvl, 1, MAX_LEVEL); }` — LevelScalingConfig.java:21-27.
  // In `original_balance` NORMAL is uncapped and CORE is capped, both at MAX_LEVEL 100.
  assert.equal(bal.multiFor("NORMAL", 101), 1 + 0.2 * 100);
  assert.equal(bal.multiFor("CORE", 101), bal.multiFor("CORE", 100));
  assert.equal(bal.multiFor("NONE", 101), 1);
});
