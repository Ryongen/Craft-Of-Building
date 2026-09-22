/**
 * The Stats tab: every stat the build resolved, and where each one came from.
 *
 * ## What it used to be, and why it stopped
 *
 * It was fourteen curated boxes — a chosen set of stat ids per subject, grouped by mechanism —
 * *above* the complete sheet. That was two renderings of the same data on one screen, and once
 * the complete sheet moved here from the sidebar it read as exactly that: strength, health, the
 * resists and the speed stats each appeared twice, a scroll apart, with no rule telling you which
 * copy to read. The curated grouping was a real idea, and it was worth having while it was the
 * *only* thing on this tab and the exhaustive list lived somewhere else.
 *
 * So the boxes are gone and `StatList` is the screen. It is grouped — `SHEET_GROUPS` in
 * `@cte2/schema` authors the sections, because `mmorpg_stat.group` files 536 of the pack's 832
 * stats under `Misc` and cannot — it is filterable, which is what the boxes' curation was
 * standing in for, and it is complete, which they never were.
 *
 * ## What is not a stat, and is therefore not here
 *
 * Effective HP and the maximum hit are defence-pass figures rather than sheet stats, and they are
 * on the Defence tab and in the sidebar. A copy here would be the same duplication one layer
 * along.
 *
 * ## The three things a row can say that a bare number cannot
 *
 * The legend under the header is the surviving half of the boxes' notes: a `×N` badge is a
 * `MULTIPLICATIVE_DAMAGE` stat holding its whole contribution back for the damage layer, a `cap`
 * badge is a hard ceiling reached, and `43.10% (1,575.9)` is an `IUsableStat` — the percent it
 * converts to in play, and the raw rating behind it.
 */

import { isSkillEnabled, spellName, type SkillSetup } from "@cte2/schema";
import { balance, simulateDps, spellRanks, type DpsResult } from "@cte2/engine";
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { mainSkillIndex, useDerived, type DerivedBuild } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { num, smart } from "../../ui/format.js";
import { Splitter } from "../../ui/Splitter.js";
import { SheetDetail, type SheetFocus } from "./SheetDetail.js";
import { StatList } from "./StatList.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

/** Whether the header's figures read per hit or per second. */
type Mode = "hit" | "dps";

