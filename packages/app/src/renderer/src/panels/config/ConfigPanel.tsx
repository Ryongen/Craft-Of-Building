/**
 * The target, the buffs, and the conditions a static document cannot answer.
 *
 * The enemy is **stated, not derived**. The game builds a mob's defences by running the whole
 * stat calculation over `mmorpg_entity` + `mmorpg_mob_rarity` + map tier, and reproducing that
 * would stack a second unverified calculation underneath every damage number — a mismatch
 * against the game would then not say which half was wrong. Sandbox numbers keep the damage
 * pipeline attributable.
 *
 * The conditions list is driven by the engine's own diagnostics rather than by the 308 entries
 * in `mmorpg_stat_condition`: showing the ones this build actually hit is useful, and showing
 * all of them would be noise.
 */

import {
  FOOD_BUFF_SLOTS,
  SINGLE_ELEMENTS,
  TARGET_PRESETS,
  isFoodBuffEnabled,
  mobAffixName,
  serverConfigNumber,
  statBuffName,
  buildTargetEnemy,
  targetPreset,
  type EnemySetup,
  type FoodBuffSetup,
  type FoodBuffSlot,
  type TargetPreset,
} from "@cte2/schema";
import {
  IN_COMBAT_REGEN_MULTI_KEY,
  inCombatRegenMultiOf,
  mobAffix,
  mobAffixIds,
} from "@cte2/engine";

/**
 * `MaxElementalResist.max` — the ceiling on the stat that lifts the 75% resist cap.
 *
 * Code-only, so it is not in any snapshot. 75 + 15 is the 90 the resist itself clamps to, which
 * is why nothing can usefully hold more.
 */
const MAX_ELEMENTAL_RESIST = 15;
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { applyPatch, type Patch } from "../../state/patch.js";
import { useWorld } from "../../state/snapshot.js";
import { AddEffect, AssumeSwitch, EffectToggles } from "../../ui/Effects.js";
// Food buffs are not gems and carry no rarity, so they keep the plain slider.
import { NumberField, RollSlider } from "../../ui/fields.js";
import { AddPicker } from "../../ui/AddPicker.js";
import { Picker, type PickerOption } from "../../ui/Picker.js";
import { FoodDiversity } from "./FoodDiversity.js";

export function ConfigPanel(): ReactNode {
  return (
    <div className="panel">
      <EnemySection />
      <ServerSection />
      <ConditionsSection />
      {/* Augments live on the Items tab: they are socketed gems, not settings, and a player
          looks for them beside the gear. One editor, one place — two would be two ideas about
          what an unset roll means. */}
      <FoodSection />
      {/* Beside the food buffs rather than on a tab of its own: both are "what has this
          character eaten", and one of them was two clicks away from the other. */}
      <FoodDiversity />
      <ExileEffectsSection />
    </div>
  );
}

/**
 * The one number that comes from a server config rather than from a datapack.
 *
 * `IN_COMBAT_REGEN_MULTI` lives in `defaultconfigs/mine_and_slash-server.toml`. The extractor
 * reads that file now, so the default here is the player's own install rather than a constant —
 * but it stays a visible, editable field for the reason it always was: a server owner can change
 * it after a world exists, and the two likely values are a factor of two apart, which is the
 * difference between a build that sustains its rotation and one that does not.
 */
