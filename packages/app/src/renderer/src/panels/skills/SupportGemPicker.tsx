/**
 * The support gem list, ordered by what each gem would actually do.
 *
 * This is the Path of Building idea the rest of the planner was missing: you do not choose a
 * support gem by reading ninety names, you choose it by reading ninety numbers. Every gem in the
 * list is priced against the skill it would be linked to — the whole document rebuilt with that
 * gem in that socket, through the same engine the Damage tab uses — and the list is sorted by
 * the gain.
 *
 * Four things are deliberate about how it is presented.
 *
 * **The ranking figure is the skill's own DPS, and the rotation's is shown beside it.** A support
 * gem only ever changes one skill, so ranking on the rotation would bury a 40% gain on your
 * second skill under the noise of the first. Full DPS is what tells you whether that gain is
 * worth anything to the build, so it is a column rather than the sort key.
 *
 * **A skill that deals no damage is priced on what it does instead.** A third of this pack's
 * skills are buffs and stances, and for those every damage figure is 0 whatever you link — so
 * the list reported all ninety gems as having no effect, and the "compatible only" filter, which
 * is the default, emptied it entirely. The two gems most worth linking to a buff are the two it
 * hid: Effect Duration, which lengthens what the press puts on you, and Cooldown, which brings
 * the press back sooner. Both are measured; neither is damage.
 *
 * **A gem that changes nothing says so, rather than reading as a tiny gain.** Roughly half the
 * pack's support gems do nothing for any given skill — a projectile gem on a melee slam, a cold
 * gem on a physical hit — and showing them at "+0.0%" implies the engine measured something.
 * "Nothing" now means nothing at all moved, not merely that the damage did not.
 *
 * **The list is usable before it is finished.** Pricing ninety candidates is over half a second;
 * `useRanking` slices it across frames and this renders what has landed, with the count. Sorting
 * by relative gain rather than absolute DPS is what makes a partial list meaningful.
 */

import { rarityName, supportGemName, supportLinks, type SkillSetup, type SupportLink } from "@cte2/schema";
import { CATEGORY, entry } from "@cte2/schema";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { supportGemAffectsSheet } from "@cte2/engine";

import { useRanking, type Ranked, type Vitals } from "../../state/compare.js";
import { useWorld } from "../../state/snapshot.js";
import type { GemPreset } from "../../ui/GemRoll.js";
import { useGemTooltip } from "../../ui/SpellTooltip.js";
import { supportGemCard } from "../../ui/spell-stats.js";
import { percent, round, signGlyph, smart } from "../../ui/format.js";

/** Below this the two figures are the same number and the difference is float noise. */
const NOISE = 1e-6;

