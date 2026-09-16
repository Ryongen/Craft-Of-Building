/**
 * Skills and their support gems.
 *
 * The invariant worth watching here: a support gem almost never changes the character sheet. The
 * game keeps a separate stat unit per spell, and the sheet is the no-spell path — so linking
 * "more fire damage" moves the damage number and leaves the sidebar untouched. That is correct,
 * and the panel says so rather than letting it read as a bug.
 *
 * *Almost*, because four gems in this pack carry a `give_exile_effect` stat — Fortify and the
 * three charge-on-hit gems. Availability is derived from what the build can put up, so socketing
 * one of those adds an effect whose own stats do land on the sheet. `supportGemAffectsSheet` is
 * the engine's answer to which, and `SupportGemPicker` reads it rather than assuming either way.
 *
 * `cast_time_ticks`, `cooldown_ticks` and `mana_cost` are shown as the facts they are and are
 * deliberately not combined into a rate. See the Damage panel.
 */

import {
  CATEGORY,
  MAX_ACTIVE_SKILLS,
  activeSkillCount,
  entry,
  modifierLine,
  spellDesc,
  spellName,
  isSkillEnabled,
  supportLinks,
  learnedSpells,
  maxBonusSpellLevels,
  type SkillSetup,
  type SupportLink,
} from "@cte2/schema";
import { useMemo, useState, type ReactNode } from "react";

import type { Snapshot } from "@cte2/extractor";
import { balance, parseRolledMod, rollToExact, statIndex } from "@cte2/engine";

import { useBuild } from "../../state/build-store.js";
import { useWorld } from "../../state/snapshot.js";
import { Fact } from "../../ui/Fact.js";
import { NumberField } from "../../ui/fields.js";
import { GemRarityRoll, gemBand } from "../../ui/GemRoll.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { SupportGemPicker } from "./SupportGemPicker.js";

export function SkillsPanel(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const addSkill = useBuild((s) => s.addSkill);
  const skills = doc.skills ?? [];

  const spellOptions = useMemo<PickerOption[]>(
    () =>
      world.spellIds.map((id) => ({
        id,
        label: spellName(world.snapshot, id),
        keywords: id,
      })),
    [world],
  );

  // `GemInventoryHelper.MAX_SKILL_GEMS` — the skill-gem inventory is sized from it and
  // `getHotbarGem(i)` indexes straight into it, so it is the length of the hotbar.
  const active = activeSkillCount(skills);
  const full = active >= MAX_ACTIVE_SKILLS;

  // What the class allocation has already bought, which is what an unstated skill level means.
  // Resolved once for the whole list rather than per card: it walks every allocated school perk.
  const learned = useMemo(() => learnedSpells(world.snapshot, doc), [world.snapshot, doc]);

  return (
    <div className="panel">
      <div className="notice info">
        A support gem changes this skill&apos;s damage, almost never the character sheet — the
        game keeps a separate stat unit per spell and the sheet is the no-spell path, so expect
        the sidebar to stay still when you link one. The four exceptions are the gems that grant
        an exile effect (Fortify and the three charge-on-hit gems): the effect they make
        available does land on the sheet.{" "}
        <strong>The gem list is ordered by what each one would add to this skill.</strong>
      </div>

      <div className="row wrap mb-4">
        <span className={active > MAX_ACTIVE_SKILLS ? "badge bad" : "badge"}>
          {active} of {MAX_ACTIVE_SKILLS} on the hotbar
        </span>
        <span className="faint text-sm">
          <code>GemInventoryHelper.MAX_SKILL_GEMS</code>. A disabled Skill takes no slot, so keep
          the setup you are comparing against and switch between them.
        </span>
      </div>

      {skills.length === 0 && (
        <div className="empty">
          No skills. Allocate a spell on the <strong>Classes</strong> tab and it lands here, or
          add one below.
        </div>
      )}

      {skills.map((skill, index) => (
        <SkillCard
          key={`${skill.spellId}-${index}`}
          skill={skill}
          index={index}
          spellOptions={spellOptions}
          learned={learned}
          barFull={full}
        />
      ))}

      {/* `world.spellIds[0]` used to be the answer, which put a specific spell nobody chose onto
          a fresh bar and left the document claiming the character had it. */}
      <AddPicker
        primary
        label="Add skill"
        placeholder="Which skill?"
        options={spellOptions}
        disabled={full}
        {...(full
          ? { title: `The hotbar holds ${MAX_ACTIVE_SKILLS}. Disable one to make room.` }
          : {})}
        onAdd={(spellId) => addSkill({ spellId, main: skills.length === 0 })}
      />
    </div>
  );
}

