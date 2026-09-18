/**
 * Skills and their support gems, in two columns: the list, and the one you picked.
 *
 * The panel used to render every skill as a full card, stacked. Eight skills with five gems each
 * is forty gem rows on one scroll, so "which of my skills does the most damage" meant scrolling
 * past everything to find out, and the answer was never on screen beside the question. PoB's
 * shape is the fix and it is the shape `LAYOUT.MD` asks for: a short list on the left where a
 * skill is one row, and one skill's whole configuration on the right.
 *
 * The **basic attack** is in that list too, pinned last and not part of the document. Swinging
 * the weapon is a damage source like any other — it has its own clock, it is in Total DPS, and
 * the two numbers it depends on (the weapon's own speed and its vanilla attack damage) are
 * exactly the two a registry cannot supply. They used to live on a Stats tab, two clicks from
 * the figure they move. Now they are inside the thing they describe.
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
 */

import {
  CATEGORY,
  MAX_ACTIVE_SKILLS,
  activeSkillCount,
  entry,
  exileEffectName,
  isSkillEnabled,
  isSupportEnabled,
  modifierLine,
  modifierValue,
  playerSpellFor,
  rarityName,
  spellDesc,
  spellExclusion,
  spellName,
  statDisplay,
  supportLinks,
  learnedSpells,
  maxBonusSpellLevels,
  type SkillSetup,
  type SupportLink,
} from "@cte2/schema";
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";

import type { Snapshot } from "@cte2/extractor";
import { balance, parseRolledMod, rollToExact, simulateDps, spellRanks, statIndex } from "@cte2/engine";

import { useBuild } from "../../state/build-store.js";
import { mainSkillIndex, useDerived } from "../../state/derived.js";
import { vitalsOf } from "../../state/compare.js";
import { applyPatch, type Patch } from "../../state/patch.js";
import { useWorld } from "../../state/snapshot.js";
import { Fact } from "../../ui/Fact.js";
import { NumberField, useRollDraft } from "../../ui/fields.js";
import { GemRarityRoll, bestGemPreset, gemBand, gemRarities, type GemPreset } from "../../ui/GemRoll.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { smart } from "../../ui/format.js";
import { SupportGemPicker } from "./SupportGemPicker.js";
import { BasicAttackCard } from "./BasicAttackCard.js";

/** Which row of the left column is open. The basic attack is not a document index. */
type Selection = { kind: "skill"; index: number } | { kind: "basic" };

/**
 * Whether the support gem list offers every gem or only the ones that do something.
 *
 * "Compatible" is not a property the registry declares — a gem is compatible with a skill when
 * its stats are read by one of that skill's damage sources, which is a question only the damage
 * pipeline can answer. `SupportGemPicker` already prices every gem against this skill, so the
 * filter is "hide the rows that measured no change" rather than a second, guessed rule.
 */
export type GemFilter = "compatible" | "all";