export function SupportGemPicker({
  skill,
  skillIndex,
  /** Which link this picker edits, or `undefined` to add a new one. */
  slot,
  value,
  onChange,
  width = 260,
  compatibleOnly = false,
  preset,
}: {
  skill: SkillSetup;
  skillIndex: number;
  slot: number | undefined;
  value: string | undefined;
  onChange: (id: string) => void;
  width?: number;
  /**
   * The rarity and roll a gem this list hands you arrives at — the Skills tab's preset.
   *
   * It is on the *picker* rather than only on the caller that writes the link, because the
   * ranking has to be priced at the same roll the pick will produce. A list that ranked every
   * gem at the bottom of its band and then handed you a mythic would be sorting by numbers none
   * of its rows are: `+40% more fire damage` and `+40% increased fire damage` do not keep their
   * order when both are scaled from 0% of their band to 100% of it.
   *
   * `undefined` leaves a gem's rarity unstated, which is what this control did before the preset
   * existed and what the engine reads as "the bottom of the band".
   */
  preset?: GemPreset | undefined;
  /**
   * Hide the gems that measured no change on this skill.
   *
   * "Compatible" is not something the registry declares and could not be: a gem is compatible
   * when its stats are read by one of *this* skill's damage sources, which is a question only
   * the pipeline that resolved those sources can answer. This list has already priced all
   * ninety, so the filter is a predicate over measurements rather than a second, guessed rule —
   * and roughly half the pack fails it for any given skill.
   *
   * The gem in this socket is never hidden, whatever it measured. A filter that could make the
   * thing you are looking at disappear from the list of things you could pick is a filter that
   * has broken the control.
   */
  compatibleOnly?: boolean;
}): ReactNode {
  const world = useWorld();
  const doc = useBuild((s) => s.doc);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const candidates = world.supportGemIds;

  /**
   * The document this gem would produce.
   *
   * The whole link list is written back rather than the one entry patched, because
   * `supportLinks` is what turns a legacy document's bare gem ids into the shape the engine
   * reads — patching in place would quietly drop every other gem's inherited roll.
   */
  const apply = useCallback(
    (gemId: string) => {
      const links = supportLinks(skill);
      const next: SupportLink[] =
        slot === undefined
          ? [...links, { id: gemId, ...preset }]
          : links.map((link, i) =>
              // The gem already in this socket keeps its own rarity and roll: that row is the
              // baseline every other one is measured against, and re-rolling it to the preset
              // would move the zero rather than the candidates.
              i === slot
                ? link.id === gemId
                  ? link
                  : { ...link, id: gemId, ...preset }
                : link,
            );
      const skills = (doc.skills ?? []).map((s, i) =>
        i === skillIndex ? { ...s, supports: next } : s,
      );
      return { ...doc, skills };
    },
    [doc, skill, skillIndex, slot, preset],
  );

  const keyOf = useCallback((gemId: string) => gemId, []);
  /**
   * A support gem never touches the character sheet, so ranking on anything but this skill's own
   * damage would be ranking on a number the gem cannot move.
   *
   * Unless the skill has no damage — a third of this pack's skills are buffs and stances, and
   * for those `dps` is 0 for every gem, so the list came back in whatever order the registry
   * happened to be in and every row read "no effect". There the rotation's total is the figure
   * that moves: a longer buff is fewer presses per pass, which is time the pass spends on
   * something else. The baseline decides which question this is, so every row is priced against
   * the same one.
   */
  const rank = useCallback(
    (vitals: Vitals, base: Vitals) => (base.dps > 0 ? vitals.dps : vitals.totalDps),
    [],
  );

  // The whole reason this list is fast enough to be a list: a support gem's stats land on the
  // spell unit, never on the character sheet, so the sheet, the defence figure and the weapon
  // swing are computed once for the sweep rather than once per gem. Four gems in this pack are
  // exceptions — the ones carrying a `give_exile_effect` — and the engine is asked which.
  const reuseSheetFor = useCallback(
    (gemId: string) => !supportGemAffectsSheet(world.snapshot, gemId),
    [world.snapshot],
  );

  // `skillIndex` is what makes the ranking about *this* skill. Without it every row is priced
  // against the document's main skill, which a gem on any other skill cannot move — so all
  // ninety gems scored identically and the list reported every one of them as having no effect.
  const ranking = useRanking({
    candidates,
    apply,
    keyOf,
    enabled: open,
    rank,
    reuseSheetFor,
    skillIndex,
  });

  // The same question `rank` asks, read off the same baseline, so the heading cannot name a sort
  // key the list did not use.
  const damageSkill = ranking.base.dps > 0;

  useEffect(() => {
    if (!open) return;
    const onDocumentDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocumentDown);
    return () => document.removeEventListener("mousedown", onDocumentDown);
  }, [open]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched =
      needle.length === 0
        ? ranking.rows
        : ranking.rows.filter((row) =>
            `${supportGemName(world.snapshot, row.id)} ${row.id}`.toLowerCase().includes(needle),
          );
    if (!compatibleOnly) return matched;
    // Anything that moved, not just damage. Filtering on `dps` alone hid the Effect Duration and
    // Cooldown gems from every buff in the pack — the two gems most worth linking to one — and
    // hid them behind a label that said they do nothing, which was not true.
    return matched.filter((row) => row.id === value || !row.comparison.unchanged);
  }, [ranking.rows, query, world.snapshot, compatibleOnly, value]);

  /**
   * Gems this skill already holds in some *other* socket.
   *
   * `validate` rejects two of the same gem on one Skill, so these are rows you cannot take —
   * and the figure beside them is real but unreachable. Marked rather than hidden, because
   * "this is already linked" is the answer to why a gem is not in the list.
   */
  const alreadyLinked = useMemo(() => {
    const held = new Set<string>();
    supportLinks(skill).forEach((link, i) => {
      if (i !== slot) held.add(link.id);
    });
    return held;
  }, [skill, slot]);

  const selectedName = value === undefined ? "" : supportGemName(world.snapshot, value);

  return (
    <div className="picker" ref={wrapRef} style={{ width }}>
      <input
        type="text"
        value={open ? query : selectedName}
        placeholder={selectedName.length > 0 ? selectedName : "Search…"}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />

      {open && (
        <div className="picker-list gem-rank-list">
          <div className="gem-rank-head">
            <span className="faint">
              {/* Named for what the sort key actually is, which differs for a skill that deals
                  no damage — see the `rank` callback. */}
              {damageSkill ? "Ranked by this skill's DPS" : "Ranked by the rotation's total"}
              {/* The roll every row was priced at. Without it the list is ninety numbers whose
                  scale is set by a control on the other side of the panel. */}
              {preset !== undefined &&
                ` · as ${rarityName(world.snapshot, preset.rarity)} ${preset.rollPercent}%`}
              {compatibleOnly && " · compatible only"}
              {ranking.pending && ` · pricing ${ranking.done} of ${ranking.total}…`}
            </span>
          </div>
          {rows.length === 0 && (
            <div className="picker-option faint">
              {ranking.pending
                ? "Pricing gems…"
                : compatibleOnly
                  ? "Nothing in the pack changes this skill at all. Switch the filter to All to see every gem."
                  : "No match"}
            </div>
          )}
          {rows.map((row) => (
            <GemRow
              key={row.id}
              row={row}
              selected={row.id === value}
              linked={alreadyLinked.has(row.id)}
              costMulti={manaMulti(world.snapshot, row.id)}
              preset={preset}
              onPick={() => {
                if (alreadyLinked.has(row.id)) return;
                onChange(row.id);
                setOpen(false);
                setQuery("");
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GemRow({
  row,
  selected,
  linked,
  costMulti,
  preset,
  onPick,
}: {
  row: Ranked<string>;
  selected: boolean;
  /** Already in another socket of this skill, so illegal here. */
  linked: boolean;
  costMulti: number;
  /** The rarity and roll every row was priced at, so the card shows the same numbers. */
  preset: GemPreset | undefined;
  onPick: (event: React.MouseEvent) => void;
}): ReactNode {
  const world = useWorld();
  const characterLevel = useBuild((s) => s.doc.character.level);
  const dps = row.comparison.headline.find((d) => d.key === "dps");
  const full = row.comparison.headline.find((d) => d.key === "fullDps");

  /*
   * What this row reports.
   *
   * The skill's own DPS where the gem moved it, which is every damage skill in the pack. Where it
   * did not, the largest thing that *did* move — because for a buff nothing ever moves DPS, and
   * a row that said "no effect" for Effect Duration on Protection was reporting the absence of a
   * measurement as the absence of an effect. `headline` is already sorted by relative magnitude,
   * so the first entry is the answer.
   */
  const moved =
    dps !== undefined && Math.abs(dps.change) > NOISE ? dps : row.comparison.headline[0];
  const nothing = moved === undefined || Math.abs(moved.change) <= NOISE;
  const tone = nothing ? "" : moved.good ? "up" : "down";
  const isDps = !nothing && moved === dps;

  /*
    What this row is claiming, said on the card rather than in a `title`.

    The two cannot both be up: a browser tooltip and a card over the same row are two boxes
    racing for the same corner of the screen. The card is the one worth keeping — it carries the
    gem's actual stats, which is the question the ranking number provokes — so the ranking's own
    note becomes a line on it.
  */
  const note = linked
    ? "Already linked to this skill in another socket. One Skill may not hold two of the same " +
      "support gem."
    : selected
      ? "The gem in this socket now — the figure every other row is measured against."
      : nothing
        ? "This gem's stats do not reach this skill: nothing it grants is read by any of the " +
          "skill's damage sources, its cooldown or the buff it applies."
        : isDps
          ? `${signGlyph(moved.change)}${smart(Math.round(Math.abs(moved.change)))} DPS on this skill` +
            (full === undefined
              ? ""
              : `, ${signGlyph(full.change)}${smart(Math.round(Math.abs(full.change)))} on the rotation`)
          : `${moved.label} ${signGlyph(moved.change)}${smart(round(Math.abs(moved.change)))}` +
            " — this gem changes nothing about the hit";

  /*
    Priced at the same roll the ranking used.

    A card showing the gem at 100% beside a row priced at the preset's 40% would be two different
    gems on one line. `preset` is the control at the top of the panel, and it governs both.
  */
  const card = useMemo(
    () =>
      supportGemCard(world.snapshot, row.id, {
        rollPercent: preset?.rollPercent ?? 100,
        characterLevel,
      }),
    [world.snapshot, row.id, preset?.rollPercent, characterLevel],
  );
  const tip = useGemTooltip(card === undefined ? undefined : { ...card, note });

  return (
    <div
      className={`picker-option gem-rank-row${selected ? " active" : ""}${linked ? " linked" : ""}`}
      onMouseDown={(event) => {
        tip.clear();
        onPick(event);
      }}
      {...tip.props}
    >
      {tip.node}
      <span className="ellipsis gem-rank-name">{supportGemName(world.snapshot, row.id)}</span>

      {linked ? (
        <span className="faint gem-rank-pct">linked</span>
      ) : selected ? (
        // Swapping a gem for itself changes nothing, which is true and reads as a bug next to
        // ninety rows that all say the same words for a different reason.
        <span className="faint gem-rank-pct">current</span>
      ) : nothing ? (
        <span className="faint gem-rank-pct">no effect</span>
      ) : (
        <>
          <span className={`gem-rank-pct ${tone}`}>
            {moved.fraction === undefined ? "new" : percent(moved.fraction)}
          </span>
          <span className={`gem-rank-abs ${tone}`}>
            {signGlyph(moved.change)}
            {/* A DPS change is read in thousands and a cooldown in seconds, so the second kind
                keeps its decimals rather than rounding 3.6s away to 4. */}
            {isDps
              ? smart(Math.round(Math.abs(moved.change)))
              : smart(round(Math.abs(moved.change)))}
          </span>
        </>
      )}

      {costMulti !== 1 && (
        <span className="faint gem-rank-cost" title="SocketedGem.getManaCostMulti">
          ×{costMulti.toFixed(2)}
        </span>
      )}
    </div>
  );
}

/** `SocketedGem.getManaCostMulti` — what linking this gem multiplies the cast cost by. */
function manaMulti(snapshot: Parameters<typeof entry>[0], gemId: string): number {
  const declared = entry(snapshot, CATEGORY.supportGem, gemId)?.data["manaMulti"];
  return typeof declared === "number" && Number.isFinite(declared) ? declared : 1;
}
