/**
 * The main/renderer contract.
 *
 * Declared once and imported by all three layers, so a channel cannot be added on one side and
 * misspelled on the other. Every payload here is structured-cloneable — no class instances, no
 * functions.
 */

import type { BuildDoc, Observation } from "@cte2/schema";

export const CHANNEL = {
  getSnapshot: "snapshot:get",
  chooseInstall: "snapshot:choose-install",
  runExtract: "snapshot:extract",
  forgetSnapshot: "snapshot:forget",
  dataStatus: "snapshot:status",

  openBuild: "build:open",
  /** Reopen a known path — what the recent list clicks through to, with no file dialog. */
  openBuildAt: "build:open-at",
  saveBuild: "build:save",
  recentBuilds: "build:recent",
  autosave: "build:autosave",
  loadAutosave: "build:load-autosave",

  /**
   * The only push channel in the app: main -> renderer, when a menu item is chosen.
   *
   * Everything else here is `invoke`/response, because the renderer asks and main answers. A menu
   * is the one thing that originates in main, and it deliberately carries a *command name* rather
   * than doing anything itself — the handlers already exist in the renderer, and a menu that
   * reimplemented them would be a second way to save a file.
   */
  menuCommand: "menu:command",
} as const;

/**
 * What a menu item asks the renderer to do.
 *
 * `tab:<id>` selects a tab; the rest map one-to-one onto buttons that already exist in the chrome.
 */
export type MenuCommand =
  | "new"
  | "open"
  | "save"
  | "save-as"
  | "copy-json"
  | "undo"
  | "redo"
  | "toggle-sidebar"
  | "pin-baseline"
  | "clear-baseline"
  | `tab:${string}`
  /** Reopen a known path from the Open Recent submenu. */
  | `open-at:${string}`;

/**
 * A loaded snapshot, as JSON text rather than a parsed object.
 *
 * The file is 9.3 MB. Parsing it in main and sending the object graph would pay for a
 * structured clone of ~200,000 nested objects; sending the text and parsing once in the
 * renderer is a single large string copy and one parse.
 */
export type SnapshotPayload = {
  json: string;
  /** Where it was read from, shown in the status bar. */
  path: string;
  /** Directory the extracted GUI textures live in, if any were extracted. */
  assetsDir: string | null;
  /** Resource path -> path relative to `assetsDir`. Empty when assets are missing. */
  assets: Record<string, string>;
  /**
   * Minecraft item id -> path relative to `assetsDir`, for gear sprites.
   *
   * Keyed separately from `assets` because these are not `namespace:textures/...` references —
   * they are resolved out of other mods' item models, so an id is all a caller has.
   */
  itemIcons: Record<string, string>;
};

/**
 * What the app knows about the data it is running on, for the Data panel.
 *
 * `stale` is the whole point: a modpack update replaces the jars underneath a snapshot and
 * nothing else would notice. It is computed by comparing the fingerprint recorded at extraction
 * against the install as it is now — see `fingerprintsMatch`.
 */
export type DataStatus = {
  /** Where the snapshot was read from, or null on first run. */
  snapshotPath: string | null;
  assetsDir: string | null;
  /** The install folder extraction last used, when one was recorded. */
  installPath: string | null;
  mineAndSlashVersion: string | null;
  packIds: string[];
  extractedAt: string | null;
  entries: number;
  langKeys: number;
  assetsWritten: number;
  itemIcons: number;
  /** True when the install on disk no longer matches what was extracted. */
  stale: boolean;
  /** Why it is stale, or why the check could not be made. */
  staleReason: string | null;
  /**
   * True when the snapshot in use is the repository's `data/snapshot.json` rather than one the
   * app produced. Re-extracting writes to userData and will take precedence next launch.
   */
  fromRepo: boolean;
};

/** What the extractor found, summarised for the first-run screen. */
export type ExtractSummary = {
  snapshotPath: string;
  assetsDir: string;
  mineAndSlashVersion: string;
  packIds: string[];
  entries: number;
  langKeys: number;
  codeOnlyStats: number;
  duplicateIds: number;
  idMismatches: number;
  assetsWritten: number;
  /** Gear sprites resolved, out of how many item ids the gear bases name. */
  itemIcons: { resolved: number; total: number };
  /** Item ids no sprite could be found for — vanilla items, mostly. */
  unresolvedItems: string[];
  /** Non-empty means the snapshot is not trustworthy — the extractor's fail-loud gate. */
  fatal: string[];
};

