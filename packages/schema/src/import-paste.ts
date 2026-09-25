/**
 * Reading whatever the player pasted, when it might not be a piece of gear.
 *
 * {@link importItem} answers one question — "what item is this?" — and it answers it for the two
 * things a player could produce before the exporter existed: a tooltip and a gear item's NBT.
 * The in-game **Ctrl+Shift+C** copies five different things, because Mine and Slash has five
 * kinds of item the planner models, and a jewel pasted into a reader that only knows gear is not
 * an error worth reporting as "unrecognised base".
 *
 * So this is the outer reader: it recognises the exporter's envelope, says which kind arrived,
 * and hands the rest to the reader that knows about it. Anything that is not an envelope falls
 * through to {@link importItem} unchanged, so a tooltip and a `/data get` dump still work exactly
 * as they did.
 *
 * ## The envelope
 *
 * ```json
 * { "cob": "item", "kind": "jewel", "exporter": "0.4.0",
 *   "name": "Viridian Jewel", "data": { … } }
 * ```
 *
 * `data` is the build document's own shape for that kind, written by the mod out of the item's
 * saved data — `AffixData` is `{id, rar, p}`, which is field for field the {@link AffixRoll} this
 * project stores — so nothing is inverted out of a displayed number and nothing can be inverted
 * wrongly. `name` is the game's own name for the item and is for the person reading the paste
 * box, never for the reader: a paste that turns out to be the wrong jewel says so up front.
 *
 * ## What is still checked
 *
 * Exactness is about the *rolls*, not about the ids. An item copied from an install running a
 * different pack version can name an affix, a rarity or a spell this snapshot has never heard
 * of, and that is exactly the kind of thing that turns into a wrong number three screens later.
 * Every id is therefore looked up, and every one that is missing is reported — as an `error`
 * when it is the item's identity, and as a `warning` when it is one modifier among several and
 * dropping it still leaves something worth planning with.
 */

import type { Snapshot } from "@cte2/extractor";

import type { AffixRoll, AuraSetup, Item, Jewel, OmenSetup, SkillSetup, SupportLink } from "./build-doc.js";
import { importItem, type ImportIssue, type ImportResult } from "./import-item.js";
import { CATEGORY, has } from "./queries.js";

/** One of the five things the game can hand the planner, already in the document's shape. */
export type ImportedThing =
  | { kind: "gear"; item: Item }
  | { kind: "jewel"; jewel: Jewel }
  | { kind: "omen"; omen: OmenSetup }
  | { kind: "skill"; skill: SkillSetup }
  | { kind: "support"; support: SupportLink }
  | { kind: "aura"; aura: AuraSetup };

export type PasteResult = {
  /** Undefined when nothing usable was read; the issues say why. */
  thing: ImportedThing | undefined;
  /** How it was read. `copied-item` is the in-game copy, which is exact. */
  format: ImportResult["format"] | "copied-item";
  /** The game's own name for the item, when the copy carried one. */
  name?: string | undefined;
  issues: ImportIssue[];
};

/** What each kind is called on screen, in the words the pack's players use. */
export const KIND_LABEL: Record<ImportedThing["kind"], string> = {
  gear: "a piece of gear",
  jewel: "a jewel",
  omen: "an omen",
  skill: "a Skill",
  support: "a support gem",
  aura: "an Augment",
};

export function importPaste(raw: string, snapshot: Snapshot): PasteResult {
  const envelope = findEnvelope(raw);
  if (envelope === undefined) {
    const result = importItem(raw, snapshot);
    return {
      thing: result.item === undefined ? undefined : { kind: "gear", item: result.item },
      format: result.format,
      issues: result.issues,
    };
  }

  const name = typeof envelope["name"] === "string" ? envelope["name"] : undefined;
  const kind = String(envelope["kind"] ?? "");
  const data = asObject(envelope["data"]);

  if (data === undefined) {
    return {
      thing: undefined,
      format: "copied-item",
      name,
      issues: [issue("error", "copy-empty", "This copy carries no item data. Copy it again in game.")],
    };
  }

  switch (kind) {
    // Gear goes through the reader it already had. The mod writes the document shape, which is
    // what `importItem` calls `document` — so an in-game copy and an item copied out of another
    // build are checked by the same code, and there is only one place that can be wrong.
    case "gear": {
      const result = importItem(JSON.stringify(data), snapshot);
      return {
        thing: result.item === undefined ? undefined : { kind: "gear", item: result.item },
        format: "copied-item",
        name,
        issues: result.issues,
      };
    }
    case "jewel":
      return finish(readJewel(data, snapshot), name);
    case "omen":
      return finish(readOmen(data, snapshot), name);
    case "skill":
      return finish(readSkill(data, snapshot), name);
    case "support":
      return finish(readSupport(data, snapshot), name);
    case "aura":
      return finish(readAura(data, snapshot), name);
    default:
      return {
        thing: undefined,
        format: "copied-item",
        name,
        issues: [
          issue(
            "error",
            "copy-unknown-kind",
            `This copy says it is a "${kind}", which this version of the planner does not know. ` +
              `The exporter mod is probably newer than the planner.`,
          ),
        ],
      };
  }
}

