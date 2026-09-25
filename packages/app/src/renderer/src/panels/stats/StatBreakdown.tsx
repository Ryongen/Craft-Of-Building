/**
 * Where a number came from.
 *
 * The formula is `InCalcContainer.calculate` with the real numbers substituted, so the line on
 * screen is the arithmetic the engine actually ran rather than a description of it.
 *
 * Under it the contributions used to be one flat table sorted by magnitude, which answered
 * "what is the biggest thing" and not "why is this number what it is". A level 100 character's
 * fire resist is eight rows from six different kinds of source plus a transfer from another
 * stat, and reading that as a list means adding it up yourself to check it against the formula.
 * So the table rolls up by **kind of source**, each group carrying the subtotal it contributes
 * to the `flat` and `percent` terms above it — the table and the formula are then one reading
 * rather than two that happen to agree.
 *
 * Three other things it now discloses, each of which was previously a number with no
 * explanation:
 *
 * - **every context type has a name and a sentence**, where nine of the nineteen used to print
 *   their raw id — `NEWBIE_RESISTS` especially, which is a grant that *decays* rather than a
 *   penalty that accrues, and reads as an unexplained −25 without that said;
 * - **a transfer names its parent and is clickable**, because `elemental_resist → fire_resist`
 *   is one hop away and nothing linked to it;
 * - **a contribution from an effect nobody captured is marked assumed**, so a planner default
 *   reads as a stated assumption instead of as a wrong number.
 */

import {
  affixName,
  attributeName,
  auraName,
  enchantName,
  exileEffectName,
  gearTypeName,
  itemSetName,
  omen,
  omenName,
  perkName,
  runewordName,
  spellName,
  statBuffName,
  statDesc,
  statDisplay,
  statName,
  supportGemName,
  uniqueName,
} from "@cte2/schema";
import type { Snapshot } from "@cte2/extractor";
import type { EffectState } from "@cte2/engine";
import type { ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useProvenance } from "../../ui/Provenance.js";
import { useDerived, type ModContribution } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { num, signed, smart } from "../../ui/format.js";
import { StatIcon } from "../../ui/StatIcon.js";
import { statLook } from "../../ui/stat-look.js";
import { StepRow } from "../../ui/StepRow.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

/**
 * The kinds a contribution rolls up into, in the order they are shown.
 *
 * Not the same list as `CTX_TYPES`: three of those are gear in the player's eyes (the item, its
 * enchantments, its vanilla-attribute compat) and two are buffs. Grouping by what a player put
 * there is the point — nobody thinks of a chestplate's Protection V as a different *source*
 * from the chestplate.
 */
const KINDS = [
  { id: "gear", name: "Gear", types: ["GEAR", "ENCHANT_COMPAT", "VANILLA_STAT_COMPAT", "ITEM_SET"] },
  { id: "jewels", name: "Jewels", types: ["JEWEL"] },
  { id: "talents", name: "Talents", types: ["TALENT"] },
  { id: "ascendancy", name: "Ascendancy", types: ["ASCENDANCY"] },
  { id: "passives", name: "Spell school perks", types: ["PASSIVES"] },
  { id: "atlas", name: "Atlas", types: ["ATLAS"] },
  { id: "auras", name: "Auras", types: ["AURA"] },
  { id: "buffs", name: "Buffs & effects", types: ["POTION_EFFECT", "FOOD_BUFF"] },
  { id: "skills", name: "Skills & gems", types: ["INNATE_SPELL", "SUPPORT_GEM"] },
  { id: "level", name: "Level grants", types: ["NEWBIE_RESISTS", "STAT_POINTS"] },
  { id: "base", name: "Base", types: ["BASE_STAT"] },
  { id: "derived", name: "Derived", types: ["STAT_CTX_MODIFIER_BONUS", "MISC"] },
] as const;

/**
 * What each context type *is*, in one line.
 *
 * Nine of these printed as a bare id before, which is the kind of gap that makes a planner feel
 * like it is hiding something. The level grant gets the longest sentence because it is the one
 * people read as a bug: it is a starting bonus that decays at 25, 50 and 75, so a level 100
 * character has none of it left and the pack's flat −25 shows through.
 */
