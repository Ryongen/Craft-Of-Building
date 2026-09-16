/**
 * Which exile effects this build can have up, and which are assumed up.
 *
 * A third of what the pack calls a "skill" is really a branch table keyed on exile effects.
 * `soul_siphon` declares eight mutually exclusive `on_cast` parts — one per aura, doubled by
 * whether `sacrifice` has three stacks — and until something evaluated those gates the engine
 * counted all eight, so it reported a spell that fires four different projectiles at once.
 * `armageddon` declares its meteor stream twice, the second copy gated on four `overheat`
 * stacks. Every weapon skill in the pack asks which stance you are in.
 *
 * So "what is up" is not decoration around the damage model, it *is* the damage model, and it
 * has to be answered before a source list means anything.
 *
 * ## Availability, and why it is derived rather than declared
 *
 * The question a planner has to answer is not "which effects exist" (212 of them) but "which
 * could *this* build have", and that is derivable from three places:
 *
 *   - **the skills you have equipped** — 157 effects are applied by an `exile_effect` act in
 *     some spell's component tree, `fighter_stance` and `overheat` and `shred` among them;
 *   - **the stats you carry** — 59 more come from a `give_exile_effect` stat effect hanging off
 *     a stat. That is the only way to get `fortify`, and the only way to get the three charges:
 *     no spell in the pack grants `endurance_charge`, a support gem or an ascendancy node does;
 *   - **the aura skills you run** — this pack has two aura systems, and only one of them matters
 *     here. `mmorpg_aura` holds the passive gem auras (armor, dodge, fire_damage); the *spell*
 *     auras are exile effects applied by a skill of the same name, and the thirteen of them share
 *     `one_of_a_kind_id: "aura"`. So "which aura is active" is answered by the skill bar, which
 *     is what lets `soul_siphon` pick between its sanguine, abyssal and plague branches — each a
 *     different projectile with a different `value_calculation`.
 *
 * An effect nothing in the build can produce is not offered, which is the whole point: a list
 * of 212 toggles is not a user interface, and a list of the four your gear actually grants is.
 *
 * ## Stacks
 *
 * `max_stacks` is in the data, and `ExileEffect.getMaxCharges` adds a bonus on top:
 *
 *     return this.max_stacks + en.maxCharges.bonus.getOrDefault(this.GUID(), 0);
 *
 * where the bonus map is filled by `UnsavedMaxEffectStacksData.calc`, which sweeps the stat
 * container for every `MaximumChargesStat` and writes its value against the effect it names.
 * Those stats are named `max_<effect id>_charges` — `max_endurance_charge_charges` and friends
 * — so the cap is read off the sheet rather than declared.
 *
 * An active effect is assumed to be at that cap unless the document says otherwise. Charges are
 * the case that justifies it: a build that generates endurance charges runs at three of them,
 * and reporting one would be as arbitrary a choice as reporting three, with the disadvantage of
 * being wrong.
 *
 * ## What is assumed, and how loudly
 *
 * Everything available is assumed active, at max stacks, and every one of them is reported in
 * `EffectState.options` with what granted it and whether the answer was chosen or defaulted.
 * The alternative — assume nothing — makes every combo finisher in the pack report zero, and
 * the alternative before this file existed — assume *everything*, including effects that
 * exclude each other — is what counted `soul_siphon` four times over.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, EffectSetup, ExileEffectSetup } from "@cte2/schema";
import { CATEGORY, entry, isAuraEnabled, isSkillEnabled, learnedSpells, supportLinks } from "@cte2/schema";

import { balance } from "../balance.js";
import { spellRanks, type SpellRanks } from "../collect/spell.js";
import type { Sheet } from "./ctx.js";

/**
 * Whose effect it is — whose stat sheet its stats land on.
 *
 * **Not** `ExileEffect.type`. That field says buff or debuff for display, and it disagrees with
 * who holds the effect often enough to be a trap: `bleed_effect` is typed `negative` and the
 * stat that grants it, `bleed_effect_when_hit`, puts it on *you* when you are bled.
 *
 * The answer is in the grant. A `give_exile_effect` block carries a `side` — which end of the
 * event the stat's owner is — and the stat effect carries a `give_to`, and the receiver is the
 * player exactly when the two agree. A spell says it with its target selector instead: `self`
 * is the caster, an `aoe` or an `in_front` is whatever it hit.
 */
export type EffectHolder = "caster" | "target";

/**
 * Which end of the triggering event the granting stat's owner is on — the block's own `side`.
 *
 * Distinct from {@link EffectHolder}, which says who ends up *holding* the effect. The two answer
 * different questions and a stat can disagree on them: `endurance_charge_when_hit` is
 * `side: "Target"` (you are being hit) and gives to the target (you), so the holder is the caster
 * while the side is Target.
 *
 * It is kept because it decides whose spell the grant is bound to. `GiveExileStatusEffect` copies
 * the event's spell onto the effect when `event.isSpell()`, and on a Source-side grant that spell
 * is yours — the one you just cast. On a Target-side grant it belongs to whatever hit you, which
 * a build document knows nothing about.
 */
export type EffectSide = "Source" | "Target";

/** One thing in the build that could put an effect up, and on whom. */
export type EffectGrant = {
  holder: EffectHolder;
  /**
   * Effects the part carrying this grant is gated on — its own `caster_has_mns_effect` entries,
   * and only the positive ones.
   *
   * A grant behind an unmet gate is not a grant. The pack writes its aura variants exactly this
   * way: `blasphemous_ritual` declares three `ritual_of_*` grants behind three different
   * `caster_has_mns_effect` gates, one per aura, so reading the acts without the gates offers
   * all three to a character who can only ever run one aura.
   *
   * Negated gates are deliberately not requirements. "When you do *not* have X" puts no
   * precondition on a build, because not having something is always reachable — and
   * `blasphemous_ritual`'s own first part is that shape, so treating it as one would make the
   * ritual unavailable the instant the ritual was up.
   */
  requires?: readonly string[];
} & (
  /** A spell in the build has an `exile_effect` act naming it. */
  | { kind: "spell"; spellId: string; action: string }
  /** A stat the sheet holds references a `give_exile_effect` stat effect for it. */
  | { kind: "stat"; statId: string; value: number; event: string; side: EffectSide }
  /**
   * A support gem linked into one of your Skills carries such a stat.
   *
   * Separate from `stat` because a support gem's stats never reach the character sheet — they
   * are a `SUPPORT_GEM` context on the Skill — so nothing about your sheet would reveal that
   * socketing Fortify into Tailwind Sweep is what fortifies you.
   */
  | { kind: "support"; gemId: string; spellId: string; statId: string; event: string; side: EffectSide }
  /**
   * The spell's *own* `statsForSkillGem` carries such a stat.
   *
   * `Spell.getStats` interpolates that list over the spell's rank and files it as an
   * `INNATE_SPELL` context on the Skill, so — exactly like a support gem's stats — it never
   * reaches the character sheet and the sheet scan below cannot see it. `tailwind_sweep` grants
   * `give_tailwind_on_hit` at a flat 100 and `stun_on_hit` at 10-20 this way, and both read as
   * unavailable until this arm existed: the sweep would then run the grant, find the effect
   * switched off, and report it as something the build had chosen not to use.
   */
  | { kind: "skill_gem"; spellId: string; statId: string; event: string; side: EffectSide }
  /**
   * An aura gem whose id is also an exile effect.
   *
   * None of this pack's 28 gem auras are, so this arm is unused here — it is kept because the
   * two registries are independent and a pack that overlapped them would otherwise be wrong.
   */
  | { kind: "aura"; auraId: string }
  /** The capture recorded it live on the character. */
  | { kind: "captured" }
  /**
   * `config.effects` names it, and nothing else in the build would.
   *
   * Hand-authoring needs this: a document that says "assume I am shredded" for a debuff none
   * of its own skills apply is a legitimate thing to ask, and without this arm the entry would
   * be silently dropped by the availability filter it was written to override.
   */
  | { kind: "declared" }
);

