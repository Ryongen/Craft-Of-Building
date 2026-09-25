/**
 * Reading an item back out of the game.
 *
 * Hand-entering a level 94 amulet — base, rarity, four affixes, each one's own tier and roll
 * percent — is ten minutes of fiddly work per item, and the whole value of a hand-authored
 * character is that it be *recreatable*. Anything mistyped here is a mismatch the engine gets
 * blamed for later. So this parses what the game already prints.
 *
 * Three input formats are accepted, and which one you pasted is detected rather than asked:
 *
 *  - **This app's own item JSON**, which is what `Copy item` puts on the clipboard. Exact by
 *    construction — it is the document shape — so the reader's whole job is checking that the ids
 *    in it exist in the loaded snapshot. It is how an item moves between two builds, and how
 *    duplicating one works.
 *  - **The item's NBT**, from `/data get entity @s SelectedItem`. Exact, no inference at all.
 *    `LoadSave.Save` is `gson.toJson(object)` stored as a plain string under the item's
 *    `mmorpg_gear` tag, so the affix list arrives as `{ id, rar, p }` per affix — which is
 *    field-for-field the {@link AffixRoll} this project already stores. Prefer this.
 *  - **The tooltip text**, which is what a player can actually see. Invertible, but only
 *    approximately, and only in the in-depth view — see below.
 *
 * ## The tooltip is only invertible with Shift held
 *
 * `GearTooltipUtils.BuildTooltip` branches on `showMerge = !tinfo.useInDepthStats()`, and
 * `StatRangeInfo.useInDepthStats()` is `!hasAltDown && hasShiftDown`. Without Shift the stats
 * are *merged* — every affix, implicit and unique stat summed into one flat list, sorted by
 * element and damage priority, with no section headers, no ranges and no tiers. Two +11
 * Dexterity affixes become one +22 line, and no amount of cleverness recovers which two
 * affixes made it.
 *
 * With Shift you get what the screenshots show: sections in the order
 * `impComps, uniComps, prefixComps, suffixComps, corComps`, and every line suffixed by
 * `NormalStatTooltip.getPercentageView`:
 *
 *     var v1 = mod.ToExactStat(max.minmax.min, lvl).getValue();
 *     var v2 = mod.ToExactStat(max.minmax.max, lvl).getValue();
 *     var text = Component.literal(" [").append(v1 + " - " + v2).append("]");
 *     if (rar != null) { text.append(" [" + rarityShort(rar) + "]"); }
 *
 * so a line reads `+3.2% Attack Hits Health Leech [3.1 - 3.7] [Epic]`. That bracket pair is
 * the affix's **own tier band** evaluated at the item's level, and the trailing name is that
 * tier — not the item's rarity. Which is exactly the two things {@link AffixRoll} needs.
 *
 * ## Why the roll percent comes out level-free
 *
 * `ToExactStat` interpolates `min + (max - min) * percent / 100` and then multiplies by the
 * level curve, and `Stat.scale` leaves PERCENT and MORE untouched. Either way the displayed
 * value is **linear in the roll percent**, so the level multiplier cancels in
 *
 *     roll = bandMin + (value - rangeMin) / (rangeMax - rangeMin) * (bandMax - bandMin)
 *
 * and the item level, the stat's scaling class and the balance curves are all unnecessary.
 * That matters: it means an import cannot go wrong by disagreeing with our port of the
 * scaling tables.
 *
 * ## What it cannot do exactly, and says so
 *
 * `NumberUtils.formatForTooltip` prints one decimal below the client's
 * `SHOW_DECIMALS_ON_NUMBER_SMALLER_THAN` threshold and **truncates to an int** above it:
 *
 *     if (Math.abs(num) < threshold) { return format.format(num); }
 *     else { return (int) num + ""; }
 *
 * `[90 - 109]` therefore means the real endpoints are somewhere in `[90, 91)` and `[109, 110)`.
 * Rather than pretend, {@link rollFromDisplay} propagates those bounds through the same
 * arithmetic and returns the feasible *interval*; the importer takes its midpoint and attaches
 * a diagnostic naming the uncertainty whenever it is wider than a percentage point. A roll this
 * cannot pin down is a warning, never a silently confident number.
 */

import type { Snapshot } from "@cte2/extractor";

import type { AffixRoll, Item } from "./build-doc.js";
import {
  LANG_KEY,
  humanise,
  stripFormatting,
  stripGlossaryMarkup,
  text,
} from "./display.js";
import {
  CATEGORY,
  affixesFor,
  baseGearType,
  gearRarity,
  has,
  ids,
  unique,
  uniqueRarityId,
  type AffixType,
  type AffixView,
  type BaseGearTypeView,
  type GearRarityView,
  type MinMax,
} from "./queries.js";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type ImportSeverity = "error" | "warning" | "info";

export type ImportIssue = {
  severity: ImportSeverity;
  /** Stable, greppable identifier for the rule that fired. */
  code: string;
  message: string;
  /** The tooltip line this came from, when it came from one. */
  line?: string;
};

export type ImportResult = {
  /**
   * The item, when enough was recognised to build one. An item is returned even with warnings
   * outstanding — a mostly-right item the player can correct beats no item — but never with an
   * `error`, because an item built from an unidentified base is not a correction, it is a
   * different item.
   */
  item: Item | undefined;
  /**
   * Which reader ran.
   *
   * `"document"` and `"nbt"` are exact; `"tooltip"` carries the caveats above.
   */
  format: "document" | "nbt" | "tooltip" | "unknown";
  issues: ImportIssue[];
};

