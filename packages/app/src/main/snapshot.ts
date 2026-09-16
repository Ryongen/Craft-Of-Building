/**
 * Finding, loading and producing the snapshot.
 *
 * The app never ships game data — it reads the player's own install, exactly as the README
 * promises. This is where that happens: the first run picks an install folder and runs the
 * extractor in-process, and every run after that reads the JSON back off disk.
 *
 * In development it prefers the repository's own `data/snapshot.json` if one is there, so the
 * work already done by `npm run extract` is not repeated.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  extract,
  extractAssets,
  fingerprintInstall,
  fingerprintsMatch,
  gearItemIds,
  locateInstall,
  LocateError,
  type AssetIndex,
  type Snapshot,
} from "@cte2/extractor";
import { app } from "electron";

import type { DataStatus, ExtractResult, ExtractSummary, SnapshotPayload } from "@shared/ipc";

import { readSettings, updateSettings } from "./settings.js";

/** Where an app-produced snapshot and its textures live. */
function userDataSnapshot(): { snapshotPath: string; assetsDir: string } {
  const root = app.getPath("userData");
  return { snapshotPath: join(root, "snapshot.json"), assetsDir: join(root, "assets") };
}

/**
 * The repo's `data/` directory when running from a checkout.
 *
 * `app.getAppPath()` points at `packages/app` under `electron-vite dev`, so the repo root is
 * two levels up. Guarded by an existence check rather than by an env var, so a packaged build
 * that happens to sit in a similar tree still falls through to userData.
 */
function repoData(): { snapshotPath: string; assetsDir: string } | null {
  if (app.isPackaged) return null;
  const root = resolve(app.getAppPath(), "..", "..");
  const snapshotPath = join(root, "data", "snapshot.json");
  return existsSync(snapshotPath) ? { snapshotPath, assetsDir: join(root, "data", "assets") } : null;
}

/**
 * Reads the snapshot text and the asset index.
 *
 * Returns null when there is nothing to load — the renderer shows the first-run screen. A
 * configured-but-missing snapshot is treated the same way and the setting is cleared, because
 * the file having been deleted is a likelier explanation than a transient read failure.
 */
export function loadSnapshot(): SnapshotPayload | null {
  const settings = readSettings();

  const candidates = [
    settings.snapshotPath
      ? { snapshotPath: settings.snapshotPath, assetsDir: settings.assetsDir }
      : null,
    repoData(),
    userDataSnapshot(),
  ];

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate.snapshotPath)) continue;
    let json: string;
    try {
      json = readFileSync(candidate.snapshotPath, "utf8");
    } catch {
      continue;
    }
    const assetsDir = candidate.assetsDir ?? null;
    const index = assetsDir ? readAssetIndex(assetsDir) : { assets: {}, items: {} };
    return {
      json,
      path: candidate.snapshotPath,
      assetsDir,
      assets: index.assets,
      itemIcons: index.items,
    };
  }

  if (settings.snapshotPath) updateSettings({ snapshotPath: null, assetsDir: null });
  return null;
}

type AssetIndexes = { assets: Record<string, string>; items: Record<string, string> };

function readAssetIndex(assetsDir: string): AssetIndexes {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(assetsDir, "index.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object") return { assets: {}, items: {} };
    const index = parsed as Partial<AssetIndex>;
    return { assets: stringMap(index.assets), items: stringMap(index.items) };
  } catch {
    return { assets: {}, items: {} };
  }
}