export type EffectOption = {
  id: string;
  side: EffectHolder;
  /** `max_stacks` + the `max_<id>_charges` stat, which is what `getMaxCharges` returns. */
  maxStacks: number;
  /** `max_stacks` alone, so a breakdown can show what the cap stat added. */
  declaredMaxStacks: number;
  /** `one_of_a_kind_id`: at most one member of a group can be up. Empty string means none. */
  group: string;
  /** Everything in the build that could produce it. Never empty for an offered option. */
  grantedBy: EffectGrant[];
  /** `ExileEffect.type` — what the game calls it, for a buff/debuff icon. */
  kind: "beneficial" | "negative";
  /** True when the effect grants stats of its own, rather than only answering a gate. */
  hasStats: boolean;
  /** Stacks assumed up. 0 means off. */
  stacks: number;
  /** True when the document decided this, false when it was defaulted. */
  chosen: boolean;
  /** Set when an exclusivity group forced it off in favour of another member. */
  excludedBy?: string;
  /**
   * Prerequisites that no grant of this effect can meet, so nothing in the build could put it up.
   *
   * Reported rather than silently dropping the row: "you cannot have this, and here is what it
   * wants" is the answer somebody hunting a missing buff needs. An explicit `config.effects`
   * entry still overrides it, the same escape hatch hand-authored documents have everywhere else.
   */
  needs?: string[];
  /**
   * The spell whose rank {@link rollPercent} was interpolated over, when one is known.
   *
   * From the capture where the capture has it, and otherwise from the skill on the bar that
   * would apply the effect — for the pack's self-buffs those are the same id, because the spell
   * `hunters_focus` is what grants the effect `hunters_focus`.
   */
  spellId?: string;
  /**
   * The percent every one of the effect's stats rolls at, 0-100.
   *
   * `ExileEffect.getExactStats` interpolates over the rank of whatever applied the effect, so
   * this is not decoration: `hunters_focus` grants `FLAT 1..3 projectile_count`, which is one
   * extra projectile at 0% and three at 100%.
   */
  rollPercent: number;
  /**
   * `ExileEffectInstanceData.str_multi` — a flat multiplier on every stat the effect grants.
   *
   * Always derived, from the `inc_effect_of_*_buff_*` stats matching the effect's tags. See
   * {@link strMultiFor}, which also says why it is not read off a capture.
   */
  strMulti: number;
  /**
   * What a capture measured {@link strMulti} to be, when one recorded this effect.
   *
   * Kept for comparison rather than used. The two agree on every fixture in this project, and a
   * build edited away from the captured character is exactly when they should stop agreeing —
   * so a divergence here is either the edit working or `strMultiFor` drifting, and both are
   * worth being able to see.
   */
  capturedStrMulti?: number;
  /** Stacks the capture recorded, when it recorded this effect. */
  capturedStacks?: number;
  /** True when a capture recorded this effect at all. */
  captured: boolean;
};

export type EffectState = {
  /** Every effect the build could have, in id order. The UI's toggle list. */
  options: EffectOption[];
  /**
   * What an effect `config.effects` does not mention was assumed to be — see
   * `BuildConfig.assumeEffects`. Reported so the UI can say which reading produced the list.
   */
  assume: "available" | "captured";
  /** Active effects and their stacks, for the gates. Only entries above 0. */
  active: Map<string, number>;
  /** The chosen member of each `one_of_a_kind_id` group. */
  chosenOfGroup: Map<string, string>;
};

export type EffectStateInput = {
  snapshot: Snapshot;
  build: BuildDoc;
  /** The character sheet, for `give_exile_effect` grants and the `max_*_charges` caps. */
  sheet: Sheet;
  /**
   * Effect ids the current skill's gates name, positive ones first.
   *
   * Used only to break a tie inside an exclusivity group: if you have two auras available and
   * the spell has a branch for one of them, that is the branch the figure should describe.
   */
  preferred?: readonly string[];
  /** Which `mmorpg_balance` entry to read `MAX_BONUS_SPELL_LEVELS` from, for the roll percent. */
  balanceId?: string;
  /**
   * The charge state the skill's own combo pass reaches, from `planCombo`.
   *
   * Availability is the right default everywhere else: an effect your gear or your bar can put
   * up is one you want the number for. A combo *resource* is the exception, because it is not a
   * thing you have, it is a thing the previous press just handed you — and the pack's branch
   * tables read it both ways round. `phase_dive` has eight mutually exclusive branches over
   * `alpha`, `beta` and `gamma`, and assuming all three up picks the eighth for free while the
   * chain that pays for it presses three buttons and arrives holding one.
   *
   * So for these ids alone, "up" means "the pass delivers it" rather than "the build could".
   * Everything gated but never spent — stances, auras, the charges — keeps the old reading,
   * because those you do simply have.
   */
  combo?: { resources: readonly string[]; holds: readonly string[] };
};

/** An empty state, for a caller that has no build to resolve against. */
export const NO_EFFECTS: EffectState = {
  options: [],
  assume: "captured",
  active: new Map(),
  chosenOfGroup: new Map(),
};

/**
 * Resolves what is up.
 *
 * Order matters: availability first, then the document's own choices, then exclusivity, because
 * an explicit choice has to be able to win a group against a defaulted member.
 */