export function SkillsPanel(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const derived = useDerived();
  const addSkill = useBuild((s) => s.addSkill);
  const removeSkill = useBuild((s) => s.removeSkill);
  const duplicateSkill = useBuild((s) => s.duplicateSkill);
  const skills = doc.skills ?? [];

  /*
   * `null` means "follow the main skill", which is not the same as "index 0".
   *
   * A `useState` initialiser reads its argument on the first render only, and on the first
   * render the document is still the blank one the session restore has not replaced yet — so
   * opening a build landed on whichever skill happened to be first rather than on the one the
   * damage figure is about. Clicking a row pins it; nothing else moves it.
   */
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sortByDps, setSortByDps] = useState(false);
  const [gemFilter, setGemFilter] = useState<GemFilter>("compatible");

  /**
   * The rarity every gem this panel hands you arrives at, and is ranked at.
   *
   * A planner is a place you decide what to go and get, so the default is the best copy of the
   * gem that exists rather than the worst: an unstated rarity computes at the bottom of the
   * whole 0-100 range, which meant the ranked list was sorting ninety gems by what their worst
   * roll is worth. Anyone planning around a gem they already own drops the preset to that gem's
   * rarity, or sets the socket's own slider afterwards — the preset decides what a *new* gem
   * looks like and never touches one already on a skill.
   *
   * `null` is the old behaviour kept reachable: no rarity, no roll, bottom of the band.
   */
  const ladder = useMemo(() => gemRarities(world), [world]);
  const [gemPreset, setGemPreset] = useState<GemPreset | null>(() => bestGemPreset(world) ?? null);

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

  const ranking = useSkillRanking(sortByDps);

  /**
   * The list, in the order the left column draws it.
   *
   * Document order by default, because that is the order the document is read and written in and
   * a list that reshuffled as you edited would lose your place. Ranked only when asked.
   */
  const order = useMemo(() => {
    const indices = skills.map((_, i) => i);
    if (!sortByDps || ranking === undefined) return indices;
    return indices.sort((a, b) => (ranking.get(b) ?? 0) - (ranking.get(a) ?? 0));
  }, [skills, sortByDps, ranking]);

  // The engine's own answer, not a second copy of its rule — see `mainSkillIndex`.
  const mainIndex = mainSkillIndex(derived);

  // A skill removed from under the selection leaves it pointing past the end.
  const chosen: Selection =
    selection ?? (skills.length > 0 ? { kind: "skill", index: mainIndex } : { kind: "basic" });
  const selected: Selection =
    chosen.kind === "skill" && skills[chosen.index] === undefined
      ? skills.length > 0
        ? { kind: "skill", index: 0 }
        : { kind: "basic" }
      : chosen;

  return (
    <div className="panel skills-panel">
      {/* -- left: the socket groups ------------------------------------- */}
      <div className="skills-col">
        <div className="section-title mt-0">Socket groups</div>

        <div className="row wrap mb-3">
          <span className={active > MAX_ACTIVE_SKILLS ? "badge bad" : "badge"}>
            {active} of {MAX_ACTIVE_SKILLS} on the hotbar
          </span>
          <span
            className="faint text-sm"
            title="GemInventoryHelper.MAX_SKILL_GEMS. A disabled Skill takes no slot, so keep the setup you are comparing against and switch between them."
          >
            <code>MAX_SKILL_GEMS</code>
          </span>
        </div>

        {skills.length === 0 && (
          <div className="faint text-sm mb-3">
            No skills. Allocate a spell on the <strong>Classes</strong> tab and it lands here, or
            add one below.
          </div>
        )}

        {order.map((index) => (
          <SkillListRow
            key={`${skills[index]?.spellId}-${index}`}
            skill={skills[index]!}
            isMain={index === mainIndex}
            dps={ranking?.get(index)}
            selected={selected.kind === "skill" && selected.index === index}
            onSelect={() => setSelection({ kind: "skill", index })}
          />
        ))}

        {/*
          Pinned last and always present. It is not in `doc.skills` and must not be: a document
          does not list "swinging your weapon" as a Skill, the hotbar has no slot for it, and
          putting it there would make it count against `MAX_SKILL_GEMS`.
        */}
        <div
          className={`skill-row basic${selected.kind === "basic" ? " selected" : ""}`}
          onClick={() => setSelection({ kind: "basic" })}
        >
          <span className="ellipsis grow">Basic attack</span>
          <span className="badge" title="Always available — this is not a Skill and takes no hotbar slot">
            weapon
          </span>
        </div>

        <div className="row wrap mt-3 mb-4" style={{ gap: 4 }}>
          <AddPicker
            primary
            label="New group"
            placeholder="Which skill?"
            options={spellOptions}
            disabled={full}
            {...(full
              ? { title: `The hotbar holds ${MAX_ACTIVE_SKILLS}. Disable one to make room.` }
              : {})}
            onAdd={(spellId) => addSkill({ spellId, main: skills.length === 0 })}
          />
          <button
            disabled={selected.kind !== "skill"}
            title="Copy this skill with its support gems, their rarities and their rolls — the setup you are comparing against, kept"
            onClick={() => {
              if (selected.kind !== "skill") return;
              duplicateSkill(selected.index);
              setSelection({ kind: "skill", index: selected.index + 1 });
            }}
          >
            Duplicate
          </button>
          <button
            disabled={selected.kind !== "skill"}
            onClick={() => {
              if (selected.kind !== "skill") return;
              removeSkill(selected.index);
            }}
          >
            Delete
          </button>
        </div>

        <div className="section-title">Skill options</div>
        <label
          className="field"
          title={
            "Ranks the list by each skill's own DPS. Every skill is priced through the damage " +
            "pipeline to do it, which is one engine pass each — so it is a switch rather than " +
            "the default, and it recomputes a beat behind your edits."
          }
        >
          <input
            type="checkbox"
            checked={sortByDps}
            onChange={(event) => setSortByDps(event.target.checked)}
          />
          Sort skills by DPS
        </label>

        <div className="field mt-2">
          <label title="A gem is 'compatible' when its stats are actually read by one of this skill's damage sources — which is measured, not declared. Roughly half the pack's gems do nothing for any given skill.">
            Show support gems
          </label>
          <select value={gemFilter} onChange={(event) => setGemFilter(event.target.value as GemFilter)}>
            <option value="compatible">Compatible only</option>
            <option value="all">All</option>
          </select>
        </div>

        <div className="field mt-2">
          <label title="The rarity and roll a gem you link from here arrives at, and the roll the ranked list prices every candidate at. It never changes a gem already socketed — each one keeps its own slider.">
            New gems roll at
          </label>
          <select
            className={gemPreset === null ? undefined : `rarity-${gemPreset.rarity}`}
            value={gemPreset?.rarity ?? ""}
            onChange={(event) => {
              const id = event.target.value;
              const band = ladder.find((r) => r.id === id);
              // The top of the band, not the bottom: a rarity is a range, and the number worth
              // planning against is the one the gem ends up at once you have finished upgrading
              // it. Anything lower is a gem you would keep rolling.
              setGemPreset(band === undefined ? null : { rarity: band.id, rollPercent: band.max });
            }}
          >
            {ladder.map((r) => (
              <option key={r.id} value={r.id}>
                {rarityName(world.snapshot, r.id)} {r.max}%
              </option>
            ))}
            <option value="">Unset — bottom of the band</option>
          </select>
        </div>
      </div>

      {/* -- right: the one you picked ----------------------------------- */}
      <div className="skills-col">
        {selected.kind === "basic" ? (
          <BasicAttackCard />
        ) : skills[selected.index] === undefined ? (
          <div className="empty">
            Pick a skill on the left, or the basic attack under it.
          </div>
        ) : (
          <SkillCard
            key={`${skills[selected.index]!.spellId}-${selected.index}`}
            skill={skills[selected.index]!}
            index={selected.index}
            spellOptions={spellOptions}
            gemFilter={gemFilter}
            gemPreset={gemPreset}
            barFull={full}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Each skill's own DPS, for the ranked list — computed only when the list is ranked.
 *
 * Every row is a full engine pass, because a skill's DPS is a question about a skill the app has
 * not computed: `useDerived` resolves the *main* one and nothing else. Eight of those is most of
 * a tenth of a second, which is why this is behind a switch and behind `useDeferredValue` — the
 * document React renders against stays current while the ranking catches up a beat later, so
 * typing in the level box never waits for it.
 */
function useSkillRanking(enabled: boolean): Map<number, number> | undefined {
  const doc = useBuild((s) => s.doc);
  const { snapshot } = useWorld();
  const deferred = useDeferredValue(doc);

  return useMemo(() => {
    if (!enabled) return undefined;
    const out = new Map<number, number>();
    (deferred.skills ?? []).forEach((_, index) => {
      try {
        out.set(index, vitalsOf(deferred, snapshot, { skillIndex: index }).dps);
      } catch {
        // A skill the engine cannot evaluate ranks last rather than taking the panel down.
        out.set(index, 0);
      }
    });
    return out;
  }, [enabled, deferred, snapshot]);
}

/**
 * What this build turns the spell's declared numbers into.
 *
 * Two facts, and the pack's JSON answers neither of them:
 *
 *  - **cooldown.** `cooldown_ticks` is the floor a build works down from. `cdr`, `skill_speed`
 *    and the global-cooldown arm all land on the `on_spell_stat_calc` event, and a Cooldown
 *    support gem's do too — on the spell's own unit, where nothing else can see them. The
 *    declared 12s on `protection` is 7.3s on a build carrying one.
 *  - **buff duration.** `potion_dur` the same way, through `eff_dur_u_cast` and its twelve typed
 *    twins. Nothing showed this at all before, which meant the Effect Duration gem was a gem
 *    with no visible consequence anywhere in the planner.
 *
 * One engine pass for the one card on screen, deferred so that typing in the level box above it
 * never waits for one. Rendered as nothing at all while the answer is stale rather than as a
 * stale number, because a cooldown that lags a keystroke behind is worse than one that blinks.
 */
function ResolvedFacts({ index }: { index: number }): ReactNode {
  const doc = useBuild((s) => s.doc);
  const { snapshot } = useWorld();
  const deferred = useDeferredValue(doc);

  // The skill is read out of the *deferred* document rather than taken as a prop, so the whole
  // input to the pass moves at once. Taking the live skill beside a deferred document would run
  // the engine twice per keystroke — once on the half-updated pair, once on the settled one.
  const skill = (deferred.skills ?? [])[index];

  const result = useMemo(() => {
    if (skill === undefined) return undefined;
    try {
      return simulateDps(deferred, snapshot, { skill });
    } catch {
      // A document the engine cannot evaluate still renders its card; the Diagnostics tab says
      // why, and a missing row here is better than a broken panel.
      return undefined;
    }
  }, [deferred, snapshot, skill]);

  if (result === undefined) return null;

  const rate = result.rate;
  const buff = result.buff;

  return (
    <div className="row wrap gap-7 mb-4">
      <Fact
        layout="block"
        label="your cooldown"
        value={`${rate.cycleSeconds.toFixed(2)}s`}
      />
      {buff !== undefined && (
        <Fact
          layout="block"
          label={`${exileEffectName(snapshot, buff.effectId)} lasts`}
          // A toggle is not a duration and must not be printed as one — `-1` is the pack's
          // "until you press it again", and there is nothing for a duration stat to lengthen.
          value={
            buff.infinite
              ? "until re-cast"
              : `${buff.durationSeconds.toFixed(1)}s` +
                (Math.abs(buff.durationSeconds - buff.declaredSeconds) < 0.05
                  ? ""
                  : ` (declared ${buff.declaredSeconds.toFixed(1)}s)`)
          }
        />
      )}
    </div>
  );
}

/** One row of the socket-group list: what it is, whether it is on, and what it does. */
function SkillListRow({
  skill,
  isMain,
  dps,
  selected,
  onSelect,
}: {
  skill: SkillSetup;
  /** The one the damage figures are about, marked or defaulted. */
  isMain: boolean;
  /** Its own DPS, when the list is ranked. */
  dps: number | undefined;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const enabled = isSkillEnabled(skill);
  const supports = supportLinks(skill);
  const live = supports.filter(isSupportEnabled).length;

  return (
    <div
      className={`skill-row${selected ? " selected" : ""}${enabled ? "" : " off"}`}
      onClick={onSelect}
    >
      <span className="ellipsis grow">{spellName(snapshot, skill.spellId)}</span>
      {/* "auto" where nothing in the document marked one: `simulateDps` takes the first enabled
          skill that declares a damage act, so a bar starting with a buff still reports the
          damage skill. Saying which is how the list stops disagreeing with the sidebar. */}
      {isMain && (
        <span
          className={skill.main === true ? "badge good" : "badge"}
          title={
            skill.main === true
              ? "Damage is reported for this skill"
              : "Nothing in this build marks a main skill, so the damage figures use the first enabled skill that deals damage — this one. Tick `main skill` to pin it."
          }
        >
          {skill.main === true ? "main" : "main (auto)"}
        </span>
      )}
      {skill.includeInFullDps === true && (
        <span className="badge" title="Ticked into the Full DPS rotation">
          full
        </span>
      )}
      {supports.length > 0 && (
        <span
          className="badge"
          title={
            live === supports.length
              ? `${supports.length} support gem(s)`
              : `${live} of ${supports.length} support gems switched on`
          }
        >
          {live === supports.length ? `${supports.length}L` : `${live}/${supports.length}L`}
        </span>
      )}
      {dps !== undefined && <span className="num text-sm">{smart(Math.round(dps))}</span>}
    </div>
  );
}

function SkillCard({
  skill,
  index,
  spellOptions,
  gemFilter,
  gemPreset,
  barFull,
}: {
  skill: SkillSetup;
  index: number;
  spellOptions: PickerOption[];
  gemFilter: GemFilter;
  /** What a gem linked from this card arrives at — see the panel's own note. `null` leaves it unset. */
  gemPreset: GemPreset | null;
  /** Eight Skills are already on. A disabled one here cannot be switched back on.  */
  barFull: boolean;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const derived = useDerived();
  const updateSkill = useBuild((s) => s.updateSkill);
  const setSkillEnabled = useBuild((s) => s.setSkillEnabled);
  const setMainSkill = useBuild((s) => s.setMainSkill);
  const setIncludeInFullDps = useBuild((s) => s.setIncludeInFullDps);

  const spell = entry(world.snapshot, CATEGORY.spell, skill.spellId)?.data;
  const config = (spell?.["config"] ?? {}) as Record<string, unknown>;
  // `SupportGem.GetAllStats(en, data)` scales its flats to `en.getLevel()` — the character's
  // level, not the gem's and not the spell's.
  const level = doc.character.level;
  // What linking these costs. Worth showing beside the gems rather than only inside the damage
  // figure: most support gems charge 1.2x or 1.3x and they compound, so a five-link is often
  // triple the cast cost of the bare skill.
  const costMulti = supportCostMulti(world.snapshot, skill);

  /**
   * What the class allocation has already bought, which is what an unstated skill level means.
   *
   * Resolved here rather than for the whole list, because only one card is on screen now — the
   * old panel resolved it once for eight cards and that was the right call when it drew eight.
   */
  const learned = useMemo(() => learnedSpells(world.snapshot, doc), [world.snapshot, doc]);

  /**
   * The rank the *engine* resolves each spell to — the number the damage figure is computed at.
   *
   * `learnedSpells` alone is not that number and reading a level off it is how this panel came
   * to ignore half the things that grant a rank. It walks `character.schools`, so it sees a
   * spell a class taught and misses one a unique or a runeword granted, and it knows nothing at
   * all about `MaxSpellLevel` — the `plus_lvl_<tag>_spells` family. Kobold Influence grants
   * `+2 to Buff Spells`; the sheet had it, `withLearnedRank` used it, and the card above the
   * damage number went on printing the rank the character would have had without the amulet,
   * unchanged as you put it on and took it off.
   *
   * `spellRanks` is the port of `calcSpellLevels` and is the same call the engine makes, off the
   * same sheet, so the two cannot disagree.
   */
  const resolvedRanks = useMemo(
    () => spellRanks(world.snapshot, derived.stats, balance(world.snapshot)),
    [world.snapshot, derived.stats],
  );

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
  const resolvedRank = resolvedRanks.get(skill.spellId);
  const shownLevel = skill.level ?? resolvedRank ?? learnedRank ?? 1;

  /**
   * What gear and perks added on top of the rank the character was taught.
   *
   * The difference between the two numbers rather than a re-reading of the stats: `spellRanks`
   * clamps the *sum* of every `plus_lvl_` source to `MAX_BONUS_SPELL_LEVELS` before adding it,
   * so `+2 cold` and `+2 all` is +4 on a cold spell and +2 on the rest, and no arithmetic done
   * here could arrive at that from the sheet without repeating the port.
   */
  const grantedBonus =
    resolvedRank !== undefined && learnedRank !== undefined ? resolvedRank - learnedRank : 0;

  /**
   * A level typed into the document wins, and then nothing on the character moves it.
   *
   * That is deliberate — a capture writes the game's *final* rank into `skills[].level`, bonus
   * ranks already in it, so adding them again would double-count every imported build. It is
   * also invisible, and invisible is what made this look broken: with a level set, putting on a
   * `+2 to Buff Spells` amulet changes nothing here and there is nothing on screen to say why.
   * So the card says so, and offers the way back.
   */
  const pinnedOverBonus =
    skill.level !== undefined && resolvedRank !== undefined && resolvedRank !== skill.level;
  const description = spellDesc(world.snapshot, skill.spellId);

  /**
   * A skill this build already holds that the picker no longer offers — see
   * `SnapshotWorld.spellIds`. Either the hired companion's, or one the pack has retired.
   *
   * Flagged and offered the swap rather than rewritten on load. Which of the two "Hunter's
   * Focus" entries a build meant is the author's to say, and a planner that quietly changed a
   * skill when you opened a file would be the worse bug of the two.
   */
  const excluded = spellExclusion(world.snapshot, skill.spellId);
  const liveTwin = excluded === undefined ? undefined : playerSpellFor(world.snapshot, skill.spellId);

  // The picker is otherwise a list this skill is not in, which renders as an empty box over a
  // build that plainly has a skill in it.
  const cardSpellOptions = useMemo<PickerOption[]>(
    () =>
      excluded === undefined
        ? spellOptions
        : [
            {
              id: skill.spellId,
              label: spellName(world.snapshot, skill.spellId),
              hint: excluded,
              keywords: skill.spellId,
            },
            ...spellOptions,
          ],
    [excluded, skill.spellId, spellOptions, world.snapshot],
  );

  // Always through `supportLinks`: a document written before the per-gem roll existed spells
  // its supports as bare ids, and this is what turns those into the same shape as a fresh one.
  const supports = supportLinks(skill);
  const [adding, setAdding] = useState(false);
  const enabled = isSkillEnabled(skill);

  // `applyPatch` rather than a spread: clearing a field has to *remove* it, not set it to
  // `undefined`. These documents are saved and pasted into fixtures, and `"level": undefined`
  // is not JSON — a missing key is what a hand-authored skill looks like, and what the engine
  // reads as "derive this rank from the sheet".
  const patch = (next: Patch<SkillSetup>): void => updateSkill(index, applyPatch(skill, next));

  /**
   * Rewrites one link in place, keeping the rest as they are.
   *
   * Writing the whole list back is what makes a legacy document's inherited `gemPercent`
   * explicit the first time anything is touched: `supportLinks` has already resolved it, so
   * every gem keeps the number the panel was showing rather than silently dropping to 0.
   */
  const patchSupport = (
    at: number,
    next: {
      id?: string;
      rarity?: string | undefined;
      rollPercent?: number | undefined;
      enabled?: boolean | undefined;
    },
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
      <div className="section-title mt-0">Active skill</div>

      {excluded !== undefined && (
        <div className="notice warn">
          {excluded === "mercenary" ? (
            <>
              <strong>This is the mercenary&apos;s version of the skill.</strong>{" "}
              <code>{skill.spellId}</code> is in the hired companion&apos;s tree
              (<code>mmorpg_mercenary</code>), not yours — it caps at rank 1 and carries the
              companion&apos;s cooldowns, so every number below is about a skill your character
              cannot cast.
            </>
          ) : excluded === "wizard" ? (
            <>
              <strong>This is a wizard&apos;s version of the skill.</strong>{" "}
              <code>{skill.spellId}</code> is one of the spells an <code>mmorpg_wizard</code>
              {" "}casts at you — a hostile mob&apos;s copy, with the mob&apos;s numbers. No class
              teaches it, so your character cannot cast it.
            </>
          ) : (
            <>
              <strong>This version of the skill has been retired.</strong>{" "}
              <code>{skill.spellId}</code> is a spell the pack replaced: nothing in the game
              reaches it any more — no class perk teaches it, nothing summons or procs it — so
              the numbers below describe a skill you cannot obtain.
            </>
          )}{" "}
          It shares its display name with the live one, which is how it ended up here.{" "}
          {liveTwin === undefined ? (
            <>There is no live equivalent, so this group is best removed.</>
          ) : (
            <button className="nudge word primary" onClick={() => patch({ spellId: liveTwin })}>
              Use {spellName(world.snapshot, liveTwin)} instead
            </button>
          )}
        </div>
      )}

      <div className="row wrap mb-3">
        <Picker
          options={cardSpellOptions}
          value={skill.spellId}
          onChange={(id) => id !== undefined && patch({ spellId: id })}
          width={260}
        />

        <label className="field" title="Damage is reported for this skill">
          <input
            type="radio"
            checked={skill.main === true}
            onChange={() => setMainSkill(index)}
            disabled={!enabled}
          />
          main skill
        </label>

        <label
          className="field"
          title="One pass through every ticked skill, global cooldowns included. `main` still selects the single-skill figure beside it."
        >
          <input
            type="checkbox"
            checked={skill.includeInFullDps === true}
            onChange={(event) => setIncludeInFullDps(index, event.target.checked)}
          />
          in Full DPS
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
      </div>

      <div className="row wrap mb-4">
        <div className="field">
          <label>Level</label>
          <NumberField
            value={shownLevel}
            min={1}
            max={rankCeiling}
            width={58}
            onChange={(next) => patch({ level: next })}
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
              ? learnedRank === undefined && resolvedRank === undefined
                ? " · unset"
                : grantedBonus > 0
                  ? " · from your class and gear"
                  : " · from your class"
              : ""}
          </span>
        </div>

        {skill.level === undefined && grantedBonus > 0 && (
          <span
            className="badge"
            title={
              "MaxSpellLevel / MaxAllSpellLevels — the plus_lvl_<tag>_spells stats on gear, " +
              `perks, runewords or exile effects. Your class allocation teaches this spell at ` +
              `rank ${learnedRank ?? 0} and the sheet takes it to ${resolvedRank}. The sum of ` +
              `every source is clamped to ${bonusRanks} before it is added, so +2 to one tag ` +
              `and +2 to all spells is +4 on a spell carrying that tag and +2 on the rest.`
            }
          >
            +{grantedBonus} from gear
          </span>
        )}
        {pinnedOverBonus && (
          <button
            className="nudge word"
            title={
              `This skill's rank is pinned to ${skill.level} in the build, so the ` +
              "plus_lvl_<tag>_spells stats on your gear do not move it — a captured level " +
              "already has them folded in, and adding them twice would over-report every " +
              `imported build. Off the sheet alone this spell resolves to ${resolvedRank}. ` +
              "Clear the pin to let gear drive it."
            }
            onClick={() => patch({ level: undefined })}
          >
            pinned at {skill.level} — sheet says {resolvedRank}
          </button>
        )}
        {doc.character.level < requiredLevel && (
          <span className="badge bad" title="Spell.getRequiredLevel — the character level gate">
            needs level {requiredLevel}
          </span>
        )}
      </div>

      {/*
        The pack's declared numbers. What the *build* turns them into is the row below, because
        the two are different facts and collapsing them loses the one you are trying to change:
        "this spell has a 12s cooldown" is a property of the spell, "yours comes back in 7.3s" is
        the thing a Cooldown gem is for.
      */}
      <div className="row wrap gap-7 mb-2">
        <Fact layout="block" label="cast" value={ticks(config["cast_time_ticks"])} />
        <Fact layout="block" label="cooldown" value={ticks(config["cooldown_ticks"])} />
        <Fact layout="block" label="mana" value={range(config["mana_cost"])} />
        <Fact layout="block" label="energy" value={range(config["ene_cost"])} />
        <Fact layout="block" label="weapon" value={stringAt(config, "castingWeapon")} />
        <Fact layout="block" label="charges" value={stringAt(config, "charges")} />
      </div>

      <ResolvedFacts index={index} />


      {description !== undefined && (
        <p className="faint text-sm" style={{ margin: "0 0 10px", userSelect: "text" }}>
          {description}
        </p>
      )}

      <div className="section-title">
        Support gems ({supports.length})
        {costMulti !== 1 && (
          <span
            className="faint text-sm"
            style={{ fontWeight: "normal", marginLeft: 8 }}
            title="SocketedGem.getManaCostMulti — each linked gem's `manaMulti`, multiplied together and applied to both the mana and the energy cost. A gem switched off is an empty socket and charges nothing."
          >
            — cost multiplier {costMulti.toFixed(2)}×
          </span>
        )}
      </div>

      <div className="notice info">
        A support gem changes this skill, almost never the character sheet — the game keeps a
        separate stat unit per spell and the sheet is the no-spell path, so expect the sidebar to
        stay still when you link one. The four exceptions are the gems that grant an exile effect
        (Fortify and the three charge-on-hit gems).{" "}
        <strong>The gem list is ordered by what each one would add to this skill</strong> — its
        damage where it has any, and otherwise its cooldown and the duration of the buff it
        applies, which is what Cooldown and Effect Duration buy on a skill that hits nothing.
      </div>

      {/*
        One roll per gem, because that is how the game stores them: each support is its own
        item with its own `SkillGemData.getStatPercent()`, and `SupportGem.GetAllStats` reads
        that gem's percent rather than the skill's. A single slider for all of them was the
        wrong shape and quietly re-rolled every support whenever any one of them moved.
      */}
      {supports.map((link, gemIndex) => (
        <SupportGemRow
          key={`${link.id}-${gemIndex}`}
          link={link}
          skill={skill}
          skillIndex={index}
          slot={gemIndex}
          level={level}
          gemFilter={gemFilter}
          gemPreset={gemPreset}
          onPatch={(next) => patchSupport(gemIndex, next)}
          onRemove={() => patch({ supports: supports.filter((_, i) => i !== gemIndex) })}
        />
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
              compatibleOnly={gemFilter === "compatible"}
              preset={gemPreset ?? undefined}
              onChange={(id) => {
                // The same link `SupportGemPicker.apply` priced, so the figure you clicked is
                // the figure the card now shows.
                patch({ supports: [...supports, { id, ...(gemPreset ?? {}) }] });
                setAdding(false);
              }}
            />
            <button onClick={() => setAdding(false)}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setAdding(true)}>+ Link support gem</button>
        )}
      </div>
    </div>
  );
}

/**
 * One socketed support gem: which gem, how well it rolled, and whether it counts.
 *
 * The checkbox is the whole reason this is its own component in the first place. Reading what a
 * gem is worth means taking it out and putting it back, and doing that by deleting the link
 * loses the rarity and roll that made it *your* gem — so the comparison costs you the thing you
 * were comparing against. Off, the socket is empty: no stats, no cost multiplier, and the
 * duplicate rule stops counting it, so you can hold the gem you are replacing beside its
 * replacement.
 *
 * Its own roll draft too, because the slider and the resolved values below it both render the
 * roll and both have to follow a drag without the engine running per pixel.
 */
function SupportGemRow({
  link,
  skill,
  skillIndex,
  slot,
  level,
  gemFilter,
  gemPreset,
  onPatch,
  onRemove,
}: {
  link: SupportLink;
  skill: SkillSetup;
  skillIndex: number;
  slot: number;
  level: number;
  gemFilter: GemFilter;
  gemPreset: GemPreset | null;
  onPatch: (next: {
    id?: string;
    rarity?: string | undefined;
    rollPercent?: number | undefined;
    enabled?: boolean | undefined;
  }) => void;
  onRemove: () => void;
}): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const band = gemBand(world, link.rarity);
  const roll = useRollDraft(link.rollPercent ?? band.min);
  const on = isSupportEnabled(link);

  // Rendered from the drag draft, so the lines follow the thumb while the document — and
  // therefore the engine — stays where it was until the thumb is released.
  const lines = gemLines(snapshot, link.id, roll.shown, level);
  const gemCostMulti = manaMulti(snapshot, link.id);

  /*
   * Two columns that become two rows when there is no width for two columns.
   *
   * What the gem *does* used to be one ellipsised grey line under its controls, which is where
   * a detail goes when nobody has decided what it is worth — and it is the most important thing
   * on the card. A five-link stacks five of these, so a column beside the controls fits all five
   * into the height one of them used to take, and the flex wrap is what makes a narrow panel
   * degrade back to stacking rather than to a squeeze.
   */
  return (
    <div className={`gem-card${on ? "" : " off"}`}>
      <div className="gem-card-body">
        <div className="gem-card-controls">
          <div className="row wrap">
            <label
              className="field"
              title="An empty socket rather than a missing gem: off, it grants nothing and costs nothing to cast, and keeps its rarity and roll."
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(event) => onPatch({ enabled: event.target.checked ? undefined : false })}
              />
            </label>
            <SupportGemPicker
              skill={skill}
              skillIndex={skillIndex}
              slot={slot}
              value={link.id}
              compatibleOnly={gemFilter === "compatible"}
              preset={gemPreset ?? undefined}
              // Swapping the gem swaps the gem: a different id is a different physical item, so
              // it arrives at the preset rather than inheriting the roll of the one it replaced.
              // Re-picking the same gem is a no-op and keeps whatever the slider says.
              onChange={(id) => onPatch(id === link.id ? { id } : { id, ...(gemPreset ?? {}) })}
            />
          </div>

          <div className="row wrap" style={{ marginTop: 3 }}>
            <GemRarityRoll
              gem={link}
              shownRoll={roll.shown}
              onPreview={roll.preview}
              onChange={(next) => onPatch(next)}
            />
            {/* The cost multiplier is the other half of the gem's trade and is not in `stats`,
                so it would otherwise be the one term with nothing on screen to show for it. */}
            {gemCostMulti > 1 && (
              <span
                className="badge bad"
                title="SocketedGem.getManaCostMulti — this gem alone. The heading above multiplies every socketed gem's together."
              >
                ×{gemCostMulti.toFixed(2)} cost
              </span>
            )}
          </div>
        </div>

        {lines.length > 0 && (
          <div className="gem-mods">
            {lines.map((line, at) => (
              <span
                key={`${line.statId}-${at}`}
                className={`gem-mod${line.tone === "" ? "" : ` ${line.tone}`}`}
                title={line.statId}
              >
                {line.text}
              </span>
            ))}
          </div>
        )}

        <button className="gem-remove" title="Unsocket this gem entirely" onClick={onRemove}>
          ✕
        </button>
      </div>

      {!on && (
        <div className="muted text-sm" style={{ marginTop: 2 }}>
          Switched off — this socket grants nothing and charges nothing.
        </div>
      )}
    </div>
  );
}

/**
 * One line of what a gem grants, with the sense of it.
 *
 * `text` is the wording; the rest is what the wording cannot carry. A support gem is a trade —
 * `aoe_dmg` is `+9..27% More Area Damage` **and** `−30 Increased AoE` — and a list rendered in
 * one colour makes the reader work out which half is which from the sign of a number buried in
 * a sentence. Two of them are unsigned outright: `20% Less Armor` reads like a benefit.
 */
type GemLine = { text: string; statId: string; tone: "good" | "bad" | "" };

/**
 * The stats the pack does not flag as "down is up", but which are.
 *
 * `minus_is_good` covers 38 stats in the registry — every aura cost, every `dmg_received`,
 * `mana_cost` — and misses the handful below, which are registered in Java with no JSON and so
 * declare nothing at all. Without them a gem adding channel time or energy cost renders as a
 * benefit in green, which is worse than rendering it in no colour.
 */
const DOWN_IS_UP = new Set([
  "imbuement_energy_cost",
  "channel_cast_time",
  "spirit_cost",
  "aggro_radius",
  "proj_spread_randomness",
]);

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
function gemLines(
  snapshot: Snapshot,
  gemId: string,
  rollPercent: number,
  level: number,
): GemLine[] {
  const stats = entry(snapshot, CATEGORY.supportGem, gemId)?.data["stats"];
  if (!Array.isArray(stats)) return [];
  const index = statIndex(snapshot);
  const curves = balance(snapshot);

  return stats
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((stat) => {
      const rolled = parseRolledMod(stat);
      const statId =
        rolled?.statId ?? (typeof stat["stat"] === "string" ? stat["stat"] : "");
      if (rolled === undefined) {
        const value = modifierValue(stat, rollPercent);
        return {
          text: modifierLine(snapshot, stat, rollPercent),
          statId,
          tone: toneOf(snapshot, statId, value),
        };
      }
      const exact = rollToExact(rolled, rollPercent, level, index.shapeOf(rolled.statId), curves);
      return {
        // `modifierLine` words the stat; feeding it the resolved value as a fixed `v1` keeps the
        // wording — templates, "More"/"Increased", the percent suffix — and swaps in the number.
        text: modifierLine(snapshot, { stat: rolled.statId, type: rolled.type, v1: exact.value }),
        statId,
        tone: toneOf(snapshot, statId, exact.value),
      };
    });
}

/**
 * Whether a number on a gem is the upside or the downside.
 *
 * The same rule the stat list uses, and deliberately so: green and red have to mean one thing
 * across the app. Exactly zero is neither — a stat that rolled to nothing has not helped or
 * hurt, and colouring it either way states something that did not happen.
 */
function toneOf(snapshot: Snapshot, statId: string, value: number): "good" | "bad" | "" {
  if (value === 0) return "";
  const down = DOWN_IS_UP.has(statId) || statDisplay(snapshot, statId).minusIsGood;
  return (down ? value < 0 : value > 0) ? "good" : "bad";
}

/**
 * `SocketedGem.getManaCostMulti` — the product of every linked gem's `manaMulti`.
 *
 * Switched-off gems are skipped, which is what `activeSupportLinks` does in the engine: the
 * planner's own switch means "this socket is empty", and an empty socket charges nothing.
 */
function supportCostMulti(snapshot: Snapshot, skill: SkillSetup): number {
  let multi = 1;
  for (const link of supportLinks(skill)) {
    if (!isSupportEnabled(link)) continue;
    multi *= manaMulti(snapshot, link.id);
  }
  return multi;
}

/** One gem's own `manaMulti`. 1 when it declares none, which is what "charges nothing" is. */
function manaMulti(snapshot: Snapshot, gemId: string): number {
  const declared = entry(snapshot, CATEGORY.supportGem, gemId)?.data["manaMulti"];
  return typeof declared === "number" && Number.isFinite(declared) ? declared : 1;
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