function SkillCard({
  skill,
  index,
  spellOptions,
  learned,
  barFull,
}: {
  skill: SkillSetup;
  index: number;
  spellOptions: PickerOption[];
  /** Spell id -> the rank the character's class allocation grants it. */
  learned: ReadonlyMap<string, number>;
  /** Eight Skills are already on. A disabled one here cannot be switched back on.  */
  barFull: boolean;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const updateSkill = useBuild((s) => s.updateSkill);
  const removeSkill = useBuild((s) => s.removeSkill);
  const setSkillEnabled = useBuild((s) => s.setSkillEnabled);
  const setMainSkill = useBuild((s) => s.setMainSkill);

  const spell = entry(world.snapshot, CATEGORY.spell, skill.spellId)?.data;
  const config = (spell?.["config"] ?? {}) as Record<string, unknown>;
  // `SupportGem.GetAllStats(en, data)` scales its flats to `en.getLevel()` — the character's
  // level, not the gem's and not the spell's.
  const level = doc.character.level;
  // What linking these costs. Worth showing beside the gems rather than only inside the damage
  // figure: most support gems charge 1.2x or 1.3x and they compound, so a five-link is often
  // triple the cast cost of the bare skill.
  const costMulti = supportCostMulti(world.snapshot, skill);

  // `min_lvl` and `max_lvl` are not two ends of one range, and using them as one is how this
  // field came to refuse ranks the game had actually granted:
  //
  //     public int getMaxLevel()      { return max_lvl; }   // the spell's top rank
  //     public int getRequiredLevel() { return min_lvl; }   // the CHARACTER level to cast it
  //
  // `protection` in this pack is min_lvl 15, max_lvl 12, and a level-100 capture holds it at
  // rank 4 — a field bounded [15, 12] rewrote that to 15 the moment anybody touched it.
  //
  // The rank floor is 1 (a slotted spell is one the character has; `validate` calls rank 0 a
  // bug), and the ceiling is `getMaxLevelWithBonuses()` — `max_lvl` plus the balance file's
  // MAX_BONUS_SPELL_LEVELS, which is 8 here, because gear and perks legitimately push a spell
  // past its own top rank. The capture this project runs against has three spells above it.
  const maxRank = numberAt(spell, "max_lvl", 16);
  const bonusRanks = maxBonusSpellLevels(world.snapshot);
  const rankCeiling = maxRank + bonusRanks;
  const requiredLevel = numberAt(spell, "min_lvl", 1);
  // An unstated level is not `default_lvl` — that is 0 for every spell in this pack. The engine
  // resolves it through `withLearnedRank`, which reads the rank the class allocation bought, so
  // showing anything else would put a number on screen the damage figure was not computed at.
  const learnedRank = learned.get(skill.spellId);
  const shownLevel = skill.level ?? learnedRank ?? 1;
  const description = spellDesc(world.snapshot, skill.spellId);

  // Always through `supportLinks`: a document written before the per-gem roll existed spells
  // its supports as bare ids, and this is what turns those into the same shape as a fresh one.
  const supports = supportLinks(skill);
  const [adding, setAdding] = useState(false);
  const enabled = isSkillEnabled(skill);

  const patch = (next: Partial<SkillSetup>): void => {
    const merged: SkillSetup = { ...skill, ...next };
    for (const key of Object.keys(merged) as (keyof SkillSetup)[]) {
      if (merged[key] === undefined) delete merged[key];
    }
    updateSkill(index, merged);
  };

  /**
   * Rewrites one link in place, keeping the rest as they are.
   *
   * Writing the whole list back is what makes a legacy document's inherited `gemPercent`
   * explicit the first time anything is touched: `supportLinks` has already resolved it, so
   * every gem keeps the number the panel was showing rather than silently dropping to 0.
   */
  const patchSupport = (
    at: number,
    next: { id?: string; rarity?: string | undefined; rollPercent?: number | undefined },
  ): void => {
    patch({
      supports: supports.map((link, i) => {
        if (i !== at) return link;
        const merged = { ...link, ...next } as SupportLink;
        // An explicit `undefined` clears the field rather than recording a dead key — the same
        // rule `patch` applies to the skill itself.
        for (const key of Object.keys(merged) as (keyof SupportLink)[]) {
          if (merged[key] === undefined) delete merged[key];
        }
        return merged;
      }),
    });
  };

  return (
    <div className="card" style={enabled ? undefined : { opacity: 0.55 }}>
      <div className="row wrap mb-4">
        <Picker
          options={spellOptions}
          value={skill.spellId}
          onChange={(id) => id !== undefined && patch({ spellId: id })}
          width={240}
        />

        <div className="field">
          <label>Level</label>
          <NumberField
            value={shownLevel}
            min={1}
            max={rankCeiling}
            width={58}
            onChange={(level) => patch({ level })}
          />
          <span
            className="faint"
            title={
              bonusRanks > 0
                ? `Ranks 1-${maxRank}, plus up to ${bonusRanks} bonus ranks from gear and perks`
                : undefined
            }
          >
            of {maxRank}
            {bonusRanks > 0 ? ` (+${bonusRanks})` : ""}
            {skill.level === undefined
              ? learnedRank === undefined
                ? " · unset"
                : " · from your class"
              : ""}
          </span>
          {doc.character.level < requiredLevel && (
            <span className="badge bad" title="Spell.getRequiredLevel — the character level gate">
              needs level {requiredLevel}
            </span>
          )}
        </div>

        <label className="field" title="Damage is reported for this skill">
          <input
            type="radio"
            checked={skill.main === true}
            onChange={() => setMainSkill(index)}
            disabled={!enabled}
          />
          main
        </label>

        <label
          className="field"
          title={
            barFull && !enabled
              ? `The hotbar already holds ${MAX_ACTIVE_SKILLS} Skills (GemInventoryHelper.MAX_SKILL_GEMS). Disable another one to make room for this.`
              : "Turn the skill off without losing its level or its support gems. A disabled skill contributes no stats, no Full DPS, none of the exile effects it would have made available, and nothing when something else procs it — which is the only switch that takes a procced spell out of a figure."
          }
        >
          <input
            type="checkbox"
            checked={enabled}
            // Off is always allowed; on is refused past the eighth, because a bar the game
            // cannot load is not a state a checkbox should be able to reach.
            disabled={!enabled && barFull}
            onChange={(event) => setSkillEnabled(index, event.target.checked)}
          />
          enabled
        </label>

        <div className="grow" />
        <button onClick={() => removeSkill(index)}>Remove</button>
      </div>

      {description !== undefined && (
        <p className="faint text-sm" style={{ margin: "0 0 8px", userSelect: "text" }}>
          {description}
        </p>
      )}

      <div className="row wrap gap-7 mb-4">
        <Fact layout="block" label="cast" value={ticks(config["cast_time_ticks"])} />
        <Fact layout="block" label="cooldown" value={ticks(config["cooldown_ticks"])} />
        <Fact layout="block" label="mana" value={range(config["mana_cost"])} />
        <Fact layout="block" label="energy" value={range(config["ene_cost"])} />
        <Fact layout="block" label="weapon" value={stringAt(config, "castingWeapon")} />
        <Fact layout="block" label="charges" value={stringAt(config, "charges")} />
      </div>

      <div className="section-title">
        Support gems ({supports.length})
        {costMulti !== 1 && (
          <span
            className="faint text-sm" style={{ fontWeight: "normal", marginLeft: 8 }}
            title="SocketedGem.getManaCostMulti — each linked gem's `manaMulti`, multiplied together and applied to both the mana and the energy cost"
          >
            — together they cost {costMulti.toFixed(2)}× to cast
          </span>
        )}
      </div>

      {/*
        One roll per gem, because that is how the game stores them: each support is its own
        item with its own `SkillGemData.getStatPercent()`, and `SupportGem.GetAllStats` reads
        that gem's percent rather than the skill's. A single slider for all of them was the
        wrong shape and quietly re-rolled every support whenever any one of them moved.
      */}
      {supports.map((link, gemIndex) => (
        <div key={`${link.id}-${gemIndex}`} className="row wrap mb-2">
          <SupportGemPicker
            skill={skill}
            skillIndex={index}
            slot={gemIndex}
            value={link.id}
            onChange={(id) => patchSupport(gemIndex, { id })}
          />
          <GemRarityRoll gem={link} onChange={(next) => patchSupport(gemIndex, next)} />
          <span className="faint grow ellipsis text-sm">
            {gemLines(
              world.snapshot,
              link.id,
              link.rollPercent ?? gemBand(world, link.rarity).min,
              level,
            ).join(" · ")}
          </span>
          <button onClick={() => patch({ supports: supports.filter((_, i) => i !== gemIndex) })}>
            ✕
          </button>
        </div>
      ))}

      {/*
        Adding a link goes through the same ranked list rather than dropping in whichever gem
        happens to sort first alphabetically. The old button did the latter, which meant the
        first thing you saw after clicking "Link support" was a gem chosen at random — and the
        ranking, which is the whole point, only appeared once you went back and reopened it.
      */}
      <div className="row mt-3">
        {adding ? (
          <>
            <SupportGemPicker
              skill={skill}
              skillIndex={index}
              slot={undefined}
              value={undefined}
              onChange={(id) => {
                patch({ supports: [...supports, { id }] });
                setAdding(false);
              }}
            />
            <button onClick={() => setAdding(false)}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setAdding(true)}>Link support</button>
        )}
      </div>
    </div>
  );
}

