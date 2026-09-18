/**
 * The only bridge between the renderer and the outside world.
 *
 * Nothing here does work of its own beyond building asset URLs — every call forwards to a
 * channel declared in `@shared/ipc`, so the renderer cannot reach a filesystem path or an
 * Electron API that was not deliberately exposed.
 */

import type { BuildDoc } from "@cte2/schema";
import { contextBridge, ipcRenderer } from "electron";

import {
  assetUrlFor,
  CHANNEL,
  UNKNOWN_ICON,
  type Cte2Api,
  type MenuCommand,
  type PinnedBaseline,
  type SnapshotPayload,
} from "@shared/ipc";

/**
 * Resource path -> relative file, cached from the snapshot payload.
 *
 * `assetUrl` is called once per node per repaint on the talent tree, which is thousands of
 * times a second while panning. It has to be synchronous and local, so the index is kept here
 * rather than round-tripped to main.
 */
let assetIndex: Record<string, string> = {};

/** Item id -> relative file, for gear sprites. Cached for the same reason. */
let itemIconIndex: Record<string, string> = {};

const api: Cte2Api = {
  platform: "electron",

  // Everything, which is the point of the desktop build: it is the only host that can read a
  // modpack folder, and therefore the only one that can produce a snapshot in the first place.
  capabilities: {
    extract: true,
    saveInPlace: true,
    recentBuilds: true,
    nativeMenu: true,
    loadOwnSnapshot: false,
  },

  async getSnapshot() {
    const payload = (await ipcRenderer.invoke(CHANNEL.getSnapshot)) as SnapshotPayload | null;
    assetIndex = payload?.assets ?? {};
    itemIconIndex = payload?.itemIcons ?? {};
    return payload;
  },

  chooseInstall: () => ipcRenderer.invoke(CHANNEL.chooseInstall),
  runExtract: (installPath: string) => ipcRenderer.invoke(CHANNEL.runExtract, installPath),
  forgetSnapshot: () => ipcRenderer.invoke(CHANNEL.forgetSnapshot),
  dataStatus: () => ipcRenderer.invoke(CHANNEL.dataStatus),

  openBuild: () => ipcRenderer.invoke(CHANNEL.openBuild),
  saveBuild: (doc: BuildDoc, path?: string) => ipcRenderer.invoke(CHANNEL.saveBuild, doc, path),
  recentBuilds: () => ipcRenderer.invoke(CHANNEL.recentBuilds),
  openBuildAt: (path: string) => ipcRenderer.invoke(CHANNEL.openBuildAt, path),
  autosave: (doc: BuildDoc, baseline: PinnedBaseline | null) =>
    ipcRenderer.invoke(CHANNEL.autosave, doc, baseline),
  loadAutosave: () => ipcRenderer.invoke(CHANNEL.loadAutosave),

  onMenuCommand(handler) {
    const listener = (_event: unknown, command: MenuCommand): void => handler(command);
    ipcRenderer.on(CHANNEL.menuCommand, listener);
    return () => ipcRenderer.removeListener(CHANNEL.menuCommand, listener);
  },

  assetUrl(resourcePath: string) {
    // Falls back to the mod's own placeholder, because 51 perk icons in this pack name a
    // texture that is in no archive. Doing it here keeps the renderer from needing to know.
    const relative = assetIndex[resourcePath] ?? assetIndex[UNKNOWN_ICON];
    return relative === undefined ? null : assetUrlFor(relative);
  },

  itemIconUrl(itemId: string) {
    // No placeholder fallback here. A missing gear sprite means the item is vanilla, whose
    // textures are in the client jar — showing the mod's unknown-perk glyph for a diamond sword
    // would be worse than showing nothing, and the caller can render the item's name instead.
    const relative = itemIconIndex[itemId];
    return relative === undefined ? null : assetUrlFor(relative);
  },
};

contextBridge.exposeInMainWorld("cte2", api);