export type ExtractResult = { ok: true; summary: ExtractSummary } | { ok: false; error: string };

export type SaveResult = { ok: true; path: string } | { ok: false; cancelled: boolean; error?: string };

export type OpenResult =
  | {
      ok: true;
      path: string;
      doc: BuildDoc;
      /**
       * Present when the file opened was a **capture** rather than a hand-built document: the
       * game's own stat sheet for this character, straight out of the exporter. It is what lets
       * the app say "the game reads 4601 health and so do we" instead of asking you to trust it.
       */
      observed?: Observation;
    }
  | { ok: false; cancelled: boolean; error?: string };

export type RecentBuild = { path: string; name: string; openedAt: string };

/**
 * A build held still, to measure the one being edited against.
 *
 * The whole document rather than a set of figures, because what you want to compare changes after
 * you pin it: the figures are `vitalsOf(doc)`, and a stat you had not thought about when you
 * pinned is still in there.
 *
 * Declared here rather than in the store because it crosses the process boundary — it is session
 * state, and a session that forgot what you were comparing against every time you closed the
 * window would not be worth pinning anything in.
 */
export type PinnedBaseline = {
  doc: BuildDoc;
  /** What to call it on screen: the build's own name, or the file it was opened from. */
  name: string;
  /** When it was pinned, ISO — so the Compare tab can say how old the comparison is. */
  pinnedAt: string;
};

/**
 * What the autosave file holds: the document you had open, and what you were comparing it against.
 *
 * It used to be a bare `BuildDoc`, and files in that shape are still out there — including,
 * specifically, whatever build the person running this had open last. `loadAutosave` reads both;
 * see `main/builds.ts`.
 */
export type AutosaveSession = {
  doc: BuildDoc;
  baseline: PinnedBaseline | null;
};

/** The surface `preload` exposes on `window.cte2`. */
export type Cte2Api = {
  getSnapshot(): Promise<SnapshotPayload | null>;
  chooseInstall(): Promise<string | null>;
  runExtract(installPath: string): Promise<ExtractResult>;
  forgetSnapshot(): Promise<void>;
  dataStatus(): Promise<DataStatus>;

  openBuild(): Promise<OpenResult>;
  openBuildAt(path: string): Promise<OpenResult>;
  saveBuild(doc: BuildDoc, path?: string): Promise<SaveResult>;
  recentBuilds(): Promise<RecentBuild[]>;
  autosave(doc: BuildDoc, baseline: PinnedBaseline | null): Promise<void>;
  loadAutosave(): Promise<AutosaveSession | null>;

  /**
   * Subscribe to menu commands. Returns an unsubscribe function.
   *
   * The renderer owns what a command *means*; main only says which one was picked.
   */
  onMenuCommand(handler: (command: MenuCommand) => void): () => void;

  /** `"mmorpg:textures/gui/..."` -> a `cte2-asset://` URL, or null when it was not extracted. */
  assetUrl(resourcePath: string): string | null;
  /** `"roe_weapons:bow_3"` -> a `cte2-asset://` URL for its item sprite, or null. */
  itemIconUrl(itemId: string): string | null;
};

/**
 * The scheme extracted textures are served over.
 *
 * A custom protocol rather than `file://` with `webSecurity` disabled: the renderer stays
 * sandboxed, and main keeps the only mapping from a resource path to a location on disk.
 */
export const ASSET_SCHEME = "cte2-asset";

/**
 * The placeholder Mine and Slash ships for a texture that is not there.
 *
 * 51 of the pack's perk icons name a PNG that exists in no archive at all — not the jar, not
 * the resource pack, not under any other path. That is a pack bug, and the game renders the
 * missing-texture square for them; using the mod's own `unknown.png` is the closest honest
 * equivalent. Duplicated from `@cte2/extractor`'s `UNKNOWN_ICON` rather than imported, because
 * that module's barrel pulls in `node:fs` and this file is loaded by the renderer.
 */
export const UNKNOWN_ICON = "mmorpg:textures/gui/talent_icons/unknown.png";

/** Built in the preload so the renderer never sees a filesystem path. */
export function assetUrlFor(relative: string): string {
  return `${ASSET_SCHEME}://asset/${relative.split("/").map(encodeURIComponent).join("/")}`;
}
