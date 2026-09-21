/**
 * The shell: top bar, tabs, the always-visible sheet, and the status bar.
 *
 * The sheet stays on screen on every tab on purpose. The whole reason to build a planner rather
 * than edit JSON is watching a number move when you click a node, and that only works if the
 * number is never a tab away.
 */

import { EPILOGUE_BONUS_POINTS, maxLevel, type BuildDoc, type Observation } from "@cte2/schema";
import { ATTACK_SPEED_ATTRIBUTE, baseAttackSpeedFrom } from "@cte2/engine";
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";

import { SheetDetail, type SheetFocus } from "./panels/stats/SheetDetail.js";
import { Splitter } from "./ui/Splitter.js";
import { VitalsBlock } from "./panels/stats/VitalsBlock.js";
import { PackIcon } from "./ui/StatIcon.js";
import { useBuild } from "./state/build-store.js";
import { useDerived } from "./state/derived.js";
import { useCaptureCheck } from "./state/capture.js";
import { useWorld } from "./state/snapshot.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { Headline } from "./ui/Headline.js";
import { NumberField, TextField } from "./ui/fields.js";
import { RecentBuilds } from "./ui/RecentBuilds.js";

/*
 * The panels load on first visit rather than at boot.
 *
 * All eleven used to be imported eagerly, so opening the app parsed every one of them — including
 * the damage panel and its fourteen modules, which is the largest thing here and which most
 * sessions never open. They are code-split instead; `Suspense` below covers the one frame a first
 * visit costs.
 */
/**
 * The two levels worth a button: where a plan starts, and where it ends.
 *
 * `"max"` rather than 100 so the label follows `GameBalanceConfig.MAX_LEVEL` if a pack moves it,
 * which is the same number the field's own bound comes from.
 */
const LEVEL_STOPS = [1, "max"] as const;

const EPILOGUE_TITLE =
  "Tick when the campaign's epilogue is done. `PlayerPointsType.getFreePoints` adds " +
  "`getBonusPoints` — quest and item rewards — on top of what levelling grants, and no document " +
  "can derive it: at level 100 that is 54 passive points rather than 50, and 110 spell points " +
  "rather than 100. A build imported from the game carries the game's own totals and ignores " +
  "this.";

const CalcsPanel = lazy(() => import("./panels/stats/CalcsPanel.js").then((m) => ({ default: m.CalcsPanel })));
const ConfigPanel = lazy(() => import("./panels/config/ConfigPanel.js").then((m) => ({ default: m.ConfigPanel })));
const DamagePanel = lazy(() => import("./panels/damage/DamagePanel.js").then((m) => ({ default: m.DamagePanel })));
const DefencePanel = lazy(() => import("./panels/defence/DefencePanel.js").then((m) => ({ default: m.DefencePanel })));
const GearPanel = lazy(() => import("./panels/gear/GearPanel.js").then((m) => ({ default: m.GearPanel })));
const SchoolPanel = lazy(() => import("./panels/schools/SchoolPanel.js").then((m) => ({ default: m.SchoolPanel })));
const SkillsPanel = lazy(() => import("./panels/skills/SkillsPanel.js").then((m) => ({ default: m.SkillsPanel })));
const DataPanel = lazy(() => import("./panels/data/DataPanel.js").then((m) => ({ default: m.DataPanel })));
const CaptureCheck = lazy(() => import("./panels/stats/CaptureCheck.js").then((m) => ({ default: m.CaptureCheck })));
const ComparePanel = lazy(() => import("./panels/compare/ComparePanel.js").then((m) => ({ default: m.ComparePanel })));
const Diagnostics = lazy(() => import("./panels/stats/Diagnostics.js").then((m) => ({ default: m.Diagnostics })));
const TreePanel = lazy(() => import("./panels/tree/TreePanel.js").then((m) => ({ default: m.TreePanel })));

