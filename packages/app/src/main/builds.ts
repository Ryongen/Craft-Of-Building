/**
 * Opening and saving build documents, against the real filesystem.
 *
 * A build is a plain `BuildDoc` JSON file — the same shape `fixtures/` holds under its `build`
 * key, which is what makes "author a character here, paste it into a fixture" work at all.
 * Nothing is written that the schema would not accept back.
 *
 * What a build file *is* lives in `@shared/build-file`, not here: the browser build parses the
 * same bytes out of a `File` and has to agree with this one exactly. This module is only the
 * dialogs and the disk.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import type { BuildDoc } from "@cte2/schema";
import { dialog, type BrowserWindow } from "electron";

import {
  parseBuild,
  parseSession,
  serializeBuild,
  serializeSession,
  suggestedFileName,
} from "@shared/build-file";
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

  return readBuildAt(result.filePaths[0]!);
}

export async function openBuildAt(path: string): Promise<OpenResult> {
  if (!existsSync(path)) return { ok: false, cancelled: false, error: `No such file: ${path}` };
  return readBuildAt(path);
}

function readBuildAt(path: string): OpenResult {
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
      defaultPath: suggestedFileName(doc),
      filters: FILTERS,
    });
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
    target = result.filePath;
  }

  try {
    writeFileSync(target, serializeBuild(doc), "utf8");
    rememberBuild(target, doc.meta?.name ?? basename(target, ".json"));
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Best-effort: a failed autosave must never interrupt editing. */
export function autosave(doc: BuildDoc, baseline: PinnedBaseline | null): void {
  try {
    writeFileSync(autosavePath(), serializeSession(doc, baseline), "utf8");
  } catch {
    // Ignored on purpose.
  }
}

/** The last session, or null when there is no readable autosave file. */
export function loadAutosave(): AutosaveSession | null {
  let text: string;
  try {
    text = readFileSync(autosavePath(), "utf8");
  } catch {
    return null;
  }
  return parseSession(text);
}