/**
 * What a support gem is actually granting this character, resolved through the engine.
 *
 * This used to render `modifierLine(snapshot, stat)` with neither argument the number needs,
 * and both omissions were visible. `rollPercent` defaults to **0**, so every gem read as its
 * own minimum no matter what the document said — a gem at 60% showed "+5% Cooldown Reduction"
 * where the character had +11%. And `modifierLine` is documented as an un-levelled preview,
 * while `SupportGem.GetAllStats` scales its flats to the **player's** level: a 2..6 band of
 * `flat_water_added_damage` is 124.8 on a level 100 character, and the panel was printing 2.
 *
 * So it goes through `rollToExact`, which is the same call `collectSupportGems` makes. A line
 * here cannot disagree with the damage number for the same reason the item editor's cannot.
 */
function gemLines(snapshot: Snapshot, gemId: string, rollPercent: number, level: number): string[] {
  const stats = entry(snapshot, CATEGORY.supportGem, gemId)?.data["stats"];
  if (!Array.isArray(stats)) return [];
  const index = statIndex(snapshot);
  const curves = balance(snapshot);

  return stats
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((stat) => {
      const rolled = parseRolledMod(stat);
      if (rolled === undefined) return modifierLine(snapshot, stat, rollPercent);
      const exact = rollToExact(rolled, rollPercent, level, index.shapeOf(rolled.statId), curves);
      // `modifierLine` words the stat; feeding it the resolved value as a fixed `v1` keeps the
      // wording — templates, "More"/"Increased", the percent suffix — and swaps in the number.
      return modifierLine(snapshot, { stat: rolled.statId, type: rolled.type, v1: exact.value });
    });
}

/** `SocketedGem.getManaCostMulti` — the product of every linked gem's `manaMulti`. */
function supportCostMulti(snapshot: Snapshot, skill: SkillSetup): number {
  let multi = 1;
  for (const link of supportLinks(skill)) {
    const data = entry(snapshot, CATEGORY.supportGem, link.id)?.data;
    const declared = data?.["manaMulti"];
    if (typeof declared === "number" && Number.isFinite(declared)) multi *= declared;
  }
  return multi;
}

function numberAt(node: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = node?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringAt(node: Record<string, unknown>, key: string): string | null {
  const value = node[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 20 ticks to the second, which is how every duration in the pack is expressed. */
function ticks(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${value}t (${(value / 20).toFixed(2)}s)`;
}

function range(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  const min = node["min"];
  const max = node["max"];
  if (typeof min !== "number" || typeof max !== "number") return null;
  return min === max ? String(min) : `${min}–${max}`;
}
