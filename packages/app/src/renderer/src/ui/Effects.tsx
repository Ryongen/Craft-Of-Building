/**
 * The one effects control, shown wherever exile effects are edited.
 *
 * There used to be two. The Config tab listed `build.exileEffects` — what a capture recorded —
 * and the Damage tab listed `config.effects` — what the player wanted assumed — and neither
 * consulted the other. Unticking a buff in Damage switched off the *branch* of the spell that
 * needed it while its stats stayed on the character, because the stats came from the capture and
 * nothing there had a tick. Removing it from Config instead did turn the stats off, and turning
 * it back on lost the roll and the strength the capture had measured, which for a buff like
 * Hunter's Focus is the difference between one extra projectile and three.
 *
 * So this renders `EffectState` — the single answer the engine resolves once and uses for the
 * character sheet, the mob's debuffs and every gate — and writes back to `config.effects`, which
 * is the single place that answer can be overridden.
 */

import type { EffectOption, EffectState } from "@cte2/engine";
import { auraName, exileEffectName, supportGemName, type EffectSetup } from "@cte2/schema";
import { useMemo, type ReactNode } from "react";

import { useBuild } from "../state/build-store.js";
import { useWorld } from "../state/snapshot.js";
import { NumberField } from "./fields.js";
import { Picker, type PickerOption } from "./Picker.js";
import { useEffectProvenance } from "./Provenance.js";

/**
 * What an effect nobody mentioned is assumed to be.
 *
 * A capture is a complete reading of what was live, so a document that has one describes a real
 * character and anything absent from it was genuinely not up. A document without one is somebody
 * planning, and has nothing to read. Both are useful and neither is a default that can be left
 * implicit, so it is a switch.
 */
export function AssumeSwitch({ effects }: { effects: EffectState }): ReactNode {
  const doc = useBuild((s) => s.doc);
  const setAssumeEffects = useBuild((s) => s.setAssumeEffects);
  const stated = doc.config?.assumeEffects !== undefined;
  const captured = (doc.exileEffects ?? []).length;

  const why = stated
    ? ""
    : effects.assume === "captured"
      ? ` Defaulted this way because ${captured} effect(s) came from a capture.`
      : " Defaulted this way because no capture recorded what was live.";

  return (
    <label
      className="field"
      style={{ gap: 4 }}
      title={
        (effects.assume === "captured"
          ? "Effects your build could apply but nothing recorded are off, so the sheet reads as " +
            "the game did. Turn any of them on below — a branch that needs one says so."
          : "Everything your skills, stats and auras could apply is assumed up at its cap. The " +
            "planner's reading: it will not match a capture of the same character.") + why
      }
    >
      <input
        type="checkbox"
        checked={effects.assume === "available"}
        onChange={(event) => setAssumeEffects(event.target.checked ? "available" : "captured")}
      />
      <span className="text-sm">assume everything available is up</span>
    </label>
  );
}

/**
 * Every effect the build could have, as toggles, split by who holds it.
 *
 * The two halves answer different questions and a single row hides that. Buffs are "what am I
 * standing in"; debuffs are "what have I put on the mob" — `shred` stripping four fifths of its
 * armour at ten stacks, `elemental_weakness` (the pack calls it Scorched) taking 25 off every
 * elemental resist. Both are worth a DPS number and neither should have to be hunted for.
 */
export function EffectToggles({ effects }: { effects: EffectState }): ReactNode {
  const setEffect = useBuild((s) => s.setEffect);

  if (effects.options.length === 0) {
    return (
      <div className="faint text-sm">
        Nothing this build owns applies an exile effect that changes a number.
      </div>
    );
  }

  const buffs = effects.options.filter((o) => o.side === "caster");
  const debuffs = effects.options.filter((o) => o.side === "target");

  return (
    <>
      {buffs.length > 0 && (
        <Group
          {...(debuffs.length > 0 ? { label: "on you" } : {})}
          options={buffs}
          onChange={setEffect}
        />
      )}
      {debuffs.length > 0 && (
        <Group
          label="on the enemy"
          hint="Debuffs a skill on your bar can inflict. The DPS above assumes the ticked ones are on the target."
          options={debuffs}
          onChange={setEffect}
        />
      )}
    </>
  );
}

