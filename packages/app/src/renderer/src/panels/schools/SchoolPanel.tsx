/**
 * The class screen — `SpellSchoolScreen`, reproduced against its rules rather than a picture
 * of it.
 *
 * The game's layout, from `init()`:
 *
 *     int x = guiLeft + 12  + (point.x * SLOT_SPACING);
 *     int y = guiTop  + 178 - (point.y * SLOT_SPACING);
 *
 * so **y counts upward from the bottom**, which is why the grid below is rendered in reverse
 * row order. `SLOT_SPACING` is 21 pixels at Minecraft's scale; here a cell is larger because
 * this is a desktop window, but the shape — ten columns, seven rows, bottom row first — is the
 * screen's own.
 *
 * ## The rules, all from `SpellSchoolsData.canLearn` and `SpellSchool`
 *
 *  - **A row gates a perk by character level**: `lvl_reqs[point.y]`, which is the column of
 *    numbers down the left edge here, the same as the game's row labels.
 *  - **Each level past the first costs one more character level**, compared *strictly*:
 *    `getLevel() > baselvl + (int)((currentlvl - 1) * points_per_lvl(SPELLS))`. So a row-0 perk
 *    at level 5 needs character level 5, not 1.
 *  - **Two point pools.** A perk whose first stat is `learn_<spell>` spends `SPELLS`;
 *    everything else spends `PASSIVES`. The two counters at the bottom are the game's two
 *    `PointsDisplayButton`s.
 *  - **Two schools maximum.** A third is refused with "MAX_2_CLASSES", so schools past the
 *    second are shown locked rather than merely unhelpful.
 *  - **One school pays a bonus**: +10% MORE total damage and +5 damage reduction, and the
 *    banner appears exactly when `isSoloClass()` would.
 *
 * ## Why this page matters more than it looks
 *
 * A spell perk's stat is `learn_<spellId>`, and `SpellCastingData.calcSpellLevels` reads that
 * stat back out of the container as the spell's **rank**. So allocating here is what sets every
 * spell level, which is what the damage pipeline interpolates its value calculations against.
 * Before this page existed the app had no way to express that at all.
 */

import {
  MAX_ACTIVE_SKILLS,
  MAX_SCHOOLS,
  activeSkillCount,
  allocatedSchools,
  isSoloClass,
  isSpellPerk,
  learnedSpells,
  levelNeededForNextPerkLevel,
  perk,
  perkPointType,
  pointsAvailable,
  pointsPerLevel,
  schoolPerksInOrder,
  schoolPointsSpent,
  spellName,
  spellOfPerk,
  spellSchool,
  spellSchoolIds,
  text,
  unknownSchoolPerks,
  type SpellSchoolView,
} from "@cte2/schema";
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useWorld } from "../../state/snapshot.js";
import { GemWindow, SpellWindow } from "../../ui/SpellTooltip.js";
import { useHoverCard, type At } from "../../ui/HoverCard.js";
import { perkCard, spellCard } from "../../ui/spell-stats.js";

/** `SpellSchool.MAX_X_ROWS` / `MAX_Y_ROWS` — the grid the screen draws into. */
const COLUMNS = 10;
const ROWS = 7;

/**
 * How many levels a shift-click moves a perk by.
 *
 * Levelling a ten-rank passive one click at a time is ten round trips through the store and ten
 * re-renders of a grid that re-prices every cell, which is the kind of thing you only notice when
 * you are actually planning a class rather than reading one. Shift is the modifier every other
 * allocation screen in this app already uses for "more of that".
 *
 * It is a convenience rather than a rule the game has: `AllocateStatPacket.MAX_ALLOCATE_AT_ONCE`
 * is about *stat* points, and the perk packet has no batch form at all. So the step is clamped
 * the same way a single click is — by `max_lvls`, by the row's level requirement, and by the
 * points left in the pool — and a shift-click that can only afford two spends two.
 */
const SHIFT_STEP = 4;

