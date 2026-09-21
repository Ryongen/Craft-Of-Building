/**
 * Saved stages of a build, and the one rule that keeps them honest.
 *
 * A {@link BuildStage} holds what a character *spent* — the three trees, the core-stat points,
 * the spell-school allocation and the level all of that was planned at. The document holds the
 * same four things at the top level, where they always were, and `activeStage` says which entry
 * of the list those live fields are currently showing.
 *
 * ## The rule: the live fields are the truth
 *
 * `tree`, `character.level`, `character.statPoints` and `character.schools` are what the engine
 * computes from, what the validator grades, and what the companion mod writes. None of them
 * learns about stages. So the stage list is a *record* of them and never a second source:
 *
 *   - every edit runs {@link syncStages}, which copies the live fields into the active entry,
 *   - switching runs {@link applyStage}, which syncs first and then writes the target's fields
 *     out to the live ones,
 *   - a document whose active entry disagrees with its live fields — hand-edited, or a capture
 *     saved over an older file — is resolved by the sync, in favour of the live fields.
 *
 * Nothing outside this module writes a stage, and nothing inside it writes anything else. A
 * function here that started reaching into `gear` would be the bug: gear belongs to the
 * character, is shared by every stage, and switching must never touch it.
 *
 * ## No stages is a document with one stage
 *
 * `stages` is absent until someone asks for a second one, which is what every document authored
 * before this existed looks like. Readers use {@link stageList}, which reports the implicit
 * single stage, so "has stages" is never a question anyone has to ask. {@link mainStage} is the
 * exception and returns `undefined` there on purpose: an exporter with no list to choose from
 * should read the document, not a synthesised entry that is not in the file.
 */

import type { BuildDoc, BuildStage } from "./build-doc.js";

/** The stage-owned fields, without the identity — what a stage *is*, as opposed to which one. */
export type StageContent = Omit<BuildStage, "id" | "name" | "main">;

/** What a stage with no name of its own is called. */
export const DEFAULT_STAGE_NAME = "Main";

/**
 * The live document's stage fields, ready to store.
 *
 * Empty collections are dropped rather than stored as `{}` or `[]`, for the reason the store's
 * own `prune` gives: these files get read, diffed and pasted into fixtures by people.
 */
export function stageContent(doc: BuildDoc): StageContent {
  const out: StageContent = { level: doc.character.level };
  const tree = doc.tree ?? {};
  if (tree.talents?.length) out.talents = tree.talents;
  if (tree.ascendancy?.length) out.ascendancy = tree.ascendancy;
  if (tree.atlas?.length) out.atlas = tree.atlas;
  if (hasKeys(doc.character.statPoints)) out.statPoints = doc.character.statPoints;
  if (hasKeys(doc.character.schools)) out.schools = doc.character.schools;
  return out;
}

/**
 * The document as it would be with `stage`'s allocation in place — the same character, at a
 * different point in its plan.
 *
 * Everything the stage does not own is carried across untouched, and the fields it does own are
 * *replaced*, not merged: a stage with no `schools` is a stage that has allocated none, and
 * leaving the previous stage's schools standing would make every switch accumulate.
 *
 * `level` is the one exception — an entry that never recorded one keeps the character's current
 * level rather than resetting it, since there is no level to restore and 1 would be a lie.
 *
 * Exported because validation and any "what would this stage give me" comparison want the
 * document without changing the one on screen.
 */
export function stageDoc(doc: BuildDoc, stage: StageContent): BuildDoc {
  const character = { ...doc.character };
  if (stage.level !== undefined) character.level = stage.level;
  assign(character, "statPoints", hasKeys(stage.statPoints) ? stage.statPoints : undefined);
  assign(character, "schools", hasKeys(stage.schools) ? stage.schools : undefined);

  const tree: NonNullable<BuildDoc["tree"]> = {};
  if (stage.talents?.length) tree.talents = stage.talents;
  if (stage.ascendancy?.length) tree.ascendancy = stage.ascendancy;
  if (stage.atlas?.length) tree.atlas = stage.atlas;

  const next: BuildDoc = { ...doc, character };
  if (Object.keys(tree).length === 0) delete next.tree;
  else next.tree = tree;
  return next;
}

/** The id of the stage a document without a stage list has. Never written to a file. */
export const IMPLICIT_STAGE_ID = "";

/**
 * Every stage of this document, including the implicit one a document without a list has.
 *
 * The implicit entry is synthesised from the live fields and is not in the file; its id is
 * {@link IMPLICIT_STAGE_ID}, which no stored stage can be given.
 */
export function stageList(doc: BuildDoc): BuildStage[] {
  const stages = doc.stages;
  if (stages === undefined || stages.length === 0) {
    return [{ id: IMPLICIT_STAGE_ID, name: stageName(doc), main: true, ...stageContent(doc) }];
  }
  return stages;
}

