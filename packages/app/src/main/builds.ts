/**
 * Opening and saving build documents.
 *
 * A build is a plain `BuildDoc` JSON file — the same shape `fixtures/` holds under its `build`
 * key, which is what makes "author a character here, paste it into a fixture" work at all.
 * Nothing is written that the schema would not accept back.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { BUILD_DOC_VERSION, parseFixture, type BuildDoc, type Observation } from "@cte2/schema";
import { dialog, type BrowserWindow } from "electron";

import type { AutosaveSession, OpenResult, PinnedBaseline, SaveResult } from "@shared/ipc";

import { autosavePath, rememberBuild } from "./settings.js";

const FILTERS = [
  { name: "CTE2 build", extensions: ["json"] },
  { name: "All files", extensions: ["*"] },
];

export async function openBuild(window: BrowserWindow | null): Promise<OpenResult> {
  const result = await dialog.showOpenDialog(window ?? undefined!, {
    title: "Open build",
    filters: FILTERS,
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };

  const path = result.filePaths[0]!;
  try {
    const { doc, observed } = parseBuild(readFileSync(path, "utf8"));
    rememberBuild(path, doc.meta?.name ?? basename(path, ".json"));
    return { ok: true, path, doc, ...(observed === null ? {} : { observed }) };
  } catch (err) {
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function openBuildAt(path: string): Promise<OpenResult> {
  if (!existsSync(path)) return { ok: false, cancelled: false, error: `No such file: ${path}` };
  try {
    const { doc, observed } = parseBuild(readFileSync(path, "utf8"));
    rememberBuild(path, doc.meta?.name ?? basename(path, ".json"));
    return { ok: true, path, doc, ...(observed === null ? {} : { observed }) };
  } catch (err) {
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function saveBuild(
  window: BrowserWindow | null,
  doc: BuildDoc,
  path?: string,
): Promise<SaveResult> {
  let target = path;
  if (target === undefined) {
    const result = await dialog.showSaveDialog(window ?? undefined!, {
      title: "Save build",
      defaultPath: `${(doc.meta?.name ?? "build").replace(/[^\w.-]+/g, "-")}.json`,
      filters: FILTERS,
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    target = result.filePath;
  }

  try {
    writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    rememberBuild(target, doc.meta?.name ?? basename(target, ".json"));
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What a session-shaped autosave says it is.
 *
 * The file used to be a bare `BuildDoc` and the two shapes have to be told apart on read, so the
 * new one carries a marker rather than being recognised by the presence of a field. A build
 * document with a `doc` key is not impossible — the schema is not closed — and getting this
 * wrong means failing to restore somebody's open build.
 */
const SESSION_KIND = "cte2-session";

/** Best-effort: a failed autosave must never interrupt editing. */
export function autosave(doc: BuildDoc, baseline: PinnedBaseline | null): void {
  try {
    writeFileSync(
      autosavePath(),
      JSON.stringify({ kind: SESSION_KIND, doc, baseline }),
      "utf8",
    );
  } catch {
    // Ignored on purpose.
  }
}

/**
 * The last session, in whichever of the two shapes the file is in.
 *
 * **Old files must keep working.** This is not a format nobody has yet: it is whatever build the
 * person running this had open when they last closed the app, and before the comparison baseline
 * existed it was written as a bare document. A reader that only understood the new shape would
 * silently start every session with an empty build.
 *
 * A restored session is not a capture — it has been edited since — so no `observed` is carried
 * back, which is unchanged from before.
 */
export function loadAutosave(): AutosaveSession | null {
  let text: string;
  try {
    text = readFileSync(autosavePath(), "utf8");
  } catch {
    return null;
  }

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

/**
 * Accepts either a bare `BuildDoc` or a fixture wrapper, so a file from `fixtures/` opens
 * without being unwrapped by hand first — that round trip is the whole point of the exporter.
 *
 * Validation against a snapshot happens in the renderer, where the snapshot lives. This only
 * checks that the thing is shaped like a document at all.
 */
function parseBuild(text: string): { doc: BuildDoc; observed: Observation | null } {
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
