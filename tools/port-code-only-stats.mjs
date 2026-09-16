#!/usr/bin/env node
/**
 * Ports the code-only stats out of the Mine and Slash source.
 *
 *   node tools/port-code-only-stats.mjs --src <checkout> --snapshot data/snapshot.json
 *
 * 353 of the pack's 1,153 stats are registered in Java with no JSON anywhere, so the
 * extractor cannot see their `min`, `max`, `base`, `scaling` or `multiUseType`. They are also
 * the ones that decide a build: armor, dodge, every resist and penetration, every ailment
 * stat, leech. Without them the engine computes zeros for exactly the stats that matter.
 *
 * The mod publishes its own authoritative id list (`modpack_dev_helper/*.txt`, surfaced as
 * `snapshot.diagnostics.codeOnlyStats`), which is what makes this checkable rather than
 * hopeful: every one of those ids must be claimed by exactly one Java class, or the run
 * fails. A pack or mod update that adds a stat therefore breaks this loudly instead of
 * silently computing a zero.
 *
 * What is read here are constants and behaviour — `this.min = 0`, `StatScaling.NORMAL` — not
 * code. mahjerion/Mine-And-Slash-Rework ships no LICENSE file, so its source is
 * all-rights-reserved: the checkout is git-ignored, nothing from it is vendored, and the
 * output is a table of facts about the game the player is already running.
 *
 * Anything this cannot resolve is reported and belongs in `code-only-behaviour.ts` by hand.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** `STATICS.MAX_FLOAT`, which is also what `Stat.max` defaults to. */
const MAX_FLOAT = 100_000_000;

/**
 * `Stat`'s field initialisers — the shape a stat has before its constructor touches
 * anything (Stat.java:66-80).
 */
const STAT_DEFAULTS = {
  base: 0,
  min: -1000,
  max: MAX_FLOAT,
  softcap: 0,
  hasSoftcap: false,
  isPerc: false,
  scaling: "NONE",
  multiUseType: "MULTIPLY_STAT",
};

function main() {
  const args = parseArgs(process.argv.slice(2));

  const snapshot = JSON.parse(readFileSync(resolve(args.snapshot), "utf8"));
  const targets = snapshot.diagnostics?.codeOnlyStats;
  if (!Array.isArray(targets) || targets.length === 0) {
    fail(`${args.snapshot} has no diagnostics.codeOnlyStats — is it an extractor snapshot?`);
  }

  const srcRoot = resolve(args.src);
  const javaRoot = join(srcRoot, "src", "main", "java");
  let files;
  try {
    files = walkJava(statSync(javaRoot).isDirectory() ? javaRoot : srcRoot);
  } catch {
    fail(
      `Could not read ${javaRoot}.\n` +
        "Expected a checkout of mahjerion/Mine-And-Slash-Rework @ 1.20-Forge:\n" +
        "  git clone --filter=blob:none --sparse --depth 1 --branch 1.20-Forge \\\n" +
        "    https://github.com/mahjerion/Mine-And-Slash-Rework reference/mns-src\n" +
        "  cd reference/mns-src && git sparse-checkout set src/main/java",
    );
  }

  const classes = new Map();
  for (const file of files) {
    const parsed = parseClass(file, relative(javaRoot, file).split(sep).join("/"));
    if (parsed) classes.set(parsed.name, parsed);
  }

  const statClasses = [...classes.values()].filter((c) => extendsStat(c, classes));
  const claims = claimIds(statClasses, classes, targets, [...classes.values()].map((c) => c.text));

  const missing = targets.filter((id) => !claims.byId.has(id)).sort();
  report(statClasses.length, claims, missing, targets.length);

  if (missing.length > 0 || claims.ambiguous.length > 0) {
    console.error("");
    console.error(`FAILED: ${missing.length} unclaimed id(s), ${claims.ambiguous.length} ambiguous.`);
    console.error("Resolve them in packages/engine/src/code-only-behaviour.ts, or teach this");
    console.error("script the pattern. Do not ship a partial table — a stat that silently");
    console.error("resolves to zero is the failure mode this whole file exists to prevent.");
    process.exit(1);
  }

  const knownIds = new Set([...targets, ...Object.keys(snapshot.registries?.mmorpg_stat ?? {})]);
  const transfers = findTransfers(claims, classes, knownIds);
  console.log(`transfers    ${transfers.size} stat(s) hand themselves to others`);

  // Per-class shapes, for the families whose ids come from a datapack registry rather than
  // from Java. `LearnSpellStat` is one per spell, so a pack that adds spells adds stats that
  // are in no list anywhere — see REGISTRY_FAMILIES in code-only-behaviour.ts.
  const classShapes = new Map();
  for (const cls of statClasses) classShapes.set(cls.name, shapeOf(cls, classes).shape);

  const out = resolve(args.out);
  writeFileSync(out, emit(claims, targets, snapshot, transfers, classShapes), "utf8");
  console.log("");
  console.log(`wrote ${out}`);
}

