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
  perkName,
  perkPointType,
  pointsAvailable,
  pointsPerLevel,
  schoolPerksInOrder,
  schoolPointsSpent,
  spellName,
  spellOfPerk,
  spellSchool,
  spellSchoolIds,
  statName,
  text,
  unknownSchoolPerks,
  type SpellSchoolView,
} from "@cte2/schema";
import { useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useWorld } from "../../state/snapshot.js";

/** `SpellSchool.MAX_X_ROWS` / `MAX_Y_ROWS` — the grid the screen draws into. */
const COLUMNS = 10;
const ROWS = 7;

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

  const title = [
    perkName(snapshot, perkId) ?? perkId,
    spellId === undefined
      ? `Passive · ${perkLevel}/${maxLevels}`
      : `Spell: ${spellName(snapshot, spellId) ?? spellId} · rank ${perkLevel}/${maxLevels}`,
    statLines(snapshot, perkId, perkLevel),
    why,
    "Click to add, right-click to remove",
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return (
    <button
      className={`school-cell${perkLevel > 0 ? " taken" : ""}${isSpellPerk(snapshot, perkId) ? " spell" : " passive"}${canAdd ? "" : " blocked"}`}
      title={title}
      onClick={() => canAdd && onChange(perkId, perkLevel + 1)}
      onContextMenu={(event) => {
        event.preventDefault();
        if (perkLevel > 0) onChange(perkId, perkLevel - 1);
      }}
    >
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
 * What the perk grants at its current level, for the tooltip.
 *
 * A perk at level N grants N times its listed stats, so showing the multiplied value is what
 * the screen should say — the stat sheet will agree with it.
 */
function statLines(snapshot: ReturnType<typeof useWorld>["snapshot"], perkId: string, perkLevel: number): string {
  const data = perk(snapshot, perkId);
  if (!data) return "";
  const raw = (snapshot.registries["mmorpg_perk"]?.[perkId]?.data as Record<string, unknown> | undefined)?.[
    "stats"
  ];
  if (!Array.isArray(raw)) return "";

  const multiplier = Math.max(perkLevel, 1);
  return raw
    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
    .map((mod) => {
      const statId = typeof mod["stat"] === "string" ? mod["stat"] : "";
      const v1 = typeof mod["v1"] === "number" ? mod["v1"] : 0;
      const type = typeof mod["type"] === "string" ? mod["type"] : "FLAT";
      if (statId.startsWith("learn_")) return "";
      const value = v1 * multiplier;
      return `${type === "PERCENT" ? `${value}%` : value} ${statName(snapshot, statId) ?? statId}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}