const CTX_BLURB: Record<string, string> = {
  BASE_STAT: "The character's starting value, before anything is equipped or allocated.",
  NEWBIE_RESISTS:
    "A starting bonus that decays, not a penalty that accrues. The game grants +50 elemental " +
    "resist at level 1 and steps it down to +25 at 25, 0 at 50 and −25 at 75, on top of the " +
    "pack's own flat −25 base. At level 100 the grant is spent, which is why this reads −25.",
  STAT_POINTS: "Points you allocated on the character screen.",
  GEAR: "An equipped item: base stats, affixes, runes and runeword.",
  TALENT: "A node allocated on the passive tree.",
  ASCENDANCY: "An ascendancy node.",
  PASSIVES: "A spell school perk. The solo-class bonus deliberately goes to Misc instead.",
  ATLAS: "An atlas passive.",
  JEWEL: "A socketed jewel.",
  AURA: "An aura you are running.",
  POTION_EFFECT: "An exile effect: a buff, charge, stance or curse on you.",
  INNATE_SPELL: "A stat the skill itself grants, rather than one on your sheet.",
  SUPPORT_GEM: "A support gem socketed into a skill.",
  VANILLA_STAT_COMPAT:
    "A vanilla Minecraft attribute another mod set, converted into a real stat by " +
    "`mmorpg_stat_compat` (food diversity, Mine and Meals, the KubeJS attributes).",
  ENCHANT_COMPAT: "A vanilla enchantment on equipped gear, converted the same way.",
  ITEM_SET:
    "A gear set bonus. It belongs to the combination rather than to any one piece, which is "  +
    "why it is its own row: the stats arrive once the piece count reaches a tier, and every "  +
    "tier at or below the count is live.",
  FOOD_BUFF: "A meal, seafood or elixir.",
  STAT_CTX_MODIFIER_BONUS:
    "Not a source of its own: the share of every other context that `aura_effect` and its two " +
    "siblings add on top. The game builds it from the contexts that already exist, so the row " +
    "names the stat that took the share and the context it was a share of.",
  MISC: "Everything the game files under Misc, like omen bonuses and the solo-class bonus.",
};

/**
 * Which sheet a breakdown is about.
 *
 * `character` is the stat as the game's own character screen reports it. `skill` is the main
 * skill's separate stat unit — the same stat id, a different number, and the only place a
 * support gem's contribution exists at all. See `DerivedBuild.skillBreakdown`.
 */
export type BreakdownScope = "character" | "skill";

