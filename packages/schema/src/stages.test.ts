import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyBuild, type BuildDoc } from "./build-doc.js";
import {
  activeStage,
  addStage,
  applyStage,
  ensureStages,
  mainStage,
  normalizeStages,
  removeStage,
  renameStage,
  setMainStage,
  stageContent,
  stageList,
  syncStages,
} from "./stages.js";

/** A character that has spent something in every field a stage owns. */
function spent(level = 20): BuildDoc {
  return {
    ...emptyBuild(level),
    meta: { name: "Test build" },
    tree: { talents: [[1, 1], [1, 2]], ascendancy: [[5, 5]] },
    character: {
      level,
      statPoints: { strength: 3 },
      schools: { perk_fire: 2 },
    },
    gear: [{ base: "sword", rarity: "common", itemLevel: 1 }],
  };
}

test("a document with no stage list has one implicit stage", () => {
  const doc = spent();
  const list = stageList(doc);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, "Test build");
  assert.deepEqual(list[0]?.talents, doc.tree?.talents);
  assert.equal(activeStage(doc).id, list[0]?.id);
  // Nothing in the file to choose from, so an exporter is told to read the document itself.
  assert.equal(mainStage(doc), undefined);
});

test("asking for stages banks the character as the first one", () => {
  const doc = ensureStages(spent());
  assert.equal(doc.stages?.length, 1);
  assert.equal(doc.stages?.[0]?.main, true);
  assert.equal(doc.activeStage, doc.stages?.[0]?.id);
  assert.deepEqual(doc.stages?.[0]?.talents, [[1, 1], [1, 2]]);
  assert.deepEqual(doc.stages?.[0]?.statPoints, { strength: 3 });
  assert.equal(doc.stages?.[0]?.level, 20);
});

test("a new stage is empty, and switching back restores everything the old one spent", () => {
  const withNew = addStage(spent(), "Endgame");
  assert.equal(withNew.stages?.length, 2);
  assert.equal(withNew.activeStage, withNew.stages?.[1]?.id);

  // The live fields now show the new, empty stage — but the gear is the character's and stays.
  assert.equal(withNew.tree, undefined);
  assert.equal(withNew.character.statPoints, undefined);
  assert.equal(withNew.character.schools, undefined);
  assert.equal(withNew.gear?.length, 1);

  const back = applyStage(withNew, withNew.stages![0]!.id);
  assert.deepEqual(back.tree?.talents, [[1, 1], [1, 2]]);
  assert.deepEqual(back.tree?.ascendancy, [[5, 5]]);
  assert.deepEqual(back.character.statPoints, { strength: 3 });
  assert.deepEqual(back.character.schools, { perk_fire: 2 });
  assert.equal(back.character.level, 20);
});

test("the level travels with the stage", () => {
  let doc = addStage(spent(20), "Endgame");
  doc = { ...doc, character: { ...doc.character, level: 100 } };
  doc = syncStages(doc);
  assert.equal(applyStage(doc, doc.stages![0]!.id).character.level, 20);
  assert.equal(applyStage(doc, doc.stages![1]!.id).character.level, 100);
});

test("duplicating a stage copies what it spent and leaves the original alone", () => {
  const base = ensureStages(spent());
  const copy = addStage(base, "Variant", base.stages![0]!.id);
  assert.deepEqual(copy.stages?.[1]?.talents, base.stages?.[0]?.talents);
  assert.deepEqual(copy.tree?.talents, [[1, 1], [1, 2]]);

  // Editing the copy must not reach back into the stage it was made from.
  const edited = syncStages({ ...copy, tree: { talents: [[9, 9]] } });
  assert.deepEqual(edited.stages?.[0]?.talents, [[1, 1], [1, 2]]);
  assert.deepEqual(edited.stages?.[1]?.talents, [[9, 9]]);
});

test("edits are banked into the active stage, and only that one", () => {
  const doc = addStage(spent(), "Endgame");
  const edited = syncStages({ ...doc, tree: { talents: [[7, 7]] } });
  assert.deepEqual(edited.stages?.[1]?.talents, [[7, 7]]);
  assert.equal(edited.stages?.[0]?.talents?.length, 2);
});

