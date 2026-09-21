/**
 * The build document, and every way the UI is allowed to change it.
 *
 * One store, one document. Panels never mutate a `BuildDoc` directly — they call a mutator
 * here, which is what makes undo work and what keeps the document in a shape the validator
 * recognises. `emptyBuild()` from `@cte2/schema` is the only starting point.
 *
 * History is whole-document snapshots rather than diffs. A `BuildDoc` for a fully geared level
 * 100 character is a few tens of kilobytes of plain JSON, so 100 of them is cheaper than the
 * bookkeeping a patch-based history would need.
 */

import type { Snapshot } from "@cte2/extractor";
import type { Observation } from "@cte2/schema";
import {
  BUILD_DOC_VERSION,
  MAX_ACTIVE_SKILLS,
  activeSkillCount,
  buildTargetEnemy,
  emptyBuild,
  isSkillEnabled,
  nodeKey,
  parseNodeKey,
  type AuraSetup,
  type FoodBuffSetup,
  type BuildDoc,
  type EnemySetup,
  type ExileEffectSetup,
  type Item,
  type Jewel,
  type NodeKey,
  type OmenSetup,
  type SkillSetup,
  type TargetPlacement,
  type TargetPresetId,
  type TreeCoord,
  type TreeKey,
} from "@cte2/schema";
import { create } from "zustand";

import type { PinnedBaseline } from "@shared/ipc";

import { applyPatch, type Patch } from "./patch.js";

const HISTORY_LIMIT = 100;

/**
 * A build held still, to measure the one you are editing against.
 *
 * The shape is `@shared/ipc`'s, because it is written to the autosave file and so crosses the
 * process boundary. What belongs here is the *rule*: a baseline is **frozen** by construction,
 * not by convention. Every mutator in this store goes through `edit`, which reads and writes
 * `state.doc` and never touches this, and no action below writes into a pinned document — the
 * ones that look like they might (`pinBaseline`, `swapBaseline`) replace it wholesale.
 *
 * That is the standing rule about connected state: a value showing in two panels comes from one
 * computation and its write goes to one place. A comparison surface that let you flip an effect
 * on the baseline would be a second place that effect lives, and the two would disagree the first
 * time anyone used it.
 */
export type Baseline = PinnedBaseline;