type Read = { thing: ImportedThing | undefined; issues: ImportIssue[] };

function finish(read: Read, name: string | undefined): PasteResult {
  return { thing: read.thing, format: "copied-item", name, issues: read.issues };
}

// ---------------------------------------------------------------------------
// One reader per kind
// ---------------------------------------------------------------------------

function readJewel(node: Record<string, unknown>, snapshot: Snapshot): Read {
  const issues: ImportIssue[] = [];

  const rarity = asString(node["rarity"]) ?? "";
  if (!has(snapshot, CATEGORY.gearRarity, rarity)) {
    issues.push(
      issue("error", "jewel-rarity", `No such gear rarity in this snapshot: \`${rarity}\`.`),
    );
    return { thing: undefined, issues };
  }

  const jewel: Jewel = { rarity, itemLevel: asNumber(node["itemLevel"]) ?? 1 };

  // `style` decides both what the jewel is called and which affixes could have rolled on it, so
  // a missing one is not cosmetic: it silently turns any jewel into a `str` one.
  const style = asString(node["style"]);
  if (style !== undefined && style.length > 0) jewel.style = style;
  else issues.push(issue("warning", "jewel-style", "This copy carries no jewel style, so it reads back as a Meteorite (str) jewel."));

  const affixes = affixList(node["affixes"], snapshot, issues, "jewel");
  if (affixes.length > 0) jewel.affixes = affixes;
  const corruptions = affixList(node["corruptions"], snapshot, issues, "jewel corruption");
  if (corruptions.length > 0) jewel.corruptions = corruptions;

  const unique = asObject(node["unique"]);
  if (unique !== undefined) {
    const id = asString(unique["id"]) ?? "";
    if (has(snapshot, CATEGORY.unique, id)) {
      jewel.unique = {
        id,
        rollPercent: asNumber(unique["rollPercent"]) ?? 0,
        ...(asNumber(unique["tier"]) === undefined ? {} : { tier: asNumber(unique["tier"])! }),
      };
    } else {
      issues.push(
        issue("warning", "jewel-unique", `This jewel is a crafted unique \`${id}\`, which this snapshot does not have. Its unique stats are dropped.`),
      );
    }
  }

  const auraStats = asArray(node["auraStats"])
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      affixId: asString(entry["affixId"]) ?? "",
      rollPercent: asNumber(entry["rollPercent"]) ?? 0,
      itemLevel: asNumber(entry["itemLevel"]) ?? jewel.itemLevel,
    }))
    .filter((entry) => entry.affixId.length > 0);
  if (auraStats.length > 0) {
    jewel.auraStats = auraStats;
    issues.push(
      issue(
        "info",
        "jewel-aura-stats",
        `${auraStats.length} of this jewel's stats apply only while the aura they name is running.`,
      ),
    );
  }

  issues.push(issue("info", "read-from-copy", "Read from an in-game copy. Every roll is exact."));
  return { thing: { kind: "jewel", jewel }, issues };
}

function readOmen(node: Record<string, unknown>, snapshot: Snapshot): Read {
  const issues: ImportIssue[] = [];
  const id = asString(node["id"]) ?? "";
  if (!has(snapshot, CATEGORY.omen, id)) {
    issues.push(issue("error", "omen-id", `No such omen in this snapshot: \`${id}\`.`));
    return { thing: undefined, issues };
  }

  const omen: OmenSetup = {
    id,
    itemLevel: asNumber(node["itemLevel"]) ?? 1,
    rarity: asString(node["rarity"]) ?? "",
  };

  const requires = asObject(node["requires"]);
  if (requires !== undefined) {
    const out: Record<string, number> = {};
    for (const [type, count] of Object.entries(requires)) {
      const n = asNumber(count);
      if (n !== undefined) out[type] = n;
    }
    if (Object.keys(out).length > 0) omen.requires = out;
  }

  const slotReqs = asArray(node["slotRequirements"])
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      slot: asString(entry["slot"]) ?? "",
      rarityType: asString(entry["rarityType"]) ?? "",
    }))
    .filter((entry) => entry.slot.length > 0 && entry.rarityType.length > 0);
  if (slotReqs.length > 0) omen.slotRequirements = slotReqs;

  const affixes = affixList(node["affixes"], snapshot, issues, "omen");
  if (affixes.length > 0) omen.affixes = affixes;

  issues.push(issue("info", "read-from-copy", "Read from an in-game copy. Every roll is exact."));
  return { thing: { kind: "omen", omen }, issues };
}

