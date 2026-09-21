/**
 * A skill's and a gem's tooltip, drawn the way the game draws one.
 *
 * What these replace is the reason they exist: a browser `title` attribute. Every item in this
 * planner has had a real card for a long time — `ItemWindow`, with the pack's own rarity border
 * and its stat lines coloured by `minus_is_good` — while the two things a build is actually
 * *built out of*, the skill and the support gems linked into it, got a grey box half a second
 * late with the name and a sentence in it.
 *
 * So they borrow that card's chrome outright: `.item-window`, `.tt-header`, `.tt-divider`,
 * `.tt-line`. Not to save code — to stop the app having two ideas of what a tooltip looks like,
 * which is the same reason the damage trace and the stat drill-down share `StepRow`.
 *
 * The content is `spell-stats.ts`, and the split is the one `item-stats.ts` and `ItemTooltip`
 * already draw: that module knows what the game says, this one knows what it looks like.
 */

import type { ReactNode } from "react";

import { useWorld } from "../state/snapshot.js";
import { floatingStyle, useHoverCard, type At } from "./HoverCard.js";
import { renderFormattedStatLine } from "./ItemTooltip.js";
import { smart } from "./format.js";
import type { CardFact, GemCard, SpellCard } from "./spell-stats.js";
import type { StatLine } from "./item-stats.js";

/** Assumed sizes for the edge flip. A skill's card is the taller of the two by some way. */
const SPELL_CARD = { width: 340, height: 420 };
const GEM_CARD = { width: 320, height: 200 };

/**
 * Where the pack keeps a spell's icon, and the two generic gem plates.
 *
 * The generics are a fallback now rather than the answer. A support gem, an Augment and an exile
 * effect each have a real texture in the install, and `spell-stats.ts` names it on the card —
 * see {@link GemCard.icon}. These stay for the handful the pack ships none for.
 */
const SPELL_ICON = (id: string): string => `mmorpg:textures/gui/spells/icons/${id}.png`;
const GEM_ICON = "mmorpg:textures/gui/prophecy/support_gem.png";
const AUGMENT_ICON = "mmorpg:textures/gui/prophecy/aura_gem.png";

/**
 * Which chrome a {@link GemCard} wears, keyed on the `kind` its builder set.
 *
 * One card serves four things now — a support gem, an Augment, a buff and a debuff — because
 * they are the same card: a name, a list of stat lines, a short footer. What differs is the
 * colour it is bordered and titled in, and a debuff wants to read as a debuff whichever screen
 * it is hovered from.
 */
const GEM_LOOK: Record<string, { css: string; icon: string }> = {
  Augment: { css: "tt-gem", icon: AUGMENT_ICON },
  Buff: { css: "tt-buff", icon: AUGMENT_ICON },
  Debuff: { css: "tt-debuff", icon: AUGMENT_ICON },
  Passive: { css: "tt-perk-card", icon: GEM_ICON },
};

export function useSpellTooltip(card: SpellCard | undefined) {
  return useHoverCard(
    card === undefined ? undefined : (at: At) => <SpellWindow card={card} floating at={at} />,
  );
}

/**
 * A gem's, an Augment's, a buff's or a perk's card — they are one shape. See {@link GEM_LOOK}.
 */
export function useGemTooltip(card: GemCard | undefined) {
  return useHoverCard(
    card === undefined ? undefined : (at: At) => <GemWindow card={card} floating at={at} />,
  );
}

/**
 * The skill card.
 *
 * Line order is `SpellTooltipUtils`': name, what it does, what rank you hold it at, what it
 * costs, how often you can cast it, what it is tagged as, and what the gem itself grants.
 */