/**
 * Split a capture's `minecraft:generic.attack_speed` into the half the weapon owns and the half
 * the build owns, so the swing rate can move when the build does.
 *
 * MnS's `attack_speed` is an `AttributeStat` with `MULTIPLY_BASE`, so the attribute a capture
 * records is `(4.0 + the item's modifier) × (1 + attack_speed / 100)` — the character's own
 * percent already inside it. Read back whole, the rate was frozen: stripping every piece of gear
 * took `attack_speed` from 40% to 13% and the swings per second did not move at all.
 *
 * Both numbers are in the capture, so this is a division rather than a derivation: the attribute
 * is in `character.attributes` and the percent is in the sheet the same capture recorded. It runs
 * exactly once, when a capture file is opened — the only moment the document is guaranteed to
 * still describe the character the attribute was measured on. A build saved from the app is a
 * bare document with no `observed`, so re-opening one cannot run it a second time on a number
 * that has already been split.
 */
function withWeaponSpeed(doc: BuildDoc, observed: Observation | null | undefined): BuildDoc {
  if (!observed || doc.character.baseAttackSpeed !== undefined) return doc;
  const total = doc.character.attributes?.[ATTACK_SPEED_ATTRIBUTE];
  if (typeof total !== "number" || !(total > 0)) return doc;

  const percent = observed.stats.find((stat) => stat.statId === "attack_speed")?.currentValue ?? 0;
  const base = baseAttackSpeedFrom(total, percent);
  if (base === undefined) return doc;

  return { ...doc, character: { ...doc.character, baseAttackSpeed: base } };
}

/**
 * The tab strip, each tab carrying the pack's own icon for the thing it is about.
 *
 * Twelve words in a row at 11px is a strip you read rather than aim at; an icon is what makes
 * the one you want findable without reading. They are the mod's own textures — the talent tree
 * icon here is the talent tree icon in game — so nothing has to be learned twice. A path that
 * did not extract simply renders no image and the word stands alone, which is why the labels are
 * still here and still first.
 */