// ---------------------------------------------------------------------------
// Java reading
// ---------------------------------------------------------------------------

function walkJava(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJava(p));
    else if (e.name.endsWith(".java")) out.push(p);
  }
  return out;
}

const CLASS_RE = /(?:public|abstract|final|\s)*class\s+(\w+)(?:<[^>]*>)?\s*(?:extends\s+(\w+))?/;

function parseClass(file, origin) {
  const text = readFileSync(file, "utf8");
  const m = CLASS_RE.exec(stripComments(text));
  if (!m) return null;
  return { name: m[1], parent: m[2] ?? null, origin, text: stripComments(text) };
}

/** Line and block comments hide commented-out assignments that would otherwise be read. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function extendsStat(cls, classes) {
  let cur = cls;
  const seen = new Set();
  while (cur && !seen.has(cur.name)) {
    seen.add(cur.name);
    if (cur.parent === "Stat") return true;
    cur = cur.parent ? classes.get(cur.parent) : null;
  }
  return false;
}

/** Ancestors nearest-last, so a subclass's assignment wins over its parent's. */
function chain(cls, classes) {
  const out = [];
  let cur = cls;
  const seen = new Set();
  while (cur && !seen.has(cur.name)) {
    seen.add(cur.name);
    out.unshift(cur);
    cur = cur.parent ? classes.get(cur.parent) : null;
  }
  return out;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)F?`;

function shapeOf(cls, classes) {
  const shape = { ...STAT_DEFAULTS };
  const provenance = [];

  for (const c of chain(cls, classes)) {
    // `Stat` itself contributes only its field initialisers, which are already the seed.
    // Reading its body would match its own `setSoftCap`/`setUsesMoreMultiplier` *declarations*
    // as though every stat called them.
    if (c.name === "Stat") continue;

    const assign = (field, re, cast = Number) => {
      let last = null;
      for (const m of c.text.matchAll(re)) last = m;
      if (last) {
        shape[field] = cast(last[1]);
        provenance.push(`${c.origin}: ${field}`);
      }
    };
    assign("min", new RegExp(String.raw`this\.min\s*=\s*${NUM}\s*;`, "g"));
    assign("max", new RegExp(String.raw`this\.max\s*=\s*${NUM}\s*;`, "g"));
    assign("base", new RegExp(String.raw`this\.base\s*=\s*${NUM}\s*;`, "g"));
    assign("isPerc", /this\.is_perc\s*=\s*(true|false)\s*;/g, (v) => v === "true");
    assign("scaling", /this\.scaling\s*=\s*StatScaling\.(\w+)\s*;/g, String);

    // Nothing in the mod calls `setSoftCap` — grep the tree and the only hit is the setter's
    // own definition. So `hasSoftCap()` is false for every stat in the game, and the final
    // clamp in `StatCalculation.calc` is always to the hard cap. Read it anyway rather than
    // hardcode the conclusion: a mod update that adds one should show up here.
    const softcap = new RegExp(String.raw`setSoftCap\(\s*${NUM}\s*\)`, "g").exec(c.text);
    if (softcap) {
      shape.softcap = Number(softcap[1]);
      shape.hasSoftcap = true;
      provenance.push(`${c.origin}: softcap`);
    }

    // Two routes to MULTIPLICATIVE_DAMAGE. The explicit one, and the override in
    // `Stat.getMultiUseType()` (Stat.java:135-141), which ignores the declared value
    // whenever the stat's effect is a damage increase:
    //
    //     if (this.statEffect instanceof BaseDamageIncreaseEffect) {
    //         this.multiUseType = MultiUseType.MULTIPLICATIVE_DAMAGE;
    //
    // Note this override reaches only these Java classes. Datapack stats carry
    // `ModifyStatLayerEffect`, which extends `StatEffect`, not `BaseDamageIncreaseEffect`,
    // so a JSON stat's declared `multiUseType` always stands.
    if (/setUsesMoreMultiplier\(\)/.test(c.text) || /extends\s+BaseDamageIncreaseEffect/.test(c.text)) {
      shape.multiUseType = "MULTIPLICATIVE_DAMAGE";
      provenance.push(`${c.origin}: multiUseType`);
    }
  }

  return { shape, provenance };
}

// ---------------------------------------------------------------------------
// Id resolution
// ---------------------------------------------------------------------------

const GUID_BODY_RE = /public\s+String\s+GUID\s*\(\s*\)\s*\{\s*return\s+([^;]+);/;
const GUID_FIELD_RE = /String\s+GUID\s*=\s*"([^"]+)"/;

/**
 * What ids a class registers.
 *
 * Literals are exact. Everything else is a generated family — `getElement().guidName +
 * "_resist"` across seven elements, `ailment.GUID() + "_damage"` across five ailments,
 * `"learn_" + spell.GUID()` across every spell in the pack. Rather than parse Java enums,
 * a pattern is turned into a prefix/suffix matcher over the ids the mod says exist, which is
 * self-checking: an id claimed twice is reported, and one claimed never fails the run.
 */
function idsFor(cls, classes) {
  for (const c of [...chain(cls, classes)].reverse()) {
    const body = GUID_BODY_RE.exec(c.text);
    if (!body) continue;
    const expr = body[1].trim();

    const literal = /^"([^"]+)"$/.exec(expr);
    if (literal) return { kind: "literal", ids: [literal[1]] };

    // `return GUID;` / `return id;` — a field. A static one is a literal; an instance one is
    // a constructor argument, so the ids live at the `new SpecialStat("heal_cleanse", ...)`
    // call sites instead.
    if (/^\w+$/.test(expr)) {
      const field = GUID_FIELD_RE.exec(c.text);
      if (field) return { kind: "literal", ids: [field[1]] };
      return { kind: "constructed", className: c.name, origin: c.origin };
    }

    const parts = [...expr.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const startsWithLiteral = /^\s*"/.test(expr);
    const endsWithLiteral = /"\s*$/.test(expr);
    if (parts.length === 1 && parts[0].length > 1) {
      return startsWithLiteral
        ? { kind: "prefix", value: parts[0], origin: c.origin }
        : { kind: "suffix", value: parts[0], origin: c.origin };
    }
    if (parts.length >= 2 && startsWithLiteral && endsWithLiteral) {
      return { kind: "wrap", prefix: parts[0], suffix: parts[parts.length - 1], origin: c.origin };
    }
    // `prof + "_" + cat.id + "_drop_bonus"` — only the tail is fixed.
    if (parts.length >= 2 && endsWithLiteral) {
      const tail = parts[parts.length - 1];
      if (tail.length > 1) return { kind: "suffix", value: tail, origin: c.origin };
    }
    return { kind: "unresolved", expr, origin: c.origin };
  }
  return { kind: "none" };
}

function claimIds(statClasses, classes, targets, allText) {
  const targetSet = new Set(targets);
  const byId = new Map();
  const ambiguous = [];
  const unresolved = [];
  const patterns = [];

  const put = (id, cls, how, specificity = 0) => {
    const prev = byId.get(id);
    if (prev) {
      // A literal beats a pattern: `ailment_damage` is its own class even though
      // `ailment.GUID() + "_damage"` would happily match it. Between two patterns the
      // longer one wins, which is what separates `AilmentProcStat` (`_proc_chance`) from
      // `AilmentChance` (`_chance`) — both match, only the specific one is right.
      if (prev.how === "literal" && how !== "literal") return;
      const beatsPrev = how === "literal" && prev.how !== "literal";
      if (!beatsPrev) {
        if (specificity > prev.specificity) {
          byId.set(id, { cls, how, specificity });
        } else if (specificity < prev.specificity) {
          return;
        } else {
          ambiguous.push({ id, first: prev.cls.origin, second: cls.origin });
        }
        return;
      }
    }
    byId.set(id, { cls, how, specificity });
  };

  for (const cls of statClasses) {
    const found = idsFor(cls, classes);
    if (found.kind === "literal") {
      for (const id of found.ids) if (targetSet.has(id)) put(id, cls, "literal");
    } else if (found.kind === "constructed") {
      const call = new RegExp(String.raw`new\s+${found.className}\s*\(\s*"([^"]+)"`, "g");
      for (const text of allText) {
        for (const m of text.matchAll(call)) if (targetSet.has(m[1])) put(m[1], cls, "literal");
      }
    } else if (found.kind === "unresolved") {
      unresolved.push({ cls, expr: found.expr });
    } else if (found.kind !== "none") {
      patterns.push({ cls, found });
    }
  }

  for (const { cls, found } of patterns) {
    const match =
      found.kind === "prefix"
        ? (id) => id.startsWith(found.value)
        : found.kind === "suffix"
          ? (id) => id.endsWith(found.value)
          : (id) => id.startsWith(found.prefix) && id.endsWith(found.suffix);
    const specificity =
      found.kind === "wrap" ? found.prefix.length + found.suffix.length : found.value.length;
    for (const id of targets) if (match(id)) put(id, cls, "pattern", specificity);
  }

  const shapes = new Map();
  for (const [id, claim] of byId) {
    shapes.set(id, { ...shapeOf(claim.cls, classes), origin: claim.cls.origin, how: claim.how });
  }

  return { byId, shapes, ambiguous, unresolved, patterns };
}