export function SpellWindow({
  card,
  floating = false,
  at,
}: {
  card: SpellCard;
  floating?: boolean;
  at?: At;
}): ReactNode {
  const world = useWorld();
  const icon = world.icon(SPELL_ICON(card.id));

  return (
    <div
      className={`item-window tt-spell${floating ? " floating" : ""}`}
      style={floating && at !== undefined ? floatingStyle(at, SPELL_CARD) : undefined}
    >
      <div className="tt-header">
        <div className="tt-icon-frame">
          {icon !== null && <img className="tt-spell-icon" src={icon} alt="" />}
        </div>
        <div className="tt-title-container">
          <div className="tt-title" title={card.id}>
            {card.name}
          </div>
          <div className="tt-subtitle">{card.kind}</div>
        </div>
      </div>

      {card.description.length > 0 && (
        <>
          <div className="tt-divider" />
          <div className="tt-section tt-desc">
            {card.description.map((spans, i) => (
              <p key={i} className="tt-line">
                {spans.map((span, j) => (
                  <span
                    key={j}
                    style={{
                      color: span.colour,
                      fontWeight: span.bold ? 700 : undefined,
                      fontStyle: span.italic ? "italic" : undefined,
                    }}
                  >
                    {span.text}
                  </span>
                ))}
              </p>
            ))}
          </div>
        </>
      )}

      <div className="tt-divider" />

      <div className="tt-section tt-facts">
        {/*
          The rank every other number on the card is read at, marked rather than left to look
          like one more fact. `natural` is the spell's own ceiling and `ceiling` is that plus the
          bonus ranks gear can buy, and a card that printed only one of them made a rank-18 spell
          on a 16-rank skill look like an error.
        */}
        <FactRow
          fact={{
            label: "Skill Level",
            value: String(card.level.shown),
            title: "The rank every number on this card is read at",
          }}
          accent
        />
        {/*
          The ceiling, as its own row rather than in brackets after the rank.

          A skill can sit *above* its natural maximum — `plus_lvl_<tag>_spells` on gear buys
          ranks past it — so "24 / 20" was a fraction that read as an error every time it was
          true. Two facts, the way the game prints them: what you hold it at, and how far it goes.
        */}
        <FactRow
          fact={{
            label: "Max Gem Level",
            value:
              card.level.ceiling > card.level.natural
                ? `${card.level.natural} (${card.level.ceiling} with gear)`
                : String(card.level.natural),
            title: "max_lvl, plus MAX_BONUS_SPELL_LEVELS that gear and perks can add on top",
          }}
        />
        {card.costs.map((cost) => (
          <div key={cost.label} className="tt-fact">
            <span className="tt-fact-k">{cost.label}</span>
            <span className="tt-fact-v" style={{ color: cost.colour }}>
              {smart(cost.value)}
            </span>
          </div>
        ))}
        {card.facts.map((fact) => (
          <FactRow key={fact.label} fact={fact} />
        ))}
      </div>

      {card.tags.length > 0 && (
        <>
          <div className="tt-divider" />
          <div className="tt-chips">
            {card.tags.map((tag) => (
              <span key={tag} className="tt-chip">
                {tag.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        </>
      )}

      {card.stats.length > 0 && (
        <>
          <div className="tt-divider" />
          <div className="tt-section tt-stats">
            <div className="tt-category-title">Gem Stats at Level {card.level.shown}</div>
            <StatBlock lines={card.stats} />
          </div>
        </>
      )}

      {card.note !== undefined && (
        <>
          <div className="tt-divider" />
          <div className="tt-note">{card.note}</div>
        </>
      )}
    </div>
  );
}

/** A support gem, an Augment, a buff or a debuff: the same card with a shorter middle. */
export function GemWindow({
  card,
  floating = false,
  at,
}: {
  card: GemCard;
  floating?: boolean;
  at?: At;
}): ReactNode {
  const world = useWorld();
  const look = GEM_LOOK[card.kind] ?? { css: "tt-gem", icon: GEM_ICON };
  /*
    The card's own texture, falling back to the kind's plate when the install has none.

    Both halves are load-bearing. A perk, an effect and a gem are each identified by their art as
    much as by their name — the grid or the buff bar it was hovered from draws the same image —
    so `card.icon` wins. But `world.icon` returns null for a texture no archive holds, and three
    of this pack's 212 exile effects have no `mob_effects` PNG in the jar or in the resource
    pack; without the fallback those three drew an empty frame rather than a generic buff icon.
  */
  const icon = world.icon(card.icon) ?? world.icon(look.icon);

  return (
    <div
      className={`item-window ${look.css}${floating ? " floating" : ""}`}
      style={floating && at !== undefined ? floatingStyle(at, GEM_CARD) : undefined}
    >
      <div className="tt-header">
        <div className="tt-icon-frame">
          {icon !== null && <img className="tt-spell-icon" src={icon} alt="" />}
        </div>
        <div className="tt-title-container">
          <div className="tt-title" title={card.id}>
            {card.name}
          </div>
          <div className="tt-subtitle">{card.kind}</div>
        </div>
      </div>

      <div className="tt-divider" />

      {card.stats.length > 0 ? (
        <div className="tt-section tt-stats">
          <StatBlock lines={card.stats} />
        </div>
      ) : (
        <div className="tt-line faint">Grants no stats of its own.</div>
      )}

      {card.facts.length > 0 && (
        <>
          <div className="tt-divider" />
          <div className="tt-section tt-facts">
            {card.facts.map((fact) => (
              <FactRow key={fact.label} fact={fact} />
            ))}
          </div>
        </>
      )}

      {card.note !== undefined && (
        <>
          <div className="tt-divider" />
          <div className="tt-note">{card.note}</div>
        </>
      )}
    </div>
  );
}

/**
 * The stat lines, green or red by the game's own rule.
 *
 * `StatLine.good` is `minus_is_good`, never the sign — a Support Gem buying damage with
 * `MORE −20% Cast Speed` has to read red on that line, and a gem that cuts a cooldown has to
 * read green. See `totalLines`.
 */
function StatBlock({ lines }: { lines: readonly StatLine[] }): ReactNode {
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={`${line.statId}-${i}`}
          className={`tt-line${line.good ? "" : " worse"}`}
          title={line.statId}
        >
          {renderFormattedStatLine(line.text)}
        </div>
      ))}
    </>
  );
}

function FactRow({ fact, accent = false }: { fact: CardFact; accent?: boolean }): ReactNode {
  return (
    <div className="tt-fact" title={fact.title}>
      <span className="tt-fact-k">{fact.label}</span>
      <span className={`tt-fact-v${accent ? " accent" : ""}`}>{fact.value}</span>
    </div>
  );
}
