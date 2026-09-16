/**
 * Resolves a Craft to Exile 2 install into the specific files the extractor reads.
 *
 * The modpack folder is treated as read-only input: nothing here writes, and the caller
 * passes the root in rather than the extractor hardcoding one person's Prism path.
 */

import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";

/** One `<namespace>` directory inside a datapack root — the `<ns>` in `data/<ns>/<registry>/`. */
export type PackNamespace = {
  namespace: string;
  /** Absolute path to that directory. */
  dir: string;
};

export type OpenLoaderPack = {
  /** Pack folder name, e.g. "cte_mns". */
  id: string;
  /** The datapack root its namespaces sit in — `<pack>/data`, or `<pack>` when it has none. */
  dataRoot: string;
  /**
   * Every namespace directory under that root, sorted.
   *
   * Not just `mmorpg`. Mine and Slash's sibling mods register Exile registries of their own
   * under their own namespaces — `library_of_exile`, `dungeon_realm`, `ancient_obelisks` and
   * `the_harvest` between them declare 21 registry types — and Craft to Exile 2 ships data for
   * every one. Looking only for `mmorpg` dropped 337 files in this pack and skipped three
   * OpenLoader packs whole for not having an `mmorpg` folder at all, with nothing reporting
   * either.
   *
   * Discovering the list rather than naming it is deliberate: a namespace a future pack adds
   * then arrives the same way a new registry category already does, instead of needing this
   * file edited.
   */
  namespaces: PackNamespace[];
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
  /** Every OpenLoader data pack contributing at least one namespace, in load order. */
  openLoaderPacks: OpenLoaderPack[];
  /**
   * OpenLoader resource packs, newest-listed last; searched for lang and texture overrides.
   *
   * Each is either a `.zip` or an unpacked pack directory — OpenLoader accepts both, and
   * Craft to Exile 2 switched from `resources.zip` to a `resources/` folder. `openArchive`
   * hides the difference.
   */
  resourcePacks: string[];
  /**
   * Every jar in `mods/`, sorted.
   *
   * Gear bases name items belonging to other mods (`roe_weapons:bow_3`,
   * `cte_essentials:cloth_0_boots`), so resolving an item icon means looking outside Mine and
   * Slash. Listing them costs a `readdir`; opening them is the asset pass's business.
   */
  modJars: string[];
  /**
   * World datapack directories found under `saves/`. Not yet merged — recorded so the
   * caller can warn rather than silently producing numbers that ignore them.
   */
  worldDatapackDirs: string[];
};

/**
 * A stat-only summary of the archives a snapshot was built from.
 *
 * The point is to answer "has the modpack changed since this was extracted?" without re-reading
 * a few hundred megabytes of jars. Jars are stat-ed directly; a pack namespace is *rolled up* —
 * total bytes and newest mtime over every file beneath it — because a directory's own mtime moves
 * only when an entry is added or removed, so stat-ing it misses an edit to a file three levels
 * down, which is exactly the shape a pack update takes.
 *
 * That roll-up is a stat per file, so it costs about 0.7 s across this pack's ~8,700 files. That
 * is affordable because nothing calls it on the launch path: the extractor writes it once, and
 * the app reads it only when the Data panel is opened, in the main process, behind async IPC.
 * Putting it anywhere a repaint waits on would need a different design, not a bigger budget.
 *
 * What still slips through is an edit changing neither total size nor any mtime, which takes
 * deliberate effort to produce; a manual re-extract covers it.
 */
export type InstallFingerprint = {
  files: { path: string; size: number; mtimeMs: number }[];
};

export function fingerprintInstall(install: Install): InstallFingerprint {
  const files: InstallFingerprint["files"] = [];

  const add = (path: string): void => {
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) {
        const rolled = rollUpDirectory(path);
        files.push({ path, size: rolled.size, mtimeMs: rolled.mtimeMs });
      } else {
        files.push({ path, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      }
    } catch {
      // A path that vanished between locating and fingerprinting is itself a difference; the
      // comparison sees a missing entry and reports drift.
    }
  };

  add(install.mineAndSlashJar);
  if (install.libraryOfExileJar !== null) add(install.libraryOfExileJar);
  for (const pack of install.openLoaderPacks) {
    for (const ns of pack.namespaces) add(ns.dir);
  }
  for (const resourcePack of install.resourcePacks) add(resourcePack);

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

/** Total bytes and newest mtime over every file beneath `dir`, recursively. */
function rollUpDirectory(dir: string): { size: number; mtimeMs: number } {
  let size = 0;
  let mtimeMs = 0;

  const walk = (path: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = statSync(full);
        size += stat.size;
        mtimeMs = Math.max(mtimeMs, Math.round(stat.mtimeMs));
      } catch {
        // Unreadable now means a difference next time, which is the answer we want anyway.
      }
    }
  };

  walk(dir);
  return { size, mtimeMs };
}

/** True when the two fingerprints describe the same set of archives, unchanged. */
export function fingerprintsMatch(a: InstallFingerprint, b: InstallFingerprint): boolean {
  if (a.files.length !== b.files.length) return false;
  return a.files.every((file, index) => {
    const other = b.files[index];
    return (
      other !== undefined &&
      other.path === file.path &&
      other.size === file.size &&
      other.mtimeMs === file.mtimeMs
    );
  });
}

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
    modJars: readdirSync(modsDir)
      .filter((name) => name.toLowerCase().endsWith(".jar"))
      .sort()
      .map((name) => join(modsDir, name)),
    openLoaderPacks: findOpenLoaderPacks(gameDir),
    resourcePacks: findResourcePacks(gameDir),
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

    // OpenLoader packs may be laid out as `<pack>/data/<namespace>` (a datapack root) or may
    // nest one level deeper, so the root is `data/` where it exists and the pack folder itself
    // otherwise. Every directory under that root is a namespace.
    const root = isDir(join(packDir, "data")) ? join(packDir, "data") : packDir;
    const namespaces: PackNamespace[] = [];
    for (const namespace of readdirSync(root).sort()) {
      // Skip tooling/editor directories that live alongside the data (e.g. `.claude`).
      if (namespace.startsWith(".")) continue;
      const dir = join(root, namespace);
      if (isDir(dir)) namespaces.push({ namespace, dir });
    }

    if (namespaces.length > 0) packs.push({ id, dataRoot: root, namespaces });
  }
  return packs;
}

/**
 * Resource packs under `config/openloader/resources`, zipped or unpacked.
 *
 * A directory counts only when it actually looks like a pack root (`pack.mcmeta` or an
 * `assets/` folder). That check matters because OpenLoader's own folder may hold unrelated
 * subdirectories, and treating one of those as a pack would shadow real entries with nothing.
 */
function findResourcePacks(gameDir: string): string[] {
  const resourceRoot = join(gameDir, "config", "openloader", "resources");
  if (!isDir(resourceRoot)) return [];
  const out: string[] = [];
  for (const name of readdirSync(resourceRoot).sort()) {
    const full = join(resourceRoot, name);
    if (name.toLowerCase().endsWith(".zip")) out.push(full);
    else if (isDir(full) && (isFile(join(full, "pack.mcmeta")) || isDir(join(full, "assets")))) {
      out.push(full);
    }
  }
  return out;
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