export function resolveEffectState(input: EffectStateInput): EffectState {
  const { snapshot, build, sheet } = input;
  const declared = build.config?.effects ?? {};
  const captures = new Map<string, ExileEffectSetup>();
  for (const effect of build.exileEffects ?? []) captures.set(effect.id, effect);

  const grants = collectGrants(input);
  const options: EffectOption[] = [];

  const gated = gatedEffects(snapshot);
  const bal = balance(snapshot, input.balanceId);
  const maxBonusSpellLevels = bal.maxBonusSpellLevels;
  // The same `calcSpellLevels` the rest of the pipeline runs on. A buff's strength is read off
  // the rank of the skill that applies it, and that rank includes the bonus ranks a +2 to Buff
  // Spells amulet grants — so deriving it from the document alone under-reported every buff on
  // a character wearing one.
  const ranks = spellRanks(snapshot, sheet, bal);

  // Availability is the planner's reading and the default: an effect your gear, your tree or a
  // skill on your bar can put up is one you want to see the number for, and the toggle beside it
  // is how you say otherwise. `"captured"` is the closed-world reading a fixture asks for, where
  // an effect the capture did not record was genuinely not running.
  const assume: "available" | "captured" = build.config?.assumeEffects ?? "available";

  for (const [id, grantedBy] of [...grants].sort((a, b) => a[0].localeCompare(b[0]))) {
    const data = entry(snapshot, CATEGORY.exileEffect, id)?.data;
    if (!data) continue;

    const hasStats = asArray(data["stats"]).length > 0;
    // An effect with no stats that nothing tests for cannot change any number this engine
    // reports, and 212 toggles is not a user interface. `bleed_effect` is the case: no stats,
    // no gate, granted to you whenever something bleeds you.
    if (!hasStats && !gated.has(id)) continue;

    const declaredMax = Math.max(1, numberAt(data, "max_stacks") ?? 1);
    const bonus = Math.trunc(sheet.get(`max_${id}_charges`)?.value ?? 0);
    const maxStacks = Math.max(1, declaredMax + bonus);
    const setup = declared[id];
    const capture = captures.get(id);

    // A capture is a measurement of the live effect and beats any derivation, which is the
    // project's standing rule and also the only way the fixtures stay pinned. Where there is
    // none, both halves of an effect's strength are derived rather than left at the floor.
    const spellId = capture?.spellId ?? bindingSpell(grantedBy);

    // What "up" means for this effect when the document does not name a number.
    //
    // Normally the capture's own count, which is what stops unticking and re-ticking a buff the
    // capture caught at two of five from silently promoting it to five.
    //
    // A **charge** is the exception, and it is the case this file's header already argues for:
    // "a build that generates endurance charges runs at three of them, and reporting one would
    // be as arbitrary a choice as reporting three, with the disadvantage of being wrong". A
    // charge is a resource you sit at the cap of, so the cap is the answer and a photograph of
    // one moment is not evidence against it.
    //
    // It is also the only kind of effect whose cap an edit can move: `MaximumChargesStat` is
    // declared for `charm` and for exactly these three, and they are exactly the pack's
    // `charge`-tagged effects. Reading the capture's count for them is what made the Guardian
    // ascendancy do nothing — its two `+1 max endurance charge` nodes raise the cap to five and
    // the figure stayed at the three the capture had photographed under a different ascendancy.
    const isCharge = tagsOf(data).includes("charge");
    const natural =
      isCharge || capture?.stacks === undefined
        ? maxStacks
        : Math.max(1, Math.min(capture.stacks, maxStacks));

    // A caster-side grant wins: `caster_has_mns_effect` only ever asks about the caster, and
    // an effect something can put on you is one you can have.
    const side: EffectHolder = grantedBy.some((g) => g.holder === "caster") ? "caster" : "target";

    options.push({
      id,
      side,
      kind: stringAt(data, "type") === "negative" ? "negative" : "beneficial",
      hasStats,
      maxStacks,
      declaredMaxStacks: declaredMax,
      group: stringAt(data, "one_of_a_kind_id") ?? "",
      grantedBy,
      // A captured effect is on by default even in the closed-world reading: the capture saw it.
      stacks: stacksFor(setup, maxStacks, natural, assume === "available" || capture !== undefined),
      chosen: setup !== undefined,
      captured: capture !== undefined,
      ...(capture?.stacks === undefined ? {} : { capturedStacks: capture.stacks }),
      ...(spellId === undefined ? {} : { spellId }),
      rollPercent: rollPercentFor(snapshot, build, spellId, maxBonusSpellLevels, ranks),
      // Derived, never taken from the capture. See {@link strMultiFor}: it is a pure function of
      // the sheet and the effect's tags, it reproduces every captured value in this project's
      // fixtures exactly, and pinning it meant no `inc_effect_of_*` stat an edit added could ever
      // move a buff the capture had already measured.
      strMulti: strMultiFor(sheet, data, side),
      ...(capture?.strMulti === undefined ? {} : { capturedStrMulti: capture.strMulti }),
    });
  }

  resolveAvailability(options, input.preferred ?? []);
  pinComboResources(options, input.combo);

  const active = new Map<string, number>();
  const chosenOfGroup = new Map<string, string>();
  for (const option of options) {
    if (option.stacks <= 0) continue;
    active.set(option.id, option.stacks);
    if (option.group.length > 0) chosenOfGroup.set(option.group, option.id);
  }

  return { options, assume, active, chosenOfGroup };
}

/**
 * How many stacks a document entry asks for, with the cap as the ceiling.
 *
 * `true` and an absent entry mean the same thing — "up, at whatever it would naturally be at" —
 * so that ticking an effect back on after unticking it restores what it was rather than jumping
 * somewhere else. What `natural` is depends on the reading and is decided by the caller, where
 * `BuildConfig.assumeEffects` is in scope.
 *
 * `defaultOn` is what an *absent* entry means. An explicit `true` ignores it: the document said
 * yes, and a number said yes at that number.
 */
function stacksFor(
  setup: EffectSetup | undefined,
  maxStacks: number,
  natural: number,
  defaultOn: boolean,
): number {
  if (setup === undefined) return defaultOn ? natural : 0;
  if (setup === false) return 0;
  if (setup === true) return natural;
  return Math.max(0, Math.min(Math.trunc(setup), maxStacks));
}

/**
 * Exclusivity and prerequisites together, because neither settles without the other.
 *
 * A grant gated on another effect is only a grant while that effect is up, and which effect is
 * up is what exclusivity decides — so `blasphemous_ritual`'s three `ritual_of_*` variants
 * cannot be resolved in one pass. The group's last-resort tiebreak picks `ritual_of_abyss` on
 * id order, whose gate wants an aura the character does not run; only once that member is struck
 * out does the tiebreak reach `ritual_of_blood`, which is the one the sanguine aura earns.
 *
 * Each pass therefore restarts from the stacks the document asked for and re-runs exclusivity
 * over the members not yet struck out, so a group whose winner dies re-elects instead of
 * emptying. `dead` only ever grows, which is what makes it terminate: at most one option is
 * struck out per pass, plus a final pass to observe that nothing changed.
 */
/**
 * Hold the skill's combo resources to what its pass actually delivers.
 *
 * Runs after {@link resolveAvailability} rather than instead of it, so a resource still has to be
 * something the build can produce before the pass is asked whether it produced it — an id in
 * `holds` that no grant supports never became an option in the first place and stays off.
 *
 * The document's own word still wins. `config.effects` naming a resource is a statement about
 * the character ("assume I have alpha up"), and a derived rotation does not get to overrule one,
 * here or anywhere else in this file.
 */
function pinComboResources(
  options: EffectOption[],
  combo: { resources: readonly string[]; holds: readonly string[] } | undefined,
): void {
  if (combo === undefined || combo.resources.length === 0) return;
  for (const option of options) {
    if (option.chosen) continue;
    if (!combo.resources.includes(option.id)) continue;
    option.stacks = combo.holds.includes(option.id) ? option.maxStacks : 0;
  }
}

