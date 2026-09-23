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
  pointsSpentInSchool,
  pointsAvailable,
  pointsPerLevel,
  schoolPerksInOrder,
  schoolPointsSpent,
  schoolsByPointsSpent,
  spellName,
  spellOfPerk,
  spellSchool,
  spellSchoolIds,
  text,
  unknownSchoolPerks,
  type SpellSchoolView,
} from "@cte2/schema";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useWhatIf } from "../../state/compare.js";
import { useWorld } from "../../state/snapshot.js";
import { GemWindow, SpellWindow } from "../../ui/SpellTooltip.js";
import { useHoverCard, type At } from "../../ui/HoverCard.js";
import { perkCard, spellCard } from "../../ui/spell-stats.js";
import { ComparisonBlock } from "../../ui/DeltaTable.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

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

  /*
    Two grids side by side, because this pack gives you two classes.

    The screen this port came from shows one school at a time, which is right for a game where
    the other one is a click away and the numbers are on a different screen anyway. Planning is
    the other shape: what you are deciding is how to split one pool of points between two trees,
    and a layout that can only show one of them at a time makes that a memory exercise. The
    window is wide enough for both — ten columns is about 480px — so the space that used to sit
    empty on the right now holds the other half of the answer.

    **The left pane is your main class and does not move.** Which one that is, is decided by
    points spent (`schoolsByPointsSpent`) rather than remembered, so there is no extra state to
    keep, nothing to go stale in a saved build, and no way for the two panes to disagree about
    which class you are playing. The right pane is the one that changes: it starts as your second
    class and the tab strip repoints it, so browsing a class you have not taken never costs you
    sight of the one you have.
  */
  const ranked = useMemo(() => schoolsByPointsSpent(snapshot, doc), [snapshot, doc]);
  const pinned = ranked[0] ?? null;

  const [selected, setSelected] = useState<string | null>(null);
  // Never the same school twice: if the pane you were browsing overtakes the pinned one and
  // becomes the main class, the right pane falls back to the other one rather than duplicating it.
  const browsing =
    (selected !== null && selected !== pinned ? selected : null) ??
    ranked[1] ??
    schoolIds.find((id) => id !== pinned) ??
    null;

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
        <>
        <Plain>
          <div className="notice">
            This snapshot contains no class data, so there are no class trees to spend points in.
          </div>
        </Plain>
        <Tech>
          <div className="notice">
            This snapshot has no <code>mmorpg_spell_school</code> entries, so there are no classes
            to allocate into.
          </div>
        </Tech>
        </>
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
        <>
        <Plain>
          <div className="notice info">
            Solo class bonus active: +10% MORE total damage and +5 flat damage reduction. Allocating even a single point in a second class removes both bonuses.
          </div>
        </Plain>
        <Tech>
          <div className="notice info">
            <strong>Solo class bonus active:</strong> +10% MORE total damage and +5 damage
            reduction, from <code>SpellSchoolsData</code>. Putting a single point in a second class
            removes both.
          </div>
        </Tech>
        </>
      )}

      {/* The strip points the right-hand pane. The pinned class appears in it as a place
          marker rather than a target: selecting the pane it is already in would either
          duplicate it or move it, and neither is what the click means. */}
      <div className="school-tabs">
        {schoolIds.map((id) => {
          const isMine = mine.includes(id);
          const isPinned = id === pinned;
          const locked = !isMine && mine.length >= MAX_SCHOOLS;
          return (
            <button
              key={id}
              className={`school-tab${browsing === id ? " active" : ""}${isMine ? " mine" : ""}${isPinned ? " pinned" : ""}`}
              disabled={isPinned}
              title={
                isPinned
                  ? "Your main class — the one with the most points in it. It stays on the left."
                  : locked
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
              {isPinned && <span className="faint"> ◀</span>}
              {locked && !isPinned && <span className="faint"> 🔒</span>}
            </button>
          );
        })}
      </div>

      <div className="school-panes">
        {pinned !== null && (
          <SchoolPane
            id={pinned}
            role="Main class"
            allocated={allocated}
            level={doc.character.level}
            spellsPerLevel={spellsPerLevel}
            free={free}
            blockedByClassLimit={false}
            onChange={setSchoolPerk}
          />
        )}
        {browsing !== null && (
          <SchoolPane
            id={browsing}
            role={mine.includes(browsing) ? "Second class" : "Browsing"}
            allocated={allocated}
            level={doc.character.level}
            spellsPerLevel={spellsPerLevel}
            free={free}
            blockedByClassLimit={!mine.includes(browsing) && mine.length >= MAX_SCHOOLS}
            onChange={setSchoolPerk}
          />
        )}
      </div>

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
          <Plain>
            Each of those sets that spell&apos;s base rank, which your bonuses to spell level are
            then added on top of — the sheet carries those separately.
          </Plain>
          <Tech>
            Each of those is a <code>learn_{"<spell>"}</code> stat on the sheet, which is where{" "}
            <code>SpellCastingData.calcSpellLevels</code> reads a spell&apos;s rank from — plus any
            bonus ranks from <code>+ to spell level</code> stats, which the sheet carries
            separately.
          </Tech>
        </div>
      )}
    </div>
  );
}

