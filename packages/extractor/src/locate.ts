/**
 * Resolves a Craft to Exile 2 install into the specific files the extractor reads.
 *
 * The modpack folder is treated as read-only input: nothing here writes, and the caller
 * passes the root in rather than the extractor hardcoding one person's Prism path.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type OpenLoaderPack = {
  /** Pack folder name, e.g. "cte_mns". */
  id: string;
  /** Absolute path to the pack's `data/mmorpg` directory. */
  mmorpgDir: string;
};

export type Install = {
  /** The resolved `minecraft` (game) directory. */
  gameDir: string;
  /** Mine and Slash jar — the default datapack and the authoritative registry list. */
  mineAndSlashJar: string;
  /** Version parsed from the jar filename, e.g. "1.20.1-6.4.7". */
  mineAndSlashVersion: string;
  /** Library of Exile jar, when present. Recorded for provenance, not currently read. */
  libraryOfExileJar: string | null;
  /** Every OpenLoader data pack contributing an `mmorpg` directory, in load order. */
  openLoaderPacks: OpenLoaderPack[];
  /** OpenLoader resource zips, newest-listed last; searched for lang overrides. */
  resourceZips: string[];
  /**
   * World datapack directories found under `saves/`. Not yet merged — recorded so the
   * caller can warn rather than silently producing numbers that ignore them.
   */
  worldDatapackDirs: string[];
};

export class LocateError extends Error {}

/**
 * @param root Either the Prism instance folder (containing `minecraft/`) or the game
 *   directory itself. Both are accepted because players paste either one.
 */
export function locateInstall(root: string): Install {
  const gameDir = resolveGameDir(root);

  const modsDir = join(gameDir, "mods");
  if (!isDir(modsDir)) throw new LocateError(`No mods directory under ${gameDir}`);

  const mineAndSlashJar = findJar(modsDir, /^Mine[_ ]and[_ ]Slash-(.+)\.jar$/i);
  if (!mineAndSlashJar) {
    throw new LocateError(
      `No Mine and Slash jar in ${modsDir}. Is this a Craft to Exile 2 instance?`,
    );
  }
  const mineAndSlashVersion =
    /^Mine[_ ]and[_ ]Slash-(.+)\.jar$/i.exec(basename(mineAndSlashJar))?.[1] ?? "unknown";

  return {
    gameDir,
    mineAndSlashJar,
    mineAndSlashVersion,
    libraryOfExileJar: findJar(modsDir, /^Library[_ ]of[_ ]Exile-.+\.jar$/i),
    openLoaderPacks: findOpenLoaderPacks(gameDir),
    resourceZips: findResourceZips(gameDir),
    worldDatapackDirs: findWorldDatapackDirs(gameDir),
  };
}

function resolveGameDir(root: string): string {
  if (!existsSync(root)) throw new LocateError(`Path does not exist: ${root}`);
  if (!isDir(root)) throw new LocateError(`Not a directory: ${root}`);

  // Accept the game dir directly, or an instance folder wrapping it. Prism uses
  // `minecraft`; MultiMC and vanilla launchers use `.minecraft`.
  for (const candidate of [root, join(root, "minecraft"), join(root, ".minecraft")]) {
    if (isDir(join(candidate, "mods"))) return candidate;
  }
  throw new LocateError(
    `Could not find a game directory under ${root} (looked for ./mods, ./minecraft/mods, ./.minecraft/mods)`,
  );
}

function findJar(modsDir: string, pattern: RegExp): string | null {
  const matches = readdirSync(modsDir)
    .filter((name) => pattern.test(name))
    .sort();
  if (matches.length === 0) return null;
  // Multiple copies usually means a stale jar was left behind; last-sorted is the
  // higher version, which is what Forge would end up loading.
  return join(modsDir, matches[matches.length - 1]!);
}

function findOpenLoaderPacks(gameDir: string): OpenLoaderPack[] {
  const dataRoot = join(gameDir, "config", "openloader", "data");
  if (!isDir(dataRoot)) return [];

  const packs: OpenLoaderPack[] = [];
  for (const id of readdirSync(dataRoot).sort()) {
    const packDir = join(dataRoot, id);
    if (!isDir(packDir)) continue;
    // OpenLoader packs may be laid out as `<pack>/data/<namespace>` (a datapack root) or
    // may nest one level deeper. Only `mmorpg` matters here.
    for (const candidate of [join(packDir, "data", "mmorpg"), join(packDir, "mmorpg")]) {
      if (isDir(candidate)) {
        packs.push({ id, mmorpgDir: candidate });
        break;
      }
    }
  }
  return packs;
}

function findResourceZips(gameDir: string): string[] {
  const resourceRoot = join(gameDir, "config", "openloader", "resources");
  if (!isDir(resourceRoot)) return [];
  return readdirSync(resourceRoot)
    .filter((name) => name.toLowerCase().endsWith(".zip"))
    .sort()
    .map((name) => join(resourceRoot, name));
}

function findWorldDatapackDirs(gameDir: string): string[] {
  const savesDir = join(gameDir, "saves");
  if (!isDir(savesDir)) return [];
  const out: string[] = [];
  for (const world of readdirSync(savesDir)) {
    const datapacks = join(savesDir, world, "datapacks");
    if (isDir(datapacks) && readdirSync(datapacks).length > 0) out.push(datapacks);
  }
  return out;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