function ServerSection(): ReactNode {
  const world = useWorld();
  const { snapshot } = world;
  const doc = useBuild((s) => s.doc);
  const setInCombatRegenMulti = useBuild((s) => s.setInCombatRegenMulti);
  const stated = doc.config?.inCombatRegenMulti;
  // Read off the install's own `mine_and_slash-server.toml`, which the extractor now carries.
  // Before it did, this number was a constant in the engine and the field below asked the
  // player to retype it from a file already sitting in their game directory.
  const fromPack = inCombatRegenMultiOf(snapshot);
  const value = stated ?? fromPack;
  const packSaid = serverConfigNumber(snapshot, IN_COMBAT_REGEN_MULTI_KEY) !== undefined;

  return (
    <>
      <div className="section-title">Server</div>
      <div className="card">
        <div className="row wrap gap-6">
          <div className="field">
            <label>In-combat regen ×</label>
            <NumberField
              value={value}
              min={0}
              step={0.1}
              width={64}
              onChange={(next) => setInCombatRegenMulti(next)}
            />
          </div>
          {stated === undefined ? (
            <span className="faint text-sm">
              {packSaid
                ? "read from your install's server config"
                : "this pack's shipped value — no server config was found to read"}
            </span>
          ) : (
            <button onClick={() => setInCombatRegenMulti(undefined)}>
              Reset to your install&apos;s {fromPack}
            </button>
          )}
        </div>
        <div className="faint text-sm mt-4" style={{ maxWidth: 760 }}>
          <code>in_combat_regen_multi</code> is a <strong>server</strong> config rather than pack
          data, and is read from <code>defaultconfigs/mine_and_slash-server.toml</code> in the
          install you extracted from — override it here if the server you play on differs. Craft
          to Exile 2 ships <code>1.0</code>; Mine and Slash&apos;s own default is <code>0.5</code>.{" "}
          <code>in_combat</code> is a ten-second cooldown that
          every hit you land or take re-stamps, so a rotation never leaves it — this scales the
          regeneration column the Defence tab prints and the one the Damage tab&apos;s Sustain card
          spends. Energy is exempt by name in <code>RestoreResourceEvent.activate</code> and is
          never scaled by it.
        </div>
      </div>
    </>
  );
}

