/**
 * The application menu.
 *
 * There was none at all, which meant the six keyboard shortcuts the renderer binds — undo, redo,
 * save, save-as, open — were undiscoverable: nothing on screen named them, and on Windows the
 * absence of a menu bar also removes the only conventional place to look. Electron's default menu
 * (when you set none) is a developer menu, not this app's.
 *
 * Every item sends a **command name** to the renderer rather than doing the work here. The
 * renderer already owns saving, opening and tab selection; duplicating any of it in main would
 * create a second implementation that could disagree with the button beside it. The one exception
 * is the window-level items — reload, devtools, zoom, quit — which are Electron's own roles and
 * have no renderer counterpart.
 */

import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";

import { CHANNEL, type MenuCommand } from "@shared/ipc";

import { liveRecentBuilds } from "./settings.js";
import { checkForUpdates } from "./updater.js";

/** The tabs, mirrored from the renderer's own list so View can select them. */
const TABS: { id: string; label: string }[] = [
  { id: "tree", label: "Tree" },
  { id: "classes", label: "Classes" },
  { id: "skills", label: "Skills" },
  { id: "gear", label: "Items" },
  { id: "damage", label: "Damage" },
  { id: "defence", label: "Defence" },
  { id: "compare", label: "Compare" },
  { id: "config", label: "Config" },
  { id: "stats", label: "Stats" },
  { id: "capture", label: "Capture" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "data", label: "Data" },
];

function send(window: BrowserWindow | null, command: MenuCommand): void {
  window?.webContents.send(CHANNEL.menuCommand, command);
}

/**
 * Builds and installs the menu.
 *
 * Call it again after a build is opened or saved: the Open Recent submenu is a snapshot of the
 * recent list at build time, and Electron has no way to repopulate a submenu in place.
 */
export function installMenu(window: BrowserWindow | null): void {
  const recent = liveRecentBuilds();

  const file: MenuItemConstructorOptions = {
    label: "&File",
    submenu: [
      { label: "New Build", accelerator: "CmdOrCtrl+N", click: () => send(window, "new") },
      { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => send(window, "open") },
      {
        label: "Open Recent",
        enabled: recent.length > 0,
        submenu:
          recent.length > 0
            ? recent.map((build) => ({
                label: build.name,
                toolTip: build.path,
                // Opened through the renderer's own `openBuildAt`, so a file picked here and a
                // file picked from the Recent dropdown take exactly the same path.
                click: () => send(window, `open-at:${build.path}`),
              }))
            : [{ label: "Nothing yet", enabled: false }],
      },
      { type: "separator" },
      { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send(window, "save") },
      { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => send(window, "save-as") },
      { label: "Copy Build as JSON", click: () => send(window, "copy-json") },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: "&Edit",
    submenu: [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => send(window, "undo") },
      { label: "Redo", accelerator: "CmdOrCtrl+Y", click: () => send(window, "redo") },
      { type: "separator" },
      {
        label: "Pin as Comparison Baseline",
        accelerator: "CmdOrCtrl+Shift+P",
        click: () => send(window, "pin-baseline"),
      },
      { label: "Clear Comparison Baseline", click: () => send(window, "clear-baseline") },
      { type: "separator" },
      // Roles, not commands: these act on whatever input has focus, which is a browser concern.
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: "&View",
    submenu: [
      ...TABS.map((t, i) => ({
        label: t.label,
        // Ctrl+1..9 for the first nine; the last two have no accelerator rather than a bad one.
        ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}),
        click: () => send(window, `tab:${t.id}`),
      })),
      { type: "separator" },
      {
        label: "Toggle Stat Sheet",
        accelerator: "CmdOrCtrl+B",
        click: () => send(window, "toggle-sidebar"),
      },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      { role: "reload" },
      { role: "toggleDevTools" },
    ],
  };

  const help: MenuItemConstructorOptions = {
    label: "&Help",
    submenu: [
      {
        label: "Project on GitHub",
        click: () => void shell.openExternal("https://github.com/Ryongen/cte2-pob"),
      },
      // Main's own job rather than a renderer command: the updater lives here. The answer
      // arrives in the status bar.
      { label: "Check for Updates", click: () => void checkForUpdates(true) },
      { label: `Version ${app.getVersion()}`, enabled: false },
    ],
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate([file, edit, view, help]));
}