const TABS = [
  { id: "tree", label: "Tree", icon: "mmorpg:textures/gui/main_hub/icons/talents.png" },
  { id: "classes", label: "Classes", icon: "mmorpg:textures/gui/main_hub/icons/spells.png" },
  { id: "skills", label: "Skills", icon: "mmorpg:textures/gui/main_hub/icons/skill_gems.png" },
  { id: "gear", label: "Items", icon: "mmorpg:textures/gui/inv_gui/icons/gear.png" },
  { id: "damage", label: "Damage", icon: "mmorpg:textures/gui/stat_groups/damage.png" },
  { id: "defence", label: "Defence", icon: "mmorpg:textures/gui/stat_groups/defense.png" },
  { id: "compare", label: "Compare", icon: "mmorpg:textures/gui/main_hub/icons/map_upgrade.png" },
  { id: "config", label: "Config", icon: "mmorpg:textures/gui/main_hub/icons/configs.png" },
  // Between Config and Capture on purpose: it is the reference screen you go and look something
  // up on, not one of the screens you build on, and the three reference tabs now sit together.
  { id: "stats", label: "Stats", icon: "mmorpg:textures/gui/main_hub/icons/stats.png" },
  {
    id: "capture",
    label: "Capture",
    icon: "mmorpg:textures/gui/stat_gui/info_button_icons/current_value.png",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: "mmorpg:textures/gui/main_hub/exclamation_mark.png",
  },
  { id: "data", label: "Data", icon: "mmorpg:textures/gui/main_hub/icons/wiki.png" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App(): ReactNode {
  const [tab, setTab] = useState<TabId>("tree");
  // What the detail window under the sidebar is about: a stat, the same stat on the main skill's
  // own unit, or one of the figures the pipeline derived. `null` closes the window.
  const [focus, setFocus] = useState<SheetFocus | null>(null);
  // Held here rather than in the drill-down so it survives selecting a different stat:
  // somebody who made room to read one breakdown wants the same room for the next.
  const [breakdownHeight, setBreakdownHeight] = useState(320);
  const [sheetOpen, setSheetOpen] = useState(true);
  const world = useWorld();
  const derived = useDerived();

  const doc = useBuild((s) => s.doc);
  const dirty = useBuild((s) => s.dirty);
  const path = useBuild((s) => s.path);
  const canUndo = useBuild((s) => s.past.length > 0);
  const canRedo = useBuild((s) => s.future.length > 0);
  const undo = useBuild((s) => s.undo);
  const redo = useBuild((s) => s.redo);
  const setLevel = useBuild((s) => s.setLevel);
  const setQuestsComplete = useBuild((s) => s.setQuestsComplete);
  const setName = useBuild((s) => s.setName);
  const newBuild = useBuild((s) => s.newBuild);
  const loadBuild = useBuild((s) => s.loadBuild);
  const markSaved = useBuild((s) => s.markSaved);
  const pinBaseline = useBuild((s) => s.pinBaseline);
  const clearBaseline = useBuild((s) => s.clearBaseline);
  const restoreBaseline = useBuild((s) => s.restoreBaseline);
  const baseline = useBuild((s) => s.baseline);

  const errors = derived.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = derived.diagnostics.filter((d) => d.severity === "warning").length;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Version drift: a document authored against another pack version describes ids and roll
  // bands that may since have moved. `meta` records it precisely so this can be checked.
  const authoredAgainst = doc.meta?.mineAndSlashVersion;
  const drift =
    authoredAgainst !== undefined &&
    authoredAgainst !== world.snapshot.meta.mineAndSlashVersion
      ? `Mine and Slash ${authoredAgainst}`
      : null;

  const save = useCallback(
    async (saveAs: boolean) => {
      const result = await window.cte2.saveBuild(doc, saveAs ? undefined : (path ?? undefined));
      if (result.ok) markSaved(result.path);
    },
    [doc, path, markSaved],
  );

  // One place that turns an `OpenResult` into a loaded document, because the file dialog and
  // the recent list have to behave identically — including carrying `observed` through, which
  // is what lets a capture keep checking itself after it is reopened.
  const accept = useCallback(
    (result: Awaited<ReturnType<typeof window.cte2.openBuild>>) => {
      if (result.ok) loadBuild(withWeaponSpeed(result.doc, result.observed), result.path, result.observed ?? null);
      else if (!result.cancelled && result.error !== undefined) {
        // eslint-disable-next-line no-alert
        alert(`Could not open that build:\n\n${result.error}`);
      }
    },
    [loadBuild],
  );

  const open = useCallback(async () => {
    accept(await window.cte2.openBuild());
  }, [accept]);

  const copyJson = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(doc, null, 2)).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [doc]);

  const startNew = useCallback(() => {
    if (!dirty || confirm("Discard unsaved changes?")) newBuild();
  }, [dirty, newBuild]);

  const openAt = useCallback(
    async (path: string) => {
      accept(await window.cte2.openBuildAt(path));
    },
    [accept],
  );

  /*
   * The menu bar drives the same handlers the buttons do.
   *
   * Nothing here implements anything: a command names a thing the chrome already does, so a menu
   * item and the button beside it cannot drift apart. That is also why `tab:` and `open-at:` carry
   * their argument in the string — the alternative is a second channel per parameterised command.
   */
  useEffect(() => {
    return window.cte2.onMenuCommand((command) => {
      if (command.startsWith("tab:")) {
        const id = command.slice(4) as TabId;
        if (TABS.some((t) => t.id === id)) setTab(id);
        return;
      }
      if (command.startsWith("open-at:")) {
        void openAt(command.slice(8));
        return;
      }
      switch (command) {
        case "new": startNew(); return;
        case "open": void open(); return;
        case "save": void save(false); return;
        case "save-as": void save(true); return;
        case "copy-json": copyJson(); return;
        case "undo": undo(); return;
        case "redo": redo(); return;
        case "toggle-sidebar": setSheetOpen((v) => !v); return;
        // Pinning is on the menu because it is the one comparison action you want *before* you
        // start changing things, which is exactly when you are not on the Compare tab. It selects
        // the tab too, so the menu item shows its own result rather than acting invisibly.
        case "pin-baseline": pinBaseline(); setTab("compare"); return;
        case "clear-baseline": clearBaseline(); return;
      }
    });
  }, [openAt, startNew, open, save, copyJson, undo, redo, pinBaseline, clearBaseline]);

  // Restore the last session before the first autosave can overwrite it. A planner that
  // forgets what you were doing when you close it is a planner you stop using; `New` is there
  // for when you want a blank one. The comparison baseline comes back with it — pinning a build
  // and losing the pin to a restart would make the feature not worth using.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.cte2.loadAutosave().then((session) => {
      if (!cancelled && session !== null) {
        loadBuild(session.doc, null);
        if (session.baseline !== null) restoreBaseline(session.baseline);
      }
      if (!cancelled) setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadBuild, restoreBaseline]);

  // Autosave the working document so a crash costs nothing. `baseline` is in the dependencies
  // because pinning one is a change to the session that has to survive the same crash.
  useEffect(() => {
    if (!restored) return;
    const timer = setTimeout(() => void window.cte2.autosave(doc, baseline), 800);
    return () => clearTimeout(timer);
  }, [doc, baseline, restored]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
      } else if (key === "s") {
        event.preventDefault();
        void save(event.shiftKey);
      } else if (key === "o") {
        event.preventDefault();
        void open();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, save, open]);

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">CTE2 Build Planner</span>

        <div className="field">
          <label>Name</label>
          <TextField
            value={doc.meta?.name ?? ""}
            placeholder="Unnamed build"
            onChange={setName}
          />
        </div>

        {/*
          Level, and the two things a plan needs to say about it that a number cannot.

          `commitAs="type"` because this is the one number in the app people arrive at a value
          for rather than explore towards. Everywhere else the field holds what you typed until
          you leave it, so a half-typed roll never re-runs the engine mid-keystroke; here the
          only value anyone wants is the one they are typing, and waiting for a blur that never
          comes is what made a level look like it could only be walked up with the steppers.

          `LEVEL_STOPS` is beside it for the same reason a tree has a "max" button: 1 and 100 are
          where a plan starts and ends, and neither is worth typing.
        */}
        <div className="field">
          <label>Level</label>
          <NumberField
            value={doc.character.level}
            min={1}
            max={maxLevel(world.snapshot)}
            width={58}
            commitAs="type"
            onChange={setLevel}
          />
          {LEVEL_STOPS.map((stop) => {
            const level = stop === "max" ? maxLevel(world.snapshot) : stop;
            return (
              <button
                key={stop}
                className="nudge word"
                disabled={doc.character.level === level}
                title={`Set the character to level ${level}`}
                onClick={() => setLevel(level)}
              >
                {stop}
              </button>
            );
          })}
        </div>

        {/*
          The quest reward, which is the rest of the answer to "how many points does this
          character have".

          `getBonusPoints` is quest and item rewards and nothing derivable from a level reaches
          it, so a planner that only counts `points_per_lvl` is four passive points and ten spell
          points short of any finished character — see `EPILOGUE_BONUS_POINTS`. It sits beside the
          level because it is the same question asked twice: what has this character done.
        */}
        <label className="field" title={EPILOGUE_TITLE}>
          <input
            type="checkbox"
            checked={doc.character.questsComplete === true}
            onChange={(event) => setQuestsComplete(event.target.checked)}
          />
          <span>Epilogue</span>
          <span className="faint text-xs">
            +{EPILOGUE_BONUS_POINTS.PASSIVES} passive · +{EPILOGUE_BONUS_POINTS.SPELLS} spell
          </span>
        </label>

        {/* The figures a build is chosen on, in the chrome rather than inside a tab — so swapping
            a ring on the Gear tab shows its effect without changing tab and losing the number you
            were comparing against. Its own boundary: a headline that throws must not take the
            topbar's Save button with it. */}
        <ErrorBoundary
          what="the headline"
          fallback={() => <span className="faint" style={{ marginLeft: 8 }}>figures unavailable</span>}
        >
          {/* Clicking a headline figure opens its breakdown in the sidebar, and opens the
              sidebar's pane from wherever you were — the figure that made you ask is in the
              chrome, so the answer should not be on a tab. */}
          <Headline onFocus={setFocus} />
        </ErrorBoundary>

        <div className="spacer" />

        <button onClick={undo} disabled={!canUndo} title="Ctrl+Z">
          Undo
        </button>
        <button onClick={redo} disabled={!canRedo} title="Ctrl+Y">
          Redo
        </button>
        <button onClick={() => void open()} title="Ctrl+O">
          Open
        </button>
        {/* Nothing to list in a browser with no File System Access API: a file opened through
            an `<input>` leaves behind no handle, so there is no way to reopen it and a menu
            offering to would be a menu of dead entries. */}
        {window.cte2.capabilities.recentBuilds && <RecentBuilds onOpen={openAt} />}
        {window.cte2.capabilities.saveInPlace ? (
          <>
            <button onClick={() => void save(false)} title="Ctrl+S">
              Save{dirty ? " •" : ""}
            </button>
            <button onClick={() => void save(true)} title="Ctrl+Shift+S">
              Save as…
            </button>
          </>
        ) : (
          // Where the host cannot write back to the file you opened, "Save" would be a lie —
          // every save is a fresh copy in the downloads folder. One button, named for what it
          // actually does.
          <button onClick={() => void save(true)} title="Ctrl+S — downloads a copy">
            Download{dirty ? " •" : ""}
          </button>
        )}
        {/*
          Fixture authoring in one click. `fixtures/README.md` asks for a `build` block plus
          observations transcribed from the game; this produces the first half exactly, so the
          only manual work left is the half that has to come off the screen.
        */}
        <button
          title="Copy this build as JSON, ready to paste into a fixture's `build` block"
          onClick={copyJson}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <button
          onClick={startNew}
        >
          New
        </button>
      </div>

      {drift !== null && (
        <div className="notice" style={{ margin: "8px 12px 0" }}>
          This build was authored against {drift}, and the loaded snapshot is Mine and Slash{" "}
          {world.snapshot.meta.mineAndSlashVersion}. Ids and roll ranges move between versions,
          so numbers here may not describe the character you saved.
        </div>
      )}

      <div className={`body${sheetOpen ? "" : " no-sheet"}`}>
        <div className="main-pane">
          <div className="tabs">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                className={tab === entry.id ? "active" : ""}
                onClick={() => setTab(entry.id)}
              >
                <PackIcon path={entry.icon} size={14} />
                {entry.label}
                {entry.id === "diagnostics" && errors + warnings > 0 && (
                  <span className={`badge ${errors > 0 ? "bad" : "warn"}`} style={{ marginLeft: 6 }}>
                    {errors > 0 ? errors : warnings}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/*
            Keyed on the tab so switching away from a panel that threw and back again gives it a
            fresh boundary. Without the key the boundary keeps its error state and the panel stays
            broken until the whole app reloads, which is exactly the outcome it exists to avoid.
          */}
          <ErrorBoundary key={tab} what={`the ${TABS.find((t) => t.id === tab)?.label ?? tab} panel`}>
            <Suspense fallback={<div className="empty">Loading…</div>}>
            {tab === "tree" && <TreePanel />}
            {tab === "stats" && <CalcsPanel />}
            {tab === "classes" && <SchoolPanel />}
            {tab === "skills" && <SkillsPanel />}
            {tab === "gear" && <GearPanel />}
            {tab === "damage" && <DamagePanel />}
            {tab === "defence" && <DefencePanel />}
            {tab === "compare" && <ComparePanel />}
            {tab === "config" && <ConfigPanel />}
            {tab === "capture" && <CaptureCheck />}
            {tab === "diagnostics" && <Diagnostics />}
            {tab === "data" && <DataPanel />}
            </Suspense>
          </ErrorBoundary>
        </div>

        {sheetOpen && (
        <div className="sidebar">
          {/* The sheet and the breakdown read the same engine result the panels do, so they can
              fail on their own and must not take the panel with them. */}
          <ErrorBoundary what="the stat sheet">
            <div className="sheet">
              <VitalsBlock focus={focus} onFocus={setFocus} />
            </div>
          {focus !== null && (
            <>
              <Splitter height={breakdownHeight} onChange={setBreakdownHeight} />
              <div className="breakdown-pane" style={{ height: breakdownHeight }}>
                {/* `onFocus` is what makes a breakdown navigable: `elemental_resist` reads 0 and
                    hands everything to the three resists, so the useful move from either end is
                    to jump to the other — and a figure's terms link the same way. */}
                <SheetDetail focus={focus} onFocus={setFocus} />
              </div>
            </>
          )}
          </ErrorBoundary>
        </div>
        )}
      </div>

      <div className="statusbar">
        <span title={world.path}>snapshot: {shortPath(world.path)}</span>
        <span>{derived.stats.size} stats</span>
        <span>{derived.elapsedMs.toFixed(1)} ms</span>
        <span className={errors > 0 ? "" : undefined} style={errors > 0 ? { color: "var(--bad)" } : {}}>
          {errors} error{errors === 1 ? "" : "s"}, {warnings} warning{warnings === 1 ? "" : "s"}
        </span>
        <span className="spacer" />
        {/*
          The single most important thing to say about a number, said where it cannot be missed.
          It used to be a fixed string reading "unverified — no fixture pins a number yet", which
          went on claiming that with a matching capture open. Now it reports the document on
          screen: a capture that agrees with the game is the strongest statement this app can
          make, and a build nobody has captured should not borrow it.
        */}
        <CaptureStatus onOpenCapture={() => setTab("capture")} />
      </div>
    </div>
  );
}