function resolveAvailability(options: EffectOption[], preferred: readonly string[]): void {
  const base = new Map(options.map((option) => [option.id, option.stacks] as const));
  const dead = new Set<string>();

  for (let pass = 0; pass <= options.length; pass++) {
    for (const option of options) {
      option.stacks = dead.has(option.id) ? 0 : (base.get(option.id) ?? 0);
      delete option.excludedBy;
    }
    applyExclusivity(options, preferred);

    const up = new Set(options.filter((o) => o.stacks > 0).map((o) => o.id));
    let struck = false;
    for (const option of options) {
      if (option.stacks <= 0 || dead.has(option.id)) continue;
      // The document's own word wins here as everywhere else: `config.effects` naming an effect
      // is a statement about the character, not a derivation to be overruled.
      if (option.chosen) continue;
      const missing = unmetRequirements(option, up);
      if (missing === undefined) continue;
      option.needs = missing;
      dead.add(option.id);
      struck = true;
    }
    if (!struck) break;
  }

  // A member that lost its group *and* could not have met its own gate is better explained by
  // the gate: "wants Plague Aura" stays true whatever else you turn on, where "lost to
  // ritual_of_blood" is a fact about the rest of the build. Both are recorded; the gate is the
  // one worth leading with.
  const settled = new Set(options.filter((o) => o.stacks > 0).map((o) => o.id));
  for (const option of options) {
    if (dead.has(option.id)) option.stacks = 0;
    const missing = option.stacks > 0 || option.chosen ? undefined : unmetRequirements(option, settled);
    if (missing === undefined) delete option.needs;
    else option.needs = missing;
  }
}

/**
 * The unmet prerequisites of this effect, or `undefined` when some grant of it is reachable.
 *
 * Grants are alternatives — a build that can put an effect up two ways needs only one of them —
 * so an effect is out of reach only when every grant it has sits behind something absent. What
 * comes back is the shortest unmet list, which is the useful thing to say: "this wants Abyssal
 * Aura", rather than the union of three branches nobody is running.
 */
function unmetRequirements(option: EffectOption, up: ReadonlySet<string>): string[] | undefined {
  let shortest: string[] | undefined;
  for (const grant of option.grantedBy) {
    const missing = (grant.requires ?? []).filter((id) => !up.has(id));
    if (missing.length === 0) return undefined;
    if (shortest === undefined || missing.length < shortest.length) shortest = missing;
  }
  return shortest;
}

/**
 * `one_of_a_kind_id`: at most one member of a group is ever up.
 *
 * The winner is, in order: the member the document explicitly turned on; the member the capture
 * saw up; the member granted by a spell of the same name, because a `fighter_stance` on your bar
 * is how you say which stance you are in; the member the current skill has a branch for; then the
 * first by id. Losers are switched off with `excludedBy` set, so the UI can show *why* a stance it
 * offered is not counted.
 *
 * The same-name rule earns its place on the stances, where one spell grants both: casting
 * `fighter_stance` gives you `fighter_stance` if you have neither and swaps you to
 * `defender_stance` if you already had it, so availability alone cannot tell them apart.
 *
 * The capture rule earns its place wherever the group is named after neither member and the spell
 * decides at cast time: `blasphemous_ritual` grants `ritual_of_blood` or `ritual_of_abyss`, both
 * in the group `ritual`, and nothing about the bar says which. Without this the tie fell through
 * to the first id, so loading a capture of a bleed character into the planner quietly swapped its
 * ritual for the chaos one — a direct observation losing to alphabetical order.
 */
function applyExclusivity(options: EffectOption[], preferred: readonly string[]): void {
  const groups = new Map<string, EffectOption[]>();
  for (const option of options) {
    if (option.group.length === 0 || option.stacks <= 0) continue;
    const list = groups.get(option.group);
    if (list) list.push(option);
    else groups.set(option.group, [option]);
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const namedBySpell = (m: EffectOption): boolean =>
      m.grantedBy.some((g) => g.kind === "spell" && g.spellId === m.id);
    const winner =
      members.find((m) => m.chosen) ??
      members.find((m) => m.captured) ??
      members.find(namedBySpell) ??
      members.find((m) => preferred.includes(m.id)) ??
      members[0];
    for (const member of members) {
      if (member === winner) continue;
      member.stacks = 0;
      member.excludedBy = winner!.id;
    }
  }
}

// ---------------------------------------------------------------------------
// How strong it is
// ---------------------------------------------------------------------------

/**
 * Whose rank the effect's stats interpolate over, where the build settles it.
 *
 * `GiveExileStatusEffect.activate` builds the grant with `NO_SPELL_RELATED` and then binds it:
 *
 *     .set(x -> {
 *         if (event.isSpell()) {
 *             x.data.setString(EventData.SPELL, event.getSpell().GUID());
 *             x.spellid = event.getSpell().GUID();
 *         }
 *     })
 *
 * — with the mod's own comment on those lines saying that without it "even a spell triggered
 * grant lands unbound and scales its stats off nothing". So a stat that hands out an effect when
 * you *hit* something binds the effect to the spell that did the hitting, and the effect then
 * rolls over that spell's rank rather than over nothing.
 *
 * Three of the grant kinds settle which spell that is, and two do not:
 *
 *   - **`spell`** — the effect's own applying skill, which is the self-buff case;
 *   - **`support`** and **`skill_gem`** — the stat belongs to exactly one Skill, so the hit that
 *     triggers it is that skill's and no other. Fortify socketed into Tailwind Sweep fortifies
 *     you off Tailwind Sweep's rank, and nothing else can fire that stat.
 *
 * A **Target-side** grant is excluded even when a spell is attached: `endurance_charge_when_hit`
 * fires on a hit *you took*, so the bound spell is the attacker's, and a build document cannot
 * know it. A plain **`stat`** grant off the character sheet is excluded too — it fires on
 * whichever spell you happen to be casting, which is a property of the rotation rather than of
 * the build, and guessing it here would quietly credit one skill's rank to another's buff.
 * Both of those genuinely do roll their minimum whenever what triggered them was not a spell.
 */
function bindingSpell(grantedBy: readonly EffectGrant[]): string | undefined {
  const spell = grantedBy.find((g) => g.kind === "spell");
  if (spell?.kind === "spell") return spell.spellId;
  const linked = grantedBy.find(
    (g) => (g.kind === "support" || g.kind === "skill_gem") && g.side === "Source",
  );
  if (linked?.kind === "support" || linked?.kind === "skill_gem") return linked.spellId;
  return undefined;
}

/**
 * The percent an exile effect's stats roll at.
 *
 *     LeveledValue lvlval = new LeveledValue(0, 100);
 *     int perc = (int) lvlval.getValue(caster, spell);
 *
 * with `LeveledValue.getValue`:
 *
 *     if (provider == null) { return 0; }
 *     if (min == max) { return min; }
 *     int maxlevel = provider.getMaxLevelWithBonuses();
 *     int level = provider.getCurrentLevel(en);
 *     float perlevel = (max - min) / maxlevel;
 *     return min + (perlevel * level);
 *
 * — so with min 0 and max 100 this is `100 / (max_lvl + MAX_BONUS_SPELL_LEVELS) * rank`,
 * truncated by the `(int)` cast. The null-provider arm is not a fallback we invented: an effect
 * whose applying spell is genuinely unknown really does roll its minimum.
 *
 * The spell is the one the capture recorded, or failing that whichever one {@link bindingSpell}
 * can settle from the grant — for the pack's self-buffs a spell of the same name, because the
 * spell `hunters_focus` is what grants the effect `hunters_focus`, and for a support gem or an
 * innate skill-gem stat the single Skill that stat belongs to. Deriving it is the difference
 * between that buff granting one extra projectile and granting three.
 */
