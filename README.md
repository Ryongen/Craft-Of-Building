# cte2-pob

A Path of Building for **Craft to Exile 2** — a standalone desktop build planner with a
real damage model, not just a talent picker.

Status: **phase 4.** The extractor works end to end, the build-document contract is
defined and enforced, the stat engine computes a character sheet, the damage pipeline turns that
sheet into a per-hit damage number, and there is a desktop planner to drive all of it — pick
talents, skills, gear and omens, and read the sheet with a per-stat breakdown. Items can be
pasted straight out of the game rather than rebuilt by hand.

**The stat sheet is checked against the game.** A client-side Forge mod in [`mod/`](mod/) exports
the character you are playing together with the stat sheet the server calculated for it, and the
engine reproduces **all 265 stats** of the two captures taken so far at float precision. See
[Ground truth](#ground-truth).

**The damage model is not.** Nothing has captured an `observed.damage` block, so every DPS and
effective-HP figure here is a derivation with no measurement behind it. That is the next thing
worth doing, and [`fixtures/README.md`](fixtures/README.md) says how — the spell tooltip needs no
combat at all and pins the whole base-damage path.

## Why this exists

CTE2 is built on [Mine and Slash](https://github.com/mahjerion/Mine-And-Slash-Rework the Branch 1.20-Forge, IMPORTANT since the main is outdated and that's the updated branch) and
reproduces most of PoE's build-defining systems. The existing
[cte2-planner](https://github.com/Cofeiini/cte2-planner) covers the passive tree well but
has no gear, no skills and no damage model, so it cannot answer "what is my DPS".

Full reasoning, cost breakdown and the mechanics traced out of the mod source live in the
plan document that produced this repo.

## Layout

| Package | License | What it does |
| --- | --- | --- |
| `packages/extractor` | MIT | Reads a CTE2 install, merges every datapack namespace and the server config, emits a snapshot |
| `packages/schema` | MIT | The build document: character/item model, legality rules, fixtures |
| `packages/engine` | MIT | Stat container, damage pipeline, fixture runner |
| `packages/app` | MIT | Electron build planner: tree, skills, gear, stat sheet, damage |
| `mod/` | MIT | Client-side Forge mod: exports your character and the game's own stat sheet as a fixture |

**On the app's licence.** This package was originally earmarked GPL-3.0 because it was going to
fork `cte2-planner`'s UI, and `cte2-planner` is GPL-3.0. It does not: the tree is a canvas
renderer written against the grid the extractor already produces, which is a few hundred lines
and avoids taking on a second codebase to integrate. Nothing here derives from that project, so
the whole repository is MIT.

Phase 3 gave the tree two behaviours that project also has — click a distant node to buy the
shortest route to it, and take the orphaned branch with a removal. Both are reimplemented from
`TalentGrid.java` and `TalentsData.java`, which is where the rules actually live: the mod
precomputes the same edge list at world load and enforces the same reachability invariant on
every deallocation. The boundary is that behaviour is not copyrightable and code is.

## Running the extractor

```bash
npm install
npm run build
node packages/extractor/dist/cli.js --install "G:/PrismLauncher/instances/Craft to Exile 2 - 2.0.2 Atlas Update" --out data/snapshot.json
```

`--install` accepts either the Prism instance folder or the game directory. Add
`--verbose` to list every diagnostic instead of a sample. **The modpack folder is only
ever read from.**

> **Windows:** call the CLI through `node` as above when your install path contains
> spaces — and CTE2 instance names generally do. `npm run extract -- --install "…"` mangles
> quoted arguments containing spaces (npm passes them through `cmd.exe`, which re-escapes
> them into `^G:\…^ to^ Exile^`). The `npm run` form is fine for space-free paths.

Exit code is non-zero when a schema-level surprise appears (unknown stat serializer,
unknown `multiUseType`, unknown modifier type, unparseable file) — so it can gate CI on a
pack update. Pack-quality issues like duplicate GUIDs are reported loudly but do not fail
the run.

### What it reads

**Every datapack namespace, not just `mmorpg`.** Mine and Slash ships with Library of Exile,
Dungeon Realm, Ancient Obelisks and The Harvest, and between them those four register 21 Exile
registry types under their own namespaces. The extractor used to hardcode `data/mmorpg/` and
look for `<pack>/data/mmorpg` in an OpenLoader pack, which dropped **604 files** in this pack
and skipped three OpenLoader packs whole for not having an `mmorpg` folder at all. Namespaces
are discovered now, the same way registry categories always were, so a namespace a future pack
adds arrives without an edit here.

Categories keep their bare key where that is unambiguous — `mmorpg_spells` stays
`mmorpg_spells`, and `library_of_exile_relic_stat` stays itself, because the sibling mods
already prefix their registry folders with their own modid. Only a vanilla directory under a
foreign namespace is qualified (`terralith:loot_tables`, `dungeon_realm:recipes`), because
`tags`, `recipes`, `loot_tables` and `structures` each appear under several namespaces and an
unqualified key would have them shadow one another. `diagnostics.categoryKeyCollisions` checks
that rule against the real pack and is fatal, because a collision merges two registries in
silence — which is exactly what happened the first time the rule was written.

**`defaultconfigs/mine_and_slash-server.toml`**, into `snapshot.externalConfig.serverConfig`.
It is not a datapack, so nothing else here would ever have seen it, and the engine needs it:
`in_combat_regen_multi` scales every regeneration tick in combat and the app used to ask the
player to retype it. `gear_compatibility` (263 entries mapping real item ids onto gear slots)
and `PERC_OFFHAND_WEP_STAT` come along with it.

**`diagnostics.namespaces`** is the inventory: every namespace opened, every category under it,
the key each landed on and how many files it held. That is what makes "did this update bring
something new?" answerable from the snapshot alone.

### The audit has two halves

`npm run audit` used to ask one question — *does the engine read what the snapshot contains?* —
across seven checks, every one of which iterates `snapshot.registries`. That is why it reported
`unaccounted 0` for the whole life of this repo while four namespaces went unread: a namespace
nobody opened is not in the snapshot to be iterated.

Two checks now ask the other question, reading the **install** instead:

1. every registry type the mod family's Java declares — `ExileRegistryTypes`, `LibDatabase`,
   `DungeonDatabase`, `ObeliskDatabase`, `HarvestDatabase`, resolved through each class's own
   `MODID` constant rather than a hardcoded map — against what the snapshot holds;
2. every namespace directory in the jar and in each OpenLoader pack, against
   `diagnostics.namespaces`.

They found two things on first run, both real: `library_of_exile_map_data_block` and
`library_of_exile_mob_affix` are declared as datapack-loadable and ship no JSON anywhere, so
their defaults are Java-only — the registry equivalent of a code-only stat.

Fixing the path handling turned up a third. `--src` was being passed an MSYS-style
`/g/Projects/…` by the npm script, which node on Windows resolves to a path that does not
exist, and check 1 skips a file it cannot open — so it had been reporting nothing at all, and
`unaccounted 0` looked like success. `parseArgs` translates the path and now refuses to run
rather than pass vacuously.

### Nothing extracted is committed

The snapshot is derived from the user's own install and lands in the git-ignored `data/`.
Mod and pack assets are never redistributed; the app extracts on first run instead. That
is also why version churn is not a maintenance burden — the tool reads whatever version
the player actually has.

## What phase 0 established

Against Mine and Slash `1.20.1-6.4.7` + pack `2.0.2`:

- **5,905 merged registry entries**, from 1,204 jar defaults and 4,701 pack entries.
- **1,151 stats total**, of which **353 are code-only** — registered in Java with no JSON
  anywhere. These are the ones that matter (armor, dodge, resists, penetration, every
  ailment stat, leech) and are the bulk of the porting work.
- **6,618 lang keys**, with the pack's own copy overriding the jar's. That copy is
  `config/openloader/resources/` and may be either a `.zip` or an unpacked directory —
  Craft to Exile 2 has shipped both, and reading only zips silently loses every rename
  the pack makes (`mana_cost` -> "Resource Cost", `plus_lvl_all_spells` -> "To All Skills").

### Mechanics confirmed from source (not assumed)

- Stat resolution is `clamp((base + Flat) * (1 + Percent/100) * Multi, min, hardCap)`,
  where `* Multi` applies **only** when `multiUseType == MULTIPLY_STAT`
  (`InCalcStatData.calcValue`).
- `getCalculated()` splits the two paths: `MULTIPLY_STAT` folds `Multi` into the value;
  `MULTIPLICATIVE_DAMAGE` carries it separately in `StatData.m` for the damage layer.
  `StatData.getValue()` returns the value **without** `m`.
- Consequence: every "X per % of Y" stat (`one_to_other`) reading a `MULTIPLICATIVE_DAMAGE`
  adder **silently drops that stat's MORE modifiers**. 14 such stats in this pack
  provably truncate a MORE that actually exists.
- `StatMod.type` is a `String` resolved by `ModType.fromString()`, which is
  case-insensitive and **falls back to `FLAT`** when nothing matches. The pack relies on
  this — `"flat"` and `"MORE"` appear in the same `stats` array.
- Registry keys come from the object's declared GUID, not the file path:
  `BaseDataPackLoader.apply()` discards the `ResourceLocation` and calls
  `object.registerToExileRegistry()`.

### Pack-quality findings

These are properties of CTE2 as shipped. The engine must **replicate** them, not correct
them — players build against what the game actually does.

- **466 duplicate GUIDs** (170 unique gears, 146 stats, 139 spells), overwriting silently
  (no in-game warning; the single `random_roll` warning in the log comes from a different
  code path). Mostly the same entry shipped twice with **differing content** — at a category
  root and again in a subfolder, e.g. `mmorpg_spells/armageddon.json` vs
  `mmorpg_spells/0_8_elementalist/armageddon.json`, or the stale
  `mmorpg_unique_gears/honourhome.json` beside the current
  `mmorpg_unique_gears/chainmail_helmet/honourhome.json`.

  Which copy wins is now **reproduced rather than guessed** — see
  `packages/extractor/src/registry-order.ts`. `BaseDataPackLoader.prepare` collects resources
  into a `java.util.HashMap` (confirmed in the shipped `Library_of_Exile-1.20.1-2.1.14.jar`
  bytecode) while iterating a `TreeMap`, and `apply` registers by GUID as it walks that
  HashMap, so the last entry in **Java HashMap iteration order** wins. Arbitrary, but
  deterministic. Verified against the game: it picks the nested Honourhome, and only that
  file's `gear_defense` range can produce the +14% / 135 armor / 270 magic shield the item
  shows at level 100.
- **263 id/filename mismatches**, several of them clear copy-paste bugs:
  `mmorpg_affixes/implicit/reapers_scythe.json` declares `necromancers_scythe`;
  `mmorpg_entity/specific_mobs/minecraft_husk.json` declares `minecraft:zombie`.
- **8 files are not valid strict JSON** — the talent trees and atlas layout embed grids
  as strings containing raw newlines. Gson tolerates it; `JSON.parse` does not. See
  `lenient-json.ts`.

## What phase 1 established

The engine (`packages/engine`) turns a build document plus a snapshot into what the in-game
stat sheet would show: `{ value, dmgMulti, softcap, hardcap, usableValue }` per stat. Scope is
the character sheet, which is the no-spell path (`getStatsWithoutSuppGems`, then
`calc(..., spell = null, skillGem = -1)`); spells and support gems belong to phase 2.

### The order is the whole thing

Each step is a couple of lines of arithmetic. What makes a sheet come out right is when each
runs, and which snapshot of the container it reads from — ported from `StatCalculation.calc`:

1. collect contexts (base stats, gear, perks, jewels, auras, exile effects);
2. `ITransferToOtherStats` — `elemental_resist` empties itself into the three single elements
   and `clear()`s, which is why it always reads 0 on the sheet;
3. **calculate**;
4. core stats grant their bundles back into the *same* container, so `% intelligence` reaches
   what intelligence itself granted;
5. **calculate again**;
6. `AddToAfterCalcEnd` in priority order, against a snapshot that only refreshes *between*
   priority tiers — so two `one_to_other` stats in the same tier cannot see each other;
7. the final clamp.

Two behaviours are reproduced rather than corrected: `one_to_other` reads its adder with
`getValue()`, which excludes `StatData.m`, so a `MULTIPLICATIVE_DAMAGE` adder silently
contributes as if it had no MORE modifiers; and `InCalcStatData.addFullyTo` *adds* the Multi
(`other.Multi += 1F - Multi`) where every other MORE path multiplies it.

### The 389 code-only stats are generated, not hand-written

`tools/port-code-only-stats.mjs` reads a checkout of the mod source and emits
`packages/engine/src/code-only-stats.generated.ts`. It fails rather than emit a partial table:
every id in `snapshot.diagnostics.codeOnlyStats` must be claimed by exactly one Java class, so
a mod update that adds a stat breaks loudly instead of resolving to zero. It also derives which
stats transfer into which — `phys_to_elemental` and `max_elemental_resist` do,
`elemental_weapon_damage` does not, and all three come from `ElementalStat` subclasses, so
that list could not have been guessed.

### Corrections to what phase 0 assumed

- **No stat in the game has a soft cap.** Grep the source for `setSoftCap` and the only hit is
  the setter's own definition, so `Stat.getCap()` always returns the hard cap and the sheet's
  `softcap` row never renders. `ElementalResist.getAdditionalMax` — the "resists cap at 75 plus
  your max-resist stat" mechanic — is unreachable dead code in this version.
- **The `MULTIPLICATIVE_DAMAGE` override does not reach datapack stats.**
  `Stat.getMultiUseType()` overrides the declared value when the stat's effect is a
  `BaseDamageIncreaseEffect`, and 40 JSON stats looked like candidates. They are not:
  datapack stats carry `ModifyStatLayerEffect`, which extends `StatEffect`. The override
  applies to five Java classes only, which expand to nine ids.
- **Level scaling touches FLAT only.** `Stat.scale` returns PERCENT and MORE untouched, so a
  "+20% increased" line is worth exactly the same at level 1 and level 100.

### More pack-quality findings

- **143 `learn_<spell>` stats exist that appear in no list anywhere.** `LearnSpellStat` is
  registered per spell, so the pack's own 143 added spells each produce one — but they have no
  JSON, and the mod's `modpack_dev_helper` list only names the jar's spells. Enchants and perks
  across the pack grant them. The engine expands them from `mmorpg_spells` at load.
- **Six stat references point at nothing at all**: `lightning_resistance` (a typo for
  `lightning_resist`, on a Twilight Forest hydra), `golem_damage`, `max_total_summons`, and
  `learn_` stats for three spells the pack does not ship (`ice_crash`, `golem_fire_basic`,
  `golem_frost_basic`). None exist in the Java either, so in game they resolve to `UnknownStat`
  and do nothing. The engine reports them rather than inventing a value.
- **A seventh, found in phase 2**: `mmorpg_stat/aoe_dmg_per_perc_faster_projectiles` declares
  `add_to: "aoe_dmg"`, and `aoe_dmg` is a **support gem** id, not a stat — the pack has
  `inc_aoe` for that. `meteor_arrow` grants the broken stat through its `statsForSkillGem`, so
  the spell has a line that does nothing at all. It went unseen in phase 1 because a spell's
  innate stats are only collected once a skill is chosen.

## What phase 0.5 established

The **build document** (`packages/schema`) is the contract three different things will
produce: a person authoring a character by hand, the app's editor, and eventually the mod's
character dump. Defining it before any of them exist is what stops the third from inventing
its own format.

Items are **constructed, never a bag of finished stats** — a base, a rarity, a level, and
per-affix `{ id, tier, rollPercent }`, exactly what `GearItemData` stores. Recording
outcomes instead of inputs would make a legal item indistinguishable from an impossible one,
and the entire value of a hand-made character is that it is *recreatable*.

### Rules ported from Java, not guessed

All from mahjerion/Mine-And-Slash-Rework @ `1.20-Forge`, quoted at their call sites:

- `min_affixes` is an **exact** affix count, not a floor. `getAffixAmount()` returns it and
  `GearAffixesData.randomize()` tops the item up until it has that many: common 1 → mythic 6.
- The per-type ceiling is the **rounded-up** half, not `maximumOfOneAffixType()`. That method
  returns `min_affixes / 2`, but the top-up loop only balances prefix against suffix counts
  and does not re-check the cap, so legendary lands on 3 prefixes / 2 suffixes while the
  method reports 2.
- An affix carries **its own tier**, which is not the item's. `randomizeTier` picks any
  non-unique rarity whose `item_tier` is at most the item's, and the roll band comes from
  *that* tier (`getMinMax() → getRarity().stat_percents`). A mythic item can hold a
  common-tier affix rolling 0–17%; the reverse is impossible.
- The rarity roll bands do not overlap — 0–17, 18–34, 35–51, 52–68, 69–85, 86–100 — which is
  what makes an out-of-band roll a hard error rather than a judgement call.
- `TagRequirement.meetsRequierment()` checks exclusions first, then applies `HAS_ALL` (51
  affixes) or `INCLUDES_ANY` (438). An unrecognised mode never silently passes.
- Craft to Exile 2 runs **original** mode: it ships pack overrides for exactly
  `original_balance` and `original_mode_player`, leaving the `compat_mode_*` entries at jar
  defaults.

### Things deliberately left unresolved

Marked in the code, not quietly assumed:

- ~~**Tree connectivity is not checked.**~~ **Settled in phase 3** — and both halves of the
  original note were wrong. See [The tree](#the-tree).
- **Connector cells cost nothing.** Inferred by arithmetic in phase 0.5, confirmed in phase 3:
  `GridPoint` classifies a one-character token as a connector, and a connector is never a node.
- ~~**Points per slot** — how many items share a gear slot (two rings?) is not in the
  datapack.~~ **Settled in phase 4**, and as with the tree note, both halves of the original
  were wrong: the mod states the loadout outright in `CharacterEquipment.java`, and Curios
  registers `ring`, `omen` and `necklace` here as well as `master_bag`. See
  [Equipment](#the-equipment-layout-is-not-an-assumption-any-more).

## What phase 2 established

The engine now answers "how much does this hit for". `simulateHit(build, snapshot)` returns a
per-element breakdown for a chosen skill, as `{ hit, crit, average }`.

### Two sheets, not one

The game keeps a separate stat unit per spell — `getSpellUnitStats` runs the whole phase 1
calculation again with the spell's innate stats and its linked support gems added on top
(`PlayerData.java:368-402`). `calculate` takes an optional `skill` to produce it.

The split that matters: a spell's **base damage** reads the plain character sheet
(`ScalingCalc.getCalculatedValue` calls `Load.Unit(en).getUnit()`), while the **damage event**
sweeps the spell unit. Support gems therefore never change the base number, only the layers.

### The order, again

`EffectEvent.Activate` sweeps every non-zero stat on both sides, sorted by `StatPriority`, and
the layer flush is a pseudo-stat *inside* that list at priority 30 rather than a step after it.
Then 14 layers apply in their own priority order, and every accumulated MORE multiplier applies
after all of them. That last step is where phase 1's `dmgMulti` is finally spent: a
`MULTIPLICATIVE_DAMAGE` stat keeps its MORE out of its value for the whole stat calculation
precisely so the damage layer can apply it once, separately.

Seven of the fourteen layers have **no JSON writer at all** — conversion, ele-as-extra,
taken-as, all three mitigations and flat reduction are driven entirely by Java classes. Those
are ported by hand in `damage/code-only-effects.ts`, quoted at each call site, because they are
overridden method bodies rather than the field assignments `port-code-only-stats.mjs` can read.

### Chance is branched for crit and averaged elsewhere

`random_roll` is the most-referenced condition in the pack (144 uses) and it reads its chance
from **the stat's own value** (`RandomRollCondition.java:14-17`), so "15% chance to burn" is
`burn_chance` resolving to 15.

Crit cannot be averaged: `critical_damage` gates a multiplicative layer and `double_damage` is
clamped to exactly ×2, so an expected-value crit is a number the game never produces for either
outcome. The pipeline therefore runs twice with the boolean pinned. Every other chance
contributes at its probability **and is named in a diagnostic**; where averaging is provably
inexact — a layer whose multiplier is pinned — it says that too.

Conditions a static document cannot answer (`is_*_not_on_cd`, `is_in_combat`, `is_day`, current
health) are treated as inactive and reported one-per-id. `config.conditions` forces any of them.

### More behaviours reproduced rather than corrected

- **`StatLayerData.getNumber()`'s clamp is commented out** in the source, so the two `ADD`
  layers ignore their declared bounds entirely — `flat_damage`'s ±1e8 and
  `flat_damage_reduction`'s -1000 floor are dead numbers.
- **`AFTER_DAMAGE_LAYERS` is declared with the id string `"DAMAGE_LAYERS"`** and overwrites its
  predecessor in a shared map keyed on the lowercased id. In-code effects hold the object and
  run at 20; all 218 datapack blocks declaring `order: "damage_layers"` resolve to **21**. So
  `resisted_already` is always already set by the time a datapack damage-layer stat reads it.
- **Penetration is not floored at zero resist — it drives resists negative.**
  `ElementalResist.min` is **-300** and `getUsableValue` clamps to it, so `resist -= pene` can
  land far below zero and `elemental_mitigation` becomes an amplifier: -100 resist is x2.0
  damage, and the -300 floor is x4.0. The only case where elemental penetration is wasted is a
  resist of *exactly* 0, because `ElementalResistEffect` does not override `runsOnZeroStat()`
  and the stat is never swept. Armour is the mirror image — `ArmorEffect` *does* override it, so
  it runs at zero armour and signs its output by whether armour-after-penetration went negative,
  which caps amplification at x1.9. The asymmetry is the armour class's own comment complaining
  about the resist class.
- **Mitigation floors are per-layer and multiplicative**: armour, physical and elemental each
  cap at 90% independently and stack.
- **Ailment damage is not the final hit.** It reads the pre-multiplier number plus whatever the
  flat-damage layer added, scaled by how much of the hit did *not* convert away, then runs a
  whole second damage event purely to arrive at a number. A DoT tick skips both stat sweeps
  entirely, so a tick is not a hit.

### A phase 1 correction

**Resists cap at 75%, not at the stat's own `max`.** `ElementalResist.getUsableValue` is

```java
float max = MathHelper.clamp(75 + this.getAdditionalMax(unit), min, 90);
return MathHelper.clamp(value, min, max) / 100F;
```

Phase 1 clamped to the stat shape's `max` of 500 and reported 100% mitigation for a 100%
resist; the game reports 75%, raised by that element's `max_<element>_resist` stat and hard
capped at 90. The phase 0 note that `getAdditionalMax` is dead code was right only about
`Stat.getCap()`, which needs a soft cap nothing sets — this call site is reached by both the
stat GUI and the damage pipeline. Fixed, and it changes the `usableValue` the character sheet
reports for every resist above 75.

## What phase 3 established

Three things the earlier phases got wrong or left open, and two that were missing.

### The tree

The passive tree is **not** a grid of free toggles, and the edges are **not** an inference. All
of it is specified in `TalentGrid.java` and `TalentsData.java`, so the phase 0.5 position that
connectivity was "not settled by the data" was only defensible by excluding the vendored mod
source from "the data", which nothing else in this project does.

- **A connector glyph is a channel id, not a line direction.** A path between two talents may
  only traverse connector cells bearing the *same* letter, walking 8-directionally, refusing a
  diagonal that cuts past a talent, and stopping at the first talent it reaches. `o` and `k` are
  independent wires that cross on the grid without joining. `packages/schema/src/tree-graph.ts`
  is that port; against the live 2.0.2 grids it produces 1,549 edges over 1,321 talent nodes with
  **zero isolated nodes**, which the old adjacency guess could not have managed.
- **The anchor is an `is_entry` perk, not `[CENTER]`.** The centre cell is the tree screen's
  camera origin (`SkillTreeScreen.getPosForPoint`) and a `requireNonNull` at load. It is never an
  allocation target. What allocations must reach is one of the **six class starts** — mage,
  guardian, rogue, warrior, ranger, duelist, arranged in a ring around the centre — or, in the
  ascendancy tree, one of the sixteen `*_class` perks in a 4x4 block.
- **`one_kind` is what makes "pick one class" a rule.** All six starts share `one_kind: "start"`
  and the game refuses a second. The same field governs the 16 ascendancies, the atlas start,
  the 6 `singular_focus` keystones and the 3 `blood_mage` ones. None of it was enforced before.
- **Cells are classified by token length**, lowercased first: one character is a connector,
  `[CENTER]` is the centre, more than two characters is a talent *whether or not it names a
  registered perk*, and exactly two characters is silently nothing. `E` is therefore a connector
  on channel `"e"`, not an empty cell — the 618 of them per tree form the border ring that stops
  the game's unguarded 3x3 neighbour reads running off the array.

The app now allocates the way the game does, plus the two conveniences that make a
1,321-node tree usable: clicking a distant node buys the shortest legal route to it, and
removing a node takes the branch it was holding up, both previewed before the click commits.
Those two behaviours are what `cte2-planner` does; they are reimplemented against the graph the
mod's own parser defines rather than taken from that project, which is GPL-3.0 while this one is
MIT.

### The damage breakdown

The mod ships a damage log — `DamageEvent.getInfoHoverMessage`, behind the `damage_messages`
player config — that prints, per hit: base damage, then every layer in priority order tagged
`[Source]` or `[Target]`, then the named MORE multipliers, then the final number, then the same
block again per bonus element. The Damage tab now reproduces it row for row, which makes a
screen here directly comparable to a hover in game.

It goes one level deeper in the one place the game cannot. `StatLayerData` is a bare float, so
"Additive Damage: x2.35" never says which of your stats made it 2.35; `MoreMultiData` is the
sole exception and only because a MORE has to be applied separately. The engine records each
write with the stat that made it, so a layer row expands into its contributing stats and each of
those into the item, perk, gem or aura behind it — reusing the sheet provenance that already
existed rather than adding a second mechanism.

Only `Hit` and `Crit` carry a trace. `Average` is the weighted mean of two totals, and a layer
averaged between the branches is a multiplier the game never applies.

### DPS

The game aggregates no hits per second anywhere, so this is the one part of the pipeline that is
a decision rather than a port. The decision is split into three, each derived as far as the data
goes: **what a cast produces**, **how much of it lands**, and **how often you can cast**.

#### What a cast produces — `skill-model.ts`

A spell's damage usually rides something. Across the pack's 427 `damage` acts, most ride a
projectile or a summoned block rather than firing straight off `on_cast`, and **77 spells declare
more than one**. So a cast is enumerated rather than reduced to its first `damage` act:

- **carriers** — `projectile`, `summon_block`, `summon_at_sight` or `direct`, each with the count
  one *spawn* produces (`proj_count` + `BONUS_PROJECTILES`, unless `ignore_bonus_proj`) and the
  ticks it lives for. A projectile ignores `DURATION_MULTI` unless `unaffect_by_duration` is
  explicitly false; a summoned block never can;
- **triggers** — `on_cast`, `on_entity_expire`, `on_hit`, or a tick. For a tick, exactly which
  ticks of the carrier's life pass `tickCount >= firstTick && tickCount % rate == firstTick % rate`
  (`OnTickCondition.canActivate`), over the `1..lifeTicks` range `SimpleProjectileEntity.tick`
  really runs;
- **targets** — the selector, with `AoeSelector`'s radius already multiplied by `AREA_MULTI`;
- **origins** — the chain of carriers between the caster and the act, each with where it was
  placed. `SpellCtx.positionSource` is the field that decides it: `onCast` leaves it on the
  caster, `onTick` and `onExpire` move it to the carrier, `onHit` and `onEntityHit` move it to
  the enemy that was hit. So a ground effect dropped by a projectile is placed where that
  projectile got to, and a shard spawned by an on-hit chain starts inside the mob;
- **requirements** — the `caster_has_mns_effect` gates, which is how the pack writes *branches*.
  A third of its skills are branch tables: `soul_siphon` declares eight mutually exclusive
  `on_cast` parts keyed on which spell aura you run and whether `sacrifice` is at three stacks,
  each throwing a different projectile with a different `value_calculation`. Every gate on a part
  is ANDed and one failure switches the whole part off, so these are evaluated rather than
  assumed — see below.

Because the chain multiplies, so does the count: `carriersPerCast` is
`Π (count × times the spawning part fires on its parent)`. `fire_wall` throws five projectiles
and each lays a wall down when it expires, so it produces five walls, not the one its
`summon_block` act declares.

Component groups are *reached*, not merely declared: the walk starts at `on_cast` and follows
`entity_name` outward, plus `DoSpecificAction` and `ComponentPart.per_entity_hit` — a nested list
of parts that `tryActivate` runs once per entity the outer selector picked. 62 spells use that
last one and five component groups are reachable through nothing else, so a walk that skips it
reports them as dead data. A group nothing spawns is reported rather than counted, and an act the
model does not interpret is named too.

`raging_dragon` is the case that makes the point. It declares a slam on `on_cast`
(`raging_dragon_slam`, 1.575–2.25× weapon damage) and a pulse on its projectile's component group
(`raging_dragon`, 3.15–4.5×, `tick_rate: 4`, AoE radius 2 around the projectile). With
`life_ticks: 60` that pulse fires 15 times per projectile, and a build with 8 bonus projectiles
throws nine of them — **136 damage instances per cast, of which the old model counted one**, and
the wrong one, because the carried act is declared before `on_cast` in the JSON.

#### How much of it lands — `geometry.ts`

Whether a nova of nine projectiles reaches the enemy you care about is geometry, and the old
model made it an input (`hitsPerCast`, default 1). It is now a derivation with one input: where
the target stands. Every number the game moves a `SimpleProjectileEntity` with is in the spell
JSON, so the flight is reproducible to the tick:

1. vanilla `AbstractArrow.tick` increments `tickCount`, moves by the current velocity, then
   scales it by the 0.99 air inertia (and subtracts 0.05 from y when the projectile has gravity);
2. `applyAcceleration()` re-sets the speed to `max(speed + proj_accel, 0)` keeping the direction,
   so `proj_accel` fights the drag rather than adding to it;
3. `applyYawVelocity()` adds `yaw_acceleration` to the running yaw velocity and rotates the
   velocity that many degrees about the projectile's up vector;
4. the components fire, at the position step 1 left it in.

Initial directions come from `ProjectileCastHelper.cast()`: `NOVA` puts projectile `i` at
`i * 360 / n` of yaw and forces pitch to 0, `BARRAGE` offsets each one block sideways, and
anything else fans across `proj_apart`.

The payoff is that gear behaves. `reduced_proj_speed` reads as a downside — -40%
`faster_projectiles` — and for Raging Dragon it is the opposite: it tightens the dragons' spiral
so more pulses stay on a nearby enemy. At a target 2 blocks away that build catches 56 of its 135
pulses; at 4 blocks, 14; past 6, none. `plus_aoe` widens the radius each pulse tests against.

A projectile *hit* is a narrower test than an area, and the two are easy to confuse.
`findHitEntity` passes `getBoundingBox().expandTowards(motion).inflate(1)` to
`ProjectileUtil.getEntityHitResult`, but that box is only the broadphase: the test that decides
the hit is `entity.getBoundingBox().inflate(0.3F).clip(from, to)`, against the *movement* rather
than the tick's endpoint. `EXPIRE_ON_ENTITY_HIT` then defaults to true, so most projectiles are
deleted by the first enemy they touch — which cuts their tick pulses short and brings their
expire forward onto the target, where `moveToImpactPosition` leaves them.

Randomness is integrated, not rolled. `SummonBlockAction`'s `random_x/z_offset` is uniform on
`[-offset, +offset]`, so a scattered summon contributes its *expected* hits: `armageddon`'s ±2
meteors against a radius-1.8 reach give 1.92 of 3, and π·1.8²/16 is 1.91.

What the simulation cannot resolve says so rather than passing as derived: a `tracks_enemies`
projectile is reported as reaching its target with `Coverage.method === "assumed"`, and a
stationary carrier is a containment test labelled `"stationary"`. Any source's coverage can be
typed over, and the override is labelled too. A skill whose every source misses reports
`reachDistance` — the farthest distance anything still lands at — so that a melee area measured
from outside its own radius is distinguishable from a modelling failure.

#### What you have up — `effect-state.ts`

Which exile effects are active is not decoration around the damage model, it *is* the damage
model. It decides which branch of a spell exists, and for debuffs it decides the enemy's armour.

So it is derived, from three places: the **skills on your bar** (157 effects are applied by an
`exile_effect` act in some spell's tree — both stances, `overheat`, `shred`), the **stats you
carry** (59 more come from a `give_exile_effect` stat effect, which is the only way to get
`fortify` or any of the three charges), and the **spell auras** you run, which share a
`one_of_a_kind_id` and so resolve to one at a time.

**It is the only answer.** The character's stat sheet is built from this state, the mob's debuffs
come off it, every gate reads it, and the toggle list on screen writes to the one place that
overrides it. There used to be two answers — `build.exileEffects` fed the sheet and
`config.effects` fed the gates — and they disagreed: unticking a buff switched off the spell
branch that needed it while its stats stayed on the character. Resolving what is up needs a
finished sheet (the charge caps, the `give_exile_effect` grants, the buff-strength stats) and
applying it produces one, so `calculate` runs a first pass with nothing up and the real one on
top. About 0.7 ms.

Everything the build could apply is assumed up at `ExileEffect.getMaxCharges` — `max_stacks` plus
the `max_<id>_charges` stat your ascendancy might grant — because this is a planner and the
question it exists to answer is what a build can do. `config.effects` overrides any of it.
`config.assumeEffects: "captured"` flips the whole list to the closed-world reading, where an
effect `build.exileEffects` did not record is off; `compareFixture` sets that itself, because a
fixture asks whether the engine reproduces a *measured* sheet and the character whose sheet was
measured was not running the buffs the capture did not list. Every assumption is listed with what
granted it, and a branch a gate switched off is reported in `SkillModel.blockedBy` with the damage
acts it would have produced — and in the app, as a button that turns the effect on.

Resolving needs a sheet and the sheet needs the answer, so `calculate` runs a pass with nothing up
and then iterates until two rounds agree. That is not theoretical: `fury` carries
`proc_combo_starter`, which is the only thing in the game that grants `combo_starter`, which is
what every combo chain in the pack starts with. The settled answer is memoised against the build
document, so the four things that ask for it during a repaint pay for one loop between them.

**How strong a buff is, is derived rather than floored.** Two numbers decide it and a toggle used
to know neither:

- `ExileEffect.getExactStats` interpolates every band over the rank of the spell that applied the
  effect. That spell is usually on the bar — the spell `hunters_focus` is what grants the effect
  `hunters_focus` — so the rank is knowable, and it matters: the buff is
  `FLAT 1..3 projectile_count`, which is one extra projectile at 0% and three at 100%.
- `ExileEffectInstanceData.str_multi` multiplies the result. `ExilePotionEvent` starts it at 1 and
  the stat pipeline adds every `inc_effect_of_<tag>_buff_given` / `_on_you` whose
  `effect_has_tag_<tag>` condition holds, so it is `1 + sum/100` over the effect's own tags.

Both are pinned: the level-100 capture carries `positive` 64.7 and `defensive` 50 and recorded
2.147 on `zen` (positive+defensive), 1.647 on `fury` (positive+offensive) and 2.147 on
`hunters_focus` (all three). Delete every effect from that capture, tick the same three on by
hand, and all 188 of its observed stats still match the game — `projectile_count` at 8.3675
included. A capture still wins where it speaks, because it is a measurement.

Who *holds* an effect is read off the grant rather than off `ExileEffect.type`, which says buff or
debuff and disagrees often enough to be a trap. A debuff your skills apply — `shred` at
`PERCENT -8 armor` stacking to ten, `elemental_weakness` at `FLAT -25 elemental_resist` — lands on
the enemy's sheet, where the mitigation layers read it.

#### What your gear casts for you — `procs.ts`

99 stats carry a `proc_spell` effect. Their conditions are already ported and already run: the
damage sweep evaluates each block's `ifs` into a probability before applying it, with
`random_roll` reading the stat's own value and `spell_has_tag_*` deciding whether the skill you
are casting can trigger it. So the chance falls out of the existing pass, and what is added is the
rate — `hits per second × chance`, capped at `20 / proc_cooldown_ticks` — and the procced spell's
own damage.

A proc that cannot fire is listed with the reason rather than dropped: `when-hit`, `on-kill`,
`basic-attack`, or `wrong-skill` with the tag it wanted. "You have no procs" and "your procs
belong to a different skill" are different answers, and only one of them is about your gear.

#### What you have to press first — `combo.ts`

A finisher's cycle is how often the *button* comes back, not how often it does anything.
`raging_dragon` gates every damage act on `combo_extender` and spends it when it fires; only
`spirit_offensive` grants that, and it wants `combo_linker`; `elemental_assault` grants that, and
wants `combo_starter`; and no spell in the pack grants `combo_starter` at all — `proc_combo_starter`
does, on a **basic attack**. Four presses to see one dragon.

The chain is read out of the data rather than declared: a link is an effect a spell both gates on
and spends. Gating without spending is a *condition* — a stance you stand in, four `overheat`
stacks you maintain — and following those would put "re-enter your stance" into the rotation every
0.75 s. Each step costs `castTicks + castSpeedTicks`, already divided by the cast-speed multiplier
your `attack_speed` and `skill_speed` stats produced, or its own cooldown when that is longer. The
basic attack is vanilla's `1 / attack_speed`, which a capture records as
`minecraft:generic.attack_speed`; without one, that step is unpriced and so is the chain, which is
a better answer than quietly dropping it.

On the reference build: `dps` 2,032,592 at the button's 0.50 s cycle, `comboDps` 609,446 at the
chain's 1.67 s. A link nothing on the bar supplies is a warning, not a silent zero.

#### What it takes to kill you — `defence.ts`

Effective HP, per element, and it is the offensive pipeline with the sheets swapped: the character
is the target, the attacker is a mob with no stats, and `sweep` runs the same `armor_mitigation`,
`physical_mitigation`, `elemental_mitigation`, `damage_reduction`, `damage_suppression`,
`damage_block` and `flat_damage_reduction` layers off the same stat effects. Nothing is
re-derived, and every row on screen names the stats that produced it.

Two stats had no code-only effect until this needed them. `DodgeRating` zeroes a physical hit on a
roll and `BlockChance` halves any hit on a roll — and both average exactly rather than
approximately, because the block layer's floor is 0.5 and the avoidance layer's is 0, so reducing
each by `chance ×` its constant is the expectation. Until now `config.enemy.dodge` and
`.blockChance` were written to the enemy's sheet and read by nothing.

The pools are `health` and `magic_shield`, and they do not simply add: `CHAOS_BYPASS_PERCENT` is
50, so half a chaos hit walks past the shield into health and the chaos pool is
`min(health + shield, 2 × health)`. `damage_absorbed_by_mana` is reported beside the figure rather
than folded in — it is a buffer of half your mana that drains at a fixed percent, and how full it
is when a hit lands depends on regeneration between hits.

The attacker is a real mob, not a zero. `EnemySetup.offence` carries what it hits with, and the
two entries that change *mitigation* — accuracy, subtracted from your dodge, and penetration, taken
off armour and off the raw resist before its clamp — are swept from the Source side exactly as a
player's would be. `buildTargetEnemy` fills it the way the Training Dummy's presets do, from
`MobStatUtils.getMobBaseStats`, which is one line long:
`scaleTo(1, FLAT, accuracy, lvl)` and nothing else. So the zeroes beside it are a finding: a mob
that pierces your resists is carrying a map affix, and that is a number to state rather than one a
preset should invent. Crit and the attacker's damage increases are recorded but stay out of the
figure — they make the hit bigger, not your mitigation worse.

#### What refills, and how fast — `resources.ts`

`OnServerTick` raises one restore event per pool **once a second** — for mana, energy, magic
shield and health, and for nothing else. Three kinds of stat fill that event's number and the
engine used to read only the first:

- **`<r>_regen`** (`BaseRegenClass`) adds its flat value;
- **`<r>_per_sec`** (`RegeneratePercentStat`) adds `max × value / 100`, so it grows with the pool;
- **the `on_restore_resource` percents** — `resource_regen`, `out_of_combat_regen`, `blood_regen`,
  `missing_hp_health_regen_per_2` — are ordinary stat blocks writing to `additive_damage`, and
  they *multiply* the other two.

That last group is why the restore event runs through the same `sweep` a hit does, with the event
id swapped. Adding the stats up by hand would leave every percent on the floor.

**Blood is the interesting one.** The Blood Magic game changer (`blood_user`) is an
`InCodeStatEffect` on `SpendResourceEvent`, not on the restore one:

```java
effect.data.setString(EventData.RESOURCE_TYPE, ResourceType.blood.name());
...
if (effect.data.getResourceType() == ResourceType.mana) { return true; }
```

It rewrites which pool a mana cost comes out of and changes nothing else. Mana keeps regenerating
and you stop spending it; blood is what has to keep up — and blood has no tick. What fills it is
`hp_resto_to_blood`, which rides every non-spell health restoration at `FINAL_DAMAGE` priority,
takes a percentage of its finished number and raises a blood event *with the same restore type*,
which is how `blood_regen` gets something to multiply. So a blood build's sustain is its health
regeneration times that percentage, and `DpsResult.cost.manaRegen` reports the pool that actually
pays rather than the one the spell names. `hp_resto_to_blood` refuses any restore carrying a spell
(`if (effect.data.isSpellEffect()) return false`), so the tick feeds blood and so does health leech
from a **basic attack**, but health leech from a spell does not.

**In combat is a different number.** After every layer has run, `RestoreResourceEvent.activate`
multiplies a `regen` restore by `ServerContainer.IN_COMBAT_REGEN_MULTI` whenever `in_combat` is up
and the pool is not energy. `in_combat` is a ten-second cooldown that every hit you land or take
re-stamps, so a rotation never leaves it — which makes the in-combat column the one a sustain
verdict has to use, and makes `out_of_combat_regen` (gated on `is_in_combat_is_false`) worth
nothing while you are fighting. The mod's default for that config is 0.5; this pack ships
`in_combat_regen_multi = 1.0`, so on Craft to Exile 2 only the gated stats separate the columns.
`Regen` reports both.

That number is **read out of your own install** rather than assumed —
`defaultconfigs/mine_and_slash-server.toml` is extracted into `snapshot.externalConfig.serverConfig`
and `inCombatRegenMultiOf` prefers it. The Config tab keeps the field as an override for a server
that set it differently, and says which of the two it is showing you.

#### What the hits put back — leech, in the same file

Every one of the pack's ten `restore_resource` stat effects declares `restore_type: "leech"`, so
**nothing you take off a hit lands directly**. It goes into a per-pool bank and is metered out once
a second:

```java
float leechMaxPerSec = 5F * LEECH_CAP.get(type).getValue() / 100F;
map.put(type, MathHelper.clamp(value, 0, data.getMaximumResource(type) * leechMaxPerSec));
...
float max = LEECH_CAP.get(type).getValue() / 100F * maxres;
if (num > max) num = max;
addLeech(type, -num);
data.getResources().restore(entity, type, num);
```

`<r>_leech_cap` has a base of **5** on every pool, so the sustained rate is
`min(generated, cap% × max)` and the bank's ceiling is five seconds of that. It is a stat, and this
pack lets it reach 50. On the reference build `lifesteal` generates 139,916 health a second and
pays out 217 — which is the number worth knowing: more leech on gear buys nothing there, a bigger
pool buys everything.

Leech is collected **off the damage sweep** rather than re-derived. `restore_resource` is
implemented in `effects.ts` as a recorder writing to `ctx.restores`, so every gate the hit already
answered — which element it was, whether the target dodged, whether it was a basic attack, whatever
`random_roll` resolved to — is folded in, per damage source and per bonus element. It reads the
number at `AFTER_DAMAGE_BONUSES` (32): after the layers flush at 30, before magic shield and mana
absorption at 100, which is exactly what `StatPriority`'s own comment says that slot is for.

6.4.13 moved the pooling, and it changes the arithmetic: 6.4.8's `RestoreResourceAction` called
`addLeech` and returned before raising the event, so `inc_leech` could never fire. The jar always
raises the event and pools the finished number, so `inc_leech` and `<r>_leech_regen` apply on the
way in.

`budget()` puts the three together — in-combat regeneration, capped leech and the cast's own spend —
and says which pool runs dry, how long a full one lasts, and how many casts that is.
`<r>_on_kill` and the two `attack_type_is_dot` leeches are named in `Leech.unrated` rather than
counted at zero: a kill rate is not something a build document states.

#### How often you can cast — the 6.4.13 rate

This is where the reference checkout and the jar disagree, and the jar wins. `reference/mns-src`
is **6.4.8**; `data/snapshot.json` is extracted from **`Mine_and_Slash-1.20.1-6.4.13.jar`**, which
replaced the rate model wholesale:

- `SpellConfiguration` gained `cast_speed_ticks`, and `SpellStatsCalculationEvent` seeds it along
  with `CAST_SPEED_PERCENT` and `CHANNEL_SPEED_PERCENT`. All 40 of the pack's `*_cast_time` stats
  plus `skill_speed` write `cast_speed_perc`;
- `activate()` turns that into `multi = 1 + max(-99, percent) / 100`, then sets
  `CAST_SPEED_TICKS = max(GLOBAL_COOLDOWN_TICKS, cast_speed_ticks / multi)` and divides
  `CAST_TICKS` by the same multiplier. A `channel` spell folds `channel_speed_perc` in first,
  weighted by `CHANNEL_GENERAL_SPEED_TRANSFER`;
- `Spell.getEffectiveCooldownTicks` is `max(getCooldownTicks, getCastSpeedTicks)`, so a spell's
  own cooldown can never be shorter than its cast speed;
- `SpellCastingData.armGlobalCooldown` puts `getCastSpeedTicks` on the **shared**
  `GLOBAL_COOLDOWN` key on every cast, unless `cast_speed_ticks <= 0`
  (`SpellConfiguration.isOffGlobalCooldown`).

Without this, `raging_dragon` — which declares `cast_time_ticks: 0`, `cooldown_ticks: 0` and
carries all of its rate in `cast_speed_ticks: 15` — resolves to a **one-tick cycle** and reports a
DPS twenty times too large.

A **held channel** is a different shape rather than a different number.
`SpellCastingData.onTimePass` runs `tryChannelPulse` when `castTickLeft` reaches zero, and that
method casts the spell and immediately re-arms `castTickLeft = getCastTimeTicks(ctx)`. It never
goes through `tryCast` or `onSpellCastFinished`, so no cooldown is set and no global cooldown is
armed between pulses: while the key is held, the cycle is `CAST_TICKS` and nothing else. The
cooldown is paid when the channel ends, so a channel you tap is slower than the figure reported.

Still true from the old model: `onSpellCastFinished` calls `setCooldownOnCasted`, so recovery
starts when the cast *finishes*; `times_to_cast` fires during the cast and floors the cast time;
a charge spell's rate is its `charge_regen`; and `apply_cd_as_cast_time` still matters, because
`fireball` carries `cast_speed_to_cooldown` and for it cast speed reduces cooldown instead.

> Modelling the remaining skills to this standard is its own job, with its own document:
> [`SKILL-MODELLING.md`](SKILL-MODELLING.md) carries the mechanics reference, the procedure, the
> traps, and a prioritised queue built from a census of all 432 spells.

#### Overlap, and why it is not extra DPS

A dragon lives three seconds and the cast cycle is half a second, so casting steadily leaves
**six casts and 54 projectiles in the air at once**. That is reported (`DpsResult.overlap`) but it
is deliberately *not* multiplied into the DPS, because it is already there: a cast delivers its
whole output eventually, so casting every `T` seconds averages to `damagePerCast / T` regardless
of how long each cast takes to finish delivering. Nothing caps it — `summon_limit_group` governs
summoned blocks only, and no spell projectile in the pack is limited.

What the steady-state figure genuinely cannot say is that it is not true yet at second one.
`Coverage.landedTicks` records *when* each hit lands, so `damageWithin(result, seconds)` replays
casts at `0, T, 2T, …` against those schedules and gives the real ramp, and `timeToKill` bisects
it. On the reference build a target has taken 31% of the steady-state claim after one second and
89% after ten, with the marginal rate converging on the reported DPS to within 0.1%. That gap is
the difference between a boss and a pack that dies before the pipeline fills.

#### Full DPS

A skill ticked into `includeInFullDps` joins a rotation figure, in the spirit of Path of
Building's. It is **not a sum**: every skill arms the same `GLOBAL_COOLDOWN`, so a pass that casts
each ticked skill once takes as long as all their casts plus all their arms, and a skill whose own
cooldown outlasts the pass stretches it.

That is what the pack needs. `raging_dragon` carries the `finisher` tag and refuses to cast at all
without `combo_extender`, which only an `extender` skill grants — so its standalone number is a
"when I press it" figure, and ticking the extender beside it pays for the cast that enables it.
On the reference build that is 943k alone against a map boss, and 538k as the real rotation.

#### Target presets

The enemy block is still **stated, never derived** — see `EnemySetup`. What is new is that the
presets from the Training Dummy mod (`DummyPreset`) can *fill* it, so a number here and a number
off the dummy in game are measured against the same thing. They reproduce
`MobStatUtils.getMobBaseStats`: `10 × stat_multi` of armour through the level curve, and that same
number again as every non-physical resistance, **flat and unscaled** (`ExactStatData.noScaling`).
No mob has physical resistance — armour alone stops a physical hit. The preset fills the rows and
gets out of the way; the engine still reads only what is written.

### A phase 2 correction, and a phase 1 one

- **`increase_number` and `decrease_num` are additive off the *original* number**, not
  compounding off the current one (`DecreaseNumberByPercentEffect.java:22-25`). Two 50%
  reductions reach zero; they do not leave 25%. The engine compounded them, which mattered
  nowhere until the rate existed and matters a great deal now.
- **`increase_number` also applies the stat's MORE multiplier** to the whole running number
  afterwards, which the decrease path does not.

### More pack-quality findings

- `atlas_passives` places the same `map_find_entry` perk at three separate coordinates. They
  share `one_kind: "atlas_start"`, so exactly one of the three may ever be taken.
- 169 of the 171 item ids the gear bases name resolve to a sprite across the pack's 399 mod
  jars. The two that do not are `minecraft:elytra` and `minecraft:trident`, whose textures are
  in the client jar rather than under `mods/`.

## The app

```bash
npm install
npm run dev          # builds the libraries, then launches the planner
```

On first run it asks for your Craft to Exile 2 folder, extracts a snapshot, the GUI textures and
the gear sprites into its own data directory, and shows the same diagnostics summary the CLI
prints. From a checkout it prefers an existing `data/snapshot.json` instead, so work already
done by `npm run extract` is not repeated.

The **Data** tab does that again on demand: it shows which folder the snapshot came from, which
Mine and Slash version and OpenLoader packs it saw and when, and offers "Re-extract now" and
"Change modpack folder". It also compares the archives' sizes and mtimes against the fingerprint
recorded at extraction and says so when they no longer match — a pack update otherwise replaces
the registry underneath a snapshot that keeps confidently answering with the old one.

The **Compare** tab holds a second build still while you change the first. Pin what you have,
re-gear for twenty minutes, and read what the whole session cost: every headline figure with both
values and the move between them, effective HP per element, and every character-sheet stat that
shifted. A baseline can also be a saved build opened from disk, which is how you compare two
characters rather than two versions of one.

The pinned build is **frozen** — you edit the current one only, and nothing on that tab can write
to the baseline. While one is pinned the three figures in the title bar carry their own deltas, so
the comparison is readable from whichever tab you are working in. It is session state: it lives in
the autosave beside the open document, not inside either build's file.

Twelve tabs — Tree, Stats, Classes, Skills, Items, Damage, Defence, Compare, Config, Capture,
Diagnostics, Data — with the character sheet pinned beside all of them, because the point of a
planner is watching a number move when you click a node. `Ctrl+B` hides the sheet when a panel
wants the width; `Ctrl+1`..`Ctrl+9` reach the first nine tabs directly.

### Building something you can double-click

```bash
npm run dist:app
```

Produces two Windows x64 artifacts in `packages/app/dist/`:

| Artifact | What it is |
| --- | --- |
| `CTE2 Build Planner-<version>-portable.exe` | Runs from anywhere with no install. Keeps its snapshot, textures and settings in a `cte2-pob-data/` folder **beside the .exe**, so the whole thing travels — a USB stick, another machine, wherever. |
| `CTE2 Build Planner Setup <version>.exe` | A conventional installer. Stores its data under `%APPDATA%` like any other app. |

The two keep **separate data**, deliberately: the same machine can run both without one's snapshot
clobbering the other's. Neither reads the repo's `data/snapshot.json` — a packaged build always
starts at the first-run screen and extracts from your own install, which is what `app.isPackaged`
gates in `main/snapshot.ts`.

Nothing here is redistributed game data. The artifacts ship the planner and nothing else; the
snapshot and textures are still produced on your machine from your own copy of the pack.

**Two things to expect.** The artifacts are unsigned, so Windows SmartScreen shows *"Windows
protected your PC"* the first time — More info → Run anyway. And if you launch one from a shell
that has `ELECTRON_RUN_AS_NODE=1` set, it exits instantly and silently: that variable makes the
bundled Electron start as plain node, and it kills a packaged .exe exactly as it kills
`npm run dev`.

### What it shows that a talent picker cannot

**A per-stat breakdown.** Click any stat and get the arithmetic the engine actually ran —
`(base 0 + flat 1189) × (1 + 16%) = 1379.24` — then every contribution that fed it, named:
which item, which perk, which aura. Three things that would otherwise be invisible are called
out where they happen:

- a `MULTIPLICATIVE_DAMAGE` stat holds its MORE modifiers *out* of its value, and says so;
- `elemental_resist` empties itself into the three single elements and zeroes, so it explains
  why it reads 0 while they went up;
- the core-stat pass and the two after-calc passes add numbers no context accounts for, so
  `calculate` now returns them as `EngineResult.derived`.

That last one closed a real gap: a breakdown built from the collected modifiers alone silently
omitted exactly the stats attributes and conversions feed.

**Damage as one hit, labelled as one hit.** `Hit`, `Crit` and `Average` side by side, per
element, with ailments. No DPS, because the game aggregates none and inventing a rate is
phase 3's job.

**Everything the engine is unsure about.** The Diagnostics tab is the validator plus every
warning the pipeline emits — rolls floored at 0%, a capture recording contributions the document
has no field for, conditions no static document can answer. The Config tab lists exactly the conditions *this* build hit and
lets you force each one, rather than enumerating all 308.

### Assumptions it states on screen rather than hiding

Rune and runeword rolls compute at 0%, as does any aura, support gem or food buff whose own roll
the document does not carry. Every damage source a cast produces
gets a row saying how many instances it makes, how many of them the target catches, and whether
that came from the flight simulation, a containment test, or an assumption — with the coverage
editable in place when you know better. And a permanent line in the status bar: **no number has
been checked against the game yet.**

### Where the icons come from

The extractor's `--assets` pass copies `assets/mmorpg/textures/gui/**` (1,610 PNGs, with the
resource pack overriding 76 of the jar's) into the git-ignored `data/`, then resolves gear
sprites out of every jar in `mods/`. **51 perk icons name a texture that is in no archive at
all** — checked by full path and by basename across the jar and every resource pack. That is a
pack bug in the same family as the 466 duplicate GUIDs; the app renders the mod's own
`unknown.png`, which is what the game does.

```bash
# Snapshot and textures together.
node packages/extractor/dist/cli.js --install "<path>" --out data/snapshot.json --assets data/assets
```

### Authoring a fixture is now a button

**Copy JSON** puts the current document on the clipboard in exactly the shape a fixture's
`build` block wants. Paste it in, transcribe `observed` from the in-game stat GUI per
[`fixtures/README.md`](fixtures/README.md), and run `npm run fixtures`. The rule is unchanged:
**never write a number you did not read off the game.**

## Ground truth

The engine is checked against fixtures: a build document plus what the game actually
reported for it. See [`fixtures/README.md`](fixtures/README.md).

```bash
npm run fixtures -- --snapshot data/snapshot.json
```

The runner walks that directory recursively, so captures kept in the git-ignored
`fixtures/local/` are checked by the command above with nothing to point at them. A fixture with
no `observed.stats` — `fixtures/level-1-blank.json`, the committed placeholder — reports
`pending` rather than passing, because folding an unchecked stat into a success is the one thing
this runner must never do.

**What is pinned today.** Two `mod_dump` captures of the same character, at level 1 and at level
100, agree with the engine on **265 of 265 stats** at float precision — ±0.00005 plus 0.001% of
the value, which is roughly twenty times stricter than the stat screen's two decimals. That
covers base stats, level scaling, the core-stat pass, the ported cap table, gear and jewel rolls,
the tree, the class allocation and the `mmorpg_stat_compat` bridge. It does **not** cover damage:
no `observed.damage` block has been captured, so every DPS figure in this repository is still a
derivation nobody has held against the game.

Since phase 2 there is a second, even cheaper capture: **the spell tooltip**. It prints
`mmorpg_value_calc`'s computed number, needs no combat and no companion mod, and checks the
whole base-damage path including the spell-level interpolation. `observed.damage[].baseValue`
is where it goes. Everything else in the damage pipeline multiplies that number, so it is worth
pinning before anything else in phase 2.

Since phase 3 there is a third and much richer one: **the mod's own damage log**. Turn on the
`damage_messages` player config ("Damage Log"), hit something, and hover the combat message. It
prints base damage, every layer with its side and multiplier, every named MORE, the final
number, and the same block per bonus element — which is exactly what the Damage tab now shows,
row for row. One hover therefore checks the whole damage pipeline at once rather than a single
figure at the end of it, and any row that disagrees names the layer to go and look at.

### Regenerating the code-only stat table

Needed only after a mod update. The checkout is read-only and git-ignored; nothing from it is
vendored, since that repo ships no LICENSE.

```bash
git clone --filter=blob:none --sparse --depth 1 --branch 1.20-Forge \
  https://github.com/mahjerion/Mine-And-Slash-Rework reference/mns-src
cd reference/mns-src && git sparse-checkout set src/main/java && cd ../..

npm run port-stats -- --src reference/mns-src --snapshot data/snapshot.json
```

`observed` blocks can be **transcribed by hand from the in-game stat GUI**, which exposes
`current_value`, `usable_value`, `dmg_multi`, `softcap` and `hardcap` per stat — or produced
whole by [`mod/`](mod/README.md), which reads the same numbers out of the synced stat container
and writes a finished fixture. `dmg_multi` is the one that matters most: it is `StatData.m`, so
it makes the `MULTIPLY_STAT` / `MULTIPLICATIVE_DAMAGE` split directly observable — the failure
mode an engine would otherwise hide by matching almost every stat and being wrong on exactly
the ones that decide damage. The mod records it for every stat that has one.

The rule for fixtures is absolute: **never write a number you did not read off the game.** A
fixture containing a calculated value agrees with the engine whether or not the engine is
right, silently.

## What phase 4 established

What the app could not do — import an item, allocate a stat point, wear an omen — plus an open
question from phase 0.5 that turned out to be answerable after all.

### The equipment layout is not an assumption any more

Phase 0.5 left "how many items share a gear slot (two rings?)" open, and the Items tab carried
a banner saying the paperdoll was ours. That was right about the datapack and wrong about the
mod. `characters/CharacterEquipment.java` states the worn loadout explicitly, because switching
characters has to relocate every worn stack:

```java
VANILLA_SLOTS = HEAD, CHEST, LEGS, FEET, OFFHAND      // indices 0-4
CURIO_BLOCKS  = RING(base 5, count 2), NECKLACE(7, 1), OMEN(8, 1)
public static final int SIZE = 9; // 4 armor + offhand + 2 rings + necklace + omen
```

So: one helmet, chest, pants, boots, necklace and offhand, **two rings**, and one mainhand —
excluded from that list precisely because it is the held item rather than a stored one. The
other half of the old note was wrong too: `RefCurios` registers `ring`, `omen` and `necklace`
alongside `master_bag`, and `GearSlot.isItemOfThisSlot` resolves both jewellery slots through
`CuriosApi`.

The omen slot is in that list too, and has a row of its own — see
[The omen](#the-omen-is-a-conditional-set-bonus-not-a-piece-of-gear), which is a different
system rather than a tenth kind of gear.

Two slots are still **deliberately unchecked**: `elytra` and `head` are pack-added
`Jewelry`-family slots matching no `CurioBlock`, so how many a character may wear is genuinely
unanswered. They are reported as "not in any slot" rather than assumed to hold one.

### A two-handed weapon empties the offhand, and the rule is not Mine and Slash's

`two_handed` appears **nowhere in the mod source**. It is a pack tag on exactly three bases —
`greatsword`, `scythe`, `spear` — read by 29 affixes as a roll requirement. What the player
sees comes from **Better Combat**: `PlayerEntityMixin.getEquippedStack_Pre` intercepts
`getItemBySlot`, and when the slot asked for is `OFFHAND` and a two-handed weapon is wielded it
sets the return value to `ItemStack.EMPTY` and cancels. Mine and Slash's `GearData` then reads
an empty offhand like any other, so an offhand item grants **nothing at all** — not a partial
penalty, and not merely a UI block. Hence an error rather than a warning.

The two systems agree only because the pack makes them agree, which is worth recording because
a pack update could break it. The jar ships `bettercombat:staff` and `bettercombat:hammer` as
`two_handed: true` and `cte_configuration` overrides both to `false`; RoE's spear items point at
`bettercombat:trident` (`two_handed: false`) and the same datapack repoints `spear_0..7` to
`bettercombat:spear` (`true`). After those overrides the Better Combat set and the tag set are
the same three bases — so the planner reads the tag out of the snapshot it already extracts,
and parses no Better Combat data at all.

### The omen is a conditional set bonus, not a piece of gear

Craft to Exile 2 renames omens to **Codex** in lang (`item.mmorpg.omen`, `mmorpg.omen.blood` →
"Codex of Blood"), so that is what the app calls them. Nine ship in this pack, all with
`lvl_req: 0.5` — which is a **fraction of `MAX_LEVEL`**, not a level:

```java
ExileDB.Omens().getFilterWrapped(x -> lvl >= GameBalanceConfig.get().MAX_LEVEL * x.lvl_req)
```

so they start dropping at level 50. Reading it as a level would have made every omen legal from
level 1.

An omen is the one thing a character wears that **grants nothing by itself**. It carries
requirements over the rest of the loadout, and `OmenSet` buckets its stats by how many
qualifying pieces each needs — the omen's own `mods` at the full requirement, then each
corruption affix one piece earlier, floored at two:

```java
int index = max;                     // max = sum of every entry in `rarities`
stats.get(index).addAll(getOmen().mods.map(x -> x.ToExactStat(perc, lvl)));
index--;
for (AffixData affix : data.aff) { stats.put(index, affix.GetAllStats(lvl)); index--;
                                   if (index < 2) { index = 2; } }
```

`getStats` then pays out **every** bucket at or below the fill count, not just the best one.
That floor is a real collision rather than tidiness: an omen with more affixes than its
requirement has room for stacks the surplus onto bucket 2, so several unlock together.

**The stat percent is earned, not rolled.** There is no roll on an omen's own mods —
`OmenData.getStatPercent` derives one from how hard the omen is to satisfy, and the class
comments it "the more difficult the omen is to assemble, the more stats it provides":

```java
int num = 0;
for (var en : rarities.entrySet()) { num += en.getValue() * 10; }
num += slot_req.size() * 10;
num *= rar.omens.stat_multi;
```

Two behaviours there are reproduced rather than corrected. `num` is an `int` and `stat_multi` a
`float`, so the compound assignment **truncates** — `70 * 1.25` is 87, not 87.5. And **nothing
clamps it to 100**: `ExactStatData.fromStatModifier` is a bare
`min + (max - min) * percent / 100F`, so a mythic omen with heavy requirements reaches 125 and
puts its mods a quarter above their declared maximum. A `blood` codex at 125% grants +30% health
against a `mods` range that tops out at 25.

**Counting the pieces is subtler than it looks.** `OmenData.calcPiecesEquipped` reads three
rules out of one loop:

- **Requirements are counted over `GearRarityType`, not over rarities.** `common` through
  `mythic` are all `NORMAL`, `runeword` is `RUNED`, `unique` is `UNIQUE` — so "two NORMAL" is
  satisfied by a common and a mythic together.
- **A slot requirement disqualifies, it does not add.** A piece in a named slot whose type does
  not match stops counting entirely; a piece in a slot nobody named is unaffected. They still
  raise the stat percent, by ten each.
- **Each type is capped at what the omen asked for**, and a type it did not ask for is capped
  at zero. So the count can never exceed the threshold, which is what makes "every bucket at or
  below the fill" a sensible payout rule.

And **the mainhand never counts**. `CachedEntityStats.recalcGears` collects `CHEST, FEET, LEGS,
HEAD, OFFHAND` plus every curio slot, with the weapon tracked separately in `recalcWeapon` — the
mod's own source carries the note `// todo note somewhere the weapon isnt included in omen
counting`. The list is also filtered on `isUsableBy`, so a piece above the character's level is
not worn as far as an omen is concerned. Both are ported, and the app says so on the row rather
than leaving a set mysteriously one piece short.

The stats themselves enter as `MiscStatCtx`, i.e. `StatCtxType.MISC`, alongside gear and base
stats — an omen gets no context type of its own and no special treatment after collection. All
of the interesting behaviour is in deciding which of its stats are live.

Generation bands (`GearRarity.omens`, an `OmenDifficulty` per rarity) are checked as
**warnings**, not errors: `OmenBlueprint` is the only thing that enforces them, and
`upgrade_omen_rarity` and `RerollOmenStatsItemMod` modify an omen after it drops, so a
combination outside a band is suspicious rather than impossible. What *is* an error is a slot
requirement naming a weapon — `Omen.getRandomSlotReq` excludes weapons outright ("they're a lot
of times swapped") and the counter never reads the mainhand, so such a requirement could never
be satisfied by anything.

### Stat points

`PlayerData.statPoints` is a `HashMap<String, Integer>`, and the build document now carries it
verbatim as `character.statPoints`. Three rules, all ported rather than guessed:

- **Which stats.** `AllocateStatPacket.onReceived` rejects anything that is not a `CoreStat`,
  and `CoreStat.SER_ID` is `core_stat` — exactly `strength`, `dexterity`, `intelligence` in this
  pack. The 20 `bonus_stat_per_effect` stats carry a `core_stat_data` block *without* being
  core stats, so matching on the block rather than the serializer would have put
  `aoe_per_power_charge` in the allocation screen.
- **How many.** `base_points + (int)(lvl * points_per_lvl)` capped at `max_total_points` — one
  per level, capped at 300, plus up to 50 bonus points from sources a build document cannot
  record. Spending into that band warns; spending past it errors.
- **What one is worth: +1, at every level.** `StatPointsData` passes a hardcoded level of `1`
  to `ExactStatData.levelScaled`, and `CORE_STAT_SCALING` is `1 + 0.05 * (lvl - 1)`, which at
  level 1 is exactly 1. Levelling grants more points; it never inflates the ones already spent.

What a point *does* needed no new code: `CoreStat.affectStats` expands the attribute into its
bundle during the engine's existing core-stat pass, so flat strength arriving in its own
`STAT_POINTS` context is the whole of the job.

### Items can be pasted in

Entering a level 94 amulet by hand is a base, a rarity, a level, four affixes, four tiers and
four roll percents — and the roll percent is a number **no player can read anywhere**, because
tooltips print values. So the importer takes the things the game will show you, and detects which
one it got:

- **This app's own item JSON**, which the `⧉ JSON` button on every gear row copies. Exact by
  construction — it is the document shape — so the reader's whole job is checking that the ids in
  it still exist in the loaded snapshot, and saying which do not. It is how an item moves between
  two builds, and the same shape a fixture holds.
- **The item NBT**, from `/data get entity @s SelectedItem`. `LoadSave.Save` is
  `gson.toJson(object)` stored as a string under the item's `mmorpg_gear` tag, so the affixes
  arrive as `{ id, rar, p }` — field for field the `AffixRoll` this project already stores.
  Exact, nothing inferred.
- **The tooltip**, which is invertible but only with **Shift held**.
  `GearTooltipUtils.BuildTooltip` branches on `showMerge = !useInDepthStats()`, and without
  Shift every affix, implicit and unique stat is summed into one unsectioned list — two
  +11 Dexterity affixes become one +22 line, and nothing recovers which two. With Shift you get
  sections plus the suffix `NormalStatTooltip.getPercentageView` appends:
  `+3.2% Attack Hits Health Leech [3.1 - 3.7] [Epic]`, where the brackets are the affix's own
  tier band at the item's level and the trailing name is that tier — not the item's rarity.

### Building an item takes five clicks, not twenty-five

A rare with every roll at the top of its band is: press the slot's add button, name the base, set
the item level, `fill to 3 at max`, `roll this whole item at max`. The editor used to make you do
that one slider at a time, starting every affix at its band **floor** — so an item you had not
finished was not merely unrolled, it was the worst version of itself.

Every one of those controls reads a band rather than a number. An affix is bounded by **its own
tier's** `stat_percents`, which is not the item's rarity and not the same as its neighbour's; base
stats by the rarity's `base_stat_percents`, which is why a unique never rolls below 75; implicits,
unique stats, runes and the runeword by the full 0–100, because `ImplicitStatsData` is the one
gear part that does not override `getMinMax`. "Set everything to 100" would describe items the
game cannot produce, so nothing here does that. `roll this whole item` is one undo step for the
lot.

**The roll comes out level-free.** `ToExactStat` interpolates the band and then applies a level
multiplier to the whole thing, so the displayed value is linear in the roll percent and

```
roll = bandMin + (value - rangeMin) / (rangeMax - rangeMin) * (bandMax - bandMin)
```

needs neither the item level, the stat's scaling class, nor our port of the balance curves. An
import therefore cannot go wrong by disagreeing with any of them.

**What it cannot do exactly, it says.** `NumberUtils.formatForTooltip` prints one decimal below
the client's decimals threshold and **truncates** above it, so `[90 - 109]` means the real
endpoints are somewhere in `[90, 91)` and `[109, 110)`. The reader propagates those windows
through the same arithmetic and returns the feasible *interval*, takes its midpoint, and
attaches a diagnostic naming the uncertainty whenever it is wider than a percentage point. A
roll it cannot pin down is a warning, never a silently confident number.

One further trap the name index had to avoid: **the pack's code-only stats** (389 in the
current snapshot) have a display name but no registry entry, and
they are exactly the ones affixes grant — every regen, the resists, armour, dodge. An index
built by walking `mmorpg_stat` fails to recognise `Magic Shield Regen`, which is on half the
jewellery in the game. It is built from the lang keys instead, which name every stat whether or
not the registry has one.

Checked against the screenshot that prompted the feature — a *Promised Lapis Amulet of the
Wind* — the reader recovers `promised`, `lapis_amulet` and `of_the_wind` independently from
three separate stat lines, which reconstructs the item's own name, and the result passes the
validator with zero diagnostics.

### Rolls are edited as the number on the item

The affix editor showed `modifierLine`, which reads the **un-levelled** data — a `+2 to +4`
affix rendered as `+3` beside an item the game prints `+147` on, because everything on an item
scales at the item's level. The stat lines now run the engine's own `rollToExact`, so they are
the numbers the character sheet will use, and each one is an input: typing the value solves
back for the roll percent, by the same inverse-lerp the importer uses. The slider gained unit
steppers and a typed percent box, because a tier band is 17 whole values wide and landing on
one by dragging a 110px track was the one genuinely fiddly interaction left.

### Uniques are chosen first, not last

The unique picker listed only uniques matching the item's current base, which is backwards: a
player choosing Honourhome wants Honourhome, not "a chainmail helmet, and now filter". It lists
every unique in the pack, and selecting one moves the item to it — `UniqueGear.base_gear`
becomes the base and the unique rarity becomes the rarity. Those were never independent
choices; `validateUnique` rejects every other combination, so offering them was only offering a
way to be wrong.

### Classes

`SpellSchoolScreen` is now a tab, and the schools behind it are modelled end to end — schema,
validator, engine and UI.

A school is not a talent tree, and treating it as one would have been wrong in four ways at
once. **Nothing connects to anything**: what gates a perk is the character's level against its
row, `lvl_reqs[point.y]`. **Perks have levels, not allocations** — `learn()` increments, and a
perk at level N grants N times its stats (`percentIncrease = (lvl - 1) * 100` then
`increaseByAddedPercent`, which is `v1 *= 1 + pct/100`). **There are two point pools**, spells
and passives, budgeted separately. And **one school pays a bonus** — +10% MORE total damage,
+5 damage reduction — kept deliberately out of the `PASSIVES` context so nothing that scales
passives can reach it.

**A spell's level is a stat.** A spell perk's only stat is `learn_<spellId>`, and
`SpellCastingData.calcSpellLevels` reads the container back out:

```java
if (x.GetStat() instanceof LearnSpellStat learn)
    addSpell(new InsertedSpell(learn.spell.GUID(), (int) x.getValue()));
```

So allocating on this screen is what sets every spell rank, which is what the damage pipeline
interpolates its value calculations against. `skills[].level` left unset now resolves from the
class allocation rather than falling back to `default_lvl`. What the engine still cannot derive
is the bonus ranks `MaxSpellLevel` and `MaxAllSpellLevels` add after the container is built —
so the mod records `InsertedSpell.rank`, the game's finished answer, and a capture sidesteps the
whole question.

The page reproduces the screen's own geometry: ten columns by seven rows with **y counting up
from the bottom**, which is the `guiTop + 178 - (point.y * SLOT_SPACING)` in `init()`.

### Fields added so a capture has somewhere to land

Everything the exporter could read but the document could not hold now has a field, and the
engine either uses it or says it does not:

| Field | Why it exists |
| --- | --- |
| `character.schools` | `SpellSchoolsData.allocated_lvls`, verbatim — perk id to level |
| `character.pointTotals` | The game's own totals per pool, including the bonus points no document can derive. The validator trusts it over its own ceiling |
| `character.omensFilled` | The game's own count, so the engine's derivation can be checked against it rather than trusted |
| `Item.quality` | Added to the base roll the way `BaseStatsData.GetAllStats` adds it, but kept separate so a 40% roll on a quality item is not confused with a 60% roll |
| `Item.runewordRoll` | `GearSocketsData.rp`; without it a runeword computes at 0% |
| `Jewel.corruptions`, `Jewel.unique`, `Jewel.auraStats` | Corruption affixes, crafted uniques such as a Watcher's Eye, and aura-conditional stats |
| `SupportLink.rollPercent`, `SupportLink.rarity` | Each support gem's own `SkillGemData.perc` and `.rar`. Five gems linked into one Skill are five independent rolls, and the Skill's own percent is not one of them. The rarity grants nothing directly — it is the band the roll was drawn from |
| `AuraSetup.rarity` | The same pair on an Augment, which is a `SkillGemData` too |
| `foodBuffs` | `PlayerBuffData.map` — the meal, seafood and elixir slots. `StatBuff.getStats` rolls at `perc + lvl`, so a level 100 food lands a full band-width past its own maximum |

## Next

**A capture**, before anything else — see above. Every line of the engine is currently
justified by the Java it was ported from and by nothing else.

**Phase 4** — defence. Magic shield, mana absorption, block, dodge, suppression and
`HealthUtils.realToVanilla` all sit past the damage number, and an EHP figure needs the damage
pipeline pointed the other way round: the character as the target rather than the source. The
event already runs both sides, so this is mostly a matter of building the *attacker* from
`mmorpg_entity` + `mmorpg_mob_rarity` + map tier — which is the same second stat calculation
`config.enemy` currently avoids, and the reason it avoids it.

Known gaps after phase 3, marked in the code rather than assumed away:

- **Line of sight is assumed clear.** `AoeSelector.canHit` ray-casts from the damage origin to
  each candidate, so terrain between you and a target removes hits the geometry model counts.
  That depends on the world, not on the build.
- **A mob is assumed to stand still.** The flight simulation moves the projectiles; nothing moves
  the target. For a stationary carrier — a ground effect, a totem — coverage is the whole
  duration or none of it, and the row says so.
- **Pierce and chain are reported, not counted.** A piercing projectile hits more than one enemy
  and a chaining one jumps; how many of those jumps come back to the same target is the same
  geometry question, and `DMG_REDUCT_PER_CHAIN` would have to apply per jump.
- **Attack speed has no path.** Basic attacks read vanilla `Attributes.ATTACK_SPEED` and turn
  waited-versus-required ticks into a damage multiplier (`DamageEvent.calcAttackCooldown`), which
  is a different rate model from a spell's cast cycle and is not implemented. Every DPS figure is
  currently a spell's. Spell *cast* speed, which is a different thing, is now modelled in full.
- **Totem, banner and summon uptime.** `on_spell_stat_calc` produces `max_totems`,
  `max_banners`, `bonus_total_summons` and `duration_multi`; nothing consumes them, so a totem
  build's real output is understated.
- The skill gem's own mana-cost multiplier (`SkillGemData.getManaCostMulti`) is not in the build
  document, so resource cost is the level-scaled base only.

- Rune and runeword rolls are not fields in the build document, so those are computed at 0% — a
  floor, with a diagnostic saying so. `SupportLink.rollPercent`, `AuraSetup.rollPercent` and
  `FoodBuffSetup.rollPercent` closed this gap for the gems; the same fix would close these two.
- **The 78 `proc_spell` and 67 `give_exile_effect` stat effects are real output this number
  does not include.** "Your hit also casts a fireball" is damage; modelling it means running a
  second spell's whole pipeline and deciding how often it fires. Each one encountered is
  reported by name rather than dropped.
- **The enemy is declared, not derived.** `config.enemy` states armour and resists directly
  rather than building a mob from `mmorpg_entity` + `mmorpg_mob_rarity` + map tier. That keeps
  a damage mismatch attributable to the damage pipeline instead of to a second unverified stat
  calculation underneath it.
- Magic-shield and mana absorption, and `HealthUtils.realToVanilla`, sit past the damage number
  and belong with defence/EHP rather than here.
- Item quality (`getQualityBaseStatsBonus`), offhand stat utilisation
  (`PERC_OFFHAND_WEP_STAT`, a server config) and `mmorpg_stat_compat` (vanilla
  attribute/enchant compatibility) are not modelled.

The **companion Forge mod has landed** — see [`mod/README.md`](mod/README.md). It was deferred
until after phase 3 on the assumption that the dump half needed a server-side design, which
would have been unusable on this install: `saves/` is empty and `servers.dat` is not, so the
character worth capturing lives on a server where nothing here is an operator.

That assumption was wrong in a useful way. **Everything a dump needs is already on the client**,
because the client has to draw it: `EntityData.addClientNBT` calls `UnitNbt.Save` for players
(the whole calculated `StatContainer`, as `{id, value, moreMulti}`), `PlayerData.syncData` sends
the capability to its owning player (talents, stat points, schools, gems, auras, jewels), and
gear rolls live in each stack's own NBT because `GearItemData.BuildTooltip` is
`@OnlyIn(Dist.CLIENT)`. So the mod is client-only, sends nothing, and needs no permission —
which also settles the two blockers on the item importer above: a tooltip cannot be copied in
vanilla at all, and `/data get` is permission level 2.

Nothing transcribed by hand is wasted: the mod emits the same `observed` shape, tagged
`mod_dump` rather than `stat_gui`.

That capability immediately exposed the document's largest hole, which is now closed: **spell
school allocations grant stats, and set every spell's rank, and there was no field for any of
it.** See "Classes" below.

Build note: Forge 1.20.1 targets **JDK 17**, but Gradle itself must run on 17 or 21 — the
system default here is 25, which Gradle 8.13 refuses.