/** Whether anything in the list would stop the item being trusted. */
export function importFailed(issues: readonly ImportIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a pasted item, whichever of the three forms it is in.
 *
 * Detection is on content rather than on a flag the caller has to get right, and the three
 * shapes cannot be confused: this app's item JSON is keyed `base`/`rarity`/`itemLevel`, the gear
 * NBT is keyed `gtype`/`rar`, and nothing in a tooltip is JSON at all.
 */
export function importItem(raw: string, snapshot: Snapshot): ImportResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { item: undefined, format: "unknown", issues: [issue("error", "empty-input", "Nothing to import.")] };
  }

  // Checked first, and on the whole input rather than by scanning for a brace: a document item is
  // pasted whole, and trying the gear scan first would make an item whose *affix id* happened to
  // contain a gear-shaped substring the wrong kind of thing.
  const document = tryParse(trimmed);
  if (document !== undefined && isDocumentShape(document)) return importFromDocument(document, snapshot);

  const gearJson = findGearJson(trimmed);
  if (gearJson !== undefined) return importFromNbt(gearJson, snapshot);

  return importFromTooltip(trimmed, snapshot);
}

function issue(severity: ImportSeverity, code: string, message: string, line?: string): ImportIssue {
  return line === undefined ? { severity, code, message } : { severity, code, message, line };
}

// ---------------------------------------------------------------------------
// The document reader
// ---------------------------------------------------------------------------

/**
 * Whether this is one of *our* items rather than the game's gear NBT.
 *
 * The two JSON shapes share no field names at all — `base`/`rarity`/`itemLevel` against
 * `gtype`/`rar`/`lvl` — so the test is exact rather than a guess between two similar things.
 */
function isDocumentShape(node: Record<string, unknown>): boolean {
  return (
    typeof node["base"] === "string" &&
    typeof node["rarity"] === "string" &&
    typeof node["itemLevel"] === "number"
  );
}

/**
 * Read an item this app wrote.
 *
 * Nothing is inferred — the shape *is* the document shape, so there is no parse in the sense the
 * other two readers mean it. What there is instead is a **check**, and it is the reason this goes
 * through the importer at all rather than being a `JSON.parse` in the dialog:
 *
 *  - The ids in a copied item came from whatever snapshot was loaded when it was copied. Paste an
 *    item saved against Mine and Slash 6.4.13 into a session running 1.20.1-6.4.13 and the base
 *    may be gone, an affix may have been renamed, a tier may no longer exist. Every one of those
 *    is reported here rather than discovered later as a wrong number.
 *  - The input is arbitrary text a person pasted. The item is rebuilt field by field rather than
 *    cast, so nothing that is not part of {@link Item} reaches the document — an importer is a
 *    trust boundary, and `parsed as Item` is not one.
 *
 * Unknown *ids* are warnings and the item still lands, which is this module's standing posture:
 * a mostly-right item you can see and correct beats no item and a paragraph about why. An unknown
 * **base** is the one exception, exactly as in the NBT reader — an item on a base that does not
 * exist has no slot, no tags and no base stats, so it is not a correctable item, it is nothing.
 */