function EnemySection(): ReactNode {
  const doc = useBuild((s) => s.doc);
  const setEnemy = useBuild((s) => s.setEnemy);
  const applyTargetPreset = useBuild((s) => s.applyTargetPreset);
  const world = useWorld();
  const enemy = doc.config?.enemy ?? {};
  const preset = doc.config?.targetPreset;

  const patch = (next: Patch<EnemySetup>): void => setEnemy(applyPatch(enemy, next));

  const affixes = useMemo(
    () => mobAffixIds(world.snapshot).flatMap((id) => mobAffix(world.snapshot, id) ?? []),
    [world.snapshot],
  );
  const toggleAffix = (id: string): void => {
    const held = enemy.affixes ?? [];
    const next = held.includes(id) ? held.filter((x) => x !== id) : [...held, id];
    patch({ affixes: next.length > 0 ? next : undefined });
  };

  const setResist = (guid: string, value: number): void => {
    const resists = { ...(enemy.resists ?? {}) };
    if (value === 0) delete resists[guid];
    else resists[guid] = value;
    patch({ resists: Object.keys(resists).length === 0 ? undefined : resists });
  };

  const setMaxResist = (guid: string, value: number): void => {
    const maxResists = { ...(enemy.maxResists ?? {}) };
    if (value === 0) delete maxResists[guid];
    else maxResists[guid] = value;
    patch({ maxResists: Object.keys(maxResists).length === 0 ? undefined : maxResists });
  };

  return (
    <>
      <div className="section-title">Enemy</div>
      <div className="notice info">
        Stated, never derived. Building a mob from <code>mmorpg_entity</code> and its rarity
        would put a second unverified stat calculation underneath every damage number, and a
        mismatch against the game would no longer say which half was wrong. A preset below
        <em> fills</em> these rows and then gets out of the way &mdash; the engine still reads
        only what is written here, and every field stays yours to edit.
      </div>

      <div className="card">
        <div className="row wrap mb-2">
          <span className="card-title">
            Preset
          </span>
          {TARGET_PRESETS.map((option) => (
            <PresetButton
              key={option.id}
              option={option}
              active={preset === option.id}
              enemy={enemy}
              level={enemy.level ?? doc.character.level}
              onApply={() =>
                applyTargetPreset(option.id, world.snapshot, enemy.level ?? doc.character.level)
              }
            />
          ))}
          {preset !== undefined && (
            <span className="faint text-sm">
              from {targetPreset(preset)?.name ?? preset}
            </span>
          )}
        </div>
        <div className="faint text-sm mb-5" style={{ maxWidth: 760 }}>
          The Training Dummy mod&apos;s own targets, built the same way:{" "}
          <code>10 &times; stat_multi</code> of armour put through the level curve, and that same
          number again as every non-physical resistance, flat and unscaled. No mob in Mine and
          Slash has physical resistance &mdash; armour alone stops a physical hit &mdash; and a
          boss&apos;s raw resistance swallows that much penetration before the 75% clamp is even
          reached. <strong>Max resist</strong> is the one that is not a rarity: it solves its
          armour for 75% physical mitigation, as the dummy does, which is roughly three times a
          boss&apos;s own.
        </div>
        <div className="row wrap gap-8">
          <div className="field">
            <label>Level</label>
            <NumberField
              value={enemy.level ?? doc.character.level}
              min={1}
              onChange={(level) => patch({ level })}
            />
          </div>
          <div className="field">
            <label>Armour</label>
            <NumberField value={enemy.armor ?? 0} min={0} onChange={(armor) => patch({ armor })} />
          </div>
          <div className="field">
            <label>Damage reduction %</label>
            <NumberField
              value={enemy.damageReduction ?? 0}
              onChange={(damageReduction) => patch({ damageReduction })}
            />
          </div>
          <div className="field">
            <label>Block %</label>
            <NumberField
              value={enemy.blockChance ?? 0}
              min={0}
              onChange={(blockChance) => patch({ blockChance })}
            />
          </div>
          <div className="field">
            <label>Dodge</label>
            <NumberField value={enemy.dodge ?? 0} min={0} onChange={(dodge) => patch({ dodge })} />
          </div>
          {/* `spell_dodge` is a separate stat with a separate curve, and every mob in this pack
              has both — `mmorpg_base_stats/mob` gives 20 dodge and 15 spell dodge, level-scaled.
              Without this row a spell build was measured against a target that evaded none of
              its spells. */}
          <div className="field">
            <label>Magic dodge</label>
            <NumberField
              value={enemy.spellDodge ?? 0}
              min={0}
              onChange={(spellDodge) => patch({ spellDodge })}
            />
          </div>
        </div>

        {/* Mob affixes. Stated as ids rather than as the numbers they come to, which is the
            whole point of them: every field above is somebody's guess at a mob, and an affix is
            the game's own answer. `MobAffix.getStatAndContext` resolves each at
            `ToExactStat(100, level)` against the level above, and they stack with the fields
            rather than replacing them. This is the shape the Training Dummy mod settled on —
            presets that pin no numbers, with affixes as toggles on top. */}
        <div className="section-title">
          Affixes{" "}
          <span className="faint text-sm" style={{ fontWeight: "normal" }}>
            what makes a real mob tougher than the preset
          </span>
        </div>
        <div className="row wrap gap-5">
          {affixes.map((affix) => {
            const on = (enemy.affixes ?? []).includes(affix.id);
            return (
              <label key={affix.id} className="row gap-3" style={{ alignItems: "center" }}>
                <input type="checkbox" checked={on} onChange={() => toggleAffix(affix.id)} />
                <span className={on ? "" : "faint"}>{mobAffixName(world.snapshot, affix.id)}</span>
                <span className="badge mono text-sm">{affix.type}</span>
              </label>
            );
          })}
        </div>
        <div className="faint text-sm mt-3">
          A mob rolls at most one prefix and one suffix; more than that is reported rather than
          refused, because asking what three would cost is a fair question. Each resolves at the
          enemy level above, not yours.
        </div>

        <div className="section-title">Resists</div>
        <div className="row wrap gap-8">
          {SINGLE_ELEMENTS.map((element) => (
            <div className="field" key={element.guid}>
              <label>{element.displayName}</label>
              <NumberField
                value={enemy.resists?.[element.guid] ?? 0}
                width={62}
                onChange={(value) => setResist(element.guid, value)}
              />
            </div>
          ))}
        </div>

        {/* `max_<element>_resist` is what lifts the 75% clamp, and the Max resist preset is the
            only thing that writes it — so without these rows the preset set a number nothing
            could see. Physical is absent because it has no resist cap: armour is its layer. */}
        <div className="section-title">
          Max resists{" "}
          <span className="faint text-sm" style={{ fontWeight: "normal" }}>
            above the 75% base cap
          </span>
        </div>
        <div className="row wrap gap-8">
          {SINGLE_ELEMENTS.filter((element) => element.name !== "Physical").map((element) => (
            <div className="field" key={element.guid}>
              <label>{element.displayName}</label>
              <NumberField
                value={enemy.maxResists?.[element.guid] ?? 0}
                width={62}
                min={0}
                max={MAX_ELEMENTAL_RESIST}
                onChange={(value) => setMaxResist(element.guid, value)}
              />
            </div>
          ))}
        </div>
        <div className="faint text-sm mt-3">
          <code>ElementalResist.getUsableValue</code> is{" "}
          <code>clamp(75 + max_&lt;element&gt;_resist, min, 90)</code>, so this is an{" "}
          <em>addition</em> to the cap rather than the cap itself, and{" "}
          <code>MaxElementalResist.max</code> is {MAX_ELEMENTAL_RESIST} — exactly enough to reach
          the 90% hard cap and no more.
        </div>
        <div className="faint text-sm mt-3">
          Penetration is <strong>not</strong> floored at 0. <code>ElementalResist.min</code> is
          -300 and <code>getUsableValue</code> clamps to it, so enough penetration drives a
          resist negative and the mitigation layer becomes a multiplier — up to x4.0 damage at
          -300. The one case where it is wasted is a resist of <em>exactly</em> 0: the stat is
          never swept, because <code>ElementalResistEffect</code> does not override{" "}
          <code>runsOnZeroStat</code>. Armour is the mirror image — it does override it, so it
          runs at 0 armour, and the sign flip on <code>afterPene</code> caps amplification at
          x1.9. Both asymmetries are in the mod, not here.
        </div>
      </div>
    </>
  );
}

