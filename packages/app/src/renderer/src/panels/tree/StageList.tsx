/**
 * The saved stages of a build: the levelling tree, the respec at 50, the two endgame trees you
 * cannot choose between.
 *
 * It lives on the tree canvas because that is where the thing it switches is — you pick a stage
 * to look at a tree, not to look at a list. Collapsed it is one row naming what you are editing,
 * which is the state it is in almost always; expanded it is the whole list with the two buttons
 * that make another one.
 *
 * ## Two different "which one"
 *
 * **Selected** is the stage on the character — the trees the canvas is drawing and the level the
 * point budget is counted against. **Main** is the one an exporter or a build viewer shows when
 * it can only show one. They are deliberately not the same flag: opening the levelling tree to
 * check where a point went must not change what a published guide is a guide to.
 *
 * ## No dropdown
 *
 * The list expands in flow and pushes the stat-point block down rather than floating over it.
 * An absolutely positioned list inside the tree overlay is the exact shape of a bug this project
 * has hit twice — a popup rendered inside a container that turns out to be its own stacking
 * context, landing behind the rows below it. Nothing here can do that.
 */

import { stageList, type BuildStage } from "@cte2/schema";
import { useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";

export function StageList(): ReactNode {
  const doc = useBuild((s) => s.doc);
  const addStage = useBuild((s) => s.addStage);
  const duplicateStage = useBuild((s) => s.duplicateStage);
  const switchStage = useBuild((s) => s.switchStage);
  const renameStage = useBuild((s) => s.renameStage);
  const removeStage = useBuild((s) => s.removeStage);
  const setMainStage = useBuild((s) => s.setMainStage);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const stages = stageList(doc);
  const selected = stages.find((s) => s.id === doc.activeStage) ?? stages[0]!;
  const saved = doc.stages !== undefined;

  // A name that is already taken, numbered. "Stage 2" next to another "Stage 2" is a list you
  // have to click through to read.
  const freeName = (base: string): string => {
    const taken = new Set(stages.map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
    }
  };

  const drop = (stage: BuildStage): void => {
    const spent = spendOf(stage);
    const total = spent.talents + spent.ascendancy + spent.atlas;
    if (total > 0 && !confirm(`Delete "${stage.name}"? It has ${total} points allocated.`)) return;
    removeStage(stage.id);
  };

  return (
    <div className="tree-hud stage-block">
      <button
        className="stage-head"
        onClick={() => setOpen((v) => !v)}
        title="Saved stages of this build: trees, points and the level each was planned at"
      >
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="stage-label">Stage</span>
        <span className="stage-current">{selected.name}</span>
        {selected.main === true && saved && <span className="stage-main" title="Shown by exporters">★</span>}
        {stages.length > 1 && (
          <span className="faint text-xs">
            {stages.indexOf(selected) + 1} of {stages.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="stage-rows">
            {stages.map((stage) => {
              const spent = spendOf(stage);
              const isSelected = stage.id === selected.id;
              return (
                <div key={stage.id} className={`stage-row${isSelected ? " selected" : ""}`}>
                  {editing === stage.id ? (
                    <input
                      className="stage-name-input"
                      autoFocus
                      defaultValue={stage.name}
                      onBlur={(event) => {
                        renameStage(stage.id, event.target.value);
                        setEditing(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <button
                      className="stage-pick"
                      onClick={() => switchStage(stage.id)}
                      onDoubleClick={() => setEditing(stage.id)}
                      title={
                        `${spent.talents} talent · ${spent.ascendancy} ascendancy · ` +
                        `${spent.atlas} atlas · ${spent.statPoints} stat · ${spent.schools} school`
                      }
                    >
                      <span className="stage-name">{stage.name}</span>
                      {stage.main === true && saved && <span className="stage-main">★</span>}
                      <span className="grow" />
                      {stage.level !== undefined && <span className="faint text-xs">lv {stage.level}</span>}
                      <span className="num text-xs">{spent.talents}</span>
                    </button>
                  )}

                  {saved && (
                    <div className="stage-actions">
                      <button
                        className={`nudge${stage.main === true ? " on" : ""}`}
                        title="Make this the stage exporters and build viewers show"
                        disabled={stage.main === true}
                        onClick={() => setMainStage(stage.id)}
                      >
                        ★
                      </button>
                      <button className="nudge" title="Rename" onClick={() => setEditing(stage.id)}>
                        ✎
                      </button>
                      <button
                        className="nudge"
                        title="Delete this stage"
                        disabled={stages.length === 1}
                        onClick={() => drop(stage)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="row gap-5 mt-4">
            <button onClick={() => addStage(freeName("New stage"))} title="An empty tree at this character's level">
              New
            </button>
            <button
              onClick={() => duplicateStage(selected.id, freeName(`${selected.name} copy`))}
              title="A copy of the stage you are on, to change without losing it"
            >
              Duplicate
            </button>
          </div>

          {!saved && (
            <div className="faint text-xs mt-4">
              This build has one stage. Adding a second keeps what you have as the first.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What a stage spent, for the row's numbers and the delete confirmation. */
function spendOf(stage: BuildStage): {
  talents: number;
  ascendancy: number;
  atlas: number;
  statPoints: number;
  schools: number;
} {
  return {
    talents: stage.talents?.length ?? 0,
    ascendancy: stage.ascendancy?.length ?? 0,
    atlas: stage.atlas?.length ?? 0,
    statPoints: sum(stage.statPoints),
    schools: sum(stage.schools),
  };
}

function sum(record: Record<string, number> | undefined): number {
  return Object.values(record ?? {}).reduce((total, n) => total + n, 0);
}
