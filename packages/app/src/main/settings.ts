/**
 * Persistent app settings, in `userData/settings.json`.
 *
 * Small enough to read and write whole every time — a handful of fields, most of which change
 * once per session. A corrupt or missing file resets to defaults rather than failing to start:
 * the only things in here that cannot be recovered by re-running the extractor are the
 * recent-builds list and the window placement, and neither is worth a startup failure.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { app, screen } from "electron";

import type { RecentBuild } from "@shared/ipc";

export type Settings = {
  /** Absolute path to the snapshot JSON, or null before the first extraction. */
  snapshotPath: string | null;
  /** Absolute path to the extracted GUI textures. */
  assetsDir: string | null;
  /** The install the snapshot came from, so re-extracting does not re-ask. */
  installPath: string | null;
  recentBuilds: RecentBuild[];
  /**
   * Where the window was and how big, so the next launch opens where the last one closed.
   *
   * Null until the first close. Restored through `BrowserWindow`'s own bounds rather than
   * remembered coordinates being trusted blindly: a monitor that has since been unplugged would
   * otherwise put the window somewhere nothing can reach, so {@link liveWindowBounds} drops a
   * position no current display contains and keeps the size.
   */
  windowBounds: WindowBounds | null;
  /** Whether the window was maximised when it closed. */
  windowMaximised: boolean;
};

export type WindowBounds = { x: number; y: number; width: number; height: number };

const DEFAULTS: Settings = {
  snapshotPath: null,
  assetsDir: null,
  installPath: null,
  recentBuilds: [],
  windowBounds: null,
  windowMaximised: false,
};

const MAX_RECENT = 10;

/** Slack on the top-left reachability test, for a window sitting flush against an edge. */
const TOLERANCE = 32;

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function readSettings(): Settings {
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULTS };
    const node = parsed as Record<string, unknown>;
    return {
      snapshotPath: stringOrNull(node["snapshotPath"]),
      assetsDir: stringOrNull(node["assetsDir"]),
      installPath: stringOrNull(node["installPath"]),
      recentBuilds: Array.isArray(node["recentBuilds"])
        ? node["recentBuilds"].filter(isRecentBuild).slice(0, MAX_RECENT)
        : [],
      windowBounds: asBounds(node["windowBounds"]),
      windowMaximised: node["windowMaximised"] === true,
    };
  } catch {
    // Missing or unreadable: start fresh. Nothing here is unrecoverable.
    return { ...DEFAULTS };
  }
}

export function writeSettings(settings: Settings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  writeSettings(next);
  return next;
}

/** Moves a path to the front of the recent list, dropping any stale duplicate. */
export function rememberBuild(path: string, name: string): void {
  const settings = readSettings();
  const entry: RecentBuild = { path, name, openedAt: new Date().toISOString() };
  const rest = settings.recentBuilds.filter((r) => r.path !== path);
  writeSettings({ ...settings, recentBuilds: [entry, ...rest].slice(0, MAX_RECENT) });
}

/** Recent entries whose file still exists. A build deleted on disk should stop being offered. */
export function liveRecentBuilds(): RecentBuild[] {
  const settings = readSettings();
  const live = settings.recentBuilds.filter((r) => existsSync(r.path));
  if (live.length !== settings.recentBuilds.length) {
    writeSettings({ ...settings, recentBuilds: live });
  }
  return live;
}

/**
 * The remembered placement, minus a position no display can show any more.
 *
 * Restoring saved coordinates unconditionally is the classic way to lose a window: close the
 * app docked to a second monitor, unplug it, and the next launch puts the window at x=2600 on a
 * single 1920-wide screen where nothing can drag it back. Electron centres a window with no
 * position, so dropping the coordinates and keeping the size degrades exactly the right way.
 *
 * A window is counted as reachable when its top-left corner is inside some display's work area,
 * which is what the user can actually grab hold of.
 */
export function liveWindowBounds(): {
  bounds: WindowBounds | Pick<WindowBounds, "width" | "height"> | null;
  maximised: boolean;
} {
  const settings = readSettings();
  const saved = settings.windowBounds;
  if (saved === null) return { bounds: null, maximised: settings.windowMaximised };

  const reachable = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      saved.x >= area.x - TOLERANCE &&
      saved.y >= area.y - TOLERANCE &&
      saved.x < area.x + area.width &&
      saved.y < area.y + area.height
    );
  });

  return {
    bounds: reachable ? saved : { width: saved.width, height: saved.height },
    maximised: settings.windowMaximised,
  };
}

/** Remembers where the window is. Best-effort: a failed write must never block a close. */
export function rememberWindow(bounds: WindowBounds, maximised: boolean): void {
  try {
    writeSettings({ ...readSettings(), windowBounds: bounds, windowMaximised: maximised });
  } catch {
    // Ignored on purpose.
  }
}

export function autosavePath(): string {
  return join(app.getPath("userData"), "autosave.json");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A bounds object only survives a read if every field is a real number. */
function asBounds(value: unknown): WindowBounds | null {
  if (value === null || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  const nums = ["x", "y", "width", "height"].map((key) => node[key]);
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [x, y, width, height] = nums as number[];
  if (width! < 1 || height! < 1) return null;
  return { x: x!, y: y!, width: width!, height: height! };
}

function isRecentBuild(value: unknown): value is RecentBuild {
  if (value === null || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return typeof node["path"] === "string" && typeof node["name"] === "string";
}
