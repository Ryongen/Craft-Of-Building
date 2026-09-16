# Ground-truth fixtures

A fixture is a **build document** plus **what the game actually reported for it**. The
engine is checked by recreating a character here, running it, and diffing against the
numbers in `observed`.

An `observed` block is either transcribed by hand from the in-game stat GUI, or written whole by
the companion Forge mod in [`mod/`](../mod/README.md): press F6 in game and it drops a finished
fixture — `build` and `observed` both — into `<instance>/cte2-pob-exports/` and onto your
clipboard, tagged `source: "mod_dump"`. It reads the same stat container the GUI draws from, so
the two agree by construction; what it adds is that it also writes the `build` half, including
the affix roll percents that no screen in the game displays.

The rule below is unchanged by that. The mod records only what it can read and lists what it
could not in `exporter.warnings` — it never fills a gap with a plausible number.

## The rule

**Never write a number into `observed` that you did not read off the game.**

Not a number you derived, not one the tool produced, not one that "must be right". A fixture
containing a calculated value is worse than no fixture: it will agree with the engine
whether or not the engine is correct, and it will do so silently. If you have not captured
a stat yet, leave it out.

This is the whole reason the file has a `source` field.

## Capturing a fixture

1. **Build the character in-game.** Whatever you want to pin — a fresh level 1, an ailment
   build, one with a `MULTIPLICATIVE_DAMAGE` stat carrying a MORE modifier.
2. **Write down the build.** Every allocated tree node as `[row, col]`, every item's base,
   rarity, item level, and each affix with its own tier and roll percent. The tier is the
   affix's own rarity, not the item's — a mythic item can carry a common-tier affix.
3. **Open the stat GUI and transcribe.** For each stat use the info buttons:

   | Button | Field | What it is |
   | --- | --- | --- |
   | `current_value` | `currentValue` | `StatData.v1` — the headline number. Always record this. |
   | `dmg_multi` | `dmgMulti` | `StatData.m`. **Record this whenever the button shows one.** |
   | `usable_value` | `usableValue` | The percentage as displayed: `40.0%` is `40`, not `0.4`. |
   | `hardcap` | `hardcap` | Only when it shows a number — see below. |

   Four things about that screen, all read out of `StatInfoButton.java`, that decide what you
   will and will not see:

   - **`dmg_multi` only appears on a `MULTIPLICATIVE_DAMAGE` stat whose multiplier is not 1**
     (`shouldShow`). Its absence is therefore information too, not an oversight.
   - **`usable_value` only appears on the four `IUsableStat` stats** — `armor`, `dodge`,
     `spell_dodge` and the resists. It is the diminishing-returns curve: armor 4,000 becoming
     40% mitigation.
   - **`hardcap` reads `Inf` for most stats**, because it prints `Inf` for anything at
     `STATICS.MAX_FLOAT` and that is the default. Record it only when it shows a real number;
     leave the field out when it says `Inf` rather than transcribing 100000000, which is a
     decoding rather than a reading.
   - **`softcap` never appears at all.** Nothing in the mod calls `setSoftCap` — grep the
     source and the only hit is the setter's own definition — so `hasSoftCap()` is false for
     every one of the 1,153 stats. The field exists in this format for the day that changes.

   The screen only lists stats the container actually holds, so a stat nothing contributed to
   is absent rather than zero. The engine behaves the same way.

4. **Validate it**: `npm run fixtures -- --snapshot data/snapshot.json`. A fixture that does
   not describe a legal character is not ground truth, it is a typo.

## Capturing damage: use the damage log

Since phase 3 there is a much better capture than the stat GUI for anything about damage.

Turn on the **Damage Log** in the player config (`damage_messages`), hit something, and hover
the combat message in chat. `DamageEvent.getInfoHoverMessage` prints:

```
Spell: Fireball
Fire:
Base Damage: 1240
Damage Info:
  [Source]: Flat Damage: +182
  [Source]: Additive Damage: x2.35
  [Target]: Elemental Mitigation: x0.25
Multipliers:
  Stat: More Fire Damage: x1.20
Final Damage: 1092

- Bonus Damage Types:
  ... the same block per element ...
Total Combined Damage: 1310
```