export function rollPercentFor(
  snapshot: Snapshot,
  build: BuildDoc,
  spellId: string | undefined,
  maxBonusSpellLevels: number,
  ranks?: SpellRanks,
): number {
  if (spellId === undefined) return 0;
  const spell = entry(snapshot, CATEGORY.spell, spellId)?.data;
  if (!spell) return 0;

  const maxWithBonuses = (numberAt(spell, "max_lvl") ?? 16) + maxBonusSpellLevels;
  if (maxWithBonuses <= 0) return 0;

  // `getCurrentLevel` is `Spell.getLevelOf`, which reads the player's learned rank and floors at
  // `default_lvl`. A document states the rank on the skill; a document that does not gets it
  // from the class allocation, where a spell perk's `learn_<spell>` stat *is* its rank.
  const defaultLvl = numberAt(spell, "default_lvl") ?? 0;
  const declared = (build.skills ?? []).find((s) => s.spellId === spellId)?.level;
  const resolved = declared ?? ranks?.get(spellId) ?? learnedSpells(snapshot, build).get(spellId);
  const rank = Math.max(resolved ?? 0, defaultLvl);

  return Math.max(0, Math.min(100, Math.trunc((100 / maxWithBonuses) * rank)));
}

/**
 * `ExileEffectInstanceData.str_multi` — the multiplier applied to every stat the effect grants.
 *
 * `ExilePotionEvent` starts it at 1 and hands the event to the stat pipeline, where twenty-four
 * `inc_effect_of_<tag>_buff_given` / `_on_you` stats add themselves to the event's number on the
 * `additive_damage` layer, each gated on an `effect_has_tag_<tag>` condition:
 *
 *     extraData.str_multi = data.getNumber();
 *
 * so the result is `1 + (sum of the matching stats) / 100`. `_given` is the Source side of the
 * event and `_on_you` the Target side, so **who holds the effect decides which halves count**. A
 * self-buff is both sides at once and sums both. A debuff you put on a mob is not: you are the
 * Source, so your `_given` stats apply, but the `_on_you` half belongs to the *mob* — in this
 * pack that is `MobRarity.stats`, whose only entry is `inc_effect_of_negative_buff_on_you`.
 * Reading your own `_on_you` for a debuff would credit you twice for a stat about buffs landing
 * on you.
 *
 * Verified against the level-100 capture, which records three buffs and two of these stats:
 * `positive` 64.7 and `defensive` 50, with `offensive` at 0. `zen` is positive+defensive and the
 * game recorded 2.147; `fury` is positive+offensive and it recorded 1.647; `hunters_focus` is all
 * three and it recorded 2.147. This reproduces all three exactly.
 *
 * Only the `_given` half is pinned by that capture — the character carries no `_on_you` stat, so
 * that half is read from the same code path rather than from a measurement.
 *
 * ## Why a capture does not override this
 *
 * It used to, and that was the bug behind "my new ascendancy does nothing". This is a pure
 * function of the sheet and the effect's tags, with nothing unknowable in it — so a captured
 * value is a second opinion, not a missing input. Taking it meant the number was frozen at
 * whatever the character was when the photograph was taken: allocating Guardian, whose two
 * `inc_effect_of_defensive_buff_given` nodes are +50% between them, moved `protection`,
 * `fortify` and `blasphemous_ritual` not at all, because the capture had already measured them
 * at the Trickster value.
 *
 * Deriving it also makes the fixture runner stricter rather than looser. The captured value fed
 * the sheet that the capture's own `observed.stats` are compared against, so a drift in this
 * function would have been masked by the very measurement that should have caught it. Derived,
 * all 1342 observed stats still match, which is what pins the formula above.
 */
export function strMultiFor(
  sheet: Sheet,
  data: Record<string, unknown>,
  holder: EffectHolder = "caster",
): number {
  const tags = tagsOf(data);
  let percent = 0;
  for (const tag of tags) {
    percent += sheet.get(`inc_effect_of_${tag}_buff_given`)?.value ?? 0;
    if (holder === "caster") percent += sheet.get(`inc_effect_of_${tag}_buff_on_you`)?.value ?? 0;
  }
  // `Mth.clamp(str_multi, 0, ...)` has no counterpart in the Java: a character stacked deep
  // enough into "reduced effect of buffs" really can drive one negative. Zero is the floor a
  // multiplier can reach without inverting the sign of every stat the buff grants.
  return Math.max(0, 1 + percent / 100);
}