function importFromDocument(node: Record<string, unknown>, snapshot: Snapshot): ImportResult {
  const issues: ImportIssue[] = [];
  const base = String(node["base"]);
  const rarity = String(node["rarity"]);

  if (baseGearType(snapshot, base) === undefined) {
    issues.push(
      issue("error", "unknown-base", `This item is on base "${base}", which is not in this snapshot.`),
    );
    return { item: undefined, format: "document", issues };
  }
  if (gearRarity(snapshot, rarity) === undefined) {
    issues.push(
      issue(
        "warning",
        "unknown-rarity",
        `Rarity "${rarity}" is not in this snapshot. Affix counts and roll bands cannot be checked ` +
          `against it. Pick a rarity in the editor.`,
      ),
    );
  }

  const item: Item = { base, rarity, itemLevel: Math.max(1, Math.round(Number(node["itemLevel"]))) };

  const checkId = (category: string, id: string, what: string): void => {
    if (has(snapshot, category, id)) return;
    issues.push(issue("warning", "unknown-id", `${what} "${id}" is not in this snapshot.`));
  };

  const rolls = (raw: unknown, what: string): AffixRoll[] =>
    asArray(raw)
      .map((entry) => asObject(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map((entry) => {
        const affixId = asString(entry["affixId"]);
        if (affixId === undefined) return undefined;
        checkId(CATEGORY.affix, affixId, `${what} affix`);
        const tier = asString(entry["tier"]);
        if (tier !== undefined) checkId(CATEGORY.gearRarity, tier, `${what} tier`);
        return {
          affixId,
          ...(tier === undefined ? {} : { tier }),
          rollPercent: percent(entry["rollPercent"]),
        };
      })
      .filter((roll): roll is AffixRoll => roll !== undefined);

  const percents = (raw: unknown): number[] => asArray(raw).map((v) => percent(v));

  const list = (raw: unknown, category: string, what: string): string[] => {
    const out = asArray(raw)
      .map((v) => asString(v))
      .filter((v): v is string => v !== undefined);
    for (const id of out) checkId(category, id, what);
    return out;
  };

  const baseRolls = percents(node["baseRolls"]);
  if (baseRolls.length > 0) item.baseRolls = baseRolls;

  for (const [key, what] of [
    ["implicits", "Implicit"],
    ["prefixes", "Prefix"],
    ["suffixes", "Suffix"],
    ["corruptions", "Corruption"],
  ] as const) {
    const parsed = rolls(node[key], what);
    if (parsed.length > 0) item[key] = parsed;
  }

  const enchantNode = asObject(node["enchant"]);
  if (enchantNode !== undefined) {
    const one = rolls([enchantNode], "Enchant")[0];
    if (one !== undefined) item.enchant = one;
  }

  const uniqueId = asString(node["unique"]);
  if (uniqueId !== undefined) {
    checkId(CATEGORY.unique, uniqueId, "Unique");
    item.unique = uniqueId;
    const uniqueRolls = percents(node["uniqueRolls"]);
    if (uniqueRolls.length > 0) item.uniqueRolls = uniqueRolls;
  }

  const sockets = list(node["sockets"], CATEGORY.gem, "Socketed gem");
  if (sockets.length > 0) item.sockets = sockets;

  const runes = list(node["runes"], CATEGORY.rune, "Rune");
  if (runes.length > 0) {
    item.runes = runes;
    const runeRolls = percents(node["runeRolls"]);
    if (runeRolls.length > 0) item.runeRolls = runeRolls;
  }

  const runeword = asString(node["runeword"]);
  if (runeword !== undefined) {
    checkId(CATEGORY.runeword, runeword, "Runeword");
    item.runeword = runeword;
    if (typeof node["runewordRoll"] === "number") item.runewordRoll = percent(node["runewordRoll"]);
  }

  if (typeof node["quality"] === "number") item.quality = Math.max(0, Math.round(node["quality"]));

  const enchantments = asObject(node["enchantments"]);
  if (enchantments !== undefined) {
    const kept: Record<string, number> = {};
    for (const [id, level] of Object.entries(enchantments)) {
      if (typeof level === "number" && level > 0) kept[id] = Math.round(level);
    }
    if (Object.keys(kept).length > 0) item.enchantments = kept;
  }

  issues.push(
    issue(
      "info",
      "read-from-document",
      issues.length === 0
        ? "Read from this app's item JSON. Exact, and every id was found in the snapshot."
        : "Read from this app's own item JSON. The rolls are exact; the ids noted above are not in " +
          "the loaded snapshot.",
    ),
  );
  return { item, format: "document", issues };
}

/** A roll percent, coerced to the 0-100 integer the document stores. */
function percent(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

// ---------------------------------------------------------------------------
// The NBT reader
// ---------------------------------------------------------------------------

/**
 * Pull the `mmorpg_gear` payload out of whatever the player pasted.
 *
 * `/data get` prints SNBT, which is close to but not JSON — unquoted keys, `1b` byte suffixes,
 * single-quoted strings. Rather than write an SNBT parser for one field, this scans for the
 * embedded gear JSON directly: `LoadSave` stores it as a string produced by `gson.toJson`, so
 * it is real JSON, brace-balanced, and identifiable by the three fields every `GearItemData`
 * has. A pasted `{ "rar": ..., "lvl": ..., "gtype": ... }` on its own is found by the same scan.
 */
function findGearJson(input: string): Record<string, unknown> | undefined {
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== "{") continue;
    const end = matchBrace(input, i);
    if (end === undefined) continue;

    // SNBT escapes the embedded JSON's quotes when it prints it inside a string. Try both.
    const slice = input.slice(i, end + 1);
    const parsed = tryParse(slice) ?? tryParse(slice.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    if (parsed !== undefined && isGearShape(parsed)) return parsed;
  }
  return undefined;
}

function matchBrace(input: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = start; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
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

/** `GearItemData`'s three always-present scalars. */
function isGearShape(node: Record<string, unknown>): boolean {
  return typeof node["gtype"] === "string" && typeof node["rar"] === "string";
}

function importFromNbt(gear: Record<string, unknown>, snapshot: Snapshot): ImportResult {
  const issues: ImportIssue[] = [];
  const base = String(gear["gtype"] ?? "");
  const rarity = String(gear["rar"] ?? "");
  const itemLevel = typeof gear["lvl"] === "number" ? Math.round(gear["lvl"]) : 1;

  const baseView = baseGearType(snapshot, base);
  if (baseView === undefined) {
    issues.push(issue("error", "unknown-base", `The NBT names base "${base}", which is not in this snapshot.`));
    return { item: undefined, format: "nbt", issues };
  }

  const item: Item = { base, rarity, itemLevel };

  // `BaseStatsData.p` is a single Integer covering the whole block — the game rolls one
  // percent for every base stat on an item, not one each. The document's `baseRolls` is a
  // per-entry array because it is the more expressive shape, so fill it uniformly.
  const basePercent = readPercent(gear["baseStats"]);
  if (basePercent !== undefined && baseView.baseStats.length > 0) {
    item.baseRolls = baseView.baseStats.map(() => basePercent);
  }

  // `ImplicitStatsData` holds one affix id (`imp`) and one percent — an item has at most one
  // implicit, though the document models a list.
  const impNode = asObject(gear["imp"]);
  if (impNode !== undefined) {
    const impId = asString(impNode["imp"]);
    if (impId !== undefined) {
      item.implicits = [
        { affixId: impId, tier: rarityOfAffixNode(impNode, rarity), rollPercent: readPercent(impNode) ?? 0 },
      ];
    }
  }

  const affixes = asObject(gear["affixes"]);
  if (affixes !== undefined) {
    const pre = readAffixList(affixes["pre"], rarity);
    const suf = readAffixList(affixes["suf"], rarity);
    const cor = readAffixList(affixes["cor"], rarity);
    if (pre.length > 0) item.prefixes = pre;
    if (suf.length > 0) item.suffixes = suf;
    if (cor.length > 0) item.corruptions = cor;
  }

  const uniqueNode = asObject(gear["uniqueStats"]);
  if (uniqueNode !== undefined) {
    const percents = asArray(uniqueNode["perc"]).filter((v): v is number => typeof v === "number");
    // The NBT records the unique's rolls but not its id — `UniqueStatsData` keys off the item
    // stack, not the gear data. Exactly one unique can sit on this base with this many stats
    // more often than not, so try; where it is genuinely ambiguous, say so rather than pick.
    const candidates = ids(snapshot, CATEGORY.unique)
      .map((id) => unique(snapshot, id))
      .filter((u) => u !== undefined && u.baseGear === base && u.uniqueStats.length === percents.length);
    if (candidates.length === 1) {
      item.unique = candidates[0]!.id;
      item.uniqueRolls = percents;
    } else if (percents.length > 0) {
      issues.push(
        issue(
          "warning",
          "unique-not-identified",
          candidates.length === 0
            ? `The item carries ${percents.length} unique stat roll(s) but no unique on base "${base}" has that many. Pick the unique by hand.`
            : `${candidates.length} uniques on base "${base}" have ${percents.length} stats; the NBT does not name which. Pick it by hand.`,
        ),
      );
    }
  }

  readSockets(snapshot, gear["sockets"], item);

  issues.push(
    issue("info", "read-from-nbt", "Read from item NBT. Every roll is exact."),
  );
  return { item, format: "nbt", issues };
}

function readAffixList(node: unknown, itemRarity: string): AffixRoll[] {
  return asArray(node)
    .map((raw) => asObject(raw))
    .filter((o): o is Record<string, unknown> => o !== undefined)
    .map((o) => {
      const affixId = asString(o["id"]);
      if (affixId === undefined) return undefined;
      return {
        affixId,
        tier: rarityOfAffixNode(o, itemRarity),
        rollPercent: readPercent(o) ?? 0,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
}

/** `AffixData.rar` defaults to `common` in the Java, and gson omits nothing it was given. */
function rarityOfAffixNode(node: Record<string, unknown>, fallback: string): string {
  return asString(node["rar"]) ?? fallback;
}

/** `p` is the roll percent on every part that has one; `-1` is the unrolled sentinel. */
function readPercent(node: unknown): number | undefined {
  const obj = asObject(node);
  if (obj === undefined) return undefined;
  const p = obj["p"];
  if (typeof p !== "number" || p < 0) return undefined;
  return Math.round(p);
}

/**
 * Socketed gems, runes and the runeword.
 *
 * `GearSocketsData` is four abbreviated fields — the class comments them, which is the only
 * reason they are readable:
 *
 *     private List<SocketData> so;  // socketed gems
 *     private int sl;               // socket count
 *     private String rw = "";       // runeword
 *     private int rp = 0;           // runeword perc
 *
 * and `SocketData` is `String g` (commented "gem id") plus `int p`. The wrinkle is that `g`
 * holds **either** a gem or a rune: `SocketData.isGem()` and `isRune()` distinguish them by
 * asking the two registries, not by a field. So does this — which also means an id in neither
 * registry is reported rather than filed under whichever list was guessed.
 *
 * `p` is dropped on purpose. The build document has no field for where a gem or rune rolled
 * (`SupportLink.rollPercent` closed that gap for support gems only), so these compute at 0%
 * with a diagnostic, and inventing a home for the number here would put it somewhere the
 * engine does not read.
 */
function readSockets(snapshot: Snapshot, node: unknown, item: Item): void {
  const obj = asObject(node);
  if (obj === undefined) return;

  const gems: string[] = [];
  const runes: string[] = [];

  for (const entry of asArray(obj["so"])) {
    const socket = asObject(entry);
    const id = socket === undefined ? undefined : asString(socket["g"]);
    if (id === undefined) continue;
    // `isEmpty()` is "in neither registry", which is how an empty socket is stored.
    if (has(snapshot, CATEGORY.gem, id)) gems.push(id);
    else if (has(snapshot, CATEGORY.rune, id)) runes.push(id);
  }

  if (gems.length > 0) item.sockets = gems;
  if (runes.length > 0) item.runes = runes;

  const runeword = asString(obj["rw"]);
  if (runeword !== undefined && has(snapshot, CATEGORY.runeword, runeword)) {
    item.runeword = runeword;
  }
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
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// The tooltip reader
// ---------------------------------------------------------------------------

/** Section headers, in the order `GearTooltipUtils` emits them. */
type Section = "base" | "implicit" | "unique" | "prefix" | "suffix" | "corruption";

const SECTION_LANG: Readonly<Record<Exclude<Section, "base" | "unique">, string>> = {
  implicit: "mmorpg.word.implicit_stats",
  prefix: "mmorpg.item_tips.prefix_stats",
  suffix: "mmorpg.item_tips.suffix_stats",
  corruption: "mmorpg.item_tips.cor_stats",
};

/** Which affix `type` each section's entries carry. */
const SECTION_AFFIX_TYPE: Readonly<Record<Section, AffixType | undefined>> = {
  base: undefined,
  unique: undefined,
  implicit: "implicit",
  prefix: "prefix",
  suffix: "suffix",
  corruption: "chaos_stat",
};

type StatLine = {
  raw: string;
  value: number;
  /** The name text with the leading number and any MORE/increased word removed. */
  name: string;
  /** Present only in the in-depth (Shift) view. */
  range?: MinMax;
  /** The affix's own tier, from the trailing `[Epic]`. */
  tierId?: string;
};

function importFromTooltip(raw: string, snapshot: Snapshot): ImportResult {
  const issues: ImportIssue[] = [];
  const lines = raw
    .split(/\r?\n/)
    .map((line) => stripFormatting(stripGlossaryMarkup(line)).trim())
    .filter((line) => line.length > 0);

  const itemLevel = readLevelRequirement(snapshot, lines);
  const rarityId = readItemRarity(snapshot, lines);
  const slotId = readItemType(snapshot, lines);
  const tagNames = readTags(lines);

  const base = resolveBase(snapshot, slotId, tagNames, issues);
  if (base === undefined) {
    return { item: undefined, format: "tooltip", issues };
  }

  if (rarityId === undefined) {
    issues.push(
      issue(
        "warning",
        "rarity-not-found",
        "No `<Rarity> Item` line found; defaulting to the rarity implied by the affix count.",
      ),
    );
  }
  if (itemLevel === undefined) {
    issues.push(
      issue("warning", "level-not-found", "No `Player Level Min:` line found; the item level is a guess."),
    );
  }

  const sections = splitSections(snapshot, lines);
  const sawRanges = [...sections.values()].flat().some((l) => l.range !== undefined);
  if (!sawRanges) {
    issues.push(
      issue(
        "error",
        "not-in-depth-tooltip",
        "This is the merged tooltip: no `[min - max]` ranges and no tier names, so the affixes " +
          "behind each line cannot be recovered. Hold Shift over the item in game and copy it " +
          "again. The game only separates prefixes from suffixes in the Shift view.",
      ),
    );
    return { item: undefined, format: "tooltip", issues };
  }

  const item: Item = {
    base: base.id,
    rarity: rarityId ?? "rare",
    itemLevel: itemLevel ?? 1,
  };

  for (const [section, statLines] of sections) {
    const affixType = SECTION_AFFIX_TYPE[section];
    if (affixType === undefined) continue;

    const rolls = matchAffixes(snapshot, base, affixType, statLines, issues);
    if (rolls.length === 0) continue;
    if (section === "implicit") item.implicits = rolls;
    else if (section === "prefix") item.prefixes = rolls;
    else if (section === "suffix") item.suffixes = rolls;
    else if (section === "corruption") item.corruptions = rolls;
  }

  const socketCount = lines.filter((line) => isEmptySocketLine(snapshot, line)).length;
  if (socketCount > 0) {
    issues.push(
      issue(
        "info",
        "empty-sockets",
        `${socketCount} empty socket(s) noted; filled sockets name a gem the tooltip renders as its own stats, so gems are not imported.`,
      ),
    );
  }

  issues.push(
    issue(
      "info",
      "read-from-tooltip",
      "Read from tooltip text. Rolls are derived from the printed ranges and are only as precise " +
        "as the game's own rounding. Check anything flagged below.",
    ),
  );

  return { item, format: "tooltip", issues };
}

// ---------------------------------------------------------------------------
// Tooltip line readers
// ---------------------------------------------------------------------------

/**
 * `Player Level Min: 94` is the **item's level**, not a separate requirement.
 *
 * `GearTooltipUtils` builds the block with `.setLevelRequirement(gear.getLevel())`, and
 * `GearItemData.getLevel()` returns `lvl` — the field everything on the item scales at.
 */
function readLevelRequirement(snapshot: Snapshot, lines: readonly string[]): number | undefined {
  return readTemplated(snapshot, lines, "mmorpg.item_tips.level_req", (captured) => {
    const n = Number(captured.replace(/[^\d-]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  });
}

/** `Epic Item` — `mmorpg.item_tips.rarity_line` is `"%1$s Item"`. */
function readItemRarity(snapshot: Snapshot, lines: readonly string[]): string | undefined {
  const byName = rarityNameIndex(snapshot);
  return readTemplated(snapshot, lines, "mmorpg.item_tips.rarity_line", (captured) =>
    byName.get(normalise(captured)),
  );
}

/** `Item Type: Necklace` — the gear *slot*'s display name, not the base's. */
function readItemType(snapshot: Snapshot, lines: readonly string[]): string | undefined {
  const bySlotName = new Map<string, string>();
  for (const id of ids(snapshot, CATEGORY.gearSlot)) {
    bySlotName.set(normalise(text(snapshot, LANG_KEY.gearSlot(id)) ?? humanise(id)), id);
  }
  return readTemplated(snapshot, lines, "mmorpg.item_tips.item_type", (captured) =>
    bySlotName.get(normalise(captured)),
  );
}

/** `Tags: Jewelry Family, Necklace` — `mmorpg.word.tags` is a bare prefix, not a template. */
function readTags(lines: readonly string[]): string[] {
  for (const line of lines) {
    const match = /^Tags:\s*(.+)$/i.exec(line);
    if (match) {
      return match[1]!
        .split(",")
        .map((tag) => normalise(tag))
        .filter((tag) => tag.length > 0);
    }
  }
  return [];
}

function isEmptySocketLine(snapshot: Snapshot, line: string): boolean {
  const label = text(snapshot, "mmorpg.item_tips.empty_socket") ?? "[Socket]";
  return normalise(line) === normalise(label);
}

/**
 * Match a line against a `%1$s`-style lang template and hand the captured group to `read`.
 *
 * Going through lang rather than hardcoding "Player Level Min: " is what keeps this working
 * against the pack's own renames — `resources.zip` overrides these keys, and Craft to Exile 2
 * already renames plenty of them.
 */
function readTemplated<T>(
  snapshot: Snapshot,
  lines: readonly string[],
  key: string,
  read: (captured: string) => T | undefined,
): T | undefined {
  const template = text(snapshot, key);
  if (template === undefined) return undefined;
  const pattern = templateToRegex(template);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) {
      const value = read(match[1] ?? "");
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/** `"Player Level Min: %1$s"` -> `/^\s*Player Level Min:\s*(.+?)\s*$/`, with the rest escaped. */
function templateToRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/%1\\\$s|%s/g, "(.+?)");
  // Tooltip lines carry a leading status glyph (the green check / red cross of
  // `RequirementBlock`), which survives stripping the colour codes.
  return new RegExp(`^[^A-Za-z0-9]*${body}\\s*$`, "i");
}

function normalise(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Sections and stat lines
// ---------------------------------------------------------------------------

function splitSections(snapshot: Snapshot, lines: readonly string[]): Map<Section, StatLine[]> {
  const headers = new Map<string, Section>();
  for (const [section, key] of Object.entries(SECTION_LANG) as [Section, string][]) {
    const label = text(snapshot, key);
    if (label !== undefined) headers.set(normalise(label).replace(/:$/, "").toLowerCase(), section);
  }

  const out = new Map<Section, StatLine[]>();
  // Anything before the first header is the base stat block, which carries no header of its
  // own — `baseStatsData.GetTooltipString` is added straight to the list.
  let current: Section = "base";

  for (const line of lines) {
    const headerKey = normalise(line).replace(/:$/, "").toLowerCase();
    const header = headers.get(headerKey);
    if (header !== undefined) {
      current = header;
      continue;
    }
    const parsed = parseStatLine(line);
    if (parsed === undefined) continue;
    const list = out.get(current) ?? [];
    list.push(parsed);
    out.set(current, list);
  }
  return out;
}

/**
 * `+3.2% Attack Hits Health Leech [3.1 - 3.7] [Epic]` -> its parts.
 *
 * Peeled from the right, because the two bracket groups are appended by
 * `NormalStatTooltip.getPercentageView` after the name is already rendered, and a stat name can
 * itself contain brackets once the glossary markup is stripped.
 */
export function parseStatLine(raw: string): StatLine | undefined {
  let rest = normalise(raw);

  let tierName: string | undefined;
  const tierMatch = /\s*\[([^[\]]+)\]\s*$/.exec(rest);
  // A trailing `[a - b]` is the range, not a tier; only take this group when it is not numeric.
  if (tierMatch && !/^-?[\d., ]+-[\d., ]+$/.test(tierMatch[1]!)) {
    tierName = normalise(tierMatch[1]!);
    rest = rest.slice(0, tierMatch.index);
  }

  let range: MinMax | undefined;
  const rangeMatch = /\s*\[\s*(-?[\d.,]+)\s*-\s*(-?[\d.,]+)\s*\]\s*$/.exec(rest);
  if (rangeMatch) {
    const min = toNumber(rangeMatch[1]!);
    const max = toNumber(rangeMatch[2]!);
    if (min !== undefined && max !== undefined) {
      range = { min, max };
      rest = rest.slice(0, rangeMatch.index);
    }
  }

  // What is left is `[PLUS_MINUS][VALUE][%] [STAT_NAME]` from `StatNameRegex.translate`.
  const valueMatch = /^([+-]?[\d.,]+)\s*%?\s*(.*)$/.exec(normalise(rest));
  if (!valueMatch) return undefined;
  const value = toNumber(valueMatch[1]!);
  if (value === undefined) return undefined;

  let name = normalise(valueMatch[2] ?? "");
  if (name.length === 0) return undefined;
  // `translate` prepends the MORE prefix word and the pack's "Increased"/"Reduced" wording via
  // `Formatter.SPECIAL_CALC_STAT`; the stat's own lang name is what follows.
  name = name.replace(/^(increased|reduced|more|less)\s+/i, "");

  const out: StatLine = { raw, value, name };
  if (range !== undefined) out.range = range;
  if (tierName !== undefined) out.tierId = tierName;
  return out;
}

function toNumber(value: string): number | undefined {
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Roll recovery
// ---------------------------------------------------------------------------

/**
 * The roll percent a displayed value implies, as the interval it could actually be.
 *
 * The displayed value is linear in the roll percent — `ToExactStat` interpolates the band and
 * then applies a level multiplier that `Stat.scale` only ever applies to FLAT, and either way
 * multiplies the whole thing — so the level, the stat's scaling class and the balance curves
 * all cancel:
 *
 *     roll = bandMin + (value - rangeMin) / (rangeMax - rangeMin) * (bandMax - bandMin)
 *
 * The interval comes from `NumberUtils.formatForTooltip`, which truncates to an int above the
 * client's decimals threshold and prints one decimal below it. Each printed number therefore
 * stands for a half-open window, and the extremes of `value`, `rangeMin` and `rangeMax` bound
 * the roll. Returns `undefined` for a degenerate band (`min === max`), where every roll in the
 * band produces the same number and the tooltip genuinely does not say which one happened.
 */
export function rollFromDisplay(
  value: number,
  range: MinMax,
  band: MinMax,
): { min: number; max: number } | undefined {
  const span = range.max - range.min;
  if (Math.abs(span) < 1e-9) return undefined;

  const at = (v: number, lo: number, hi: number): number => {
    const denom = hi - lo;
    if (Math.abs(denom) < 1e-9) return band.min;
    return band.min + ((v - lo) / denom) * (band.max - band.min);
  };

  // Every combination of window endpoints; the extremes of the roll are among them.
  const vs = windowOf(value);
  const los = windowOf(range.min);
  const his = windowOf(range.max);

  let min = Infinity;
  let max = -Infinity;
  for (const v of vs) {
    for (const lo of los) {
      for (const hi of his) {
        const roll = at(v, lo, hi);
        if (!Number.isFinite(roll)) continue;
        min = Math.min(min, roll);
        max = Math.max(max, roll);
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;

  return {
    min: Math.min(Math.max(min, band.min), band.max),
    max: Math.min(Math.max(max, band.min), band.max),
  };
}

/**
 * The real values a printed number could have come from.
 *
 * `formatForTooltip` truncates toward zero above the decimals threshold and prints one decimal
 * below it. The threshold is a *client* config this project cannot read, so it is inferred from
 * the number itself: a printed value carrying a decimal point was necessarily below it.
 */
function windowOf(printed: number): number[] {
  const hasDecimals = !Number.isInteger(printed);
  if (hasDecimals) {
    // One decimal, half-up: the real value is within half a tenth.
    return [printed - 0.05, printed, printed + 0.05];
  }
  // Truncated toward zero: `(int) 90.9` is `90`, so the real value is in [90, 91).
  return printed >= 0 ? [printed, printed + 0.999] : [printed - 0.999, printed];
}

// ---------------------------------------------------------------------------
// Affix matching
// ---------------------------------------------------------------------------

function matchAffixes(
  snapshot: Snapshot,
  base: BaseGearTypeView,
  type: AffixType,
  lines: readonly StatLine[],
  issues: ImportIssue[],
): AffixRoll[] {
  const pool = affixesFor(snapshot, base.id, type);
  const statsByName = statNameIndex(snapshot);
  const raritiesByName = rarityNameIndex(snapshot);
  const out: AffixRoll[] = [];
  const used = new Set<string>();

  for (const line of lines) {
    const statIds = statsByName.get(normalise(line.name).toLowerCase()) ?? [];
    if (statIds.length === 0) {
      issues.push(
        issue("warning", "stat-not-recognised", `No stat is named "${line.name}"; this line was skipped.`, line.raw),
      );
      continue;
    }

    const tierId = line.tierId === undefined ? undefined : raritiesByName.get(normalise(line.tierId));
    if (line.tierId !== undefined && tierId === undefined) {
      issues.push(
        issue("warning", "tier-not-recognised", `"${line.tierId}" is not a gear rarity in this snapshot.`, line.raw),
      );
    }
    const band = tierId === undefined ? undefined : gearRarity(snapshot, tierId)?.statPercents;

    const candidates = pool.filter(
      (affix) =>
        !used.has(affix.id) &&
        affix.stats.some((mod) => typeof mod["stat"] === "string" && statIds.includes(mod["stat"] as string)),
    );

    if (candidates.length === 0) {
      issues.push(
        issue(
          "warning",
          "affix-not-found",
          `No ${type} on "${base.id}" grants ${line.name}; this line was skipped. A multi-stat ` +
            `affix already matched by an earlier line also lands here.`,
          line.raw,
        ),
      );
      continue;
    }

    const chosen = disambiguate(candidates, statIds, line, band);
    if (chosen.length > 1) {
      issues.push(
        issue(
          "warning",
          "affix-ambiguous",
          `${chosen.length} ${type}es on "${base.id}" match ${line.name} with the same range; ` +
            `took "${chosen[0]!.id}". Check it.`,
          line.raw,
        ),
      );
    }
    const affix = chosen[0]!;
    used.add(affix.id);

    const rollPercent = resolveRoll(affix, statIds, line, band, issues);
    out.push({ affixId: affix.id, tier: tierId ?? "common", rollPercent });
  }

  return out;
}

/**
 * Narrow several affixes granting the same stat by the range they would print.
 *
 * The printed endpoints are `mod.min` and `mod.max` interpolated at the band and multiplied by
 * one level curve, so the *ratio* of the two endpoints is level-free and specific to the
 * affix's declared numbers. Two affixes granting `all_water_damage` with different magnitudes
 * separate cleanly; two with proportional numbers do not, and that is reported rather than
 * guessed at.
 */
function disambiguate(
  candidates: readonly AffixView[],
  statIds: readonly string[],
  line: StatLine,
  band: MinMax | undefined,
): AffixView[] {
  if (candidates.length === 1 || line.range === undefined || band === undefined) {
    return [...candidates];
  }

  const want = ratioOf(line.range.min, line.range.max);
  if (want === undefined) return [...candidates];

  const scored = candidates
    .map((affix) => {
      const mod = affix.stats.find(
        (m) => typeof m["stat"] === "string" && statIds.includes(m["stat"] as string),
      );
      if (mod === undefined) return undefined;
      const min = typeof mod["min"] === "number" ? mod["min"] : undefined;
      const max = typeof mod["max"] === "number" ? mod["max"] : undefined;
      if (min === undefined || max === undefined) return undefined;
      const lo = min + ((max - min) * band.min) / 100;
      const hi = min + ((max - min) * band.max) / 100;
      const got = ratioOf(lo, hi);
      if (got === undefined) return undefined;
      return { affix, error: Math.abs(got - want) };
    })
    .filter((s): s is { affix: AffixView; error: number } => s !== undefined)
    .sort((a, b) => a.error - b.error);

  if (scored.length === 0) return [...candidates];

  // A printed range is rounded, so "equal" has to have width. 2% of the ratio covers the
  // worst case of two truncated integers a long way apart.
  const best = scored[0]!.error;
  const tied = scored.filter((s) => s.error <= best + 0.02).map((s) => s.affix);
  return tied.length > 0 ? tied : [scored[0]!.affix];
}

function ratioOf(lo: number, hi: number): number | undefined {
  if (Math.abs(lo) < 1e-9) return undefined;
  const ratio = hi / lo;
  return Number.isFinite(ratio) ? ratio : undefined;
}

function resolveRoll(
  affix: AffixView,
  statIds: readonly string[],
  line: StatLine,
  band: MinMax | undefined,
  issues: ImportIssue[],
): number {
  if (band === undefined) {
    issues.push(
      issue(
        "warning",
        "roll-not-recoverable",
        `No tier on this line, so the roll band is unknown and the roll was left at 0%.`,
        line.raw,
      ),
    );
    return 0;
  }
  if (line.range === undefined) {
    issues.push(
      issue("warning", "roll-not-recoverable", `No printed range, so the roll was left at the band floor.`, line.raw),
    );
    return band.min;
  }

  const interval = rollFromDisplay(line.value, line.range, band);
  if (interval === undefined) {
    issues.push(
      issue(
        "warning",
        "roll-band-degenerate",
        `"${affix.id}" prints the same number across its whole ${band.min}–${band.max}% band, so ` +
          `the tooltip cannot say where it rolled. Left at the floor.`,
        line.raw,
      ),
    );
    return band.min;
  }

  const width = interval.max - interval.min;
  const midpoint = Math.round((interval.min + interval.max) / 2);
  if (width > 1) {
    issues.push(
      issue(
        "warning",
        "roll-imprecise",
        `The game rounds this line, so the roll is only pinned to ` +
          `${interval.min.toFixed(1)}–${interval.max.toFixed(1)}%; took ${midpoint}%.`,
        line.raw,
      ),
    );
  }
  return Math.min(Math.max(midpoint, band.min), band.max);
}

// ---------------------------------------------------------------------------
// Base resolution
// ---------------------------------------------------------------------------

/**
 * Which base gear type the tooltip describes.
 *
 * `Item Type:` gives the *slot*, which is never enough on its own — nine bases share the
 * `chest` slot. `Tags:` is what separates them, and `BaseGearType.tags` is exactly what that
 * line renders, so the base whose tag set matches is the one. Where several still match (the
 * jewellery slots have one base each, but armour bases share most of their tags) the one with
 * the closest tag set wins, and a genuine tie is reported.
 */
function resolveBase(
  snapshot: Snapshot,
  slotId: string | undefined,
  tagNames: readonly string[],
  issues: ImportIssue[],
): BaseGearTypeView | undefined {
  const all = ids(snapshot, CATEGORY.baseGearType)
    .map((id) => baseGearType(snapshot, id))
    .filter((b): b is BaseGearTypeView => b !== undefined);

  const inSlot = slotId === undefined ? all : all.filter((b) => b.gearSlot === slotId);
  if (inSlot.length === 0) {
    issues.push(
      issue(
        "error",
        "base-not-found",
        slotId === undefined
          ? "No `Item Type:` line, and no base could be identified from the tags."
          : `No base gear type sits in the "${slotId}" slot.`,
      ),
    );
    return undefined;
  }
  if (inSlot.length === 1) return inSlot[0];

  // Tags render humanised — `armor_family` prints as "Armor Family" — so compare on that form.
  const wanted = new Set(tagNames.map((t) => t.toLowerCase()));
  const scored = inSlot
    .map((b) => {
      const own = new Set(b.tags.map((t) => humanise(t).toLowerCase()));
      let overlap = 0;
      for (const tag of wanted) if (own.has(tag)) overlap++;
      // Penalise tags the base has but the tooltip did not list: a subset is a different base.
      return { base: b, score: overlap - Math.abs(own.size - wanted.size) * 0.01 };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  if (wanted.size === 0 || best.score <= 0) {
    issues.push(
      issue(
        "error",
        "base-ambiguous",
        `${inSlot.length} bases sit in the "${slotId ?? "?"}" slot and the \`Tags:\` line did not ` +
          `separate them. Pick the base by hand: ${inSlot.map((b) => b.id).join(", ")}.`,
      ),
    );
    return undefined;
  }

  const tied = scored.filter((s) => s.score >= best.score - 1e-9);
  if (tied.length > 1) {
    issues.push(
      issue(
        "warning",
        "base-ambiguous",
        `${tied.length} bases match these tags equally; took "${best.base.id}". Check it.`,
      ),
    );
  }
  return best.base;
}

// ---------------------------------------------------------------------------
// Reverse lang indexes
// ---------------------------------------------------------------------------

/**
 * Display name -> the stat ids carrying it, memoised per snapshot.
 *
 * **Built from the lang keys, not from `mmorpg_stat`.** 389 of this pack's stats are
 * code-only — registered in Java with no JSON anywhere — and they are exactly the ones that
 * matter: armour, dodge, the resists, every regen. `magic_shield_regen` is one of them, so an
 * index walking the registry would fail to recognise a line the game prints on half the
 * jewellery in the game. Every stat with a display name has a `mmorpg.stat.<id>` key whether
 * or not it has a registry entry, so the lang table is the complete list.
 *
 * Stat ids never contain a dot, which is what separates `mmorpg.stat.lifesteal` from the
 * `mmorpg.stat.lifesteal.enlighten` glossary annotation sitting beside it.
 *
 * A list rather than a single id because 39 of the named stats share a name with another — the
 * eight professions each have their own "Double Drop Chance", and `int_dmg` and
 * `magic_spell_dmg` are both "Magic Skill Damage". Resolving by name alone would pick one at
 * random; handing the caller every candidate lets the affix pool settle it.
 */
const STAT_NAME_CACHE = new WeakMap<Snapshot, Map<string, string[]>>();

const STAT_LANG_PREFIX = "mmorpg.stat.";

export function statNameIndex(snapshot: Snapshot): Map<string, string[]> {
  const cached = STAT_NAME_CACHE.get(snapshot);
  if (cached) return cached;

  const index = new Map<string, string[]>();
  for (const key of Object.keys(snapshot.lang)) {
    if (!key.startsWith(STAT_LANG_PREFIX)) continue;
    const id = key.slice(STAT_LANG_PREFIX.length);
    if (id.length === 0 || id.includes(".")) continue;

    const raw = text(snapshot, LANG_KEY.stat(id));
    if (raw === undefined) continue;
    const name = normalise(stripFormatting(raw)).toLowerCase();
    if (name.length === 0) continue;
    const list = index.get(name) ?? [];
    list.push(id);
    index.set(name, list);
  }
  STAT_NAME_CACHE.set(snapshot, index);
  return index;
}

/** `"Epic"` -> `epic`. Rarity names live under `mmorpg.rarity.<id>`. */
const RARITY_NAME_CACHE = new WeakMap<Snapshot, Map<string, string>>();

export function rarityNameIndex(snapshot: Snapshot): Map<string, string> {
  const cached = RARITY_NAME_CACHE.get(snapshot);
  if (cached) return cached;

  const index = new Map<string, string>();
  for (const id of ids(snapshot, CATEGORY.gearRarity)) {
    const raw = text(snapshot, `mmorpg.rarity.${id}`);
    index.set(normalise(raw === undefined ? humanise(id) : stripFormatting(raw)), id);
  }
  RARITY_NAME_CACHE.set(snapshot, index);
  return index;
}

/** Re-exported so callers can type an import against the same rarity view the editor uses. */
export type { GearRarityView };
