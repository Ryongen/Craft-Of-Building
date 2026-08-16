# cte2-pob

A Path of Building for **Craft to Exile 2** — a standalone desktop build planner with a
real damage model, not just a talent picker.

Status: **phase 0 in progress.** The extractor works end to end; the engine does not exist yet.

## Why this exists

CTE2 is built on [Mine and Slash](https://github.com/mahjerion/Mine-And-Slash-Rework) and
reproduces most of PoE's build-defining systems. The existing
[cte2-planner](https://github.com/Cofeiini/cte2-planner) covers the passive tree well but
has no gear, no skills and no damage model, so it cannot answer "what is my DPS".

Full reasoning, cost breakdown and the mechanics traced out of the mod source live in the
plan document that produced this repo.

## Layout

| Package | License | What it does |
| --- | --- | --- |
| `packages/extractor` | MIT | Reads a CTE2 install, merges every `mmorpg` registry, emits a snapshot |
| `packages/engine` | MIT | Stat container + damage pipeline (not started) |
| `packages/app` | GPL-3.0 | Electron shell + forked cte2-planner UI (not started) |
| `mod/` | — | Forge companion mod for ground-truth dumps and character import (not started) |

`cte2-planner` is GPL-3.0, so anything derived from its UI is GPL-3.0. `engine` and
`extractor` are kept MIT and free of its code so they stay reusable on their own; MIT
combines cleanly into a GPL work.

## Running the extractor

```bash
npm install
npm run extract -- --install "G:/PrismLauncher/instances/Craft to Exile 2 - 2.0.2 Atlas Update" --out data/snapshot.json
```

`--install` accepts either the Prism instance folder or the game directory. Add
`--verbose` to list every diagnostic instead of a sample. **The modpack folder is only
ever read from.**

Exit code is non-zero when a schema-level surprise appears (unknown stat serializer,
unknown `multiUseType`, unknown modifier type, unparseable file) — so it can gate CI on a
pack update. Pack-quality issues like duplicate GUIDs are reported loudly but do not fail
the run.

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
- **5,564 lang keys**, with the pack's `resources.zip` copy overriding the jar's.

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

- **466 duplicate GUIDs**, overwriting silently (no in-game warning; the single
  `random_roll` warning in the log comes from a different code path). Mostly the same
  entry shipped twice with **differing content** — at a category root and again in a
  subfolder, e.g. `mmorpg_spells/armageddon.json` vs
  `mmorpg_spells/0_8_elementalist/armageddon.json`. Which copy wins is resource-iteration
  order and is **not yet verified** — it needs a ground-truth dump.
- **263 id/filename mismatches**, several of them clear copy-paste bugs:
  `mmorpg_affixes/implicit/reapers_scythe.json` declares `necromancers_scythe`;
  `mmorpg_entity/specific_mobs/minecraft_husk.json` declares `minecraft:zombie`.
- **8 files are not valid strict JSON** — the talent trees and atlas layout embed grids
  as strings containing raw newlines. Gson tolerates it; `JSON.parse` does not. See
  `lenient-json.ts`.

## Next

Phase 0.5: define the dump schema, then the Forge companion mod. The engine is
deliberately not started until there is something to check it against — several
conclusions above only became correct after being pushed on, and the pattern is not one
to trust unverified.

Note for the mod build: Forge 1.20.1 needs **JDK 17**.