That is the Damage tab's breakdown, row for row — the app was built to match it precisely so
the two can be compared line by line. One hover therefore checks the base value, every layer,
the layer *order*, and every MORE at once, and a mismatch names the layer to go and look at
rather than leaving a single wrong total at the end.

Record it with `"source": "damage_log"`. Two things to keep in mind while transcribing:

- **The log rounds to whole numbers** (`(int)` casts on base and final damage), so pin the
  layer multipliers, which are printed to the mod's own decimal format, rather than inferring
  them from the two rounded endpoints.
- **Ailment damage is shown when it is applied, not when it hurts** — the log says so itself.
  A DoT line is not part of the hit's `Total Combined Damage`.

### Precision depends on how you captured it

**The runner compares a transcription and a dump at different tolerances**, because they are not
equally precise. `observed.source` is what picks the rule, and the fixture's header line in the
output says which one applied.

| Source | `currentValue` / `dmgMulti` | Why |
| --- | --- | --- |
| `stat_gui` | ±0.005 | `DecimalFormat("0.00")`. Half the last printed digit is as precise as a transcription can honestly be — `usable_value` prints one decimal, so it gets ±0.05 |
| `damage_log` | ±0.5 on a hit | The log casts to `int` at several points in `ValueCalculation` |
| `mod_dump` | ±0.00005 **+ 0.001% of the value** | The number is the float the game held, read out of the synced container. Nothing formatted it |

So record exactly what the screen shows when you are transcribing — nothing is gained by adding
digits the screen did not print, and the runner will not read them.

**Why the dump's bound has a relative term.** Mine and Slash computes in 32-bit `float`
throughout and this engine computes in doubles, so the two drift by a fraction of the value
rather than by a fixed amount. At 18 attack speed that allows 0.00023 — twenty times stricter
than the stat GUI's rule, which is the point. At 50,000 health it allows 0.5, which only sounds
loose until you notice that a single float32 step at that magnitude is already 0.0039: a flat
±0.005 there was demanding agreement finer than the game can represent, and would have failed a
correct engine rather than caught a wrong one.

Caps stay exact for every source. They are integers read off the stat registry rather than
computed, so loosening them would only hide a wrong entry in the ported code-only stat table.

A mismatch line prints how far off it was and how far off it was allowed to be:

```
mismatch mana.currentValue: expected 50.1, got 50  (off by -0.1, allowed 5.51e-4)
```

### Why `dmg_multi` matters more than it looks

`InCalcStatData.getCalculated()` splits a stat in two:

```java
float mu = 1;
if (GetStat().getMultiUseType() == Stat.MultiUseType.MULTIPLICATIVE_DAMAGE) { mu = Multi; }
return new StatData(this.id, calcValue(), mu);
```

and `StatData.getValue()` returns the value **without** `mu`. So for the ~150 stats marked
`MULTIPLICATIVE_DAMAGE`, MORE modifiers never reach the number on the sheet — they are
carried separately and applied at the damage layer.

An engine that folded MORE into the value everywhere would match `currentValue` on nearly
every stat and be quietly wrong on exactly the ones that decide damage. Recording both
fields is what makes that failure visible instead of invisible. Prioritise stats where a
MORE modifier is involved.

## File shape

```jsonc
{
  "name": "unique-name",
  "notes": "what this fixture is meant to pin",
  "build": { /* a BuildDoc — see packages/schema/src/build-doc.ts */ },
  "observed": {
    "source": "stat_gui",            // or "mod_dump" once the mod exists
    "capturedAt": "2026-08-16",
    "mineAndSlashVersion": "1.20.1-6.4.7",
    "packVersion": "2.0.2",
    "stats": [
      { "statId": "armor", "currentValue": 0, "usableValue": 0 }
      // ^ statId is an mmorpg_stat id; the numbers are whatever the game showed you.
      //   Omit any field the screen did not show for that stat.
    ],
    "damage": [
      // Optional. Only present when you captured damage as well as the stat sheet.
      {
        "spellId": "fireball",
        "baseValue": 95,               // the spell tooltip's number
        "hit": 64,                     // one non-critical hit
        "crit": 129,                   // one critical hit
        "ailmentPerSecond": { "burn": 31.7 },
        "targetNotes": "training dummy, 50 fire resist, 0 armor"
      }
    ]
  }
}
```