export type BuildState = {
  doc: BuildDoc;
  /** Where the document was last opened from or saved to, for a plain Ctrl+S. */
  path: string | null;
  dirty: boolean;
  past: BuildDoc[];
  future: BuildDoc[];

  // -- document lifecycle -------------------------------------------------
  newBuild(): void;
  loadBuild(doc: BuildDoc, path: string | null, observed?: Observation | null): void;
  /**
   * The game's own stat sheet for the character currently loaded, when it came from a capture.
   *
   * Cleared by every edit: the moment you change a piece of gear, the capture describes a
   * different character and comparing against it would be worse than not comparing at all.
   */
  observed: Observation | null;
  markSaved(path: string): void;
  undo(): void;
  redo(): void;

  // -- comparison ---------------------------------------------------------
  /**
   * The build the current one is being measured against, or null for no comparison.
   *
   * Session state, not part of the document: two people opening the same `.json` are not
   * comparing it against the same thing, and nothing about a build says what you were holding it
   * up against. It survives opening another build on purpose — pin A, open B, read the
   * difference is the whole point — and it survives `New` for the same reason, since the surface
   * that uses it names what is pinned and offers one click to drop it.
   */
  baseline: Baseline | null;
  /** Freeze the document as it stands now. Pinning again replaces what was pinned. */
  pinBaseline(name?: string): void;
  /** Pin a document that is not the open one — a file opened as a baseline. */
  setBaseline(doc: BuildDoc, name: string): void;
  /**
   * Put back a baseline that was pinned in an earlier session, keeping the time it was pinned.
   *
   * Separate from {@link setBaseline} precisely because of that timestamp: restoring through
   * `setBaseline` would stamp the app's launch onto a pin from three days ago, and "pinned just
   * now" is the one thing the Compare tab's header must not lie about.
   */
  restoreBaseline(baseline: Baseline): void;
  clearBaseline(): void;
  /**
   * Make the pinned build the one you are editing, and pin what you were editing in its place.
   *
   * The move you want after reading a comparison the wrong way round, and the reason it is one
   * action rather than "open the baseline, then pin the other one": the second of those loses the
   * document you had open unless it was saved first.
   */
  swapBaseline(): void;

  // -- character ----------------------------------------------------------
  setLevel(level: number): void;
  /**
   * Whether the campaign's epilogue is finished, which is +4 passive and +10 spell points.
   *
   * See `BuildDoc.character.questsComplete`. Unset rather than `false` when it is off, so a
   * hand-authored document says nothing rather than asserting an unfinished campaign.
   */
  setQuestsComplete(done: boolean): void;
  setName(name: string): void;
  setSchool(school: string | undefined): void;
  setAscendancy(ascendancy: string | undefined): void;
  /**
   * Spend or refund level-up points on one core stat.
   *
   * Mirrors `AllocateStatPacket`: the map holds whole points per stat id, a zero is removed
   * rather than stored as `0`, and the budget is the caller's to enforce — the packet checks
   * `getFreePoints(player) < 1` before each increment, and the panel does the same so the
   * buttons disable instead of producing a document the validator then rejects.
   */
  setStatPoints(statId: string, points: number): void;
  /** Solonion's food-diversity count. `undefined` clears it. */
  setFoodDiversity(count: number | undefined): void;
  /**
   * The weapon's own swings per second, before `attack_speed` multiplies it.
   *
   * `undefined` clears it, which puts the swing rate back on whatever raw attribute a capture
   * recorded — right for the captured character and frozen thereafter.
   */
  setBaseAttackSpeed(speed: number | undefined): void;
  /**
   * `minecraft:generic.attack_damage` — the weapon's vanilla attack damage, 1.0 bare-handed.
   *
   * The other half of the weapon that no registry carries, and the one that moves damage rather
   * than rate: `attack_damage_compat` turns this attribute into `total_damage` at 0.5x, and
   * `total_damage` is the pack's only unconditional additive-damage stat, so it multiplies every
   * element of every hit. Unlike {@link setBaseAttackSpeed} it needs no splitting — nothing in
   * MnS writes onto this attribute, so a capture taken with the weapon in hand is already the
   * whole answer, and this field is for a weapon no capture ever held.
   *
   * `undefined` removes the key rather than writing vanilla's 1.0, so "not recorded" and
   * "recorded as bare-handed" stay distinguishable to the engine's warning.
   */
  setWeaponAttackDamage(value: number | undefined): void;
  clearStatPoints(): void;

  /**
   * Spell school allocation — one perk's level, `SpellSchoolsData.allocated_lvls` style.
   * Zero removes the entry, the way `removeUnlearnedPerks` prunes anything below 1.
   */
  setSchoolPerk(perkId: string, level: number): void;
  /**
   * Put a spell on the bar, or take it off — the Skills tab, driven from the Classes tab.
   *
   * Learning a spell perk *is* slotting the skill in game: `SpellCastingData` reads the
   * `learn_<spell>` stat back out of the container as the spell's rank and the hotbar is filled
   * from what you know. Allocating on the class screen and then hunting for the same spell in a
   * 372-entry picker was a step the game does not ask for.
   *
   * It is idempotent both ways: a spell already on the bar is not added twice, and taking the
   * perk back to 0 removes the Skill only if nothing else was done to it — a Skill with support
   * gems linked is kept and disabled instead, because those links are work and the perk can be
   * re-taken.
   */
  toggleSkillFor(spellId: string, on: boolean): void;
  clearSchools(): void;

  // -- tree ---------------------------------------------------------------
  /**
   * Add every node of an already-validated route. The canvas computes the route against the
   * graph (`shortestPathTo`), so the store's job is only to record it in document order.
   */
  allocateNodes(tree: TreeKey, keys: readonly NodeKey[]): void;
  /** Remove a node and the branch it was holding up, as computed by `orphansIfRemoved`. */
  deallocateNodes(tree: TreeKey, keys: readonly NodeKey[]): void;
  clearTree(tree: TreeKey): void;

  // -- gear ---------------------------------------------------------------
  addItem(item: Item): void;
  updateItem(index: number, item: Item): void;
  removeItem(index: number): void;

  // -- the item pool ------------------------------------------------------
  //
  // The bench: items the build owns and is not wearing. Equipping and unequipping move an item
  // between `gear` and `itemPool` rather than creating or destroying one, so trying a sword on
  // and taking it off again is lossless — which is the entire reason to have a pool.

  /** Put a new item on the bench, unequipped. Returns nothing; the pool is appended to. */
  addPoolItem(item: Item): void;
  updatePoolItem(index: number, item: Item): void;
  removePoolItem(index: number): void;
  /**
   * Wear a benched item, sending `displace` off the character to make room for it.
   *
   * Anything the slot has no room for comes **off onto the bench** rather than being deleted:
   * swapping a ring must not silently lose the ring it replaced. Which items those are is the
   * caller's to work out, not this store's — it takes `SLOT_CAPACITY`, the item's base and the
   * snapshot to answer, and this module deliberately holds no snapshot. `GearPanel` has one.
   *
   * One edit, so equipping and the displacement it caused undo together.
   */
  equipPoolItem(index: number, displace?: readonly number[]): void;
  /** Take a worn item off, onto the bench. The inverse of {@link equipPoolItem}. */
  unequipItem(index: number): void;
  /**
   * The omen, of which a character wears one — `CURIO_BLOCKS` gives `OMEN` a count of 1.
   * `undefined` removes it.
   */
  setOmen(omen: OmenSetup | undefined): void;
  addJewel(jewel: Jewel): void;
  updateJewel(index: number, jewel: Jewel): void;
  removeJewel(index: number): void;

  // -- skills -------------------------------------------------------------
  addSkill(skill: SkillSetup): void;
  updateSkill(index: number, skill: SkillSetup): void;
  removeSkill(index: number): void;
  /**
   * Copy a skill, its support gems and their rolls, in beside the original.
   *
   * The move a socket-group list exists for: "what if this gem were that gem" is answered by
   * having both, and rebuilding five supports with their rarities and rolls by hand to ask it is
   * how people stop asking. The copy is never the main skill and is never in the rotation — a
   * duplicate that silently doubled the Full DPS figure would be worse than no button.
   */
  duplicateSkill(index: number): void;
  setMainSkill(index: number): void;

  // -- buffs and config ---------------------------------------------------
  setAuras(auras: AuraSetup[]): void;
  setFoodBuffs(buffs: FoodBuffSetup[]): void;
  /**
   * Replace the capture's effect record.
   *
   * Not wired to a control: whether an effect is *up* is `setEffect`, and this is the measurement
   * underneath it — which spell applied it and at what `str_multi`, neither of which a person can
   * usefully type. It exists for whatever loads a capture.
   */
  setExileEffects(effects: ExileEffectSetup[]): void;
  setEnemy(enemy: EnemySetup): void;
  setCondition(id: string, active: boolean | undefined): void;
  /**
   * How much health a side has left, as a percent of its maximum.
   *
   * One number rather than a switch per threshold, because the thresholds are not independent —
   * see `BuildConfig.targetHealthPercent`. `undefined` returns it to unstated, which is not the
   * same as full: unstated leaves every health condition reported as underivable.
   */
  setHealthPercent(side: "self" | "target", percent: number | undefined): void;
  setEnemyLevel(level: number | undefined): void;
  /** Tick a skill into the Full DPS rotation, or untick it. */
  setIncludeInFullDps(index: number, include: boolean): void;
  /** Fill the enemy block from a built-in target, and record which one it came from. */
  applyTargetPreset(id: TargetPresetId, snapshot: Snapshot, level: number): void;
  /** Where the enemy stands, for the projectile geometry. `undefined` restores the default. */
  setTargetPlacement(placement: TargetPlacement | undefined): void;
  /** How many enemies the pack figure counts. `undefined` or 1 means single target. */
  setPackSize(size: number | undefined): void;
  /** Force one damage source's hits per cast. `undefined` gives it back to the simulation. */
  setCoverageOverride(sourceId: string, hits: number | undefined): void;
  /**
   * Turn a skill off without losing it.
   *
   * A disabled skill keeps its level and its support gems and contributes nothing — no stats, no
   * Full DPS, and none of the exile effects it would have made available. It is how you compare
   * two setups without deleting the one you are comparing against.
   */
  setSkillEnabled(index: number, enabled: boolean): void;
  /**
   * How much of an exile effect to assume is up.
   *
   * `undefined` hands the answer back to `resolveEffectState`, which assumes anything the build
   * can produce is up at its cap. `false` turns it off, a number pins the stacks.
   */
  setEffect(id: string, setup: boolean | number | undefined): void;
  /** What an effect `config.effects` does not mention is assumed to be. */
  setAssumeEffects(assume: "available" | "captured" | undefined): void;
  /**
   * `in_combat_regen_multi` for the server this character is on.
   *
   * `undefined` restores this pack's shipped 1.0. It is a server config rather than pack data,
   * so no snapshot can answer it — which is exactly why it is a field.
   */
  setInCombatRegenMulti(multi: number | undefined): void;
};