/** The stage the live fields are showing, or the implicit one. */
export function activeStage(doc: BuildDoc): BuildStage {
  const list = stageList(doc);
  return list.find((s) => s.id === doc.activeStage) ?? list[0]!;
}

/**
 * The stage that represents this build — what an exporter or a build viewer should draw.
 *
 * `undefined` where the document has no stage list, which means the document itself is the
 * answer. That is deliberately not the same as returning a synthetic entry: a caller that wants
 * either can write `mainStage(doc) ?? activeStage(doc)`, and one that is about to *write* a
 * stage needs to know there is nothing there yet.
 */
export function mainStage(doc: BuildDoc): BuildStage | undefined {
  const stages = doc.stages;
  if (stages === undefined || stages.length === 0) return undefined;
  return stages.find((s) => s.main === true) ?? stages[0];
}

/**
 * Copy the live fields into the active entry.
 *
 * Called after every edit, so it must be cheap and must not churn identity: a document whose
 * active stage already agrees is returned as-is, which is what stops React re-rendering the
 * stage list on every keystroke in an unrelated panel.
 */
export function syncStages(doc: BuildDoc): BuildDoc {
  const stages = doc.stages;
  if (stages === undefined || stages.length === 0) return doc;

  const index = stages.findIndex((s) => s.id === doc.activeStage);
  if (index < 0) return doc;

  const current = stages[index]!;
  const content = stageContent(doc);
  if (sameContent(current, content)) return doc;

  const next = [...stages];
  next[index] = { id: current.id, name: current.name, ...(current.main ? { main: true } : {}), ...content };
  return { ...doc, stages: next };
}

/**
 * Switch to a stage: bank the one being left, then put the target's allocation on the character.
 *
 * A no-op where the id names nothing, rather than an error — the callers are a click on a list
 * that was rendered from the same document, and a stale click is not worth a throw.
 */
export function applyStage(doc: BuildDoc, id: string): BuildDoc {
  const banked = syncStages(doc);
  const target = banked.stages?.find((s) => s.id === id);
  if (target === undefined) return doc;
  return { ...stageDoc(banked, target), activeStage: id };
}

/**
 * Give a document that has no stage list one, holding exactly what it holds now.
 *
 * The first entry is the character as it stands, because it has to be: the alternative is that
 * asking for a second stage quietly loses the first, which is the tree the person has been
 * working on for an hour.
 */
export function ensureStages(doc: BuildDoc, name?: string): BuildDoc {
  if (doc.stages !== undefined && doc.stages.length > 0) return syncStages(doc);
  // The same name {@link stageList} was already showing for the implicit stage, so asking for a
  // second one does not quietly rename the first.
  const first: BuildStage = { id: "s1", name: name ?? stageName(doc), main: true, ...stageContent(doc) };
  return { ...doc, stages: [first], activeStage: first.id };
}

/**
 * Add a stage and switch to it.
 *
 * `from` is the stage to copy, which is what "duplicate" is: a new stage that starts as a copy
 * of another one. Without it the new stage starts empty, at the character's current level —
 * empty being the right start for "now plan the levelling tree", and a copy being the right
 * start for "now try this without the crit nodes".
 */
export function addStage(doc: BuildDoc, name: string, from?: string): BuildDoc {
  const base = ensureStages(doc);
  const stages = base.stages ?? [];
  // A `from` that names nothing is the implicit stage: its id does not survive materialising,
  // and the entry it became is the active one. Duplicating a one-stage build must copy that
  // build, not hand back an empty tree.
  const source =
    from === undefined
      ? undefined
      : (stages.find((s) => s.id === from) ?? stages.find((s) => s.id === base.activeStage));
  const content: StageContent = source
    ? stripIdentity(source)
    : { level: base.character.level };

  const stage: BuildStage = { id: freeId(stages), name, ...content };
  return applyStage({ ...base, stages: [...stages, stage] }, stage.id);
}

/**
 * Rename a stage. An empty name is refused — a row you cannot tell apart is worse than a bad name.
 *
 * Renaming the *implicit* stage of a document that has no list is how a list usually starts:
 * calling a character's one allocation "1-20" is the moment it becomes a stage of something.
 * So an id that matches nothing on a document with no stages renames the one it just
 * materialised, rather than silently doing nothing.
 */
export function renameStage(doc: BuildDoc, id: string, name: string): BuildDoc {
  const trimmed = name.trim();
  if (trimmed.length === 0) return doc;
  const base = ensureStages(doc);
  const stages = base.stages ?? [];
  const target = stages.some((s) => s.id === id) ? id : doc.stages === undefined ? base.activeStage : undefined;
  if (target === undefined) return doc;
  return { ...base, stages: stages.map((s) => (s.id === target ? { ...s, name: trimmed } : s)) };
}

/**
 * Mark the stage an exporter should show. The mark moves rather than being added: exactly one
 * stage carries it, so a viewer never has to break a tie or cope with none.
 */
