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
  SNAPSHOT_VERSION,
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
  let current = app.getAppPath();
  for (let i = 0; i < 5; i++) {
    const snapshotPath = join(current, "data", "snapshot.json");
    if (existsSync(snapshotPath)) {
      return { snapshotPath, assetsDir: join(current, "data", "assets") };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Core registries required for a complete v2 snapshot. */
export const REQUIRED_V2_REGISTRIES = [
  "library_of_exile_currency",
  "library_of_exile_item_modification",
  "library_of_exile_item_requirement",
  "mmorpg_affixes",
  "mmorpg_base_gear_types",
  "mmorpg_gear_rarity",
  "mmorpg_spells",
  "mmorpg_stat",
] as const;

type CandidatePath = { snapshotPath: string; assetsDir: string | null };

type CandidateInspection = {
  candidate: CandidatePath;
  json: string;
  snapshot: Snapshot;
  version: number;
  isUpToDate: boolean;
  missingRegistries: string[];
};

let activeAssetsDir: string | null = null;

function inspectCandidate(candidate: CandidatePath | null): CandidateInspection | null {
  if (!candidate || !existsSync(candidate.snapshotPath)) return null;
  let json: string;
  try {
    json = readFileSync(candidate.snapshotPath, "utf8");
  } catch {
    return null;
  }

  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(json) as Snapshot;
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== "object" || !snapshot.registries) return null;

  const version = typeof snapshot.snapshotVersion === "number" ? snapshot.snapshotVersion : 1;
  const missingRegistries = REQUIRED_V2_REGISTRIES.filter((r) => !snapshot.registries[r]);
  const isUpToDate = version >= SNAPSHOT_VERSION && missingRegistries.length === 0;

  return { candidate, json, snapshot, version, isUpToDate, missingRegistries };
}

function normalizeSnapshot(snapshot: Snapshot): { snapshot: Snapshot; json: string } {
  const registries = { ...snapshot.registries };
  for (const r of REQUIRED_V2_REGISTRIES) {
    if (!registries[r]) {
      registries[r] = {};
    }
  }
  const externalConfig = snapshot.externalConfig ?? { foodDiversity: null, serverConfig: null };
  const normalized: Snapshot = {
    ...snapshot,
    registries,
    externalConfig,
  };
  return { snapshot: normalized, json: JSON.stringify(normalized) };
}

function toPayload(inspected: CandidateInspection): SnapshotPayload {
  const assetsDir = inspected.candidate.assetsDir ?? null;
  activeAssetsDir = assetsDir;
  const index = assetsDir ? readAssetIndex(assetsDir) : { assets: {}, items: {} };
  return {
    json: inspected.json,
    path: inspected.candidate.snapshotPath,
    assetsDir,
    assets: index.assets,
    itemIcons: index.items,
  };
}

/**
 * Reads the snapshot text and the asset index.
 *
 * Checks candidates for schema currency and completeness:
 *   1. Prioritizes up-to-date snapshots matching `SNAPSHOT_VERSION`. In dev checkout,
 *      prefers `data/snapshot.json` if up to date.
 *   2. If all snapshots are on an outdated schema, auto-migrates via `runExtract` if a
 *      valid install is found.
 *   3. If re-extraction cannot run, falls back to a normalized snapshot ensuring missing
 *      registries are empty rather than undefined, allowing the app to run with warnings.
 */
export function loadSnapshot(): SnapshotPayload | null {
  const settings = readSettings();
  const repo = repoData();
  const user = userDataSnapshot();

  const configured = settings.snapshotPath
    ? { snapshotPath: settings.snapshotPath, assetsDir: settings.assetsDir }
    : null;

  // In development, prefer repoData() if it is present and up-to-date,
  // matching the design promise in the module header.
  const candidates: CandidatePath[] = [];
  if (repo) candidates.push(repo);
  if (configured && (!repo || configured.snapshotPath !== repo.snapshotPath)) {
    candidates.push(configured);
  }
  if (!configured || configured.snapshotPath !== user.snapshotPath) {
    candidates.push(user);
  }

  const inspectedList: CandidateInspection[] = [];
  for (const c of candidates) {
    const inspected = inspectCandidate(c);
    if (inspected) inspectedList.push(inspected);
  }

  // 1. If any candidate is up-to-date, use the first up-to-date candidate
  const upToDate = inspectedList.find((i) => i.isUpToDate);
  if (upToDate) {
    return toPayload(upToDate);
  }

  // 2. If candidates exist but all are outdated, attempt auto-migration via re-extraction
  // if an install path is available and valid.
  if (inspectedList.length > 0) {
    const installPath = settings.installPath ?? inspectedList[0]!.snapshot.meta?.gameDir ?? null;
    if (installPath && existsSync(installPath)) {
      try {
        const extractResult = runExtract(installPath);
        if (extractResult.ok) {
          const fresh = inspectCandidate(userDataSnapshot());
          if (fresh && fresh.isUpToDate) {
            return toPayload(fresh);
          }
        }
      } catch {
        // Auto-extract failed, fall through to fallback below.
      }
    }

    // 3. Fallback: normalize the best available candidate so the app does not crash on missing registries.
    const fallbackCandidate = inspectedList[0]!;
    const { json, snapshot } = normalizeSnapshot(fallbackCandidate.snapshot);
    const normalizedInspection: CandidateInspection = {
      ...fallbackCandidate,
      json,
      snapshot,
    };
    return toPayload(normalizedInspection);
  }

  if (settings.snapshotPath) updateSettings({ snapshotPath: null, assetsDir: null });
  activeAssetsDir = null;
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
    // No such thing here: a desktop snapshot is always one this app extracted, or the
    // repository's. `fromRepo` is the distinction that matters on this host.
    userSupplied: false,
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

  const version = typeof snapshot.snapshotVersion === "number" ? snapshot.snapshotVersion : 1;
  const missing = REQUIRED_V2_REGISTRIES.filter(
    (r) => !snapshot.registries?.[r] || Object.keys(snapshot.registries[r]!).length === 0,
  );
  if (version < SNAPSHOT_VERSION || missing.length > 0) {
    return {
      ...status,
      installPath: settings.installPath ?? meta?.gameDir ?? null,
      stale: true,
      staleReason: `This snapshot uses an older schema format (v${version}, expected v${SNAPSHOT_VERSION})${
        missing.length > 0 ? ` and is missing registries: ${missing.join(", ")}` : ""
      }. Please re-extract.`,
    };
  }

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
  activeAssetsDir = null;
  updateSettings({ snapshotPath: null, assetsDir: null, installPath: null });
}

/** The directory the asset protocol serves out of, or null when nothing was extracted. */
export function currentAssetsDir(): string | null {
  if (activeAssetsDir && existsSync(activeAssetsDir)) return activeAssetsDir;
  const repo = repoData();
  if (repo && existsSync(repo.assetsDir)) return repo.assetsDir;
  const settings = readSettings();
  if (settings.assetsDir && existsSync(settings.assetsDir)) return settings.assetsDir;
  const user = userDataSnapshot();
  return existsSync(user.assetsDir) ? user.assetsDir : null;
}