function readSkill(node: Record<string, unknown>, snapshot: Snapshot): Read {
  const issues: ImportIssue[] = [];
  const spellId = asString(node["spellId"]) ?? "";
  if (!has(snapshot, CATEGORY.spell, spellId)) {
    issues.push(issue("error", "skill-id", `No such spell in this snapshot: \`${spellId}\`.`));
    return { thing: undefined, issues };
  }

  const skill: SkillSetup = { spellId };
  const level = asNumber(node["level"]);
  if (level !== undefined && level > 0) skill.level = Math.round(level);
  const gemPercent = asNumber(node["gemPercent"]);
  if (gemPercent !== undefined) skill.gemPercent = gemPercent;

  // The rank a Skill is cast at comes off the class allocation, not off the gem: `learn_<spell>`
  // is the stat `calcSpellLevels` reads. So a copied gem's own level is a starting point, and
  // says so, rather than looking like the answer.
  issues.push(
    issue(
      "info",
      "skill-rank-from-classes",
      "A Skill's rank comes from your class points, not the gem. This is the gem's own level.",
    ),
  );
  return { thing: { kind: "skill", skill }, issues };
}

function readSupport(node: Record<string, unknown>, snapshot: Snapshot): Read {
  const issues: ImportIssue[] = [];
  const id = asString(node["id"]) ?? "";
  if (!has(snapshot, CATEGORY.supportGem, id)) {
    issues.push(issue("error", "support-id", `No such support gem in this snapshot: \`${id}\`.`));
    return { thing: undefined, issues };
  }

  const support: SupportLink = { id };
  const rollPercent = asNumber(node["rollPercent"]);
  if (rollPercent !== undefined) support.rollPercent = rollPercent;
  const rarity = asString(node["rarity"]);
  if (rarity !== undefined && rarity.length > 0) support.rarity = rarity;

  issues.push(issue("info", "read-from-copy", "Read from an in-game copy. This is the gem's own roll, not the Skill's."));
  return { thing: { kind: "support", support }, issues };
}

function readAura(node: Record<string, unknown>, snapshot: Snapshot): Read {
  const issues: ImportIssue[] = [];
  const id = asString(node["id"]) ?? "";
  if (!has(snapshot, CATEGORY.aura, id)) {
    issues.push(issue("error", "aura-id", `No such Augment in this snapshot: \`${id}\`.`));
    return { thing: undefined, issues };
  }

  const aura: AuraSetup = { id, enabled: true };
  const rollPercent = asNumber(node["rollPercent"]);
  if (rollPercent !== undefined) aura.rollPercent = rollPercent;
  const rarity = asString(node["rarity"]);
  if (rarity !== undefined && rarity.length > 0) aura.rarity = rarity;

  issues.push(issue("info", "read-from-copy", "Read from an in-game copy. Every roll is exact."));
  return { thing: { kind: "aura", aura }, issues };
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/**
 * One affix list, with every id checked.
 *
 * A missing affix is a warning rather than an error on purpose: it is one modifier of several,
 * and a jewel that is three quarters right is still worth planning with as long as the quarter
 * that went missing is named rather than silently absent.
 */
function affixList(
  raw: unknown,
  snapshot: Snapshot,
  issues: ImportIssue[],
  what: string,
): AffixRoll[] {
  const out: AffixRoll[] = [];
  for (const entry of asArray(raw)) {
    const node = asObject(entry);
    if (node === undefined) continue;
    const affixId = asString(node["affixId"]) ?? "";
    if (affixId.length === 0) continue;
    if (!has(snapshot, CATEGORY.affix, affixId)) {
      issues.push(
        issue("warning", "affix-missing", `This snapshot has no ${what} affix \`${affixId}\`, so it is dropped.`),
      );
      continue;
    }
    const roll: AffixRoll = { affixId, rollPercent: asNumber(node["rollPercent"]) ?? 0 };
    const tier = asString(node["tier"]);
    if (tier !== undefined && tier.length > 0) roll.tier = tier;
    out.push(roll);
  }
  return out;
}

/**
 * The envelope, found the same way the NBT reader finds the gear JSON: by scanning for a
 * brace-balanced object rather than by trusting the paste to be nothing but JSON.
 *
 * People paste with a stray line above or below it more often than you would think, and a reader
 * that fails on that sends them back to the game to copy the same item again.
 */
function findEnvelope(input: string): Record<string, unknown> | undefined {
  const at = input.indexOf("{");
  if (at < 0) return undefined;
  const direct = tryParse(input.slice(at, input.lastIndexOf("}") + 1));
  if (direct === undefined) return undefined;
  // "cte2pob" is what exporters before the rename to Craft of Building wrote.
  return direct["cob"] === "item" || direct["cte2pob"] === "item" ? direct : undefined;
}

function tryParse(slice: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(slice);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function issue(
  severity: ImportIssue["severity"],
  code: string,
  message: string,
): ImportIssue {
  return { severity, code, message };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