test("syncing an unchanged document changes nothing, identity included", () => {
  const doc = ensureStages(spent());
  assert.equal(syncStages(doc), doc);
});

test("the main mark moves rather than accumulating", () => {
  const doc = setMainStage(addStage(spent(), "Endgame"), "s2");
  assert.equal(doc.stages?.filter((s) => s.main === true).length, 1);
  assert.equal(mainStage(doc)?.id, "s2");
  // Marking it does not change which one is being edited.
  assert.equal(doc.activeStage, "s2");
  assert.equal(mainStage(setMainStage(doc, "s1"))?.id, "s1");
});

test("main and active are independent", () => {
  let doc = setMainStage(addStage(spent(), "Endgame"), "s2");
  doc = applyStage(doc, "s1");
  assert.equal(doc.activeStage, "s1");
  assert.equal(mainStage(doc)?.id, "s2");
});

test("renaming keeps the stage's identity", () => {
  const doc = renameStage(ensureStages(spent()), "s1", "  1-20  ");
  assert.equal(doc.stages?.[0]?.name, "1-20");
  assert.equal(doc.stages?.[0]?.id, "s1");
  // An empty name is refused rather than stored.
  assert.equal(renameStage(doc, "s1", "   ").stages?.[0]?.name, "1-20");
});

test("deleting the active stage switches to another one", () => {
  const doc = addStage(spent(), "Endgame");
  const left = removeStage(doc, "s2");
  assert.equal(left.stages?.length, 1);
  assert.equal(left.activeStage, "s1");
  assert.deepEqual(left.tree?.talents, [[1, 1], [1, 2]]);
});

test("deleting the main stage moves the mark", () => {
  const doc = setMainStage(addStage(spent(), "Endgame"), "s1");
  assert.equal(mainStage(removeStage(doc, "s1"))?.id, "s2");
});

test("deleting the last stage leaves the character exactly as it was", () => {
  const doc = ensureStages(spent());
  const gone = removeStage(doc, "s1");
  assert.equal(gone.stages, undefined);
  assert.equal(gone.activeStage, undefined);
  assert.deepEqual(gone.tree?.talents, [[1, 1], [1, 2]]);
  assert.deepEqual(gone.character.statPoints, { strength: 3 });
});

test("normalising repairs a hand-edited list", () => {
  const doc: BuildDoc = {
    ...spent(),
    stages: [
      { id: "s1", name: "One", talents: [[0, 0]] },
      { id: "s1", name: "", main: true, talents: [[2, 2]] },
      { id: "s3", name: "Three", main: true },
    ],
    activeStage: "nope",
  };
  const fixed = normalizeStages(doc);

  assert.deepEqual(fixed.stages?.map((s) => s.id), ["s1", "s2", "s3"]);
  assert.equal(fixed.stages?.[1]?.name, "Stage 2");
  assert.equal(fixed.stages?.filter((s) => s.main === true).length, 1);
  assert.equal(mainStage(fixed)?.id, "s2");
  assert.equal(fixed.activeStage, "s2");
  // `activeStage` named nothing, so the live fields are what the stage it landed on now holds.
  assert.deepEqual(fixed.stages?.[1]?.talents, [[1, 1], [1, 2]]);
});

test("the live fields win over a stale copy in the active stage", () => {
  const doc: BuildDoc = {
    ...spent(),
    stages: [{ id: "s1", name: "One", main: true, level: 3, talents: [[0, 0]] }],
    activeStage: "s1",
  };
  const fixed = normalizeStages(doc);
  assert.deepEqual(fixed.stages?.[0]?.talents, [[1, 1], [1, 2]]);
  assert.equal(fixed.stages?.[0]?.level, 20);
  assert.equal(fixed.character.level, 20);
});

test("an empty stage list is dropped rather than carried", () => {
  const fixed = normalizeStages({ ...spent(), stages: [], activeStage: "s1" });
  assert.equal(fixed.stages, undefined);
  assert.equal(fixed.activeStage, undefined);
});

test("stage content never carries anything the character owns", () => {
  const content = stageContent(spent());
  assert.deepEqual(Object.keys(content).sort(), [
    "ascendancy",
    "level",
    "schools",
    "statPoints",
    "talents",
  ]);
});