/** Applies a change, pushing the previous document onto the undo stack. */
function edit(
  set: (partial: (state: BuildState) => Partial<BuildState>) => void,
  change: (doc: BuildDoc) => BuildDoc,
  options: { keepsCapture?: boolean } = {},
): void {
  set((state) => {
    const next = change(state.doc);
    if (next === state.doc) return {};
    return {
      doc: next,
      dirty: true,
      // The capture described the character as it was; one edit and it does not any more.
      // Comparing an edited build against a stale capture is worse than not comparing.
      //
      // `keepsCapture` is for edits that provably do not describe the character. Renaming a build
      // is the one that matters: `meta.name` reaches no stat, and discarding the capture for it
      // meant typing a name silently emptied the Capture tab.
      ...(options.keepsCapture === true ? {} : { observed: null }),
      past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
      // Any new edit abandons the redo branch, as every editor does.
      future: [],
    };
  });
}

/** Replaces one entry of an optional array, leaving the rest alone. */
function replaceAt<T>(list: readonly T[] | undefined, index: number, value: T): T[] {
  const next = [...(list ?? [])];
  if (index < 0 || index >= next.length) return next;
  next[index] = value;
  return next;
}

function removeAt<T>(list: readonly T[] | undefined, index: number): T[] {
  return (list ?? []).filter((_, i) => i !== index);
}