function Group({
  label,
  hint,
  options,
  onChange,
}: {
  label?: string;
  hint?: string;
  options: EffectOption[];
  onChange: (id: string, setup: EffectSetup | undefined) => void;
}): ReactNode {
  return (
    <div style={{ marginTop: label === undefined ? 0 : 6 }}>
      {label !== undefined && (
        <div className="faint text-xs" style={{ marginBottom: 3 }} title={hint}>
          {label}
          {hint !== undefined && " *"}
        </div>
      )}
      <div className="row wrap gap-5">
        {options.map((option) => (
          <EffectToggle key={option.id} option={option} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

/** One effect: on, off, or pinned to a number of stacks below its cap. */
export function EffectToggle({
  option,
  onChange,
}: {
  option: EffectOption;
  onChange: (id: string, setup: EffectSetup | undefined) => void;
}): ReactNode {
  const world = useWorld();
  const on = option.stacks > 0;
  /*
    What the buff actually grants, as a card rather than as a line of the `title` string.

    The toggle said which effects were assumed up and never what any of them did, so "is Frenzy
    Charge worth assuming" meant leaving the tab. The card is the same one the damage trace
    raises on a `Buffs & effects` row, priced at this option's own roll and stacks — which is
    the point of sharing it: the toggle and the trace cannot end up describing the buff
    differently.
  */
  const where = useEffectProvenance(option.id);

  const grants = option.grantedBy
    .map((g) =>
      g.kind === "spell"
        ? `the skill ${g.spellId}`
        : g.kind === "stat"
          ? `the stat ${g.statId}`
          : g.kind === "support"
            ? `the ${supportGemName(world.snapshot, g.gemId)} support gem in ${g.spellId}`
            : g.kind === "aura"
              ? `the ${auraName(world.snapshot, g.auraId)} Augment`
              : g.kind === "captured"
                ? "your capture"
                : "this document",
    )
    .join(", ");
  const capNote =
    option.maxStacks !== option.declaredMaxStacks
      ? ` — ${option.declaredMaxStacks} base, ${option.maxStacks} with your charge bonus` +
        (option.capturedStacks !== undefined && option.capturedStacks !== option.stacks
          ? `, and your capture caught it at ${option.capturedStacks}. A charge sits at its cap, ` +
            "so the cap is what is counted"
          : "")
      : "";

  // Where the strength came from is the difference between a buff worth what the game says it is
  // and one reading at its minimum, and nothing else on screen would show it.
  //
  // `strMulti` is always derived, even for a captured effect. A capture measures the character as
  // it was, and the moment you edit the build away from that character the measurement is about
  // somebody else — which is why a +50% to defensive buffs used to move nothing. Where the two
  // disagree the capture is named, so the change is visible rather than silent.
  const drifted =
    option.capturedStrMulti !== undefined &&
    Math.abs(option.capturedStrMulti - option.strMulti) > 0.0005;
  const measured = drifted
    ? ` Your capture measured x${round(option.capturedStrMulti ?? 1)}, before the edits since.`
    : "";
  const strength = option.captured
    ? `Rolled at ${option.rollPercent}% (measured by your capture), x${round(option.strMulti)} ` +
      `from your inc_effect_of_*_buff_* stats.${measured}`
    : option.spellId === undefined
      ? "Rolled at 0%: nothing in the build says which spell would apply it, and the percent comes " +
        "from that spell's rank. Its bands read at their minimum."
      : `Rolled at ${option.rollPercent}% from ${option.spellId}'s rank, x${round(option.strMulti)} ` +
        "from your inc_effect_of_*_buff_* stats. Derived, not measured.";

  // A gate it cannot meet is the more fundamental answer than losing its group, and the one
  // that stays true whatever else you turn on, so it leads.
  const blocked = option.needs === undefined ? undefined : option.needs.join(", ");
  const why = option.chosen
    ? "You set this."
    : on
      ? "Assumed on."
      : blocked !== undefined
        ? `Unavailable: the only thing that grants it is gated on ${blocked}, which this build ` +
          "cannot put up. Tick it anyway to plan around one."
        : option.excludedBy !== undefined
          ? ""
          : "Off: your capture did not record it. Tick it to assume it anyway.";

  return (
    <div
      className="row"
      style={{
        gap: 6,
        alignItems: "center",
        opacity: option.excludedBy === undefined && blocked === undefined ? 1 : 0.5,
      }}
      title={
        `${exileEffectName(world.snapshot, option.id)} (${option.id})\n` +
        `Granted by ${grants}${capNote}.\n` +
        `${strength}\n` +
        (option.side === "target" ? "Lands on the enemy, not on you.\n" : "") +
        (option.excludedBy === undefined
          ? ""
          : `Excluded: only one ${option.group} can be up, and ${option.excludedBy} is.\n`) +
        why
      }
    >
      <label className="field" style={{ gap: 4 }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => onChange(option.id, event.target.checked ? true : false)}
        />
        <span className="text-sm has-source" {...where.props}>
          {option.id}
          {where.node}
        </span>
      </label>
      {on && option.maxStacks > 1 && (
        <NumberField
          value={option.stacks}
          min={1}
          max={option.maxStacks}
          width={44}
          onChange={(value) => onChange(option.id, value === undefined ? undefined : value)}
        />
      )}
      {on && option.maxStacks > 1 && (
        <span className="faint text-xs">
          /{option.maxStacks}
        </span>
      )}
      {option.side === "target" && (
        <span className="badge text-xs" title="Lands on the enemy">
          enemy
        </span>
      )}
      {blocked !== undefined && (
        <span className="badge warn text-xs" title={`Needs ${blocked}`}>
          needs {blocked}
        </span>
      )}
      {blocked === undefined && option.excludedBy !== undefined && (
        <span className="badge text-xs">
          {option.group}
        </span>
      )}
    </div>
  );
}

/**
 * Assume an effect nothing in the build would apply.
 *
 * Availability is an aid to whoever is filling in the form, not a veto over what they write:
 * "the target is shredded" and "I am planning around a Fortify I have not bought yet" are both
 * reasonable things to ask, and an explicit entry is itself enough to make the effect real.
 */
export function AddEffect({ effects }: { effects: EffectState }): ReactNode {
  const world = useWorld();
  const setEffect = useBuild((s) => s.setEffect);

  // Memoised because this walks every exile effect in the pack to build the "not already offered"
  // list, and it was doing so on every render of a panel that re-renders on every document edit.
  const options: PickerOption[] = useMemo(() => {
    const offered = new Set(effects.options.map((o) => o.id));
    return world.exileEffectIds
      .filter((id) => !offered.has(id))
      .map((id) => ({ id, label: exileEffectName(world.snapshot, id), keywords: id }));
  }, [effects.options, world]);

  return (
    <div className="row gap-3 mt-4">
      <span className="faint text-sm">
        assume another:
      </span>
      <Picker
        options={options}
        value={undefined}
        placeholder="an effect nothing here grants…"
        onChange={(id) => id !== undefined && setEffect(id, true)}
        width={240}
      />
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