/**
 * `ITransferToOtherStats` — which stats empty themselves into others before the first pass.
 *
 * Derived rather than listed, because which families even have an `Elemental` variant is not
 * obvious: `phys_to_elemental` exists, `elemental_weapon_damage` does not, and both come from
 * `ElementalStat` subclasses. The variable part of the id is compared against the element
 * name; targets are the same pattern over `Elements.getAllSingleElemental()`, which is the
 * three ELEMENTAL-tagged single elements (Elements.java:92).
 */
const ELEMENTAL_TOKEN = "elemental";
const SINGLE_ELEMENTAL_TOKENS = ["fire", "water", "lightning"];

function findTransfers(claims, classes, knownIds) {
  const transfers = new Map();

  for (const { cls, found } of claims.patterns) {
    if (!chain(cls, classes).some((c) => c.name === "ElementalStat")) continue;
    const affix =
      found.kind === "prefix"
        ? { head: found.value, tail: "" }
        : found.kind === "suffix"
          ? { head: "", tail: found.value }
          : { head: found.prefix, tail: found.suffix };
    const id = `${affix.head}${ELEMENTAL_TOKEN}${affix.tail}`;
    if (!claims.byId.has(id)) continue;
    const targets = SINGLE_ELEMENTAL_TOKENS.map((e) => `${affix.head}${e}${affix.tail}`).filter((t) =>
      knownIds.has(t),
    );
    if (targets.length > 0) transfers.set(id, targets);
  }

  // `AllAttributes`, the one implementor that is not elemental. Its targets are the three
  // core stat ids it names in `coreStatsThatBenefitIDS()` (AllAttributes.java:49-51).
  for (const [id, claim] of claims.byId) {
    const cls = claim.cls;
    if (!/implements[^{]*ITransferToOtherStats/.test(cls.text)) continue;
    if (chain(cls, classes).some((c) => c.name === "ElementalStat")) continue;
    const list = /coreStatsThatBenefitIDS\(\)\s*\{\s*return\s+Arrays\.asList\(([^)]*)\)/.exec(cls.text);
    if (!list) continue;
    const targets = list[1]
      .split(",")
      .map((ref) => {
        const field = ref.trim().split(".").pop();
        const literal = new RegExp(String.raw`String\s+${field}\s*=\s*"([^"]+)"`).exec(cls.text);
        return literal ? literal[1] : null;
      })
      .filter((t) => t !== null && knownIds.has(t));
    if (targets.length > 0) transfers.set(id, targets);
  }

  return transfers;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function report(scanned, claims, missing, total) {
  console.log(`scanned      ${scanned} classes extending Stat`);
  console.log(`claimed      ${claims.byId.size}/${total} code-only ids`);
  console.log(`  literal    ${[...claims.byId.values()].filter((c) => c.how === "literal").length}`);
  console.log(`  generated  ${[...claims.byId.values()].filter((c) => c.how === "pattern").length}`);

  if (claims.unresolved.length > 0) {
    console.log("");
    console.log(`unresolved GUID expressions (${claims.unresolved.length}):`);
    for (const u of claims.unresolved.slice(0, 10)) console.log(`  ${u.cls.origin}  ${u.expr}`);
    if (claims.unresolved.length > 10) console.log(`  ... and ${claims.unresolved.length - 10} more`);
  }
  if (claims.ambiguous.length > 0) {
    console.log("");
    console.log(`claimed by more than one class (${claims.ambiguous.length}):`);
    for (const a of claims.ambiguous.slice(0, 10)) console.log(`  ${a.id}  ${a.first} vs ${a.second}`);
  }
  if (missing.length > 0) {
    console.log("");
    console.log(`unclaimed (${missing.length}):`);
    for (const id of missing.slice(0, 40)) console.log(`  ${id}`);
    if (missing.length > 40) console.log(`  ... and ${missing.length - 40} more`);
  }
}

function emit(claims, targets, snapshot, transfers, classShapes) {
  const shapeLiteral = (f) =>
    `{ ${[
      `base: ${f.base}`,
      `min: ${f.min}`,
      `max: ${f.max === MAX_FLOAT ? "MAX_FLOAT" : f.max}`,
      `softcap: ${f.softcap}`,
      `hasSoftcap: ${f.hasSoftcap}`,
      `isPerc: ${f.isPerc}`,
      `scaling: "${f.scaling}"`,
      `multiUseType: "${f.multiUseType}"`,
    ].join(", ")} }`;

  const rows = [...targets].sort().map((id) => {
    const s = claims.shapes.get(id);
    return `  ${JSON.stringify(id)}: ${shapeLiteral(s.shape)}, // ${s.origin}`;
  });

  const classRows = [...classShapes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, shape]) => `  ${JSON.stringify(name)}: ${shapeLiteral(shape)},`);

  return `// Generated by tools/port-code-only-stats.mjs — do not edit by hand.
//
// The ${targets.length} stats Mine and Slash registers in Java with no JSON, so the extractor
// cannot see them. Regenerate after a mod update; the script fails rather than emit a partial
// table, so a missing stat can never quietly resolve to zero.
//
// Source: mahjerion/Mine-And-Slash-Rework @ 1.20-Forge
// Against: Mine and Slash ${snapshot.meta?.mineAndSlashVersion ?? "unknown"}
//
// Behaviour that is not a constant — usable values, the Elemental-to-single-element
// transfer — is hand-written in ./code-only-behaviour.ts.

import { MAX_FLOAT, type StatShape } from "./stat-shape.js";

export const CODE_ONLY_STATS: Record<string, StatShape> = {
${rows.join("\n")}
};

/**
 * \`ITransferToOtherStats\`: these empty their Flat/Percent/Multi into the listed stats before
 * the first calculation pass, then clear themselves. See \`applyTransfers\` in ./calculate.ts.
 */
export const CODE_ONLY_TRANSFERS: Record<string, readonly string[]> = {
${[...transfers.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([id, to]) => `  ${JSON.stringify(id)}: [${to.map((t) => JSON.stringify(t)).join(", ")}],`)
  .join("\n")}
};

/**
 * Shape per Java class, for the families whose ids come from a datapack registry rather than
 * from the mod. Those cannot be enumerated here — the ids depend on the pack — so the engine
 * expands them at load. See \`REGISTRY_FAMILIES\` in ./code-only-behaviour.ts.
 */
export const CODE_ONLY_CLASS_SHAPES: Record<string, StatShape> = {
${classRows.join("\n")}
};
`;
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let src = null;
  let snapshot = null;
  let out = "packages/engine/src/code-only-stats.generated.ts";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--src") src = argv[++i] ?? null;
    else if (arg === "--snapshot" || arg === "-s") snapshot = argv[++i] ?? null;
    else if (arg === "--out" || arg === "-o") out = argv[++i] ?? out;
    else if (arg === "--help" || arg === "-h") usage(0);
    else fail(`Unknown argument: ${arg}`);
  }
  if (!src) fail("Missing required --src <checkout of Mine-And-Slash-Rework @ 1.20-Forge>");
  if (!snapshot) fail("Missing required --snapshot <path>");
  return { src, snapshot, out };
}

function usage(code) {
  console.log(
    [
      "Usage: node tools/port-code-only-stats.mjs --src <dir> --snapshot <file> [--out <file>]",
      "",
      "  --src            Checkout of mahjerion/Mine-And-Slash-Rework @ 1.20-Forge.",
      "  --snapshot, -s   Extractor snapshot, for the authoritative code-only id list.",
      "  --out, -o        Where to write the table.",
    ].join("\n"),
  );
  process.exit(code);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

main();