/**
 * Whether the numbers on screen have been checked, in one line.
 *
 * Three states, and the difference between them is the whole point of the Capture tab:
 *
 *  - **checked** — this document came out of the in-game exporter and still describes the
 *    character it was taken from, so every stat here can be held against the game's own answer;
 *  - **stale** — it was a capture and has since been edited, so the comparison was dropped;
 *  - **unchecked** — an ordinary build, which nothing pins.
 *
 * Clicking it opens the tab that shows the rows behind it.
 */
function CaptureStatus({ onOpenCapture }: { onOpenCapture: () => void }): ReactNode {
  const check = useCaptureCheck();

  if (check.kind === "none") {
    return (
      <span
        className="link-ish"
        onClick={onOpenCapture}
        title={
          check.dirty
            ? "This build has been edited since it was opened, so the capture it came from no longer describes it"
            : "Open a file the in-game exporter wrote (F6, or /pobexport) to check every stat against the game"
        }
      >
        {check.dirty ? "edited since capture — not checked" : "not checked against the game"}
      </span>
    );
  }

  const { matched, wrong, rows } = check;
  return (
    <span
      className="link-ish"
      onClick={onOpenCapture}
      style={{ color: wrong > 0 ? "var(--bad)" : "var(--good)" }}
      title={
        wrong > 0
          ? "Open the Capture tab for the stats that disagree"
          : "Every stat the game reported for this character is the number shown here"
      }
    >
      {wrong > 0
        ? `${wrong} of ${rows.length} stats disagree with the game`
        : `${matched} stats match the game`}
    </span>
  );
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.slice(-2).join("/");
}
