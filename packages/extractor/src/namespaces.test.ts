/**
 * The two rules the widened extractor rests on.
 *
 * Until this pass the extractor read `data/mmorpg/` and nothing else, so 604 files across four
 * sibling-mod namespaces and three OpenLoader packs never reached the snapshot and nothing
 * reported it. Opening every namespace raises one question the old code never had to answer —
 * what does a category get *called* once two namespaces can both ship a `tags/` folder — and
 * brings in one file the extractor had never parsed. Both are pinned here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { categoryKey, parseServerConfigToml } from "./extract.js";

// ---------------------------------------------------------------------------
// categoryKey
// ---------------------------------------------------------------------------

test("mmorpg categories keep their bare key, so no existing consumer moves", () => {
  // The whole engine, schema and app read these strings. A rename here is a rename everywhere,
  // which is why `mmorpg` is special-cased ahead of every other rule.
  assert.equal(categoryKey("mmorpg", "mmorpg_spells"), "mmorpg_spells");
  assert.equal(categoryKey("mmorpg", "mmorpg_stat"), "mmorpg_stat");

  // Including the vanilla directories that happen to sit beside them under `data/mmorpg/`.
  assert.equal(categoryKey("mmorpg", "recipes"), "recipes");
  assert.equal(categoryKey("mmorpg", "loot_tables"), "loot_tables");
  assert.equal(categoryKey("mmorpg", "curios"), "curios");
});

test("a sibling mod's own registries keep their bare key too", () => {
  // Library of Exile, Dungeon Realm, Ancient Obelisks and The Harvest all name their registry
  // folders with their own modid, because the registry id is `modid + "_" + id`. Qualifying
  // those would give `library_of_exile:library_of_exile_relic_stat` — a stutter, and it would
  // stop the key matching the jar's own `modpack_dev_helper/<registry>.txt` list.
  assert.equal(
    categoryKey("library_of_exile", "library_of_exile_relic_stat"),
    "library_of_exile_relic_stat",
  );
  assert.equal(categoryKey("dungeon_realm", "dungeon_realm_dungeon"), "dungeon_realm_dungeon");
  assert.equal(categoryKey("ancient_obelisks", "ancient_obelisks_obelisk"), "ancient_obelisks_obelisk");
  assert.equal(categoryKey("the_harvest", "the_harvest_harvest_arena"), "the_harvest_harvest_arena");
});

test("a vanilla directory under a foreign namespace is qualified, because they repeat", () => {
  // `tags`, `loot_tables`, `recipes` and `structures` each appear under several namespaces in
  // this pack. Unqualified they would silently shadow one another, which is a merge nobody sees.
  assert.equal(categoryKey("library_of_exile", "tags"), "library_of_exile:tags");
  assert.equal(categoryKey("dungeon_realm", "recipes"), "dungeon_realm:recipes");
  assert.equal(categoryKey("terralith", "loot_tables"), "terralith:loot_tables");
  assert.equal(categoryKey("ancient_obelisks", "structures"), "ancient_obelisks:structures");
});

test("a category named exactly after its namespace is qualified, not bare", () => {
  // This is the case that was wrong first time round. Letting `data/curios/curios/` through as
  // the bare `curios` collided it with `data/mmorpg/curios/`, quietly merging two unrelated
  // registries into one bucket — 2 entries became 3 and nothing said so.
  assert.equal(categoryKey("curios", "curios"), "curios:curios");
  assert.notEqual(categoryKey("curios", "curios"), categoryKey("mmorpg", "curios"));
});

test("two namespaces outside mmorpg can never collide", () => {
  // The property the qualifying rule does guarantee. A non-mmorpg key is either prefixed with
  // its own namespace or carries a colon, so no two of them can land on the same string.
  const namespaces = ["library_of_exile", "dungeon_realm", "curios", "terralith", "the_harvest"];
  const categories = ["tags", "recipes", "curios", "structures", "library_of_exile_currency"];

  const claims = new Map<string, string>();
  for (const namespace of namespaces) {
    for (const category of categories) {
      const key = categoryKey(namespace, category);
      const owner = `${namespace}/${category}`;
      const previous = claims.get(key);
      assert.equal(previous, undefined, `${key} claimed by both ${previous} and ${owner}`);
      claims.set(key, owner);
    }
  }
});

test("mmorpg can still collide with a sibling, which is why extraction checks rather than assumes", () => {
  // The rule is *not* collision-proof in general, and that is worth writing down rather than
  // assuming away. If `data/mmorpg/` ever shipped a directory named after a sibling mod's own
  // registry, both would claim one bare key and merge silently — the same failure the `curios`
  // case above caused when the rule was first written.
  //
  // Nothing in this pack does that, and no rule expressible here prevents it without qualifying
  // `mmorpg` too, which would move every key the rest of the codebase reads. So it is caught
  // rather than prevented: `findCategoryKeyCollisions` walks the inventory after extraction, and
  // `diagnostics.categoryKeyCollisions` is in the CLI's fatal set — a pack that did this fails
  // the extract instead of quietly merging two registries.
  assert.equal(
    categoryKey("mmorpg", "library_of_exile_currency"),
    categoryKey("library_of_exile", "library_of_exile_currency"),
  );
});

// ---------------------------------------------------------------------------
// mine_and_slash-server.toml
// ---------------------------------------------------------------------------

test("scalars are typed, and qualified by their section", () => {
  const config = parseServerConfigToml(
    [
      "",
      "#General Configs",
      "[general]",
      "\tGET_STARTER_ITEMS = false",
      "\tloot_announcements = true",
      "\t#Range: 0 ~ 100",
      "\tPERC_OFFHAND_WEP_STAT = 25",
      "\t#Range: 0.0 ~ 1000.0",
      "\tin_combat_regen_multi = 1.0",
      "\texp_gain_multi = 0.15",
    ].join("\n"),
    "test.toml",
  );

  assert.equal(config.values["general.GET_STARTER_ITEMS"], false);
  assert.equal(config.values["general.loot_announcements"], true);
  assert.equal(config.values["general.PERC_OFFHAND_WEP_STAT"], 25);
  assert.equal(config.values["general.in_combat_regen_multi"], 1);
  assert.equal(config.values["general.exp_gain_multi"], 0.15);

  // `#Range:` lines are Forge's own annotations, not values.
  assert.equal(Object.keys(config.values).length, 5);
});

test("a dotted, quoted section header flattens to a dotted key", () => {
  const config = parseServerConfigToml(
    ['[general."Default Feature Configs"]', "\tenable_maps = true"].join("\n"),
    "test.toml",
  );
  assert.equal(config.values['general.Default Feature Configs.enable_maps'], true);
});

test("string arrays survive, which is how gear_compatibility is readable at all", () => {
  // 263 entries in this pack, mapping real item ids onto Mine and Slash gear slots — the answer
  // to "does a vanilla iron sword count as a sword". Dropping arrays would lose it silently.
  const config = parseServerConfigToml(
    ['[general]', '\tgear_compatibility = ["minecraft:iron_sword:sword", "roe_weapons:bow_3:bow"]'].join("\n"),
    "test.toml",
  );
  assert.deepEqual(config.values["general.gear_compatibility"], [
    "minecraft:iron_sword:sword",
    "roe_weapons:bow_3:bow",
  ]);
});

test("an array wrapped across lines is still read whole", () => {
  // Forge does not emit them this way; a person editing the file might, and losing half a list
  // to a line break is the kind of quiet wrong answer this whole pass exists to stop.
  const config = parseServerConfigToml(
    ["[general]", '\tblacklist = ["minecraft:allay",', '\t  "minecraft:armor_stand"]'].join("\n"),
    "test.toml",
  );
  assert.deepEqual(config.values["general.blacklist"], [
    "minecraft:allay",
    "minecraft:armor_stand",
  ]);
});

test("a value this subset cannot read is skipped rather than guessed at", () => {
  const config = parseServerConfigToml(
    ["[general]", "\tgood = 1.5", "\tinline_table = { a = 1 }", "\tbare_word = sometimes"].join("\n"),
    "test.toml",
  );
  assert.equal(config.values["general.good"], 1.5);
  assert.equal("general.inline_table" in config.values, false);
  assert.equal("general.bare_word" in config.values, false);
});

test("the origin is carried, so a value can be traced back to the file it came from", () => {
  const config = parseServerConfigToml("[general]\n\tx = 1", "/some/install/server.toml");
  assert.equal(config.origin, "/some/install/server.toml");
});