Versions are recorded per capture because they are what tells you a fixture has gone stale
after a pack update, rather than the engine having regressed.

## Capturing damage

Damage is checked separately from the stat sheet, and one of the four readings needs no combat
at all — which makes it the cheapest real check this project has.

1. **`baseValue` — the spell tooltip.** Hover the skill. `ValueCalculation.getShortTooltip`
   prints the computed value, and holding **shift** breaks it into the base term and each stat
   scaling. This is `mmorpg_value_calc` end to end: spell-level interpolation, character-level
   scaling, the weapon-damage cap. Nothing needs to be hit. Capture this first, and capture it
   at two different spell levels — that is what pins the interpolation denominator, which is
   `max_lvl + MAX_BONUS_SPELL_LEVELS` (24 for most spells here, not 16).
2. **`hit` — one non-critical hit on a known target.** Record the target's resists and armour
   in the build's `config.enemy`, and say what it was in `targetNotes`. This checks the layer
   stack.
3. **`crit` — one critical hit of the same skill on the same target.** The engine reports crit
   and non-crit as separate numbers precisely so this is checkable; an averaged figure would
   agree with nothing observable.
4. **`ailmentPerSecond` — one second of a damage-over-time ailment.** Bleed or burn on a
   stationary target. This checks the per-second amortisation, which is the one piece of
   ailment maths with no other witness.

Two cautions specific to damage:

- **A crit is not "the biggest number you saw."** Several stats roll independently — double
  damage, block, ailment procs — so a spread of numbers is expected. Capture a hit you can
  attribute, ideally on a build with as few chance-based stats as possible.
- **`config.enemy` in the fixture must describe the thing you actually hit.** The engine takes
  those numbers as given; they are an assumption, not a derivation, so a fixture whose declared
  target does not match the real one is not ground truth about anything.

The rule at the top of this file applies unchanged: an `observed.damage` block containing a
number the engine produced will agree with the engine whether or not the engine is right.

## Which fixtures are worth capturing

Roughly in order of how much they pin per minute spent:

1. **`level-1-blank`** — base stats and level scaling, with nothing else in the way.
2. **A stat with a MORE modifier on a `MULTIPLY_STAT` stat** (e.g. `bleed_damage` via a
   MAJOR perk) — pins that MORE folds into the value there.
3. **A stat with a MORE modifier on a `MULTIPLICATIVE_DAMAGE` stat** (e.g.
   `all_physical_damage`) — pins that it does *not*, and shows up in `dmgMulti` instead.
4. **A `one_to_other` derived stat whose adder is `MULTIPLICATIVE_DAMAGE`** — the 14 stats
   that provably truncate a MORE. This is the subtlest known behaviour in the pack.
5. **A duplicated-GUID entry** — 466 ids are registered twice with differing content, and
   which copy wins is resource-iteration order, which the extractor currently only
   approximates. A dump settles it.
6. **A spell tooltip at two spell levels** — see above. No combat, and it pins the whole of
   `mmorpg_value_calc` including the interpolation denominator.
7. **A resist above 75%** — `usable_value` on a resist should read 75, not the resist itself,
   because `ElementalResist.getUsableValue` caps at 75 plus that element's max-resist stat.
   Phase 1 got this wrong and phase 2 corrected it; a capture is what settles it for good.
8. **Your actual character**, at whatever level it is. The broadest coverage per capture.

## `local/`

`fixtures/local/` is git-ignored. Put captures there that contain anything you would rather not
publish — a real character's gear and tree are nobody else's business, and the exporter writes
both.

**The runner reads it.** It walks the fixture directory recursively, so a capture dropped in
`local/` is checked by a plain `npm run fixtures` with nothing to point at it. What stays out of
the repository is the file, not the check. `*.raw.json` — the exporter's companion dump of every
equipped stack's NBT — is skipped, because it is not a fixture.