export function setMainStage(doc: BuildDoc, id: string): BuildDoc {
  const base = ensureStages(doc);
  const stages = base.stages ?? [];
  if (!stages.some((s) => s.id === id)) return doc;
  return {
    ...base,
    stages: stages.map((s) => {
      const { main: _drop, ...rest } = s;
      return s.id === id ? { ...rest, main: true } : rest;
    }),
  };
}

/**
 * Delete a stage.
 *
 * Two consequences the caller does not have to think about. Deleting the **active** stage
 * switches to another one, because the live fields have to be showing something and leaving
 * them on the allocation of a stage that no longer exists is how a document ends up with a tree
 * nothing in it accounts for. Deleting the **main** stage moves the mark to the first survivor.
 *
 * Deleting the last stage drops the list entirely and leaves the character exactly as it is —
 * back to a document with one unnamed stage, which is where it started.
 */
export function removeStage(doc: BuildDoc, id: string): BuildDoc {
  const base = syncStages(doc);
  const stages = base.stages;
  if (stages === undefined || !stages.some((s) => s.id === id)) return doc;

  const rest = stages.filter((s) => s.id !== id);
  if (rest.length === 0) {
    const next = { ...base };
    delete next.stages;
    delete next.activeStage;
    return next;
  }

  const withMain = rest.some((s) => s.main === true)
    ? rest
    : rest.map((s, i) => (i === 0 ? { ...s, main: true as const } : s));

  const next = { ...base, stages: withMain };
  return base.activeStage === id ? applyStage(next, withMain[0]!.id) : next;
}

/**
 * Bring a document's stage list into the shape the rest of this module assumes: ids that exist
 * and are unique, exactly one `main`, and an `activeStage` that names an entry.
 *
 * Run when a document is opened, because a `BuildDoc` can arrive from a text editor, an older
 * build of this app or a future one. Nothing here is a legality judgement — {@link validateBuild}
 * reports what was wrong; this makes the app's own handling of it defined.
 */
export function normalizeStages(doc: BuildDoc): BuildDoc {
  const stages = doc.stages;
  if (stages === undefined) return doc;
  if (stages.length === 0) {
    const next = { ...doc };
    delete next.stages;
    delete next.activeStage;
    return next;
  }

  const seen = new Set<string>();
  const fixed: BuildStage[] = [];
  let main: number | undefined;
  for (const stage of stages) {
    const id =
      typeof stage.id === "string" && stage.id.length > 0 && !seen.has(stage.id)
        ? stage.id
        : freeId(fixed);
    seen.add(id);
    const name = typeof stage.name === "string" && stage.name.trim().length > 0 ? stage.name : `Stage ${fixed.length + 1}`;
    const { main: wasMain, ...rest } = stage;
    if (wasMain === true && main === undefined) main = fixed.length;
    fixed.push({ ...rest, id, name });
  }
  fixed[main ?? 0] = { ...fixed[main ?? 0]!, main: true };

  const wanted = doc.activeStage;
  const active = wanted !== undefined && fixed.some((s) => s.id === wanted) ? wanted : fixed[main ?? 0]!.id;
  // The live fields win over the entry that claims to be showing them — see the module note.
  return syncStages({ ...doc, stages: fixed, activeStage: active });
}

// ---------------------------------------------------------------------------

/** `s1`, `s2`, … — the lowest number not already taken. Readable in a hand-edited file. */
function freeId(stages: readonly BuildStage[]): string {
  const taken = new Set(stages.map((s) => s.id));
  for (let n = 1; ; n++) {
    const id = `s${n}`;
    if (!taken.has(id)) return id;
  }
}

function stripIdentity(stage: BuildStage): StageContent {
  const { id: _id, name: _name, main: _main, ...content } = stage;
  return content;
}

/** What to call the implicit stage of a document that has no list. */
function stageName(doc: BuildDoc): string {
  return doc.meta?.name?.trim() || DEFAULT_STAGE_NAME;
}

function hasKeys(record: Record<string, number> | undefined): record is Record<string, number> {
  return record !== undefined && Object.keys(record).length > 0;
}

function assign<K extends "statPoints" | "schools">(
  character: BuildDoc["character"],
  key: K,
  value: Record<string, number> | undefined,
): void {
  if (value === undefined) delete character[key];
  else character[key] = value;
}

/**
 * Whether a stored stage already holds this content.
 *
 * Reference equality on the collections, not a deep compare: every mutator in the app builds a
 * new array or object for what it changed and hands the rest through untouched, so a reference
 * that has not moved is content that has not changed. A deep compare would run on every
 * keystroke to confirm the same thing.
 */
function sameContent(stage: BuildStage, content: StageContent): boolean {
  return (
    stage.level === content.level &&
    stage.talents === content.talents &&
    stage.ascendancy === content.ascendancy &&
    stage.atlas === content.atlas &&
    stage.statPoints === content.statPoints &&
    stage.schools === content.schools
  );
}
