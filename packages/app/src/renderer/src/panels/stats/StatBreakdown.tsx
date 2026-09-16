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
  auraName,
  exileEffectName,
  gearTypeName,
  itemSetName,
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
import { useDerived, type ModContribution } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { num, signed, smart } from "../../ui/format.js";
import { StepRow } from "../../ui/StepRow.js";

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
  GEAR: "An equipped item — its base stats, affixes, runes and runeword.",
  TALENT: "A node allocated on the passive tree.",
  ASCENDANCY: "An ascendancy node.",
  PASSIVES: "A spell school perk. The solo-class bonus deliberately goes to Misc instead.",
  ATLAS: "An atlas passive.",
  JEWEL: "A socketed jewel.",
  AURA: "An aura you are running.",
  POTION_EFFECT: "An exile effect — a buff, a charge, a stance or a curse on you.",
  INNATE_SPELL: "A stat the skill itself grants, rather than one on your sheet.",
  SUPPORT_GEM: "A support gem socketed into a skill.",
  VANILLA_STAT_COMPAT:
    "A vanilla Minecraft attribute another mod set, converted into a real stat by " +
    "`mmorpg_stat_compat` — food diversity, Mine and Meals, the KubeJS attributes.",
  ENCHANT_COMPAT: "A vanilla enchantment on equipped gear, converted the same way.",
  ITEM_SET:
    "A gear set bonus. It belongs to the combination rather than to any one piece, which is "  +
    "why it is its own row: the stats arrive once the piece count reaches a tier, and every "  +
    "tier at or below the count is live.",
  FOOD_BUFF: "A meal, seafood or elixir.",
  STAT_CTX_MODIFIER_BONUS:
    "Not a source of its own: the share of every other context that `aura_effect` and its two " +
    "siblings add on top. The game builds it from the contexts that already exist.",
  MISC: "Everything the game files under Misc, including the solo-class bonus.",
};

export function StatBreakdown({
  statId,
  onSelect,
}: {
  statId: string;
  /** Lets a transfer row jump to the stat that actually holds the value. */
  onSelect?: (statId: string) => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const derived = useDerived();
  const breakdown = derived.breakdown(statId);
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
  const transferredFrom = derived.derived
    .filter((d) => d.statId === statId && d.kind === "transfer")
    .map((d) => d.from);

  const groups = groupContributions(breakdown.contributions);

  return (
    <div className="breakdown">
      <div className="row mb-3">
        <span style={{ color: display.colour }}>{display.icon}</span>
        <strong className="grow ellipsis">{statName(snapshot, statId)}</strong>
        <span className="badge mono">{statId}</span>
      </div>

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
            usable value: <strong>{smart(stat.usableValue)}%</strong> — the diminishing-returns
            number the game applies, not this raw total
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
          before anything resolves, then zeroes itself (<code>ITransferToOtherStats</code>). It
          reads <strong>0</strong> on the sheet no matter what feeds it — the value is not lost,
          it moved.
        </div>
      )}

      {stat.dmgMulti !== 1 && (
        <div className="notice">
          This stat is <code>MULTIPLICATIVE_DAMAGE</code>: its MORE modifiers are deliberately{" "}
          <em>not</em> in the value above. They are carried as{" "}
          <strong>×{num(stat.dmgMulti, 3)}</strong> and spent once, later, in the damage layer.
          Anything reading this stat&apos;s value — including every <code>one_to_other</code>{" "}
          that adds from it — sees the number without that multiplier, which is what the game
          does too.
        </div>
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
}: {
  name: string;
  rows: ModContribution[];
  snapshot: Snapshot;
  effects: EffectState;
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
      tone="faint"
    >
      {[...rows]
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .map((row, index) => (
          <ContribRow
            key={`${row.path}-${row.source}-${index}`}
            row={row}
            snapshot={snapshot}
            effects={effects}
          />
        ))}
    </StepRow>
  );
}

function ContribRow({
  row,
  snapshot,
  effects,
}: {
  row: ModContribution;
  snapshot: Snapshot;
  effects: EffectState;
}): ReactNode {
  const setEffect = useBuild((s) => s.setEffect);

  // An effect the capture did not record is the planner's own assumption, not an observation.
  // Saying so on the row is what turns "this number disagrees with the game" into "this number
  // assumes a buff the game did not have up", which is a different conversation.
  const option =
    row.ctxType === "POTION_EFFECT" ? effects.options.find((o) => o.id === row.source) : undefined;
  const assumed = option !== undefined && !option.captured;

  const origin = row.from;
  const part =
    origin === undefined
      ? undefined
      : `${originLabel(snapshot, origin)}${origin.tier === undefined ? "" : ` [${origin.tier}]`}` +
        `${origin.rollPercent === undefined ? "" : ` · ${Math.round(origin.rollPercent)}%`}`;

  return (
    <StepRow
      depth={1}
      label={
        <>
          {sourceName(snapshot, row)}
          {part !== undefined && <span className="faint"> — {part}</span>}
        </>
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
              "Assumed up by the planner — no capture recorded it. Click to switch it off and " +
              "see this number without it."
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
    />
  );
}

/**
 * Buckets the contributions by kind, dropping kinds nothing contributed to.
 *
 * Order comes from `KINDS` rather than from magnitude: a breakdown is read top to bottom against
 * the formula, and a list whose rows move when a number changes cannot be compared with the one
 * you looked at a moment ago.
 */
function groupContributions(
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

/** A group's contribution to each term, printed only where there is one. */
function subtotal(flat: number, percent: number, more: number): string {
  const parts: string[] = [];
  if (flat !== 0) parts.push(signed(flat));
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
  const { ctxType, source } = contribution;
  switch (ctxType) {
    case "GEAR":
    case "ENCHANT_COMPAT":
      return gearTypeName(snapshot, source);
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
    case "STAT_CTX_MODIFIER_BONUS":
      return "Context modifiers";
    case "MISC":
      return "Misc";
    default:
      return source;
  }
}

/** Names the part of an item a modifier came off, as specifically as the collector knew. */
function originLabel(snapshot: Snapshot, origin: NonNullable<ModContribution["from"]>): string {
  switch (origin.kind) {
    case "base":
      return "base stat";
    case "unique":
      return origin.id === undefined ? "unique" : uniqueName(snapshot, origin.id);
    case "runeword":
      return origin.id === undefined ? "runeword" : runewordName(snapshot, origin.id);
    case "rune":
      return origin.id === undefined ? "rune" : `rune ${origin.id}`;
    default:
      // Every remaining kind is an affix list, and the affix's own name is what the player sees
      // on the item.
      return origin.id === undefined ? origin.kind : affixName(snapshot, origin.id);
  }
}

function derivedTypeHint(type: string): string {
  if (type === "ADD_TO_VALUE") {
    return "Written straight onto the resolved value, after the calculation — not a modifier";
  }
  if (type === "MULTI_ADD") {
    return "InCalcStat.addFullyTo adds to the multiplier where every other MORE path multiplies";
  }
  return type;
}
