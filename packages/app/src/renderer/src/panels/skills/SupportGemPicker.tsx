/**
 * The support gem list, ordered by what each gem would actually do.
 *
 * This is the Path of Building idea the rest of the planner was missing: you do not choose a
 * support gem by reading ninety names, you choose it by reading ninety numbers. Every gem in the
 * list is priced against the skill it would be linked to — the whole document rebuilt with that
 * gem in that socket, through the same engine the Damage tab uses — and the list is sorted by
 * the gain.
 *
 * Three things are deliberate about how it is presented.
 *
 * **The ranking figure is the skill's own DPS, and the rotation's is shown beside it.** A support
 * gem only ever changes one skill, so ranking on the rotation would bury a 40% gain on your
 * second skill under the noise of the first. Full DPS is what tells you whether that gain is
 * worth anything to the build, so it is a column rather than the sort key.
 *
 * **A gem that changes nothing says so, rather than reading as a tiny gain.** Roughly half the
 * pack's support gems do nothing for any given skill — a projectile gem on a melee slam, a cold
 * gem on a physical hit — and showing them at "+0.0%" implies the engine measured something.
 *
 * **The list is usable before it is finished.** Pricing ninety candidates is over half a second;
 * `useRanking` slices it across frames and this renders what has landed, with the count. Sorting
 * by relative gain rather than absolute DPS is what makes a partial list meaningful.
 */

import { supportGemName, supportLinks, type SkillSetup, type SupportLink } from "@cte2/schema";
import { CATEGORY, entry } from "@cte2/schema";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { supportGemAffectsSheet } from "@cte2/engine";

import { useRanking, type Ranked, type Vitals } from "../../state/compare.js";
import { useWorld } from "../../state/snapshot.js";
import { percent, signGlyph, smart } from "../../ui/format.js";

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
}: {
  skill: SkillSetup;
  skillIndex: number;
  slot: number | undefined;
  value: string | undefined;
  onChange: (id: string) => void;
  width?: number;
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
          ? [...links, { id: gemId }]
          : links.map((link, i) => (i === slot ? { ...link, id: gemId } : link));
      const skills = (doc.skills ?? []).map((s, i) =>
        i === skillIndex ? { ...s, supports: next } : s,
      );
      return { ...doc, skills };
    },
    [doc, skill, skillIndex, slot],
  );

  const keyOf = useCallback((gemId: string) => gemId, []);
  // A support gem never touches the character sheet, so ranking on anything but this skill's own
  // damage would be ranking on a number the gem cannot move.
  const rank = useCallback((vitals: Vitals) => vitals.dps, []);

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
    if (needle.length === 0) return ranking.rows;
    return ranking.rows.filter((row) =>
      `${supportGemName(world.snapshot, row.id)} ${row.id}`.toLowerCase().includes(needle),
    );
  }, [ranking.rows, query, world.snapshot]);

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
              Ranked by this skill&apos;s DPS
              {ranking.pending && ` · pricing ${ranking.done} of ${ranking.total}…`}
            </span>
          </div>
          {rows.length === 0 && (
            <div className="picker-option faint">
              {ranking.pending ? "Pricing gems…" : "No match"}
            </div>
          )}
          {rows.map((row) => (
            <GemRow
              key={row.id}
              row={row}
              selected={row.id === value}
              linked={alreadyLinked.has(row.id)}
              costMulti={manaMulti(world.snapshot, row.id)}
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
  onPick,
}: {
  row: Ranked<string>;
  selected: boolean;
  /** Already in another socket of this skill, so illegal here. */
  linked: boolean;
  costMulti: number;
  onPick: () => void;
}): ReactNode {
  const world = useWorld();
  const skill = row.comparison.headline.find((d) => d.key === "dps");
  const full = row.comparison.headline.find((d) => d.key === "fullDps");

  const nothing = skill === undefined || Math.abs(skill.change) <= NOISE;
  const tone = nothing ? "" : skill.change > 0 ? "up" : "down";

  return (
    <div
      className={`picker-option gem-rank-row${selected ? " active" : ""}${linked ? " linked" : ""}`}
      onMouseDown={onPick}
      title={
        linked
          ? "Already linked to this skill in another socket. One Skill may not hold two of the " +
            "same support gem."
          : selected
            ? "The gem in this socket now — the figure every other row is measured against."
            : nothing
          ? "This gem's stats do not reach this skill: nothing it grants is read by any of " +
            "the skill's damage sources."
          : `${signGlyph(skill.change)}${smart(Math.round(Math.abs(skill.change)))} DPS on this skill` +
            (full === undefined
              ? ""
              : `, ${signGlyph(full.change)}${smart(Math.round(Math.abs(full.change)))} on the rotation`)
      }
    >
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
            {skill.fraction === undefined ? "new" : percent(skill.fraction)}
          </span>
          <span className={`gem-rank-abs ${tone}`}>
            {signGlyph(skill.change)}
            {smart(Math.round(Math.abs(skill.change)))}
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
