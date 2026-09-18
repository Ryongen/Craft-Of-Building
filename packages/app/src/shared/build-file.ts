/**
 * Reading and writing build documents, with no opinion about where the bytes came from.
 *
 * This used to live inside `main/builds.ts`, wrapped around `readFileSync`. Splitting it out is
 * what makes the browser build possible at all: the rules for what counts as a build document,
 * how a fixture is unwrapped, and how an autosaved session is recognised are *format* decisions,
 * and they have to be identical whether the text arrived from a file dialog, a `<input type=file>`
 * or IndexedDB. Two implementations would mean a build that opens in the desktop app and not on
 * the site, which is the one failure the site cannot afford.
 *
 * Nothing here touches `node:fs` or `electron`, so the renderer can import it.
 */

import { BUILD_DOC_VERSION, parseFixture, type BuildDoc, type Observation } from "@cte2/schema";

import type { AutosaveSession, PinnedBaseline } from "./ipc.js";

/**
 * What a session-shaped autosave says it is.
 *
 * The file used to be a bare `BuildDoc` and the two shapes have to be told apart on read, so the
 * new one carries a marker rather than being recognised by the presence of a field. A build
 * document with a `doc` key is not impossible — the schema is not closed — and getting this
 * wrong means failing to restore somebody's open build.
 */
export const SESSION_KIND = "cte2-session";

/** The name to offer in a save dialog for a document that has never been saved. */
export function suggestedFileName(doc: BuildDoc): string {
  return `${(doc.meta?.name ?? "build").replace(/[^\w.-]+/g, "-")}.json`;
}

/** The bytes a build file holds. Pretty-printed, because these get read and diffed by hand. */
export function serializeBuild(doc: BuildDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The bytes an autosaved session holds. Not pretty-printed — nothing reads this but the app. */
export function serializeSession(doc: BuildDoc, baseline: PinnedBaseline | null): string {
  return JSON.stringify({ kind: SESSION_KIND, doc, baseline });
}

/**
 * Accepts either a bare `BuildDoc` or a fixture wrapper, so a file from `fixtures/` opens
 * without being unwrapped by hand first — that round trip is the whole point of the exporter.
 *
 * Validation against a snapshot happens in the renderer, where the snapshot lives. This only
 * checks that the thing is shaped like a document at all.
 */
export function parseBuild(text: string): { doc: BuildDoc; observed: Observation | null } {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object") throw new Error("Not a JSON object");

  const node = parsed as Record<string, unknown>;
  const isFixture =
    node["build"] !== undefined && typeof node["build"] === "object" && node["build"] !== null;
  const candidate = isFixture ? (node["build"] as Record<string, unknown>) : node;

  // A capture's `observed` block is the game's own stat sheet. Keeping it lets the app check
  // itself against the character the numbers came from, which is the whole point of having
  // captured it — the CLI could already do this and the app could not.
  let observed: Observation | null = null;
  if (isFixture) {
    try {
      observed = parseFixture(parsed, "opened build").observed;
    } catch {
      // A build that is not a well-formed fixture still opens; it just has nothing to check
      // against. Refusing the whole file over a malformed `observed` would be perverse.
      observed = null;
    }
  }

  const character = candidate["character"];
  if (character === null || typeof character !== "object") {
    throw new Error("Missing `character` — this does not look like a build document");
  }
  if (typeof (character as Record<string, unknown>)["level"] !== "number") {
    throw new Error("Missing `character.level`");
  }
  if (typeof candidate["schemaVersion"] !== "number") {
    throw new Error("Missing `schemaVersion`");
  }
  if (candidate["schemaVersion"] !== BUILD_DOC_VERSION) {
    // Not fatal: the validator reports version drift with far more detail than this can.
    // Loading it and letting the diagnostics panel explain is more useful than refusing.
  }
  return { doc: candidate as unknown as BuildDoc, observed };
}

/**
 * The last session, in whichever of the two shapes the text is in.
 *
 * **Old files must keep working.** This is not a format nobody has yet: it is whatever build the
 * person running this had open when they last closed the app, and before the comparison baseline
 * existed it was written as a bare document. A reader that only understood the new shape would
 * silently start every session with an empty build.
 *
 * A restored session is not a capture — it has been edited since — so no `observed` is carried
 * back, which is unchanged from before.
 */
export function parseSession(text: string): AutosaveSession | null {
  let node: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    node = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (node["kind"] !== SESSION_KIND) {
    // The old shape: the file *is* the document.
    try {
      return { doc: parseBuild(text).doc, baseline: null };
    } catch {
      return null;
    }
  }

  let doc: BuildDoc;
  try {
    doc = parseBuild(JSON.stringify(node["doc"])).doc;
  } catch {
    return null;
  }

  // A baseline that will not parse loses the comparison and nothing else. It is session state,
  // and refusing to restore the document over it would trade the important half for the other.
  let baseline: PinnedBaseline | null = null;
  const pinned = node["baseline"];
  if (pinned !== null && typeof pinned === "object") {
    const entry = pinned as Record<string, unknown>;
    try {
      baseline = {
        doc: parseBuild(JSON.stringify(entry["doc"])).doc,
        name: typeof entry["name"] === "string" ? entry["name"] : "Baseline",
        pinnedAt: typeof entry["pinnedAt"] === "string" ? entry["pinnedAt"] : "",
      };
    } catch {
      baseline = null;
    }
  }

  return { doc, baseline };
}

/** The name to file a build under, given where it came from. Mirrors `basename(path, ".json")`. */
export function buildLabel(doc: BuildDoc, fallbackPath: string): string {
  const named = doc.meta?.name;
  if (named !== undefined && named !== "") return named;
  const leaf = fallbackPath.split(/[\\/]/).pop() ?? fallbackPath;
  return leaf.replace(/\.json$/i, "");
}