export function SchoolPanel(): ReactNode {
  const { snapshot, icon } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setPerk = useBuild((s) => s.setSchoolPerk);
  const toggleSkillFor = useBuild((s) => s.toggleSkillFor);
  const clearSchools = useBuild((s) => s.clearSchools);

  /**
   * Allocating a spell perk is slotting the skill, so it does both.
   *
   * In game these are the same act: the perk's stat is `learn_<spell>`, `calcSpellLevels` reads
   * it back as the spell's rank, and what you have learned is what the hotbar offers. Leaving
   * the Skills tab to be filled in by hand meant every new spell silently contributed nothing
   * to any damage figure until somebody noticed.
   *
   * Levelling a perk past 1 changes only the rank, which the Skills tab already reads off the
   * class allocation, so only the 0 crossing touches the bar.
   */
  const setSchoolPerk = (perkId: string, level: number): void => {
    const before = doc.character.schools?.[perkId] ?? 0;
    setPerk(perkId, level);
    const spellId = spellOfPerk(snapshot, perkId);
    if (spellId === undefined) return;
    if (before === 0 && level > 0) toggleSkillFor(spellId, true);
    else if (before > 0 && level <= 0) toggleSkillFor(spellId, false);
  };

  const schoolIds = useMemo(() => spellSchoolIds(snapshot), [snapshot]);
  const allocated = doc.character.schools ?? {};
  const mine = useMemo(() => allocatedSchools(snapshot, doc), [snapshot, doc]);

  // The game opens on the player's own class rather than whatever is first in the database
  // (`pickDefaultSchool` in `init()`), so this does too.
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected ?? mine[0] ?? schoolIds[0] ?? null;

  const view = useMemo(
    () => (current === null ? undefined : spellSchool(snapshot, current)),
    [snapshot, current],
  );

  const spent = useMemo(() => schoolPointsSpent(snapshot, doc), [snapshot, doc]);
  const spellsPerLevel = useMemo(() => pointsPerLevel(snapshot, "SPELLS"), [snapshot]);
  // `pointsAvailable` is the one place that decides between the game's own count and the
  // level-derived floor, shared with the validator and the other two point screens.
  const budgets = useMemo(
    () => ({
      SPELLS: pointsAvailable(snapshot, doc.character, "SPELLS"),
      PASSIVES: pointsAvailable(snapshot, doc.character, "PASSIVES"),
    }),
    [snapshot, doc.character],
  );

  const totalFor = (pool: "SPELLS" | "PASSIVES"): number => budgets[pool].total;
  const free = {
    SPELLS: totalFor("SPELLS") - spent.SPELLS,
    PASSIVES: totalFor("PASSIVES") - spent.PASSIVES,
  };

  if (schoolIds.length === 0) {
    return (
      <div className="panel">
        <div className="notice">
          This snapshot has no <code>mmorpg_spell_school</code> entries, so there are no classes
          to allocate into.
        </div>
      </div>
    );
  }

  const solo = isSoloClass(snapshot, doc);
  const spells = learnedSpells(snapshot, doc);
  const onBar = activeSkillCount(doc.skills);

  return (
    <div className="panel">
      <div className="row wrap mb-5">
        <strong>Classes</strong>
        <span className="faint">
          {mine.length === 0
            ? "none allocated"
            : `${mine.map((id) => text(snapshot, `mmorpg.asc_class.${id}`) ?? id).join(" + ")}`}
        </span>
        <span className="grow" />
        {/* Taking a spell perk puts the spell on the Skills tab, so the hotbar's own budget
            belongs beside the point counters rather than only on the other tab. */}
        <span
          className={onBar >= MAX_ACTIVE_SKILLS ? "badge warn" : "badge"}
          title={
            onBar >= MAX_ACTIVE_SKILLS
              ? `The hotbar holds ${MAX_ACTIVE_SKILLS} (GemInventoryHelper.MAX_SKILL_GEMS). A spell learned now still lands on the Skills tab, but arrives disabled.`
              : "Spells you learn here land on the Skills tab, up to the eight the hotbar holds."
          }
        >
          {onBar}/{MAX_ACTIVE_SKILLS} on the bar
        </span>
        <PointCounter label="Spell points" free={free.SPELLS} spent={spent.SPELLS} total={totalFor("SPELLS")} />
        <PointCounter
          label="Passive points"
          free={free.PASSIVES}
          spent={spent.PASSIVES}
          total={totalFor("PASSIVES")}
        />
        <button disabled={Object.keys(allocated).length === 0} onClick={clearSchools}>
          Reset
        </button>
      </div>

      {solo && (
        <div className="notice info">
          <strong>Solo class bonus active:</strong> +10% MORE total damage and +5 damage
          reduction, from <code>SpellSchoolsData</code>. Putting a single point in a second class
          removes both.
        </div>
      )}

      <div className="school-tabs">
        {schoolIds.map((id) => {
          const isMine = mine.includes(id);
          const locked = !isMine && mine.length >= MAX_SCHOOLS;
          return (
            <button
              key={id}
              className={`school-tab${current === id ? " active" : ""}${isMine ? " mine" : ""}`}
              title={
                locked
                  ? "You already have two classes. The game refuses a third: MAX_2_CLASSES."
                  : undefined
              }
              onClick={() => setSelected(id)}
            >
              <img
                className="school-tab-icon"
                src={icon(`mmorpg:textures/gui/asc_classes/class/${id}.png`) ?? undefined}
                alt=""
              />
              <span>{text(snapshot, `mmorpg.asc_class.${id}`) ?? id}</span>
              {locked && <span className="faint"> 🔒</span>}
            </button>
          );
        })}
      </div>

      {view === undefined ? (
        <div className="notice">No such school in this snapshot.</div>
      ) : (
        <SchoolGrid
          view={view}
          allocated={allocated}
          level={doc.character.level}
          spellsPerLevel={spellsPerLevel}
          free={free}
          blockedByClassLimit={!mine.includes(view.id) && mine.length >= MAX_SCHOOLS}
          onChange={setSchoolPerk}
        />
      )}

      {spells.size > 0 && (
        <div className="faint text-sm mt-5" style={{ lineHeight: 1.6 }}>
          <strong>Spell ranks from this allocation:</strong>{" "}
          {[...spells.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([spellId, rank], i) => (
              <span key={spellId}>
                {i > 0 ? " · " : ""}
                {spellName(snapshot, spellId) ?? spellId} {rank}
              </span>
            ))}
          <br />
          Each of those is a <code>learn_{"<spell>"}</code> stat on the sheet, which is where{" "}
          <code>SpellCastingData.calcSpellLevels</code> reads a spell&apos;s rank from — plus any
          bonus ranks from <code>+ to spell level</code> stats, which the sheet carries
          separately.
        </div>
      )}
    </div>
  );
}