/**
 * Drops a key when its value is empty.
 *
 * A `BuildDoc` with `"gear": []` and one with no `gear` at all are equivalent to the engine,
 * but only the second is what a hand-authored document looks like. Since these files get
 * pasted into fixtures, keeping them minimal is worth the small effort.
 */
function prune<K extends keyof BuildDoc>(doc: BuildDoc, key: K, value: BuildDoc[K]): BuildDoc {
  const next = { ...doc };
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

function withTree(doc: BuildDoc, tree: TreeKey, coords: TreeCoord[]): BuildDoc {
  const nextTree = { ...(doc.tree ?? {}) };
  if (coords.length === 0) delete nextTree[tree];
  else nextTree[tree] = coords;
  return prune(doc, "tree", Object.keys(nextTree).length === 0 ? undefined : nextTree);
}

function withConfig(doc: BuildDoc, patch: Patch<NonNullable<BuildDoc["config"]>>): BuildDoc {
  const config = applyPatch(doc.config ?? {}, patch);
  return prune(doc, "config", Object.keys(config).length === 0 ? undefined : config);
}

/** What to call a document on screen when nothing better is to hand. */
function nameOf(doc: BuildDoc): string {
  return doc.meta?.name ?? "Unnamed build";
}

export const useBuild = create<BuildState>((set) => ({
  doc: emptyBuild(1),
  path: null,
  dirty: false,
  observed: null,
  baseline: null,
  past: [],
  future: [],

  // `baseline` is deliberately absent from both of these: see its docstring. Everything else
  // about the session resets, because everything else describes the document that is going away.
  newBuild: () =>
    set({ doc: emptyBuild(1), path: null, observed: null, dirty: false, past: [], future: [] }),

  loadBuild: (doc, path, observed) =>
    set({ doc, path, observed: observed ?? null, dirty: false, past: [], future: [] }),

  markSaved: (path) => set({ path, dirty: false }),

  pinBaseline: (name) =>
    set((state) => ({
      baseline: {
        doc: state.doc,
        name: name ?? nameOf(state.doc),
        pinnedAt: new Date().toISOString(),
      },
    })),

  setBaseline: (doc, name) => set({ baseline: { doc, name, pinnedAt: new Date().toISOString() } }),

  restoreBaseline: (baseline) => set({ baseline }),

  clearBaseline: () => set({ baseline: null }),

  swapBaseline: () =>
    set((state) => {
      if (state.baseline === null) return {};
      return {
        doc: state.baseline.doc,
        // The document arriving is not the one on disk at `path`, and it is not the character a
        // capture described. Saying so is cheaper than a wrong claim in either direction: a stale
        // `path` would let Ctrl+S overwrite a file with a different build.
        path: null,
        observed: null,
        dirty: true,
        // History is the edits that produced the document being put aside, so it does not
        // describe the one arriving. Clearing it is the honest move; the swap is its own undo.
        past: [],
        future: [],
        baseline: {
          doc: state.doc,
          name: nameOf(state.doc),
          pinnedAt: new Date().toISOString(),
        },
      };
    }),

  undo: () =>
    set((state) => {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return {};
      return {
        doc: previous,
        dirty: true,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
      };
    }),

  redo: () =>
    set((state) => {
      const next = state.future[0];
      if (next === undefined) return {};
      return {
        doc: next,
        dirty: true,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
      };
    }),

  setLevel: (level) =>
    edit(set, (doc) => ({ ...doc, character: { ...doc.character, level } })),

  setQuestsComplete: (done) =>
    edit(set, (doc) => {
      const character = { ...doc.character };
      if (done) character.questsComplete = true;
      else delete character.questsComplete;
      return { ...doc, character };
    }),

  setName: (name) =>
    edit(
      set,
      (doc) => {
        const meta = { ...(doc.meta ?? {}) };
        if (name.length === 0) delete meta.name;
        else meta.name = name;
        return prune(doc, "meta", Object.keys(meta).length === 0 ? undefined : meta);
      },
      { keepsCapture: true },
    ),

  setSchool: (school) =>
    edit(set, (doc) => {
      const character = { ...doc.character };
      if (school === undefined) delete character.school;
      else character.school = school;
      return { ...doc, character };
    }),

  setAscendancy: (ascendancy) =>
    edit(set, (doc) => {
      const character = { ...doc.character };
      if (ascendancy === undefined) delete character.ascendancy;
      else character.ascendancy = ascendancy;
      return { ...doc, character };
    }),

  setFoodDiversity: (count) =>
    edit(set, (doc) => {
      const character = { ...doc.character };
      if (count === undefined || !Number.isFinite(count) || count <= 0) delete character.foodDiversity;
      else character.foodDiversity = Math.trunc(count);
      return { ...doc, character };
    }),

  setBaseAttackSpeed: (speed) =>
    edit(set, (doc) => {
      const character = { ...doc.character };
      if (speed === undefined || !Number.isFinite(speed) || speed <= 0) {
        delete character.baseAttackSpeed;
      } else character.baseAttackSpeed = speed;
      return { ...doc, character };
    }),

  setWeaponAttackDamage: (value) =>
    edit(set, (doc) => {
      const attributes = { ...(doc.character.attributes ?? {}) };
      if (value === undefined || !Number.isFinite(value) || value <= 0) {
        delete attributes["minecraft:generic.attack_damage"];
      } else attributes["minecraft:generic.attack_damage"] = value;

      const character = { ...doc.character };
      if (Object.keys(attributes).length === 0) delete character.attributes;
      else character.attributes = attributes;
      return { ...doc, character };
    }),

  setStatPoints: (statId, points) =>
    edit(set, (doc) => {
      const statPoints = { ...(doc.character.statPoints ?? {}) };
      if (points <= 0) delete statPoints[statId];
      else statPoints[statId] = Math.round(points);

      const character = { ...doc.character };
      // An empty map is `undefined`, not `{}` — hand-authored documents say nothing rather
      // than saying nothing verbosely, and these get pasted into fixtures.
      if (Object.keys(statPoints).length === 0) delete character.statPoints;
      else character.statPoints = statPoints;
      return { ...doc, character };
    }),

  clearStatPoints: () =>
    edit(set, (doc) => {
      if (doc.character.statPoints === undefined) return doc;
      const character = { ...doc.character };
      delete character.statPoints;
      return { ...doc, character };
    }),

  setSchoolPerk: (perkId, level) =>
    edit(set, (doc) => {
      const schools = { ...(doc.character.schools ?? {}) };
      if (level <= 0) delete schools[perkId];
      else schools[perkId] = Math.round(level);

      const character = { ...doc.character };
      // Same rule as statPoints: an empty map is absent, not `{}`, because these documents get
      // pasted into fixtures and read by people.
      if (Object.keys(schools).length === 0) delete character.schools;
      else character.schools = schools;
      return { ...doc, character };
    }),

  toggleSkillFor: (spellId, on) =>
    edit(set, (doc) => {
      const skills = [...(doc.skills ?? [])];
      const at = skills.findIndex((s) => s.spellId === spellId);

      if (!on) {
        if (at === -1) return doc;
        // Support links are work; a Skill carrying them is disabled rather than dropped, so
        // re-taking the perk gets the setup back rather than an empty Skill.
        const held = skills[at]!;
        const next =
          (held.supports ?? []).length > 0
            ? skills.map((s, i) => (i === at ? { ...s, enabled: false } : s))
            : removeAt(skills, at);
        if (next.length > 0 && !next.some((s) => s.main === true)) {
          next[0] = { ...next[0]!, main: true };
        }
        return prune(doc, "skills", next);
      }

      if (at !== -1) {
        // Already there. Turn it back on if it was disabled, and respect the hotbar while
        // doing it — re-taking a perk should not silently produce a ninth active Skill.
        const held = skills[at]!;
        if (isSkillEnabled(held)) return doc;
        if (activeSkillCount(skills) >= MAX_ACTIVE_SKILLS) return doc;
        const { enabled: _drop, ...rest } = held;
        return prune(doc, "skills", replaceAt(skills, at, rest));
      }

      // A new Skill arrives enabled only if there is a slot for it. Past the eighth it is added
      // disabled rather than refused: the perk really is allocated, and a Skill that exists and
      // is off is a truer picture than one that is missing.
      const full = activeSkillCount(skills) >= MAX_ACTIVE_SKILLS;
      const added: SkillSetup = { spellId, ...(full ? { enabled: false } : {}) };
      const next = [...skills, added];
      if (!next.some((s) => s.main === true) && next[0] !== undefined) {
        next[0] = { ...next[0], main: true };
      }
      return prune(doc, "skills", next);
    }),

  clearSchools: () =>
    edit(set, (doc) => {
      if (doc.character.schools === undefined) return doc;
      const character = { ...doc.character };
      delete character.schools;
      return { ...doc, character };
    }),

  allocateNodes: (tree, keys) =>
    edit(set, (doc) => {
      const current = doc.tree?.[tree] ?? [];
      const held = new Set(current.map(([r, c]) => nodeKey(r, c)));
      const added = keys.filter((key) => !held.has(key)).map(parseNodeKey);
      if (added.length === 0) return doc;
      return withTree(doc, tree, [...current, ...added]);
    }),

  deallocateNodes: (tree, keys) =>
    edit(set, (doc) => {
      const drop = new Set(keys);
      const current = doc.tree?.[tree] ?? [];
      const next = current.filter(([r, c]) => !drop.has(nodeKey(r, c)));
      if (next.length === current.length) return doc;
      return withTree(doc, tree, next);
    }),

  clearTree: (tree) => edit(set, (doc) => withTree(doc, tree, [])),

  addItem: (item) => edit(set, (doc) => prune(doc, "gear", [...(doc.gear ?? []), item])),
  updateItem: (index, item) =>
    edit(set, (doc) => prune(doc, "gear", replaceAt(doc.gear, index, item))),
  removeItem: (index) => edit(set, (doc) => prune(doc, "gear", removeAt(doc.gear, index))),

  addPoolItem: (item) =>
    edit(set, (doc) => prune(doc, "itemPool", [...(doc.itemPool ?? []), item])),
  updatePoolItem: (index, item) =>
    edit(set, (doc) => prune(doc, "itemPool", replaceAt(doc.itemPool, index, item))),
  removePoolItem: (index) =>
    edit(set, (doc) => prune(doc, "itemPool", removeAt(doc.itemPool, index))),

  equipPoolItem: (index, displace = []) =>
    edit(set, (doc) => {
      const item = (doc.itemPool ?? [])[index];
      if (item === undefined) return doc;

      // Read the displaced items out before anything is removed: the indices are into the
      // *current* `gear`, and filtering first would renumber them under the lookup.
      const coming = new Set(displace);
      const takenOff = (doc.gear ?? []).filter((_, i) => coming.has(i));

      const gear = [...(doc.gear ?? []).filter((_, i) => !coming.has(i)), item];
      const pool = [...(doc.itemPool ?? []).filter((_, i) => i !== index), ...takenOff];
      return prune(prune(doc, "gear", gear), "itemPool", pool);
    }),

  unequipItem: (index) =>
    edit(set, (doc) => {
      const item = (doc.gear ?? [])[index];
      if (item === undefined) return doc;
      return prune(prune(doc, "gear", removeAt(doc.gear, index)), "itemPool", [
        ...(doc.itemPool ?? []),
        item,
      ]);
    }),

  setOmen: (omen) => edit(set, (doc) => prune(doc, "omen", omen)),

  addJewel: (jewel) => edit(set, (doc) => prune(doc, "jewels", [...(doc.jewels ?? []), jewel])),
  updateJewel: (index, jewel) =>
    edit(set, (doc) => prune(doc, "jewels", replaceAt(doc.jewels, index, jewel))),
  removeJewel: (index) => edit(set, (doc) => prune(doc, "jewels", removeAt(doc.jewels, index))),

  addSkill: (skill) =>
    edit(set, (doc) => {
      const skills = [...(doc.skills ?? []), skill];
      // The first skill added becomes the main one; the validator errors on two.
      if (!skills.some((s) => s.main === true) && skills[0] !== undefined) {
        skills[0] = { ...skills[0], main: true };
      }
      return prune(doc, "skills", skills);
    }),
  updateSkill: (index, skill) =>
    edit(set, (doc) => prune(doc, "skills", replaceAt(doc.skills, index, skill))),
  removeSkill: (index) =>
    edit(set, (doc) => {
      const skills = removeAt(doc.skills, index);
      if (skills.length > 0 && !skills.some((s) => s.main === true)) {
        skills[0] = { ...skills[0]!, main: true };
      }
      return prune(doc, "skills", skills);
    }),
  duplicateSkill: (index) =>
    edit(set, (doc) => {
      const skills = [...(doc.skills ?? [])];
      const source = skills[index];
      if (source === undefined) return doc;
      // The supports are copied element-wise: they are objects, and a shared reference would
      // make editing one gem's roll edit the other copy's too.
      const copy: SkillSetup = {
        ...source,
        ...(source.supports === undefined
          ? {}
          : { supports: source.supports.map((link) => (typeof link === "string" ? link : { ...link })) }),
      };
      delete copy.main;
      delete copy.includeInFullDps;
      skills.splice(index + 1, 0, copy);
      return prune(doc, "skills", skills);
    }),

  setMainSkill: (index) =>
    edit(set, (doc) =>
      prune(
        doc,
        "skills",
        (doc.skills ?? []).map((skill, i) => {
          const next = { ...skill };
          if (i === index) next.main = true;
          else delete next.main;
          return next;
        }),
      ),
    ),

  setAuras: (auras) => edit(set, (doc) => prune(doc, "auras", auras)),
  setFoodBuffs: (buffs) => edit(set, (doc) => prune(doc, "foodBuffs", buffs)),
  setExileEffects: (effects) => edit(set, (doc) => prune(doc, "exileEffects", effects)),

  setEnemy: (enemy) =>
    edit(set, (doc) =>
      withConfig(doc, { enemy: Object.keys(enemy).length === 0 ? undefined : enemy }),
    ),

  setEnemyLevel: (level) => edit(set, (doc) => withConfig(doc, { enemyLevel: level })),

  setIncludeInFullDps: (index, include) =>
    edit(set, (doc) => {
      // `exactOptionalPropertyTypes` is on, so unticking removes the key rather than writing
      // `undefined` into it — which also keeps a saved document free of dead fields.
      const skills = (doc.skills ?? []).map((skill, i) => {
        if (i !== index) return skill;
        const { includeInFullDps: _drop, ...rest } = skill;
        return include ? { ...rest, includeInFullDps: true } : rest;
      });
      return prune(doc, "skills", skills);
    }),

  applyTargetPreset: (id, snapshot, level) =>
    edit(set, (doc) =>
      // The preset fills the enemy block and then gets out of the way: the engine goes on
      // reading only `enemy`, so every row stays editable afterwards. `targetPreset` is kept
      // as a record of where the numbers came from, not as something re-derived later.
      withConfig(doc, { enemy: buildTargetEnemy(snapshot, id, level), targetPreset: id }),
    ),

  setTargetPlacement: (placement) => edit(set, (doc) => withConfig(doc, { target: placement })),

  setPackSize: (size) =>
    edit(set, (doc) => withConfig(doc, { packSize: size === undefined || size <= 1 ? undefined : size })),

  setCoverageOverride: (sourceId, hits) =>
    edit(set, (doc) => {
      const current = { ...(doc.config?.coverageOverrides ?? {}) };
      if (hits === undefined) delete current[sourceId];
      else current[sourceId] = hits;
      return withConfig(doc, {
        coverageOverrides: Object.keys(current).length === 0 ? undefined : current,
      });
    }),

  setSkillEnabled: (index, enabled) =>
    edit(set, (doc) => {
      // The hotbar holds eight (`GemInventoryHelper.MAX_SKILL_GEMS`), so enabling a ninth is
      // refused here rather than merely reported by the validator: a document the game cannot
      // load is not a state the editor should be able to reach by clicking a checkbox. Turning
      // one *off* is always allowed.
      if (enabled && activeSkillCount(doc.skills) >= MAX_ACTIVE_SKILLS) {
        const already = doc.skills?.[index];
        if (already !== undefined && !isSkillEnabled(already)) return doc;
      }
      // `exactOptionalPropertyTypes` is on, so enabling removes the key rather than writing
      // `true` into it — the default is on, and a saved document stays free of dead fields.
      const skills = (doc.skills ?? []).map((skill, i) => {
        if (i !== index) return skill;
        const { enabled: _drop, ...rest } = skill;
        return enabled ? rest : { ...rest, enabled: false };
      });
      return prune(doc, "skills", skills);
    }),

  setEffect: (id, setup) =>
    edit(set, (doc) => {
      const effects = { ...(doc.config?.effects ?? {}) };
      if (setup === undefined) delete effects[id];
      else effects[id] = setup;
      return withConfig(doc, { effects: Object.keys(effects).length === 0 ? undefined : effects });
    }),

  setAssumeEffects: (assume) => edit(set, (doc) => withConfig(doc, { assumeEffects: assume })),

  setInCombatRegenMulti: (multi) =>
    edit(set, (doc) =>
      withConfig(doc, {
        inCombatRegenMulti:
          multi === undefined || !Number.isFinite(multi) || multi < 0 ? undefined : multi,
      }),
    ),

  setCondition: (id, active) =>
    edit(set, (doc) => {
      const conditions = { ...(doc.config?.conditions ?? {}) };
      if (active === undefined) delete conditions[id];
      else conditions[id] = active;
      return withConfig(doc, {
        conditions: Object.keys(conditions).length === 0 ? undefined : conditions,
      });
    }),

  setHealthPercent: (side, percent) =>
    edit(set, (doc) =>
      withConfig(doc, {
        [side === "self" ? "selfHealthPercent" : "targetHealthPercent"]: percent,
      }),
    ),
}));

/** Whether the document is at the version this build of the app writes. */
export function isCurrentVersion(doc: BuildDoc): boolean {
  return doc.schemaVersion === BUILD_DOC_VERSION;
}

/** The store's current document, for callers outside React. */
export function currentDoc(): BuildDoc {
  return useBuild.getState().doc;
}