/**
 * Conditions the engine could not answer, offered as three-state overrides.
 *
 * `unknown-condition` is the diagnostic code the pipeline emits once per distinct id when it
 * meets an `is_*_not_on_cd`, `is_in_combat`, `is_day` or health-threshold condition. Anything
 * derivable from the build (spell tags, weapon type, element match) never appears here because
 * the engine answers it from the data.
 */
function ConditionsSection(): ReactNode {
  const doc = useBuild((s) => s.doc);
  const derived = useDerived();
  const setCondition = useBuild((s) => s.setCondition);
  const forced = doc.config?.conditions ?? {};

  const unanswered = useMemo(() => {
    const ids = new Set<string>();
    for (const diagnostic of derived.diagnostics) {
      if (diagnostic.code !== "unknown-condition") continue;
      // The message names the id in backticks; that is the only place it appears.
      const match = /`([^`]+)`/.exec(diagnostic.message);
      if (match?.[1] !== undefined) ids.add(match[1]);
    }
    for (const id of Object.keys(forced)) ids.add(id);
    return [...ids].sort();
  }, [derived.diagnostics, forced]);

  return (
    <>
      <div className="section-title">Conditions</div>
      {unanswered.length === 0 ? (
        <div className="faint mb-5">
          Nothing in this build depends on a condition the engine cannot work out for itself.
        </div>
      ) : (
        <div className="card">
          <div className="faint text-sm mb-4">
            These depend on the world or on what happened a moment ago, which no static document
            records. Left alone they are treated as inactive.
          </div>
          {unanswered.map((id) => (
            <div key={id} className="row" style={{ marginBottom: 3 }}>
              <span className="grow mono ellipsis text-md">
                {id}
              </span>
              <select
                value={forced[id] === undefined ? "" : forced[id] ? "on" : "off"}
                onChange={(event) => {
                  const value = event.target.value;
                  setCondition(id, value === "" ? undefined : value === "on");
                }}
              >
                <option value="">inactive (default)</option>
                <option value="on">force on</option>
                <option value="off">force off</option>
              </select>
            </div>
          ))}
        </div>
      )}
    </>
  );
}


/**
 * Meals, seafood and elixirs.
 *
 * Temporary, and worth editing rather than only recording: a meal is an hour of +14% health
 * that most characters are never without, so "what am I worth fed" and "what am I worth
 * hungry" are both real questions. One slot each, because `PlayerBuffData.map` is keyed by
 * `Type` — a second meal replaces the first.
 */
function FoodSection(): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const setFoodBuffs = useBuild((s) => s.setFoodBuffs);
  const level = doc.character.level;
  const buffs = doc.foodBuffs ?? [];

  const options = useMemo<PickerOption[]>(
    () => world.statBuffIds.map((id) => ({ id, label: statBuffName(world.snapshot, id), keywords: id })),
    [world],
  );

  const update = (index: number, next: FoodBuffSetup): void =>
    setFoodBuffs(buffs.map((buff, i) => (i === index ? next : buff)));

  return (
    <>
      <div className="section-title">Food and elixirs</div>
      <div className="notice">
        <code>StatBuff.getStats</code> rolls at <code>perc + lvl</code> — the crafted roll{" "}
        <em>plus</em> the food's level — so a level {level} food lands {level} points past its
        own band. The roll below is the crafted part alone, as the game stores it.
      </div>

      {buffs.map((buff, index) => (
        <div key={`${buff.id}-${index}`} className="row wrap mb-2">
          <Picker
            options={options}
            value={buff.id}
            onChange={(id) => id !== undefined && update(index, { ...buff, id })}
            width={200}
          />
          <select
            value={buff.slot ?? ""}
            onChange={(event) => {
              const next: FoodBuffSetup = { ...buff };
              const slot = event.target.value;
              if (slot === "") delete next.slot;
              else next.slot = slot as FoodBuffSlot;
              update(index, next);
            }}
          >
            <option value="">slot?</option>
            {FOOD_BUFF_SLOTS.map((slot) => (
              <option key={slot} value={slot}>
                {slot}
              </option>
            ))}
          </select>
          <div className="field">
            <label>Level</label>
            <NumberField
              value={buff.level ?? level}
              min={1}
              max={level}
              width={58}
              onChange={(next) => update(index, { ...buff, level: next })}
            />
          </div>
          <RollSlider
            label="roll"
            value={buff.rollPercent ?? 0}
            showBand={false}
            onChange={(rollPercent) => update(index, { ...buff, rollPercent })}
          />
          <label className="field">
            <input
              type="checkbox"
              checked={isFoodBuffEnabled(buff)}
              onChange={(event) => {
                const next: FoodBuffSetup = { ...buff };
                if (event.target.checked) delete next.enabled;
                else next.enabled = false;
                update(index, next);
              }}
            />
            enabled
          </label>
          <button onClick={() => setFoodBuffs(buffs.filter((_, i) => i !== index))}>✕</button>
        </div>
      ))}

      <AddPicker
        label="Add food buff"
        placeholder="Which buff?"
        options={options}
        width={240}
        onAdd={(id) => setFoodBuffs([...buffs, { id, level }])}
      />
    </>
  );
}

/**
 * Exile effects — one list, shared with the Damage tab.
 *
 * This used to be an editor for `build.exileEffects`, the capture's own record, with an add and a
 * remove button and no way to switch anything off. That made it a second, disconnected answer to
 * a question the Damage tab was also answering: a buff unticked there kept its stats here.
 *
 * Now both render the state the engine resolved once. A capture still supplies what only a
 * capture can — which spell applied the effect, and the `str_multi` it was applied with — and
 * everything else is derived, including for effects the capture never saw.
 */
function ExileEffectsSection(): ReactNode {
  const derived = useDerived();
  const doc = useBuild((s) => s.doc);
  const captured = (doc.exileEffects ?? []).length;

  return (
    <>
      <div className="section-title">Exile effects</div>
      <div className="row wrap gap-7 mb-3" style={{ alignItems: "baseline" }}>
        <span className="faint text-sm">
          {captured > 0
            ? `${captured} recorded by your capture, with the roll and strength the game had.`
            : "Nothing captured, so every strength below is derived from the skill that grants it."}
        </span>
        <AssumeSwitch effects={derived.effects} />
      </div>

      <EffectToggles effects={derived.effects} />
      <AddEffect effects={derived.effects} />
    </>
  );
}

/**
 * A preset button that says what it would do before you press it.
 *
 * The Training Dummy mod shows this on its own preset screen, and the reason is the same here:
 * every one of these buttons overwrites a block of fields the player may have edited, and the
 * only way to know which ones was to press it and read the diff off the rows afterwards. Eleven
 * presets differing by one `stat_multi` are not distinguishable from their names.
 *
 * Built by running `buildTargetEnemy` for real and diffing it against the enemy now, so the
 * preview cannot drift from what pressing the button does — it is the same call.
 */
function PresetButton({
  option,
  active,
  enemy,
  level,
  onApply,
}: {
  option: TargetPreset;
  active: boolean;
  enemy: EnemySetup;
  level: number;
  onApply: () => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const [open, setOpen] = useState(false);

  // Only while hovered: eleven of these resolving a full enemy block on every keystroke in the
  // level field is eleven times the work for ten previews nobody is looking at.
  const changes = useMemo(
    () => (open ? presetChanges(enemy, buildTargetEnemy(snapshot, option.id, level)) : []),
    [open, enemy, snapshot, option.id, level],
  );

  return (
    <span
      className="preset-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button className={active ? "primary" : ""} onClick={onApply}>
        {option.name}
      </button>
      {open && (
        <span className="preset-preview card">
          <span className="preset-preview-title">{option.name}</span>
          <span className="faint text-sm">{option.description}</span>
          {changes.length === 0 ? (
            <span className="faint text-sm mt-3">
              Every field already reads what this preset would set.
            </span>
          ) : (
            <span className="preset-preview-rows mt-3">
              {changes.map((row) => (
                <span key={row.label} className="preset-preview-row">
                  <span className="name">{row.label}</span>
                  <span className="faint mono">{row.from}</span>
                  <span className="faint">&rarr;</span>
                  <span className="mono">{row.to}</span>
                </span>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

type PresetChange = { label: string; from: string; to: string };

/**
 * What applying this preset would change, field by field.
 *
 * Rows that would not move are dropped: the question a hover answers is "what is different about
 * this one", and eleven identical lists answer nothing. `offence` is summarised rather than
 * listed, because its five entries move together and the two that matter to a reader are the two
 * that change what the mob does to you.
 */
function presetChanges(from: EnemySetup, to: EnemySetup): PresetChange[] {
  const out: PresetChange[] = [];
  const n = (value: number | undefined): string =>
    value === undefined ? "—" : Math.round(value).toLocaleString();
  const row = (label: string, a: number | undefined, b: number | undefined): void => {
    if (Math.round(a ?? 0) === Math.round(b ?? 0)) return;
    out.push({ label, from: n(a), to: n(b) });
  };

  row("Level", from.level, to.level);
  row("Armour", from.armor, to.armor);
  row("Dodge", from.dodge, to.dodge);
  row("Magic dodge", from.spellDodge, to.spellDodge);
  row("Block %", from.blockChance, to.blockChance);
  row("Damage reduction %", from.damageReduction, to.damageReduction);

  for (const element of SINGLE_ELEMENTS) {
    if (element.name === "Physical") continue;
    row(`${element.displayName} resist`, from.resists?.[element.guid], to.resists?.[element.guid]);
    row(
      `${element.displayName} max resist`,
      from.maxResists?.[element.guid],
      to.maxResists?.[element.guid],
    );
  }

  row("Its accuracy", from.offence?.accuracy, to.offence?.accuracy);
  row("Its armour penetration", from.offence?.armorPenetration, to.offence?.armorPenetration);

  return out;
}