/** Trust only string->string; a malformed index should degrade to no icons, not crash. */
function stringMap(node: unknown): Record<string, string> {
  if (node === null || typeof node !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Runs the extractor over an install and stores the result.
 *
 * Synchronous and potentially several seconds — it reads a 160 MB resource zip and writes
 * 1,610 textures. The renderer shows a spinner; splitting this across progress events would
 * mean threading a callback through the extractor for a one-off operation.
 */
export function runExtract(installPath: string): ExtractResult {
  let summary: ExtractSummary;
  try {
    const install = locateInstall(resolve(installPath));
    const snapshot = extract(install);

    // A packaged app has no repo to write into, and a checkout should not have its committed
    // `data/` overwritten by a click. Both go to userData.
    const { snapshotPath, assetsDir } = userDataSnapshot();
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");

    // The item pass opens every jar in `mods/` — 399 of them in this pack — so it only runs
    // for ids a gear base actually names.
    const itemIds = gearItemIds(snapshot);
    const assets = extractAssets(install, assetsDir, { itemIds });
    const d = snapshot.diagnostics;

    summary = {
      snapshotPath,
      assetsDir,
      mineAndSlashVersion: install.mineAndSlashVersion,
      packIds: install.openLoaderPacks.map((p) => p.id),
      entries: Object.values(snapshot.registries).reduce((n, r) => n + Object.keys(r).length, 0),
      langKeys: Object.keys(snapshot.lang).length,
      codeOnlyStats: d.codeOnlyStats.length,
      duplicateIds: d.duplicateIds.length,
      idMismatches: d.idMismatches.length,
      assetsWritten: assets.written,
      itemIcons: { resolved: Object.keys(assets.index.items).length, total: itemIds.length },
      unresolvedItems: assets.unresolvedItems,
      // The extractor's own fail-loud gate, surfaced rather than swallowed: these mean the
      // engine would be guessing about schema, not that the pack is merely untidy.
      fatal: [
        ...d.unknownStatSerializers.map((u) => `unknown stat serializer: ${u.id} (ser="${u.ser}")`),
        ...d.unknownMultiUseTypes.map((u) => `unknown multiUseType: ${u.id} ("${u.value}")`),
        ...d.unknownModifierTypes.map((u) => `unknown modifier type: ${u.stat} ("${u.type}")`),
        ...d.parseFailures.map((f) => `could not parse ${f.origin}: ${f.error}`),
      ],
    };

    updateSettings({ snapshotPath, assetsDir, installPath: install.gameDir });
  } catch (err) {
    if (err instanceof LocateError) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, summary };
}

/**
 * What data the app is running on, and whether the install has moved on since.
 *
 * The staleness check is the reason `snapshot.meta.fingerprint` exists: a modpack update
 * replaces the Mine and Slash jar and the OpenLoader packs underneath a snapshot that then
 * silently keeps answering with the old registry. Comparing sizes and mtimes costs a handful of
 * `stat` calls, against re-reading a few hundred megabytes of archives to be sure.
 *
 * A snapshot with no recorded install cannot be checked at all — `staleReason` says so rather
 * than reporting a clean bill of health it has not earned.
 */
export function dataStatus(): DataStatus {
  const settings = readSettings();
  const payload = loadSnapshot();

  const base: DataStatus = {
    snapshotPath: payload?.path ?? null,
    assetsDir: payload?.assetsDir ?? null,
    installPath: settings.installPath ?? null,
    mineAndSlashVersion: null,
    packIds: [],
    extractedAt: null,
    entries: 0,
    langKeys: 0,
    assetsWritten: payload ? Object.keys(payload.assets).length : 0,
    itemIcons: payload ? Object.keys(payload.itemIcons).length : 0,
    stale: false,
    staleReason: payload === null ? "Nothing has been extracted yet." : null,
    fromRepo: payload !== null && payload.path === repoData()?.snapshotPath,
  };
  if (payload === null) return base;

  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(payload.json) as Snapshot;
  } catch {
    return { ...base, stale: true, staleReason: "The snapshot file could not be parsed." };
  }

  const meta = snapshot.meta;
  const status: DataStatus = {
    ...base,
    mineAndSlashVersion: meta?.mineAndSlashVersion ?? null,
    packIds: meta?.openLoaderPackIds ?? [],
    extractedAt: meta?.extractedAt ?? null,
    entries: Object.values(snapshot.registries ?? {}).reduce((n, r) => n + Object.keys(r).length, 0),
    langKeys: Object.keys(snapshot.lang ?? {}).length,
  };

  const installPath = settings.installPath ?? meta?.gameDir ?? null;
  if (installPath === null) {
    return { ...status, staleReason: "No install folder was recorded, so drift cannot be checked." };
  }
  if (meta?.fingerprint === undefined) {
    return {
      ...status,
      staleReason: "This snapshot predates fingerprinting, so drift cannot be checked.",
    };
  }

  try {
    const install = locateInstall(installPath);
    if (fingerprintsMatch(meta.fingerprint, fingerprintInstall(install))) return status;
    return {
      ...status,
      installPath,
      stale: true,
      staleReason:
        install.mineAndSlashVersion === meta.mineAndSlashVersion
          ? `The pack files under ${installPath} have changed since this snapshot was taken.`
          : `The install is now Mine and Slash ${install.mineAndSlashVersion}; this snapshot was taken from ${meta.mineAndSlashVersion}.`,
    };
  } catch (err) {
    return {
      ...status,
      installPath,
      staleReason: `Could not read ${installPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Clears the stored snapshot so the next launch goes back to the first-run screen. */
export function forgetSnapshot(): void {
  updateSettings({ snapshotPath: null, assetsDir: null, installPath: null });
}

/** The directory the asset protocol serves out of, or null when nothing was extracted. */
export function currentAssetsDir(): string | null {
  const settings = readSettings();
  if (settings.assetsDir && existsSync(settings.assetsDir)) return settings.assetsDir;
  const repo = repoData();
  if (repo && existsSync(repo.assetsDir)) return repo.assetsDir;
  const user = userDataSnapshot();
  return existsSync(user.assetsDir) ? user.assetsDir : null;
}