/**
 * One class, with its own heading.
 *
 * The heading is what tells the two panes apart at a glance, and it says the two things the
 * split is made of: which class it is, and how many points are in it — which is also the rule
 * that decides which side it is on. Reading the count off `pointsSpentInSchool` rather than
 * passing it down means the label and the ordering cannot come from two different sums.
 */
function SchoolPane({
  id,
  role,
  allocated,
  level,
  spellsPerLevel,
  free,
  blockedByClassLimit,
  onChange,
}: {
  id: string;
  /** What this pane is, in the player's terms: the main class, the second, or one being looked at. */
  role: string;
  allocated: Record<string, number>;
  level: number;
  spellsPerLevel: number;
  free: { SPELLS: number; PASSIVES: number };
  blockedByClassLimit: boolean;
  onChange: (perkId: string, level: number) => void;
}): ReactNode {
  const { snapshot, icon } = useWorld();
  const doc = useBuild((s) => s.doc);

  const view = useMemo(() => spellSchool(snapshot, id), [snapshot, id]);
  const spent = useMemo(() => pointsSpentInSchool(snapshot, doc, id), [snapshot, doc, id]);
  const name = text(snapshot, `mmorpg.asc_class.${id}`) ?? id;

  return (
    <div className="school-pane">
      <div className="school-pane-head">
        <img
          className="school-tab-icon"
          src={icon(`mmorpg:textures/gui/asc_classes/class/${id}.png`) ?? undefined}
          alt=""
        />
        <strong>{name}</strong>
        <span className="faint text-sm">{role}</span>
        <span className="grow" />
        <span className="faint text-sm" title="Perk levels allocated in this class, both pools">
          {spent} point{spent === 1 ? "" : "s"}
        </span>
      </div>

      {view === undefined ? (
        <div className="notice">No such school in this snapshot.</div>
      ) : (
        <SchoolGrid
          view={view}
          allocated={allocated}
          level={level}
          spellsPerLevel={spellsPerLevel}
          free={free}
          blockedByClassLimit={blockedByClassLimit}
          onChange={onChange}
        />
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
        <>
        <Plain>
          <div className="notice">
            You cannot allocate points into a third class. Reset one of your current two classes first.
          </div>
        </Plain>
        <Tech>
          <div className="notice">
            Points here would be a <strong>third class</strong>, which{" "}
            <code>canLearn</code> refuses outright. Reset one of your two classes first.
          </div>
        </Tech>
        </>
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
        <>
        <Plain>
          <div className="notice">
            {missing.length} perk entry in this school grid is missing from game data: {missing.join(", ")}. This is a modpack bug, and the game displays nothing for them either.
          </div>
        </Plain>
        <Tech>
          <div className="notice">
            {missing.length} perk id(s) in this school&apos;s grid have no{" "}
            <code>mmorpg_perk</code> entry: <code>{missing.join(", ")}</code>. That is a pack bug —
            the game renders nothing for them too.
          </div>
        </Tech>
        </>
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
      canAdd={canAdd}
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
  canAdd,
  note,
  at,
}: {
  perkId: string;
  spellId: string | undefined;
  perkLevel: number;
  maxLevels: number;
  characterLevel: number;
  /** Whether a click would take another rank; when not, the card prices the right-click instead. */
  canAdd: boolean;
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
  if (card === undefined) return null;
  return (
    <GemWindow card={{ ...card, note }} floating at={at}>
      <PassivePrice perkId={perkId} perkLevel={perkLevel} maxLevels={maxLevels} canAdd={canAdd} />
    </GemWindow>
  );
}

/**
 * What one more rank of a passive does to the build — or, where no more can be taken, what
 * giving one back costs. Holding Alt shows the other direction.
 *
 * The card above already lists the perk's own lines, but `+3% Spell Damage` is not a number you
 * can plan with; how far it moves your DPS, life and the rest of the sheet is. Priced the way a
 * tree node is, by recomputing the build with the change, so conversions, exile effects and
 * everything downstream are in it.
 *
 * One direction at a time rather than both stacked: two comparison blocks do not fit on a
 * screen, and for a flat perk the second is the first with its signs flipped. Alt is for the
 * perks where it is not — a rank that pushes armour up its curve or a resist into its cap.
 *
 * "Up" with Alt is allowed past what a click could buy — out of points, or under the row's
 * level — because what the next rank would do is exactly what someone saving for it wants to
 * know. Only `max_lvls` stops it.
 *
 * Spell perks are left out: taking one also puts the skill on the bar, and the spell card is
 * already about that skill.
 */
function PassivePrice({
  perkId,
  perkLevel,
  maxLevels,
  canAdd,
}: {
  perkId: string;
  perkLevel: number;
  maxLevels: number;
  canAdd: boolean;
}): ReactNode {
  const doc = useBuild((s) => s.doc);
  const alt = useAltHeld();

  const naturalUp = canAdd || perkLevel === 0;
  const up = alt ? !naturalUp : naturalUp;
  const target = up
    ? perkLevel < maxLevels
      ? perkLevel + 1
      : undefined
    : perkLevel > 0
      ? perkLevel - 1
      : undefined;

  // Memoised on the document and the target rank, so the pointer moving across the cell does not
  // restart `useWhatIf`'s timer on every frame.
  const candidate = useMemo(() => {
    if (target === undefined) return undefined;
    const schools = { ...(doc.character.schools ?? {}) };
    if (target <= 0) delete schools[perkId];
    else schools[perkId] = target;
    return { ...doc, character: { ...doc.character, schools } };
  }, [doc, perkId, target]);

  const whatIf = useWhatIf(candidate);

  const title = up
    ? canAdd
      ? "Taking the next rank"
      : "The next rank, if you could take it"
    : "Refunding a rank (right-click)";
  const other = up
    ? perkLevel > 0 && "Hold Alt for refunding a rank"
    : perkLevel < maxLevels && "Hold Alt for the next rank";

  return (
    <>
      <div className="tt-divider" />
      <div className="delta-section-title">
        {target === undefined ? (up ? "Already at max rank" : "No rank to refund") : title}
        {target !== undefined && whatIf === undefined && " · measuring…"}
      </div>
      {target === undefined ? null : whatIf === undefined ? (
        <div className="faint text-sm" style={{ minHeight: 34 }}>
          Recomputing the build with this change…
        </div>
      ) : (
        <ComparisonBlock
          comparison={whatIf.click.comparison}
          emptyNote={
            up ? "Moves no number this planner reports." : "Costs no number this planner reports."
          }
        />
      )}
      {(alt || other) && (
        <div className="faint text-xs mt-2">{alt ? "Release Alt to flip back" : other}</div>
      )}
    </>
  );
}

/**
 * Whether Alt is held, for as long as the component using it is mounted.
 *
 * `preventDefault` on the Alt keydown is what stops Windows from handing focus to the menu bar
 * when the key goes back up — Electron only routes a keystroke to the menu when the page left it
 * unhandled. Scoped to the tooltip's lifetime so Alt reaches the menu everywhere else. Cleared on
 * blur, because an Alt-Tab away never delivers the keyup.
 */
function useAltHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key !== "Alt") return;
      event.preventDefault();
      setHeld(true);
    };
    const up = (event: KeyboardEvent): void => {
      if (event.key !== "Alt") return;
      event.preventDefault();
      setHeld(false);
    };
    const reset = (): void => setHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
}
