# CTE2 PoB Exporter

A client-side Forge mod that writes the character you are playing — and the stat sheet the
game calculated for it — to one JSON file that `npm run fixtures` reads as ground truth.

It needs no operator level, no server install and no cooperation from the server.

## Why this works without permissions

The two things a build importer needs are already on your client, because the client has to
draw them:

| What | Where it comes from | Read here by |
| --- | --- | --- |
| The finished stat sheet | `EntityData.addClientNBT` calls `UnitNbt.Save` for players, writing every entry of the calculated `StatContainer` as `{i, v, m}` | `ObservedExport` |
| Level, talents, stat points, spell schools, gems, auras, jewels | `PlayerData.syncData` serialises the capability and sends it to the owning player | `BuildExport` |
| Every affix, tier and roll percent on your gear | Each `ItemStack`'s own NBT under `mmorpg_gear` (`StackSaving.GEARS`) — `GearItemData.BuildTooltip` is `@OnlyIn(Dist.CLIENT)`, so the client cannot draw a tooltip without it | `GearExport` |

So this mod sends no packets, runs no commands and asks the server for nothing. That is the
whole point: `/data get entity @s SelectedItem` is vanilla permission level 2 and is refused on
any server where you are not an operator, and there is no way to copy a tooltip in vanilla at
all. Neither limitation applies to reading data the server already sent you.

**The roll percent matters most.** It is a number no player can read anywhere in game —
tooltips print values, not rolls — and `AffixData` stores it as `{id, rar, p}`, which is field
for field the `AffixRoll` the build document wants. Nothing is inverted out of a displayed
number, so nothing can be inverted wrongly.

## Build

Needs a JDK that Gradle 8.13 can run on — **17 or 21, not 25**. On this machine:

```bash
cd mod
JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.7.6-hotspot" ./gradlew build
# -> build/libs/cte2pob-exporter-1.20.1-0.2.0.jar
```

It compiles against the pack's own production jars rather than a published API, because Mine
and Slash publishes none. `gradle.properties` points at the instance:

```properties
cte2_mods=G:/Minecraft FTB Instances/craft to exile 2 vr support (2)/mods
mns_jar=Mine_and_Slash-1.20.1-6.4.5.jar
exile_jar=Library_of_Exile-1.20.1-2.1.9.jar
curios_jar=curios-forge-5.14.1+1.20.1.jar
```

Override without editing the file: `./gradlew build -Pcte2_mods="D:/other/instance/mods"`. The
jars are `compileOnly` and never bundled — nothing from Mine and Slash is redistributed here.

Those jars carry SRG names for the vanilla methods they inherit, while this code is compiled
against official mappings and reobfuscated on build. That only bites where a Mine and Slash
class inherits a vanilla method, so every such access goes through the vanilla type instead —
see `Equipment`, which reads armour with `getArmorSlots()` rather than reaching into the
inventory.

## Install

Drop the jar in the instance's `mods/` folder. It is client-only: `displayTest` is
`IGNORE_ALL_VERSION`, so a server without it will still let you connect, and there is no reason
to install it on one.

## Use

- **F6** — rebindable in Controls, under *CTE2 PoB Exporter*.
- **`/pobexport`** — a *client* command, registered through `RegisterClientCommandsEvent`, so it
  is dispatched locally and never reaches the server.
- **`/pobexport "2.0.2"`** — the same, passing the pack version. Nothing in game exposes it (a
  modpack version is launcher metadata), so unless you pass it the field reads `unknown` and the
  export says so. It is what tells a stale fixture from a regression after a pack update.

Two files land in `<instance>/cte2-pob-exports/`, and the first also goes to your clipboard:

| File | What it is |
| --- | --- |
| `<name>-lvl<n>-<stamp>.json` | A complete fixture: `name`, `build`, `observed` with `source: "mod_dump"`. Drop it in `fixtures/local/` and run `npm run fixtures` — nothing needs editing. |
| `<name>-lvl<n>-<stamp>.raw.json` | Every equipped stack's raw NBT, the same text `/data get` would print. Kept so a capture never has to be taken twice when the mapping below improves. |

`fixtures/local/` is git-ignored, which is where a capture of a real character belongs.

## What it will not do

It records what it can read and names what it cannot, in `exporter.warnings` in the file. It
never fills a gap with a plausible number: a fixture containing an invented value agrees with
the engine whether or not the engine is right, and does so silently.

Known gaps, all of them reported per export rather than assumed away:

- **The stat sheet has totals only.** The sync carries `{value, moreMulti}` per stat and no
  per-source breakdown, so a mismatch names the stat, never the modifier that caused it.
- **`usableValue` is computed here**, by calling the game's own `IUsableStat.getUsableValue` on
  the game's own `Stat` — the same call the stat GUI makes. It is not a sixth field in the sync.
- **An implicit has no tier.** `ImplicitStatsData` applies its percent directly with no band, so
  the `tier` written is the item's rarity. It changes no number — the engine reads only
  `affixId` and `rollPercent` — but it is not a reading.
- **Aura-conditional jewel stats** are exported (`Jewel.auraStats`) but the engine does not apply
  them yet: they only count while the gating aura is running.
- **Which skill is `main`** is left unset. That is a choice about what you want DPS reported
  for, not a fact about the character.
- **The map atlas** (`AtlasData.unlockedNodes`) is not tree coordinates and is not exported.
  `tree.atlas` is the `atlas_passives` talent tree, which is a different thing.

### What it does export that no screen shows you

- **Class allocation** — `SpellSchoolsData.allocated_lvls` verbatim, perk id to level. Because a
  spell perk's stat is `learn_<spellId>`, this is also every spell's rank.
- **The game's own spell ranks** — `InsertedSpell.rank`, which is the `learn_` stat plus the
  bonus ranks from `MaxSpellLevel` / `MaxAllSpellLevels`, already clamped. The engine can derive
  the first half and not the second, so recording the finished number is what makes spell damage
  checkable.
- **Point totals per pool** — `getFreePoints + getPointsInUse`, which includes the quest and item
  bonus points no document can derive from a level. The validator trusts it over its own ceiling.
- **Quality, separately from the base roll.** The game adds them (`p + getQualityBaseStatsBonus`)
  and so does the engine, but kept apart a 40% roll on a 20-quality item stays distinguishable
  from a 60% roll on a plain one.
- **The runeword's roll** (`GearSocketsData.rp`), read out of the item's own saved JSON because
  the field is private with no accessor.

## Untested in game

Everything above is checked as far as it can be checked outside Minecraft: it compiles against
the pack's real jars, and the exact field set it emits validates as a **legal** fixture against
this repo's own validator, with zero errors and zero warnings. It has not yet been run in the
game. The first export is the thing worth doing next.