export function CalcsPanel(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const derived = useDerived();
  const skills = doc.skills ?? [];

  // The engine's own answer, not a second copy of its rule — see `mainSkillIndex`.
  const mainIndex = mainSkillIndex(derived);
  /*
   * `undefined` means "follow the main skill", which is not the same as "index 0".
   *
   * `useState(mainIndex)` reads its argument on the first render only, and on the first render
   * the document is still the blank one the session restore has not replaced yet — so opening a
   * build landed on whatever skill happened to be first rather than on the one its damage figure
   * is about. Picking from the dropdown pins it; nothing else moves it.
   */
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const skillIndex = picked ?? mainIndex;
  const [mode, setMode] = useState<Mode>("dps");

  /**
   * Which number the pane at the bottom is about.
   *
   * The same `SheetFocus` the sidebar uses, so a row here and a row there open the same window
   * and mean the same thing by "selected".
   */
  const [focus, setFocus] = useState<SheetFocus | null>(null);
  const [detailHeight, setDetailHeight] = useState(340);
  const selected = focus?.kind === "stat" ? focus.statId : null;
  const select = (statId: string | null): void =>
    setFocus(statId === null ? null : { kind: "stat", statId });

  /**
   * The skill the header is about.
   *
   * `useDerived` resolves the document's *main* skill and nothing else, so asking about any other
   * one is a real engine call. Memoised on the document and the index, and only on this tab —
   * selecting the main skill costs nothing, because that run is already in hand.
   */
  const skill: SkillSetup | undefined = skills[skillIndex];
  const result: DpsResult | undefined = useMemo(() => {
    if (skill === undefined) return undefined;
    if (skillIndex === mainIndex) return derived.dps;
    try {
      return simulateDps(doc, world.snapshot, { skill });
    } catch {
      // A document mid-edit can name a spell that no longer exists. The list below is about the
      // character and stays useful; only the skill header goes quiet.
      return undefined;
    }
  }, [skill, skillIndex, mainIndex, derived.dps, doc, world.snapshot]);

  const ranks = useMemo(
    () => spellRanks(world.snapshot, derived.stats, balance(world.snapshot)),
    [world.snapshot, derived.stats],
  );

  return (
    <div className="panel calcs-panel">
      <div className="calcs-body">
        <SkillHeader
          skills={skills}
          skillIndex={skillIndex}
          onSkillIndex={setPicked}
          mode={mode}
          onMode={setMode}
          result={result}
          rank={skill === undefined ? undefined : ranks.get(skill.spellId)}
          derived={derived}
        />

        <StatList selected={selected} onSelect={select} />
      </div>

      {/*
        The same drill-down the sidebar opens, docked to the bottom of this tab.

        Same component, same splitter, same behaviour, because a breakdown that looked or worked
        differently depending on which screen opened it would be two features.
      */}
      {focus !== null && (
        <>
          <Splitter height={detailHeight} onChange={setDetailHeight} />
          <div className="breakdown-pane" style={{ height: detailHeight }}>
            <SheetDetail focus={focus} onFocus={setFocus} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Which skill, read how, and what is assumed up.
 *
 * The three things every number below is conditional on. PoB puts them at the top of its Calcs
 * tab for the same reason: a damage figure with no statement of which skill it is about and
 * which buffs were counted is not a figure anybody can check.
 */
function SkillHeader({
  skills,
  skillIndex,
  onSkillIndex,
  mode,
  onMode,
  result,
  rank,
  derived,
}: {
  skills: readonly SkillSetup[];
  skillIndex: number;
  onSkillIndex: (index: number) => void;
  mode: Mode;
  onMode: (mode: Mode) => void;
  result: DpsResult | undefined;
  rank: number | undefined;
  derived: DerivedBuild;
}): ReactNode {
  const { snapshot } = useWorld();

  /**
   * What the figures below assume is up.
   *
   * Read off the effect state the *damage pipeline* settled, not off the document: availability
   * is a fixed point — what is up depends on the sheet and the sheet depends on what is up — so
   * the document's own list is the input to that and not its answer.
   */
  const assumed = derived.effects.options
    .filter((option) => option.side === "caster" && option.stacks > 0 && option.hasStats)
    .map((option) => option.id);

  return (
    <div className="card mb-4">
      <div className="row wrap gap-6">
        <div className="field">
          <label>Skill</label>
          <select
            value={skillIndex}
            disabled={skills.length === 0}
            onChange={(event) => onSkillIndex(Number(event.target.value))}
          >
            {skills.length === 0 && <option value={0}>no skills</option>}
            {skills.map((skill, index) => (
              <option key={`${skill.spellId}-${index}`} value={index}>
                {spellName(snapshot, skill.spellId)}
                {skill.main === true ? " (main)" : ""}
                {isSkillEnabled(skill) ? "" : " — off"}
              </option>
            ))}
          </select>
          {rank !== undefined && (
            <span className="muted text-sm" title="The rank the engine resolved off the sheet">
              rank {rank}
            </span>
          )}
        </div>

        <div className="field">
          <label title="Per hit is one press landing; per second divides it by the cast cycle. The stats below are the same either way — this only changes the figures on this row.">
            Read as
          </label>
          <select value={mode} onChange={(event) => onMode(event.target.value as Mode)}>
            <option value="dps">Per second</option>
            <option value="hit">Per hit</option>
          </select>
        </div>

        {result !== undefined && <Figures result={result} mode={mode} />}
      </div>

      <div className="muted text-sm mt-3 prose">
        {assumed.length === 0 ? (
          <>Nothing is assumed up. The Config tab is where buffs and exile effects are switched.</>
        ) : (
          <>
            Assumed up: {assumed.join(", ")}. Every number on this screen is computed with these
            applied — switch them on the Config tab.
          </>
        )}
      </div>

      {/*
        The legend the curated boxes used to carry in their notes. Three row conventions a bare
        number cannot explain, said once here rather than under every section that happens to
        contain an example of one.
      */}
      <>
      <Plain>
        <div className="muted text-sm mt-3 prose">
          Multiplier values (like xN) represent multiplicative damage stats that apply directly during final damage calculations, which is why their sheet values show as 0. Reaching a cap indicates a hard ceiling. Values formatted like 43.10% (1,575.9) show the effective in-game percentage followed by the underlying rating score that generates it. Click any row to view its exact source calculation.
        </div>
      </Plain>
      <Tech>
        <div className="muted text-sm mt-3 prose">
          <span className="badge warn">×N</span> is a <code>MULTIPLICATIVE_DAMAGE</code> stat holding
          its whole contribution back for the damage layer, which is why several of those read 0.{" "}
          <span className="badge bad">cap</span> is a hard ceiling reached.{" "}
          <strong>43.10% (1,575.9)</strong> is an <code>IUsableStat</code>: the percent the rating
          converts to in play, and the rating behind it. Click any row for where its number came
          from.
        </div>
      </Tech>
      </>
    </div>
  );
}

/** The skill's own figures, in whichever unit the header is set to. */
function Figures({ result, mode }: { result: DpsResult; mode: Mode }): ReactNode {
  const perCycle = result.rate.cycleSeconds;
  const scale = (perCast: number): number =>
    mode === "hit" || perCycle <= 0 ? perCast : perCast / perCycle;
  const unit = mode === "hit" ? "" : "/s";

  return (
    <>
      <Fig label="Damage" value={`${smart(scale(result.damagePerCast))}${unit}`} />
      <Fig label="Crit" value={`${smart(scale(result.critDamagePerCast))}${unit}`} />
      <Fig label="Crit chance" value={`${num(result.hit.critChance * 100, 2)}%`} />
      <Fig label="Cycle" value={`${num(perCycle, 2)}s`} />
      {result.ailmentDps > 0 && <Fig label="Ailments" value={`${smart(result.ailmentDps)}/s`} />}
      {result.procDps > 0 && <Fig label="Procs" value={`${smart(result.procDps)}/s`} />}
      {result.summonDps > 0 && <Fig label="Summons" value={`${smart(result.summonDps)}/s`} />}
    </>
  );
}

function Fig({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="field">
      <label>{label}</label>
      <span className="num">{value}</span>
    </div>
  );
}