function PointCounter({
  label,
  free,
  spent,
  total,
}: {
  label: string;
  free: number;
  spent: number;
  total: number;
}): ReactNode {
  return (
    <span className="faint text-sm" title={`${spent} spent of ${total}`}>
      {label}: <strong style={{ color: free < 0 ? "var(--bad)" : undefined }}>{free}</strong>{" "}
      free
    </span>
  );
}

function SchoolGrid({
  view,
  allocated,
  level,
  spellsPerLevel,
  free,
  blockedByClassLimit,
  onChange,
}: {
  view: SpellSchoolView;
  allocated: Record<string, number>;
  level: number;
  spellsPerLevel: number;
  free: { SPELLS: number; PASSIVES: number };
  blockedByClassLimit: boolean;
  onChange: (perkId: string, level: number) => void;
}): ReactNode {
  const { snapshot } = useWorld();

  const byPosition = useMemo(() => {
    const map = new Map<string, { perkId: string }>();
    for (const { perkId, point } of schoolPerksInOrder(view)) {
      map.set(`${point.y},${point.x}`, { perkId });
    }
    return map;
  }, [view]);

  const missing = useMemo(() => unknownSchoolPerks(snapshot, view), [snapshot, view]);

  // `y` counts up from the bottom in game, so the top row rendered is the highest y.
  const rows = Array.from({ length: ROWS }, (_, i) => ROWS - 1 - i);

  return (
    <>
      {blockedByClassLimit && (
        <div className="notice">
          Points here would be a <strong>third class</strong>, which{" "}
          <code>canLearn</code> refuses outright. Reset one of your two classes first.
        </div>
      )}

      <div className="school-grid">
        {rows.map((y) => {
          const required = view.levelForRow(y);
          const rowLocked = level < required;
          return (
            <div className="school-row" key={y}>
              <span className={`school-row-req${rowLocked ? " locked" : ""}`} title={`Row ${y}`}>
                lvl {Number.isFinite(required) ? required : "—"}
              </span>
              {Array.from({ length: COLUMNS }, (_, x) => {
                const at = byPosition.get(`${y},${x}`);
                if (at === undefined) {
                  return <span className="school-cell empty" key={x} />;
                }
                return (
                  <PerkCell
                    key={x}
                    perkId={at.perkId}
                    point={{ x, y }}
                    view={view}
                    level={level}
                    perkLevel={allocated[at.perkId] ?? 0}
                    spellsPerLevel={spellsPerLevel}
                    free={free}
                    blocked={blockedByClassLimit}
                    onChange={onChange}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      {missing.length > 0 && (
        <div className="notice">
          {missing.length} perk id(s) in this school&apos;s grid have no{" "}
          <code>mmorpg_perk</code> entry: <code>{missing.join(", ")}</code>. That is a pack bug —
          the game renders nothing for them too.
        </div>
      )}
    </>
  );
}

function PerkCell({
  perkId,
  point,
  view,
  level,
  perkLevel,
  spellsPerLevel,
  free,
  blocked,
  onChange,
}: {
  perkId: string;
  point: { x: number; y: number };
  view: SpellSchoolView;
  level: number;
  perkLevel: number;
  spellsPerLevel: number;
  free: { SPELLS: number; PASSIVES: number };
  blocked: boolean;
  onChange: (perkId: string, level: number) => void;
}): ReactNode {
  const { snapshot, icon } = useWorld();

  const data = perk(snapshot, perkId);
  const maxLevels = data?.maxLevels ?? 1;
  const pool = perkPointType(snapshot, perkId);
  const spellId = spellOfPerk(snapshot, perkId);

  const needed = levelNeededForNextPerkLevel(view, point, perkLevel, spellsPerLevel);
  const levelAllows = level >= needed;
  const atMax = perkLevel >= maxLevels;
  const hasPoints = free[pool] > 0;
  const canAdd = !blocked && levelAllows && !atMax && hasPoints;

  const why = blocked
    ? "Would be a third class"
    : atMax
      ? `Already at max_lvls (${maxLevels})`
      : !levelAllows
        ? `Needs character level ${Number.isFinite(needed) ? needed : "—"}`
        : !hasPoints
          ? `No ${pool === "SPELLS" ? "spell" : "passive"} points left`
          : `Spend one ${pool === "SPELLS" ? "spell" : "passive"} point`;

  /*
    The real card, rather than the browser `title` this screen kept until now.

    Built inside the render function rather than above it, which is the whole reason
    `useHoverCard` takes one: a school is seventy cells and `spellCard` resolves a description's
    `[calc:]` placeholders and a cost curve to produce one. Seventy of those on every keystroke,
    all but one of them thrown away unhovered, is what the laziness is for.
  */
  const note = `${why}. Click to add, right-click to remove — shift for ${SHIFT_STEP} at a time.`;
  const hover = useHoverCard((at) => (
    <CellCard
      perkId={perkId}
      spellId={spellId}
      perkLevel={perkLevel}
      maxLevels={maxLevels}
      characterLevel={level}
      note={note}
      at={at}
    />
  ));

  /**
   * How many levels one click actually moves this perk.
   *
   * Everything a single click is checked against applies to a shift-click too, so the step is
   * taken as the smallest of the three ceilings rather than sent and then refused: `max_lvls`,
   * the points left in the pool, and — because `canLearn` compares against the level each
   * *individual* rank needs — how many of the next ranks this character is high enough for.
   * `levelNeededForNextPerkLevel` is asked once per rank for that reason: a level-40 character
   * buying into a row whose fourth rank wants 44 gets three, not four.
   */
  const addStep = (many: number): number => {
    if (!canAdd) return 0;
    let step = 0;
    while (
      step < many &&
      perkLevel + step < maxLevels &&
      step < free[pool] &&
      level >= levelNeededForNextPerkLevel(view, point, perkLevel + step, spellsPerLevel)
    ) {
      step += 1;
    }
    return step;
  };

  return (
    <button
      className={`school-cell${perkLevel > 0 ? " taken" : ""}${isSpellPerk(snapshot, perkId) ? " spell" : " passive"}${canAdd ? "" : " blocked"}`}
      {...hover.props}
      onClick={(event) => {
        const step = addStep(event.shiftKey ? SHIFT_STEP : 1);
        if (step > 0) onChange(perkId, perkLevel + step);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        // Down to zero and no further, so a shift-click on a rank-two perk refunds the two it
        // has rather than being refused for not having four.
        const step = Math.min(event.shiftKey ? SHIFT_STEP : 1, perkLevel);
        if (step > 0) onChange(perkId, perkLevel - step);
      }}
    >
      {hover.node}
      <img className="school-cell-icon" src={icon(data?.icon) ?? undefined} alt="" />
      {perkLevel > 0 && (
        <span className="school-cell-level">
          {perkLevel}
          <span className="faint">/{maxLevels}</span>
        </span>
      )}
    </button>
  );
}

/**
 * One grid cell's tooltip: the skill it is a rank of, or the passive it is.
 *
 * Two cards because the grid holds two different things, and each already has one drawn the way
 * the game draws it. A spell perk is a rank of a skill, so it raises `SpellWindow` — the
 * description with its damage figure filled in, the cost at your level, the cooldown, the tags.
 * A passive is a stat node and raises the small card, with what it grants at the level it is
 * taken to.
 *
 * **Previewed at rank 1 when the perk is untaken**, because rank 0 is not a rank: the numbers on
 * the card are what taking the cell would buy, which is the question an empty cell raises.
 *
 * `ceiling` is the perk's own `max_lvls` rather than the spell's `max_lvl`. On this screen a
 * skill is bought one perk rank at a time and the perk is what caps it; the bonus ranks gear can
 * add are a property of the Skills tab, where the skill is equipped.
 */
function CellCard({
  perkId,
  spellId,
  perkLevel,
  maxLevels,
  characterLevel,
  note,
  at,
}: {
  perkId: string;
  spellId: string | undefined;
  perkLevel: number;
  maxLevels: number;
  characterLevel: number;
  /** The planner's own remark — what this click would do — at the foot of either card. */
  note: string;
  at: At;
}): ReactNode {
  const { snapshot } = useWorld();
  const shown = Math.max(perkLevel, 1);

  if (spellId !== undefined) {
    const card = spellCard(snapshot, spellId, {
      level: shown,
      natural: maxLevels,
      ceiling: maxLevels,
      characterLevel,
    });
    return card === undefined ? null : <SpellWindow card={{ ...card, note }} floating at={at} />;
  }

  const card = perkCard(snapshot, perkId, { perkLevel: shown, characterLevel });
  return card === undefined ? null : <GemWindow card={{ ...card, note }} floating at={at} />;
}