/** An `mmorpg_exile_effect`'s own `tags.tags`, which is what every `_<tag>_buff_` stat matches on. */
function tagsOf(data: Record<string, unknown>): string[] {
  return asArray(asObject(data["tags"])?.["tags"]).filter((t): t is string => typeof t === "string");
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** Every effect the build could put up, and what would put it there. */
function collectGrants(input: EffectStateInput): Map<string, EffectGrant[]> {
  const { snapshot, build, sheet } = input;
  const grants = new Map<string, EffectGrant[]>();
  const add = (id: string, grant: EffectGrant): void => {
    const list = grants.get(id);
    if (list) list.push(grant);
    else grants.set(id, [grant]);
  };

  for (const skill of build.skills ?? []) {
    if (!isSkillEnabled(skill)) continue;
    const spell = entry(snapshot, CATEGORY.spell, skill.spellId)?.data;
    if (!spell) continue;
    for (const applied of effectsAppliedBy(spell)) {
      add(applied.id, {
        kind: "spell",
        spellId: skill.spellId,
        action: applied.action,
        holder: applied.holder,
        ...(applied.requires.length === 0 ? {} : { requires: applied.requires }),
      });
    }
  }

  for (const aura of build.auras ?? []) {
    if (!isAuraEnabled(aura)) continue;
    if (entry(snapshot, CATEGORY.exileEffect, aura.id)) {
      add(aura.id, { kind: "aura", auraId: aura.id, holder: "caster" });
    }
  }

  for (const grant of statGrants(snapshot, sheet)) {
    add(grant.effectId, {
      kind: "stat",
      statId: grant.statId,
      value: grant.value,
      event: grant.event,
      holder: grant.holder,
      side: grant.side,
    });
  }

  // Support gems. Their stats are not on the sheet — `collectSupportGems` files them as
  // `SUPPORT_GEM` contexts belonging to the linked Skill — so the loop above cannot see them,
  // and without this a build with Fortify, Power Charge on Crit and Endurance on Hit socketed
  // was offered none of the three. The gem's roll is not consulted: every one of these bands is
  // positive at 0%, and availability only asks whether the stat is there at all.
  for (const skill of build.skills ?? []) {
    if (!isSkillEnabled(skill)) continue;
    for (const link of supportLinks(skill)) {
      const gem = entry(snapshot, CATEGORY.supportGem, link.id)?.data;
      if (!gem) continue;
      for (const raw of asArray(gem["stats"])) {
        const statId = stringAt(asObject(raw) ?? {}, "stat");
        if (statId === undefined) continue;
        for (const grant of grantingStats(snapshot).get(statId) ?? []) {
          add(grant.effectId, {
            kind: "support",
            gemId: link.id,
            spellId: skill.spellId,
            statId,
            event: grant.event,
            holder: grant.holder,
            side: grant.side,
          });
        }
      }
    }
  }

  // The spell's own innate stats, which reach the Skill the same way a support gem's do and are
  // invisible to the sheet scan for the same reason — `collectSpellStats` files them as an
  // `INNATE_SPELL` context. Without this, `tailwind_sweep`'s `give_tailwind_on_hit` (a flat 100,
  // so it fires on every hit) and its `stun_on_hit` were both unavailable, and the damage sweep
  // then reported the two effects as switched off rather than as ones the skill grants itself.
  for (const skill of build.skills ?? []) {
    if (!isSkillEnabled(skill)) continue;
    const spell = entry(snapshot, CATEGORY.spell, skill.spellId)?.data;
    if (!spell) continue;
    // `usesSupportGemsFromAnotherSpell` takes the other spell's innate stats too, at that spell's
    // own level — 21 spells in the pack do it, and the stats arrive on this Skill either way.
    const borrowed = stringAt(asObject(spell["config"]) ?? {}, "use_support_gems_from") ?? "";
    const sources: [string, Record<string, unknown>][] = [[skill.spellId, spell]];
    const other = borrowed.length > 0 ? entry(snapshot, CATEGORY.spell, borrowed)?.data : undefined;
    if (other) sources.push([borrowed, other]);

    for (const [spellId, data] of sources) {
      for (const raw of asArray(data["statsForSkillGem"])) {
        const statId = stringAt(asObject(raw) ?? {}, "stat");
        if (statId === undefined) continue;
        for (const grant of grantingStats(snapshot).get(statId) ?? []) {
          add(grant.effectId, {
            kind: "skill_gem",
            spellId,
            statId,
            event: grant.event,
            holder: grant.holder,
            side: grant.side,
          });
        }
      }
    }
  }

  // A capture records what was actually live on the character, which is the one source that
  // needs no inference at all — except about a skill you have since switched off. Turning a skill
  // off is how you ask what the build is worth without it, and leaving the buff it was sustaining
  // up would answer a different question. The capture names the spell that applied each effect,
  // so this is a lookup rather than a guess.
  const disabled = new Set(
    (build.skills ?? []).filter((s) => !isSkillEnabled(s)).map((s) => s.spellId),
  );
  for (const effect of build.exileEffects ?? []) {
    if (effect.spellId !== undefined && disabled.has(effect.spellId)) continue;
    if (entry(snapshot, CATEGORY.exileEffect, effect.id)) {
      add(effect.id, { kind: "captured", holder: "caster" });
    }
  }

  // An explicit `config.effects` entry is itself a grant, so that a document can assume an
  // effect nothing it owns would apply — "the target is shredded", "I am running with a
  // Fortify I have not bought yet". Availability is an aid to the person filling in the form,
  // not a veto over what they wrote. `false` grants nothing: it is how you say "not that one",
  // and an entry that only ever turned something off should not put it on the list.
  for (const [id, setup] of Object.entries(build.config?.effects ?? {})) {
    if (setup === false || setup === 0) continue;
    if (grants.has(id)) continue;
    const data = entry(snapshot, CATEGORY.exileEffect, id)?.data;
    if (!data) continue;
    // Nothing said who holds it, so `ExileEffect.type` is all there is. It is a poor signal —
    // which is why it is the last resort rather than the rule — but a debuff a document asks
    // for out of nowhere is being asked for on the mob.
    add(id, { kind: "declared", holder: stringAt(data, "type") === "negative" ? "target" : "caster" });
  }

  return grants;
}

/**
 * Every `exile_effect` act anywhere in a spell's tree, `per_entity_hit` included.
 *
 * Who receives it is the enclosing part's target selector: a `self` selector buffs the caster,
 * anything else lands on whatever the selector picked. That is the difference between
 * `fighter_stance`, which a spell puts on you, and `shred`, which a spell puts on the mob.
 */
type AppliedEffect = {
  id: string;
  action: string;
  holder: EffectHolder;
  requires: string[];
  /**
   * `potion_dur` in ticks, or `Infinity` for the `-1` a toggle writes.
   *
   * `ExileStatusEffectData.setDuration` stores it straight, and `-1` is the sentinel
   * `MMORPGStatusEffect` reads as "never expires" — which is how every stance, aura and
   * `banishing_blade`-style toggle in this pack is spelled. It is the only thing in the tree
   * that answers "how often do I have to press this", so it is carried out with the grant.
   */
  durationTicks: number;
};

function effectsAppliedBy(
  spell: Record<string, unknown>,
  keep: (action: string) => boolean = (action) => action.startsWith("GIVE"),
): AppliedEffect[] {
  const out = new Map<string, AppliedEffect>();

  const visitPart = (
    raw: unknown,
    inherited: EffectHolder | undefined,
    inheritedGates: readonly string[],
  ): void => {
    const part = asObject(raw);
    if (!part) return;
    const selectors = asArray(part["targets"]).flatMap((raw) => {
      const target = asObject(raw);
      if (target === undefined) return [];
      const type = stringAt(target, "type");
      if (type === undefined) return [];
      return [{ type, predicate: stringAt(asObject(target["map"]) ?? {}, "en_predicate") }];
    });
    // `self` is obvious; an area is the caster's too when it searches for allies, because you
    // are one of your own. `protection` buffs `aoe:allies` and is a self-buff in every practical
    // sense — reading only the selector type would have put it on the mob.
    const onCaster = (s: { type: string; predicate: string | undefined }): boolean =>
      s.type === "self" || s.predicate === "allies" || s.predicate === "casters_summons" || s.predicate === "pets";
    const holder: EffectHolder =
      selectors.length === 0
        ? (inherited ?? "caster")
        : selectors.every(onCaster)
          ? "caster"
          : "target";

    // Every gate on a part is ANDed, and a `per_entity_hit` sub-part only runs when the outer
    // part's own gates passed, so a nested grant carries both.
    const requires = [...inheritedGates, ...requiredEffectsOf(part)];

    for (const rawAct of asArray(part["acts"])) {
      const act = asObject(rawAct);
      if (!act || act["type"] !== "exile_effect") continue;
      const map = asObject(act["map"]) ?? {};
      const id = stringAt(map, "exile_potion_id");
      const action = stringAt(map, "potion_action") ?? "GIVE_STACKS";
      // Only an act that *grants* makes an effect available; `raging_dragon` consuming
      // `combo_extender` is not a way to get one. `keep` is what lets the combo walk ask the
      // opposite question — which effects a press takes away — off the same part-by-part rule,
      // rather than re-deriving who receives what and risking a second answer.
      if (id === undefined || !keep(action)) continue;
      const declaredDur = numberAt(map, "potion_dur");
      const durationTicks =
        declaredDur === undefined || declaredDur < 0 ? Number.POSITIVE_INFINITY : declaredDur;
      const key = `${id}:${holder}`;
      const existing = out.get(key);
      // One spell can grant the same effect from several parts behind different gates. The part
      // asking for least is the one that decides whether the build can have it, so an
      // unconditional grant must not stay hidden behind a gated one that was simply walked first.
      if (existing !== undefined && existing.requires.length <= requires.length) continue;
      out.set(key, { id, action, holder, requires, durationTicks });
    }
    // A `per_entity_hit` block runs against one entity the outer selector picked, so its grants
    // land on that entity rather than on the caster.
    for (const inner of asArray(part["per_entity_hit"])) visitPart(inner, "target", requires);
  };

  const attached = asObject(spell["attached"]) ?? {};
  for (const part of asArray(attached["on_cast"])) visitPart(part, undefined, []);
  for (const parts of Object.values(asObject(attached["entity_components"]) ?? {})) {
    for (const part of asArray(parts)) visitPart(part, undefined, []);
  }
  return [...out.values()];
}

/**
 * How long one press of a buff lasts, and which effect decides it.
 *
 * "How often do I press this" is the one thing a rotation figure needs from a buff and cannot
 * get from the rate: `cooldown_ticks` says how soon you *may* press it again, not how soon you
 * *have to*. The answer is the longest-lived effect the press puts on **you** — anything shorter
 * is a sub-effect the long one's own ticker refreshes, which is how every aura in this pack is
 * written:
 *
 *     blessed_aim   GIVE blessed_aim = -1  |  GIVE blessed_aim_effect = 1  |  REMOVE blessed_aim = 20
 *
 * The `-1` toggle is the press; the 1-tick `_effect` is re-applied every tick while it is up,
 * and the 20-tick `REMOVE` is the second press turning it off. So the maximum over the
 * caster-held **grants** is the reading, and taking the minimum would have said you must re-press
 * `blessed_aim` twenty times a second.
 *
 * Undefined when the spell puts nothing on the caster — a curse, a debuff, a plain attack. A
 * `-1` grant returns `Infinity`, which is the honest answer for a toggle: you press it once.
 */
/**
 * What one press of this spell does to the *caster's* own effects.
 *
 * The combo walk's view of a supplier: `turbo` hands you `alpha` and `beta`, `fusion` hands you
 * `gamma` and takes those two back. Both halves are read through `effectsAppliedBy`, so who
 * receives a grant is decided by the same target-selector rule that decides whether an effect is
 * offered at all — a walk of its own would be a second answer to that question, and the two
 * would drift.
 *
 * Caster-side only, and that is the point. `phase_dive` puts `stun` on everything its beta
 * projectile touches, and a walk blind to the selector counted that as a resource the press
 * supplies — so a finisher gated on `stun` would have been fed by a spell that only ever applies
 * it to somebody else.
 */
export function casterResourceFlow(spell: Record<string, unknown>): {
  grants: string[];
  spends: string[];
} {
  const mine = (applied: AppliedEffect): boolean => applied.holder === "caster";
  return {
    grants: effectsAppliedBy(spell).filter(mine).map((a) => a.id),
    spends: effectsAppliedBy(spell, (action) => action === "REMOVE_STACKS")
      .filter(mine)
      .map((a) => a.id),
  };
}

export type BuffUpkeep = {
  /** Ticks until the press has to be repeated. `Infinity` for a toggle. */
  durationTicks: number;
  /** The effect whose duration decided it. */
  effectId: string;
};

export function casterBuffUpkeep(spell: Record<string, unknown>): BuffUpkeep | undefined {
  let best: BuffUpkeep | undefined;
  for (const applied of effectsAppliedBy(spell)) {
    if (applied.holder !== "caster") continue;
    if (best === undefined || applied.durationTicks > best.durationTicks) {
      best = { durationTicks: applied.durationTicks, effectId: applied.id };
    }
  }
  return best;
}

/**
 * The effects a part's `ifs` require the caster to be holding.
 *
 * This is the availability half of `skill-model.ts`'s `requirementsOf`, which asks the harder
 * question — does this part *fire*, at these stacks, on this side — against a resolved state.
 * The question here is weaker and comes first: could the build ever satisfy the gate at all.
 * So it reads only `caster_has_mns_effect`, ignores `effect_stacks` (an effect you can have
 * you can have at its cap) and ignores `en_preds`, which ask about the target rather than
 * about you. The two cannot disagree, because this one is a strict weakening of that one.
 */
function requiredEffectsOf(part: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const raw of asArray(part["ifs"])) {
    const gate = asObject(raw);
    if (!gate || gate["type"] !== "caster_has_mns_effect") continue;
    const map = asObject(gate["map"]) ?? {};
    // `CasterHasExileEffectCondition` is `is_false ? !held : held`, and only `held` constrains
    // what a build can reach.
    if (map["is_false"] === true) continue;
    const id = stringAt(map, "exile_potion_id");
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Every effect some spell in the pack gates on, so an effect with no stats of its own is still
 * offered when a branch depends on it.
 *
 * Cached per snapshot: 432 spells is a walk worth doing once.
 */
const GATED_CACHE = new WeakMap<object, Set<string>>();

function gatedEffects(snapshot: Snapshot): Set<string> {
  const cached = GATED_CACHE.get(snapshot as unknown as object);
  if (cached) return cached;

  const found = new Set<string>();
  const visitPart = (raw: unknown): void => {
    const part = asObject(raw);
    if (!part) return;
    for (const rawGate of asArray(part["ifs"])) {
      const gate = asObject(rawGate);
      if (!gate) continue;
      const type = stringAt(gate, "type");
      if (type !== "caster_has_mns_effect" && type !== "has_mns_effect") continue;
      const id = stringAt(asObject(gate["map"]) ?? {}, "exile_potion_id");
      if (id !== undefined) found.add(id);
    }
    for (const inner of asArray(part["per_entity_hit"])) visitPart(inner);
  };

  for (const spell of Object.values(snapshot.registries[CATEGORY.spell] ?? {})) {
    const attached = asObject(asObject(spell.data)?.["attached"]) ?? {};
    for (const part of asArray(attached["on_cast"])) visitPart(part);
    for (const parts of Object.values(asObject(attached["entity_components"]) ?? {})) {
      for (const part of asArray(parts)) visitPart(part);
    }
  }

  // Stat conditions test for effects too — `is_target_under_scorched` is how a damage bonus
  // reads a debuff, and `elemental_weakness` would otherwise never be offered.
  for (const condition of Object.values(snapshot.registries[CATEGORY.statCondition] ?? {})) {
    const data = asObject(condition.data);
    if (!data) continue;
    const ser = stringAt(data, "ser");
    if (ser !== "is_under_exile_effect" && ser !== "is_mns_effect_max_charges" && ser !== "is_effect") {
      continue;
    }
    const id = stringAt(data, "effect");
    if (id !== undefined) found.add(id);
  }

  GATED_CACHE.set(snapshot as unknown as object, found);
  return found;
}

/**
 * Effects granted by a stat the character actually has.
 *
 * `give_exile_effect` is a `mmorpg_stat_effect`; a stat references it from an effect block, and
 * the block's `events` say when it fires — `on_damage` on the Source side is "when you hit",
 * on the Target side is "when you are hit", and `on_mob_kill` is a kill. The value is the stat's
 * own, which for most of these is a chance; the trigger rate is `procs.ts`'s problem, and for
 * availability all that matters is that the stat is above zero.
 */
function statGrants(
  snapshot: Snapshot,
  sheet: Sheet,
): (EffectGrantFromStat & { statId: string; value: number })[] {
  const out: (EffectGrantFromStat & { statId: string; value: number })[] = [];

  for (const [statId, grants] of grantingStats(snapshot)) {
    const value = sheet.get(statId)?.value ?? 0;
    if (value <= 0) continue;
    for (const grant of grants) out.push({ ...grant, statId, value });
  }
  return out;
}

/**
 * Every stat in the pack that hands out an exile effect, and which effect, keyed by stat id.
 *
 * Split out from {@link statGrants} because a stat can reach the character from somewhere the
 * sheet never sees. A support gem's stats belong to the Skill it is linked into, not to the
 * character — `SupportGem.GetAllStats` feeds `SUPPORT_GEM` contexts that only the linked spell
 * reads — so socketing Fortify really does mean "your melee hits fortify you" while
 * `sheet.get("fortify_on_melee_hit")` stays 0.
 *
 * Cached per snapshot: it walks all 1400-odd stats and the answer only changes with the pack.
 */
const GRANTING_STATS = new WeakMap<object, Map<string, EffectGrantFromStat[]>>();

/**
 * Events raised with one entity on both ends, where `side` and `give_to` cannot disagree.
 *
 * The `giveTo === side` rule below reads "which end of the event does the stat's owner sit on,
 * and which end receives" — a question that only means something when the event *has* two ends.
 * A player tick has one. `OnServerTick` builds it from the same local twice:
 *
 *     TenSecondPlayerTickEvent event = new TenSecondPlayerTickEvent(player, player);
 *
 * and `GiveExileStatusEffect.activate` resolves the receiver with `event.getSide(give_to)`, so
 * whichever end `give_to` names, the entity that comes back is the player. Checked against
 * `Mine_and_Slash-1.20.1-6.4.13.jar` — `OnServerTick` disassembles to `aload_0` twice into the
 * two-`LivingEntity` constructor — rather than against the fork checkout, per §0 of
 * `SKILL-MODELLING.md`.
 *
 * All eight of this pack's tick grants are written `side: Source, give_to: Target`, so the rule
 * filed every one of them onto the enemy. `gain_frenzy_charges_every_10s` is the one that shows
 * it up: frenzy charges are yours, and the pack has no other way to generate them. The other
 * seven are `instant_traps` (`saboteur`, which `pulsar_singularity_trap` gates on),
 * `reckless_defender`, and the five `cursed_by_*` stats — self-curses, where the player is the
 * one carrying `agony`, `despair`, `slow`, `weak` or `wounds`.
 *
 * Neither captured character carries any of the eight, so the fixtures neither confirm this nor
 * are disturbed by it; the jar is the whole of the evidence.
 */
const SELF_EVENTS = new Set(["player_tick_event_10s"]);

type EffectGrantFromStat = {
  effectId: string;
  event: string;
  holder: EffectHolder;
  side: EffectSide;
};

/**
 * Whether linking this support gem can change the *character sheet*.
 *
 * It sounds like it should always be no, and for most gems it is: `SupportGem.GetAllStats` feeds
 * a `SUPPORT_GEM` context that only the linked spell's own unit reads, which is the invariant the
 * Skills panel is built on. The exception is a gem carrying a `give_exile_effect` stat — Fortify,
 * Power Charge on Crit, Endurance on Hit. Availability is derived from what the build *can* put
 * up, and socketing one of those adds an effect to that list; the effect's own stats then land on
 * the character sheet like any other buff's, and effective HP and the weapon swing move with them.
 *
 * Exported because the planner prices ninety gems at a time and can skip recomputing the sheet
 * for the ones this returns false for. Deriving that in the app instead would be a second copy of
 * the rule, and the copy would be the one that went stale.
 */
export function supportGemAffectsSheet(snapshot: Snapshot, gemId: string): boolean {
  const gem = entry(snapshot, CATEGORY.supportGem, gemId)?.data;
  if (!gem) return false;
  const granting = grantingStats(snapshot);
  for (const raw of asArray(gem["stats"])) {
    const statId = stringAt(asObject(raw) ?? {}, "stat");
    if (statId !== undefined && granting.has(statId)) return true;
  }
  return false;
}

function grantingStats(snapshot: Snapshot): Map<string, EffectGrantFromStat[]> {
  const cached = GRANTING_STATS.get(snapshot as unknown as object);
  if (cached) return cached;

  const found = new Map<string, EffectGrantFromStat[]>();
  const effects = snapshot.registries[CATEGORY.statEffect] ?? {};
  const stats = snapshot.registries[CATEGORY.stat] ?? {};

  for (const [statId, stat] of Object.entries(stats)) {
    for (const rawBlock of asArray(asObject(stat.data)?.["effect"])) {
      const block = asObject(rawBlock);
      if (!block) continue;
      for (const rawId of asArray(block["effects"])) {
        if (typeof rawId !== "string") continue;
        const data = asObject(effects[rawId]?.data);
        const ser = data === undefined ? undefined : stringAt(data, "ser");
        if (ser !== "give_exile_effect" && ser !== "give_exile_effect_in_radius") continue;
        const effectId = stringAt(data!, "effect");
        if (effectId === undefined) continue;
        const event = asArray(block["events"]).find((e): e is string => typeof e === "string") ?? "on_damage";
        // `side` is which end of the event the stat's owner is on, `give_to` is which end
        // receives — so the player gets it exactly when the two agree. `endurance_charge_when_hit`
        // is `side: Target, give_to: Target`: you are the target, and you are who gains it.
        const side = stringAt(block, "side") ?? "Source";
        const giveTo = stringAt(data!, "give_to") ?? "Source";
        const list = found.get(statId);
        const grant: EffectGrantFromStat = {
          effectId,
          event,
          holder: SELF_EVENTS.has(event) ? "caster" : giveTo === side ? "caster" : "target",
          side: side === "Target" ? "Target" : "Source",
        };
        if (list) list.push(grant);
        else found.set(statId, [grant]);
      }
    }
  }

  GRANTING_STATS.set(snapshot as unknown as object, found);
  return found;
}

// ---------------------------------------------------------------------------
// Reading the state
// ---------------------------------------------------------------------------

/**
 * `CasterHasExileEffectCondition` — the gate 523 component parts in the pack carry.
 *
 * `effect_stacks` is a floor, not an equality: the condition asks whether the caster has *at
 * least* that many. `is_false` flips the whole answer, which is how a spell declares its
 * "and the plain version when you do not" branch.
 */
export function hasEffect(state: EffectState, effectId: string, minimumStacks = 1): boolean {
  return (state.active.get(effectId) ?? 0) >= Math.max(1, minimumStacks);
}

/** True when the effect is up and at the cap `getMaxCharges` would return. */
export function atMaxStacks(state: EffectState, effectId: string): boolean {
  const option = state.options.find((o) => o.id === effectId);
  if (!option) return false;
  return option.stacks > 0 && option.stacks >= option.maxStacks;
}

/** The active effects on one side of the hit, for the sheets that have to carry their stats. */
export function activeOn(state: EffectState, side: EffectHolder): EffectOption[] {
  return state.options.filter((o) => o.stacks > 0 && o.side === side);
}

/**
 * How many stacks of one effect the named side is holding.
 *
 * `state.active` is side-blind on purpose — the stat sweep asks "is this up at all" — but a gate
 * on a spell branch is not: `has_mns_effect` in an `en_preds` block asks about the entity being
 * hit, and answering it off the caster's list would pass a debuff gate because *you* were the
 * one who applied it.
 */
export function stacksHeldBy(state: EffectState, effectId: string, side: EffectHolder): number {
  const option = state.options.find((o) => o.id === effectId && o.side === side);
  return option?.stacks ?? 0;
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringAt(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAt(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