export function StatBreakdown({
  statId,
  scope = "character",
  onSelect,
  onScope,
}: {
  statId: string;
  scope?: BreakdownScope;
  /** Lets a transfer row jump to the stat that actually holds the value. */
  onSelect?: (statId: string) => void;
  /** Switches sheets, where the caller can hold the other one. */
  onScope?: (scope: BreakdownScope) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const derived = useDerived();
  const skill = scope === "skill" ? derived.skillBreakdown(statId) : undefined;
  // A skill scope with no skill set falls back rather than rendering nothing: the character's
  // own number is still the honest answer to "where did this come from", and the banner below
  // says which sheet is on screen so the two can never be mistaken for each other.
  const onSkillSheet = skill !== undefined;
  const breakdown = skill ?? derived.breakdown(statId);
  const display = statDisplay(snapshot, statId);
  const { stat, flat, percent, multi, base, addedAfterCalc, transferredTo } = breakdown;

  const description = statDesc(snapshot, statId);

  // `MULTIPLY_STAT` folds the MORE into the value; `MULTIPLICATIVE_DAMAGE` holds it in
  // dmgMulti for the damage layer. The formula has to show whichever one applies.
  const multiInValue = stat.dmgMulti === 1 && multi !== 1;
  const afterCalc = breakdown.derived.filter((d) => d.type === "ADD_TO_VALUE");
  const resolved = (base + flat) * (1 + percent / 100) * (multiInValue ? multi : 1);

  // Which stats hand their value to this one. The complaint the plan named was a 70.9 row that
  // did not say where it came from; this is the other end of that link.
  const transferredFrom = breakdown.derived
    .filter((d) => d.kind === "transfer")
    .map((d) => d.from);

  const groups = groupContributions(breakdown.contributions);
  const spellId = derived.damage?.spellId;

  /*
   * What the main skill resolves this same stat to, when that is a different number.
   *
   * Compared rather than merely fetched: every stat the spell unit does not touch resolves
   * identically on both sheets, and announcing "on Tailwind Sweep this is also 47" on two
   * hundred rows would bury the handful where it matters. The epsilon is float noise from two
   * separate container runs, not a tolerance.
   */
  const skillValue = onSkillSheet ? undefined : derived.skillBreakdown(statId)?.stat.value;
  const differs =
    skillValue !== undefined && Math.abs(skillValue - stat.value) > 1e-6;

  return (
    <div className="breakdown">
      <div className="row mb-3">
        <StatIcon statId={statId} size={16} />
        <strong className="grow ellipsis" style={{ color: statLook(snapshot, statId).colour }}>
          {statName(snapshot, statId)}
        </strong>
        {onSkillSheet && (
          <span
            className="badge good"
            title="The spell's own stat unit, not the character sheet. This is the number the damage pipeline used."
          >
            on {spellId === undefined ? "this skill" : spellName(snapshot, spellId)}
          </span>
        )}
        <span className="badge mono">{statId}</span>
      </div>

      {/*
        Said once, at the top, because the whole reason this scope exists is that the two numbers
        differ and nothing on screen used to say so. A player linking a crit gem watches the
        sidebar not move and concludes the gem did nothing.
      */}
      {onSkillSheet && (
        <div className="notice info">
          This is <strong>{statName(snapshot, statId)} on this skill</strong>, which is not the
          same as the number on your character sheet. Each spell has its own stats, and support gems
          only add to those, so the gems below count here but not in the sidebar.{" "}
          {onScope !== undefined && (
            <a className="link" onClick={() => onScope("character")}>
              Show the character sheet&apos;s {smart(derived.stats.get(statId)?.value ?? 0)}
              {display.isPerc ? "%" : ""} instead.
            </a>
          )}
        </div>
      )}

      {/*
        The other direction, and only when the two actually differ.

        A stat opened off the character sheet is the right answer to most questions about it, so
        this does not nag — but when the skill resolves the same id to a different number there
        is a support gem or an innate stat behind the gap, and that is a thing the reader wants
        to be *told* rather than left to discover by opening the sidebar's crit row.
      */}
      {differs && skillValue !== undefined && (
        <div className="notice info">
          On {spellId === undefined ? "your main skill" : spellName(snapshot, spellId)} this stat
          is <strong>{smart(skillValue)}{display.isPerc ? "%" : ""}</strong>, not{" "}
          {smart(stat.value)}
          {display.isPerc ? "%" : ""}. The spell has its own stats, and support gems only add to
          those.{" "}
          {onScope !== undefined && (
            <a className="link" onClick={() => onScope("skill")}>
              Show where the skill&apos;s number comes from.
            </a>
          )}
        </div>
      )}

      {description !== undefined && (
        <p className="faint text-sm mt-0 mb-4 selectable">
          {description}
        </p>
      )}

      <div className="formula">
        <div>
          (base {num(base)} + flat {num(flat)}) × (1 + {num(percent)}%)
          {multiInValue ? ` × ${num(multi, 3)}` : ""} = <strong>{num(resolved)}</strong>
        </div>
        {addedAfterCalc !== 0 && (
          <div className="faint">
            + {num(addedAfterCalc)} added after the calculation ({afterCalc.length} source
            {afterCalc.length === 1 ? "" : "s"})
          </div>
        )}
        {transferredTo.length > 0 && (
          <div className="faint">
            then emptied into {transferredTo.map((id) => statName(snapshot, id)).join(", ")} and
            zeroed
          </div>
        )}
        <div>
          shown on the sheet: <strong>{smart(stat.value)}{display.isPerc ? "%" : ""}</strong>
          {stat.hardcap > 0 && stat.value >= stat.hardcap && (
            <span className="badge bad" style={{ marginLeft: 6 }}>
              clamped to hard cap {smart(stat.hardcap)}
            </span>
          )}
        </div>
        {stat.usableValue !== undefined && (
          <div className="faint">
            usable value: <strong>{smart(stat.usableValue)}%</strong>, after diminishing returns.
            This is what the game uses
          </div>
        )}
      </div>

      {transferredTo.length > 0 && (
        <div className="notice">
          This stat hands everything it collects to{" "}
          {transferredTo.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <a className="link" onClick={() => onSelect?.(id)}>
                {statName(snapshot, id)}
              </a>
            </span>
          ))}{" "}
          <Plain>
            before anything resolves, then zeroes itself. It reads <strong>0</strong> on the sheet
            no matter what feeds it. The value isn&apos;t lost, it moved.
          </Plain>
          <Tech>
            before anything resolves, then zeroes itself (<code>ITransferToOtherStats</code>). It
            reads <strong>0</strong> on the sheet no matter what feeds it. The value is not lost,
            it moved.
          </Tech>
        </div>
      )}

      {stat.dmgMulti !== 1 && (
        <>
        <Plain>
          <div className="notice">
            This is a multiplicative damage stat: its MORE multipliers are excluded from the base value shown above. Instead, they are saved as a x{num(stat.dmgMulti, 3)} multiplier and applied during final damage calculations. Any effect reading this stat including stat conversions, uses the unmultiplied base number, matching in-game behavior.
          </div>
        </Plain>
        <Tech>
          <div className="notice">
            This stat is <code>MULTIPLICATIVE_DAMAGE</code>: its MORE modifiers are deliberately{" "}
            <em>not</em> in the value above. They are carried as{" "}
            <strong>×{num(stat.dmgMulti, 3)}</strong> and spent once, later, in the damage layer.
            Anything reading this stat&apos;s value, including every <code>one_to_other</code>{" "}
            that adds from it, sees the number without that multiplier, which is what the game
            does too.
          </div>
        </Tech>
        </>
      )}

      {breakdown.contributions.length === 0 && breakdown.derived.length === 0 && (
        <div className="empty">Nothing in this build contributes to it.</div>
      )}

      {groups.length > 0 && (
        <>
          <div className="section-title">Contributions ({breakdown.contributions.length})</div>
          <div className="steps">
            {groups.map((group) => (
              <KindGroup
                key={group.id}
                name={group.name}
                rows={group.rows}
                snapshot={snapshot}
                effects={derived.effects}
                minusIsGood={display.minusIsGood}
              />
            ))}
          </div>
        </>
      )}

      {breakdown.derived.length > 0 && (
        <>
          <div className="section-title">Added by the calculation itself</div>
          <div className="steps">
            {breakdown.derived.map((d, index) => (
              <StepRow
                key={`${d.from}-${index}`}
                label={
                  // A transfer's parent is a place to go, not something to expand: its own
                  // contributions are its own breakdown and duplicating them here would be two
                  // answers to one question.
                  <a className="link" onClick={() => onSelect?.(d.from)}>
                    {statName(snapshot, d.from)}
                  </a>
                }
                badge={d.type === "ADD_TO_VALUE" ? "→ value" : d.type === "MULTI_ADD" ? "+multi" : d.type}
                title={derivedTypeHint(d.type)}
                value={signed(d.value)}
                onClick={() => onSelect?.(d.from)}
              />
            ))}
          </div>
          {transferredFrom.length > 0 && (
            <div className="faint text-sm mt-2">
              Each of these is another stat that emptied itself into this one. Click through to
              see what fed it.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One kind of source, with the subtotal it puts into each term of the formula. */
function KindGroup({
  name,
  rows,
  snapshot,
  effects,
  minusIsGood,
}: {
  name: string;
  rows: ModContribution[];
  snapshot: Snapshot;
  effects: EffectState;
  /** `mmorpg_stat.minus_is_good` for the stat these rows feed. See {@link modTone}. */
  minusIsGood: boolean;
}): ReactNode {
  const flat = sum(rows, "FLAT");
  const percent = sum(rows, "PERCENT");
  const more = rows.filter((r) => r.type === "MORE").reduce((n, r) => n * (1 + r.value / 100), 1);

  return (
    <StepRow
      label={
        <>
          {name} <span className="faint">({rows.length})</span>
        </>
      }
      value={subtotal(flat, percent, more)}
      /*
        Coloured by where the kind lands, not by each term.

        A group can add flat and take percent — a unique with an upside and a downside sits under
        one heading — and the subtotal beside it is already the three terms written together, so
        the colour answers the question the heading asks: did this lot help.
      */
      tone={modTone(flat + percent + (more - 1) * 100, minusIsGood)}
    >
      {[...rows]
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .map((row, index) => (
          <ContribRow
            key={`${row.path}-${row.source}-${index}`}
            row={row}
            snapshot={snapshot}
            effects={effects}
            minusIsGood={minusIsGood}
          />
        ))}
    </StepRow>
  );
}

function ContribRow({
  row,
  snapshot,
  effects,
  minusIsGood,
}: {
  row: ModContribution;
  snapshot: Snapshot;
  effects: EffectState;
  minusIsGood: boolean;
}): ReactNode {
  const setEffect = useBuild((s) => s.setEffect);
  /*
    Which of your things this row is, not merely what kind of thing.

    The rows most in need of it are the tree's: this pack repeats a perk id at many grid
    positions, so four rows reading "Attack Damage" under Talents are four different nodes and
    the name alone cannot separate them. See `ui/mod-source.ts`.
  */
  const where = useProvenance(row);

  // An effect the capture did not record is the planner's own assumption, not an observation.
  // Saying so on the row is what turns "this number disagrees with the game" into "this number
  // assumes a buff the game did not have up", which is a different conversation.
  const option =
    row.ctxType === "POTION_EFFECT" ? effects.options.find((o) => o.id === row.source) : undefined;
  const assumed = option !== undefined && !option.captured;

  const part = originPart(snapshot, row);

  return (
    <StepRow
      depth={1}
      label={
        <span className={where.has ? "has-source" : undefined} {...where.props}>
          {sourceName(snapshot, row)}
          {part !== undefined && <span className="faint"> — {part}</span>}
          {where.node}
        </span>
      }
      title={`${CTX_BLURB[row.ctxType] ?? row.ctxType}\n${row.path}`}
      badge={
        // The chip is the toggle. Putting a separate control here would mean a second vocabulary
        // for something the Config tab already expresses; making the chip itself clickable keeps
        // the number, the reason it might differ from the game, and the way to test that on one
        // row — which is the whole point of saying "assumed" at all.
        assumed ? (
          <span
            className="warn chip-toggle"
            title={
              "Assumed active; the capture didn't record it. Click to turn it off and see the " +
              "number without it."
            }
            onClick={(event) => {
              event.stopPropagation();
              setEffect(row.source, false);
            }}
          >
            assumed ✕
          </span>
        ) : undefined
      }
      value={`${row.type === "MORE" ? "×" : ""}${signed(row.value)}${row.type === "PERCENT" ? "%" : ""}`}
      tone={modTone(row.value, minusIsGood)}
    />
  );
}

/**
 * Green for a modifier that improved the stat, red for one that did not.
 *
 * `minus_is_good` rather than the sign, which is the same rule the item card and the what-if
 * tables already take: 19 of this pack's stats are better when they go down — cooldowns, costs,
 * the `*_received` families — and colouring a cooldown reduction red would be worse than leaving
 * every row grey, which is what this replaced.
 */
function modTone(value: number, minusIsGood: boolean): "good" | "bad" | undefined {
  if (value === 0) return undefined;
  return (minusIsGood ? value < 0 : value > 0) ? "good" : "bad";
}

/**
 * Buckets the contributions by kind, dropping kinds nothing contributed to.
 *
 * Order comes from `KINDS` rather than from magnitude: a breakdown is read top to bottom against
 * the formula, and a list whose rows move when a number changes cannot be compared with the one
 * you looked at a moment ago.
 */
/**
 * Contributions bucketed into the kinds a player thinks in: gear, tree, jewels, auras, the rest.
 *
 * Exported for the same reason {@link sourceName} is: the Damage panel's trace drills all the way
 * down to these rows, and a stat with thirty `STAT_CTX_MODIFIER_BONUS` entries behind six real
 * sources is unreadable flat. One taxonomy, used by both screens, so a pack update that adds a
 * context type shows up in the same place on each.
 */
export function groupContributions(
  contributions: readonly ModContribution[],
): { id: string; name: string; rows: ModContribution[] }[] {
  const out: { id: string; name: string; rows: ModContribution[] }[] = [];
  const claimed = new Set<string>();

  for (const kind of KINDS) {
    const rows = contributions.filter((c) => (kind.types as readonly string[]).includes(c.ctxType));
    for (const type of kind.types) claimed.add(type);
    if (rows.length > 0) out.push({ id: kind.id, name: kind.name, rows });
  }

  // A context type `KINDS` has not been taught about still has to appear, or a pack update
  // silently loses contributions from the breakdown — the exact failure the sheet taxonomy's
  // audit exists to prevent, one panel over.
  const rest = contributions.filter((c) => !claimed.has(c.ctxType));
  if (rest.length > 0) out.push({ id: "other", name: "Other", rows: rest });

  return out;
}

function sum(rows: readonly ModContribution[], type: ModContribution["type"]): number {
  return rows.filter((r) => r.type === type).reduce((n, r) => n + r.value, 0);
}

/**
 * {@link subtotal} for a group of rows — what a kind puts into each term of the formula.
 *
 * `isPerc` is the stat's own `is_perc`, and it decides whether the FLAT term carries a `%`. It
 * defaults to off so this sheet's own formula block reads as it always has, next to the terms it
 * is derived from; the Damage tab passes it, because there a lone `+47.52` under Attack Damage
 * is percentage points of damage and nothing on the row said so.
 */
export function contributionSubtotal(
  rows: readonly ModContribution[],
  isPerc = false,
): string {
  return subtotal(
    sum(rows, "FLAT"),
    sum(rows, "PERCENT"),
    rows.filter((r) => r.type === "MORE").reduce((n, r) => n * (1 + r.value / 100), 1),
    isPerc,
  );
}

/** A group's contribution to each term, printed only where there is one. */
function subtotal(flat: number, percent: number, more: number, isPerc = false): string {
  const parts: string[] = [];
  if (flat !== 0) parts.push(`${signed(flat)}${isPerc ? "%" : ""}`);
  if (percent !== 0) parts.push(`${signed(percent)}%`);
  if (more !== 1) parts.push(`×${num(more, 3)}`);
  return parts.length === 0 ? "—" : parts.join("  ");
}

/** Resolves a context's `source` id through whichever registry that context type names. */
/**
 * Names the thing a modifier came off — the item, perk, gem, aura or effect.
 *
 * Exported because the Damage panel's layer trace resolves all the way down to the same
 * `ModContribution` rows and was printing `ctxType` and `source` raw beside each other: a
 * `GEAR` badge next to `sword_2`, where this produces "Sword". One mapping, not two.
 */
export function sourceName(snapshot: Snapshot, contribution: ModContribution): string {
  const { ctxType, source, from } = contribution;
  switch (ctxType) {
    case "GEAR":
      return gearTypeName(snapshot, source);
    // `enchant_compat` is the collector's own id for the context, not a registry entry, so
    // naming it through a registry produced "Enchant Compat". Which enchantment it was is on
    // the row's origin; the heading only has to say what kind of thing they all are.
    case "ENCHANT_COMPAT":
      return "Enchantments";
    case "JEWEL":
      return gearTypeName(snapshot, source);
    case "TALENT":
    case "ASCENDANCY":
    case "ATLAS":
    case "PASSIVES":
      return perkName(snapshot, source);
    case "AURA":
      return auraName(snapshot, source);
    case "SUPPORT_GEM":
      return supportGemName(snapshot, source);
    case "INNATE_SPELL":
      return spellName(snapshot, source);
    case "POTION_EFFECT":
      return exileEffectName(snapshot, source);
    case "FOOD_BUFF":
      return statBuffName(snapshot, source);
    case "BASE_STAT":
      return "Base stats";
    case "NEWBIE_RESISTS":
      return "Level grant";
    case "STAT_POINTS":
      return "Allocated stat points";
    case "ITEM_SET":
      return itemSetName(snapshot, source);
    case "VANILLA_STAT_COMPAT":
      return "Vanilla attributes";
    /*
      The thing that granted the `statContextModifier` stat, where the engine recorded it.

      "Context modifiers" is the name of the bag, and a bag is all this could say before: one
      heading over three dozen rows, each a share some stat took of some other context. Naming
      the grantor rather than the stat keeps the rule every other row follows — a row is one of
      your things — and it is also the only thing that tells these rows apart, since this build
      has four `aura_effect` lines all taking a cut of the same Augment. The stat and the
      context it was a cut of follow as the row's origin.
    */
    case "STAT_CTX_MODIFIER_BONUS":
      return from?.kind === "share" && from.by !== undefined
        ? sourceName(snapshot, asContribution(from.by))
        : "Context modifiers";
    // MISC is where the game files two unrelated things: an omen's payout and the solo-class
    // bonus. Both have a name and neither was printing one.
    case "MISC":
      return miscName(snapshot, source);
    default:
      return source;
  }
}

/**
 * What a `MISC` row actually is.
 *
 * `MiscStatCtx` is the game's catch-all and this pack puts exactly two things in it, so the
 * check is against the omen registry rather than against a list written here — an omen the pack
 * adds later names itself without anything changing. `solo_class_bonus` is `collectSpellSchools`
 * deliberately filing the bonus outside `PASSIVES` so nothing that scales perks can reach it.
 */
function miscName(snapshot: Snapshot, source: string): string {
  if (source === "solo_class_bonus") return "Solo class bonus";
  return omen(snapshot, source) === undefined ? "Misc" : omenName(snapshot, source);
}

/**
 * One end of a share, as a row {@link sourceName} can name.
 *
 * A `StatContext` is not a `ModContribution` — it has no type or value, because it is the
 * group rather than one modifier — and the two fields that matter for naming are the same
 * three either way. The stub carries a zero so nothing can print it by accident.
 */
function asContribution(ref: { ctxType: string; source: string; path: string }): ModContribution {
  return {
    ctxType: ref.ctxType as ModContribution["ctxType"],
    source: ref.source,
    path: ref.path,
    type: "FLAT",
    value: 0,
  };
}

/**
 * Names the part of an item a modifier came off, as specifically as the collector knew.
 *
 * `rowName` is what the row already says, and it is passed so a share does not say it twice:
 * this pack names the `aura_effect` spell-school perk after the stat it grants, so the row
 * would read "Augment Effect — Augment Effect · share of …".
 */
function originLabel(
  snapshot: Snapshot,
  origin: NonNullable<ModContribution["from"]>,
  rowName?: string,
): string {
  switch (origin.kind) {
    case "base":
      return "base stat";
    case "unique":
      return origin.id === undefined ? "unique" : uniqueName(snapshot, origin.id);
    case "runeword":
      return origin.id === undefined ? "runeword" : runewordName(snapshot, origin.id);
    case "rune":
      return origin.id === undefined ? "rune" : `rune ${origin.id}`;
    // The vanilla attribute the compat entry read. This is the answer to "where does it come
    // from" and not merely a label: `generic.attack_damage` is the weapon in your hand,
    // `kubejs:magic_shield` is food diversity, and the row said neither.
    case "attribute":
      return origin.id === undefined ? "vanilla attribute" : attributeName(origin.id);
    case "enchantment":
      return origin.id === undefined ? "enchantment" : enchantName(origin.id);
    // The stat that took the cut, and whose stats it was a cut of. The row itself is named
    // after the thing that granted the stat.
    case "share": {
      const stat = origin.id === undefined ? "context modifier" : statName(snapshot, origin.id);
      const of =
        origin.of === undefined
          ? "another context"
          : sourceName(snapshot, asContribution(origin.of));
      return stat === rowName ? `share of ${of}` : `${stat} · share of ${of}`;
    }
    default:
      // Every remaining kind is an affix list, and the affix's own name is what the player sees
      // on the item.
      return origin.id === undefined ? origin.kind : affixName(snapshot, origin.id);
  }
}

/**
 * The part of the source a row came off, worded — "Sword's Fury [mythic] · 87%".
 *
 * Shared because both drill-downs print the same rows and only one of them was printing this:
 * the Damage tab's trace showed "Vanilla attributes +2.00" and "Context modifiers ×1.338" with
 * the origin the engine had already resolved sitting unused on the modifier.
 */
export function originPart(snapshot: Snapshot, mod: ModContribution): string | undefined {
  const origin = mod.from;
  if (origin === undefined) return undefined;
  const label = originLabel(snapshot, origin, sourceName(snapshot, mod));
  return (
    `${label}${origin.tier === undefined ? "" : ` [${origin.tier}]`}` +
    `${origin.rollPercent === undefined ? "" : ` · ${Math.round(origin.rollPercent)}%`}`
  );
}

function derivedTypeHint(type: string): string {
  if (type === "ADD_TO_VALUE") {
    return "Added straight to the final value after the calculation, not a modifier";
  }
  if (type === "MULTI_ADD") {
    return "InCalcStat.addFullyTo adds to the multiplier where every other MORE path multiplies";
  }
  return type;
}
