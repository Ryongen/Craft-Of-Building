/**
 * Electron main.
 *
 * Three jobs: own the window, own the filesystem (the renderer never touches it directly), and
 * serve the extracted textures over a custom protocol. Everything else lives in the renderer,
 * because `@cte2/schema` and `@cte2/engine` are pure and run there unchanged.
 */

import { existsSync, readFile } from "node:fs";
import { join, normalize, sep } from "node:path";

import { isSafeAssetPath } from "@cte2/extractor";
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";

import { ASSET_SCHEME, CHANNEL } from "@shared/ipc";

import { autosave, loadAutosave, openBuild, openBuildAt, saveBuild } from "./builds.js";
import { installMenu } from "./menu.js";
import { liveRecentBuilds, liveWindowBounds, rememberWindow } from "./settings.js";
import {
  currentAssetsDir,
  dataStatus,
  forgetSnapshot,
  loadSnapshot,
  runExtract,
} from "./snapshot.js";

/**
 * The app speaks en-US, including its numbers.
 *
 * Every figure here is read against the game's own rendering and against captures transcribed
 * from it, so `ui/format.ts` pins `toLocaleString` to `en-US` rather than following the system.
 * That left one surface disagreeing: Chromium renders `<input type="number">` in the *browser*
 * locale, so on this Spanish-locale machine the stat sheet read `2,420.64` while the hitbox-radius
 * box beside it read `0,3`. The input's `.value` was always canonical `"0.3"` — only the display
 * localised — but two decimal separators on one screen is the kind of thing you stop trusting.
 *
 * Forcing the switch is safe because there is no i18n to lose: the UI is English-only.
 *
 * This is one half of the decision; the other is `LOCALE` in `renderer/src/ui/format.ts`, which
 * carries the full reasoning. Changing the app's mind means changing both, and nothing else.
 */
app.commandLine.appendSwitch("lang", "en-US");

// Must be declared before `ready`. `standard` gives the scheme normal URL parsing so relative
// paths resolve; `supportFetchAPI` lets the renderer preload images through fetch if it wants.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
  },
]);

/**
 * Portable builds keep their data beside the .exe rather than in %APPDATA%.
 *
 * electron-builder's portable target sets PORTABLE_EXECUTABLE_DIR to the directory the .exe was
 * launched from, and it is the only way to find it: a portable .exe unpacks itself into %TEMP%
 * and runs from there, so __dirname and process.execPath both point at the throwaway copy.
 *
 * This has to run before anything reads getPath("userData"). Nothing does at module load —
 * settings.ts and snapshot.ts resolve their paths inside functions, never at import — so keep it
 * here, above the window and the handlers.
 *
 * Both kinds of build were renamed along with the app ("CTE2 Build Planner" and `cte2-pob-data`
 * before it was Craft of Building). A folder under the new name wins; failing that, one under
 * the old name is kept, so a beta tester's settings, autosave and extracted snapshot survive
 * the upgrade; failing both, the new name is created.
 */
function dataDir(parent: string, name: string, oldName: string): string {
  const current = join(parent, name);
  const old = join(parent, oldName);
  return !existsSync(current) && existsSync(old) ? old : current;
}

const portableDir = process.env["PORTABLE_EXECUTABLE_DIR"];
if (portableDir !== undefined) {
  app.setPath("userData", dataDir(portableDir, "cob-data", "cte2-pob-data"));
} else if (app.isPackaged) {
  app.setPath("userData", dataDir(app.getPath("appData"), "Craft of Building", "CTE2 Build Planner"));
}

let mainWindow: BrowserWindow | null = null;

/**
 * The window icon, for the runs where the executable does not already carry one.
 *
 * A packaged Windows build gets its icon from the .exe that electron-builder stamped
 * (`win.icon` in electron-builder.yml), and that is what the taskbar and Alt-Tab read — so
 * this is really about `npm run dev`, where the executable is Electron's own and the window
 * would otherwise wear Electron's logo.
 *
 * `__dirname` is `out/main`, so this reaches `packages/app/build/icon.png`. It is deliberately
 * the PNG rather than the .ico: `nativeImage` reads both, and the PNG is the one that is
 * guaranteed to be a single square bitmap rather than an icon directory. Missing is not an
 * error — a packaged build has no `build/` beside it and does not need one.
 */
function windowIcon(): string | undefined {
  const path = join(__dirname, "../../build/icon.png");
  return existsSync(path) ? path : undefined;
}

function createWindow(): void {
  // Where the last session left it. A position no current display can show is dropped rather
  // than restored — see `liveWindowBounds` — so unplugging a monitor cannot hide the window.
  const placement = liveWindowBounds();
  const icon = windowIcon();

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    ...(placement.bounds ?? {}),
    ...(icon === undefined ? {} : { icon }),
    show: false,
    backgroundColor: "#12141a",
    title: "Craft of Building",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (placement.maximised) mainWindow.maximize();

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // `getNormalBounds` rather than `getBounds`: a maximised window reports the screen, and
  // restoring that as the un-maximised size loses whatever it was before. Saved on close
  // rather than on every drag, which would write the file continuously while resizing.
  mainWindow.on("close", () => {
    if (mainWindow === null) return;
    rememberWindow(mainWindow.getNormalBounds(), mainWindow.isMaximized());
  });

  // External links open in the real browser, never in a chromeless app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Serves an extracted texture.
 *
 * The URL carries a path relative to the asset directory and nothing else. It is checked twice
 * — once by {@link isSafeAssetPath} for traversal segments, and once by confirming the resolved
 * path is still inside the asset directory — because this is the only place a renderer-supplied
 * string reaches the filesystem.
 */
function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const root = currentAssetsDir();

    if (root === null || !isSafeAssetPath(relative)) return new Response(null, { status: 404 });

    const target = normalize(join(root, ...relative.split("/")));
    if (!target.startsWith(normalize(root) + sep)) return new Response(null, { status: 403 });
    if (!existsSync(target)) return new Response(null, { status: 404 });

    const bytes = await new Promise<Buffer | null>((resolveBytes) => {
      readFile(target, (err, data) => resolveBytes(err ? null : data));
    });
    if (bytes === null) return new Response(null, { status: 404 });

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" },
    });
  });
}

function registerHandlers(): void {
  ipcMain.handle(CHANNEL.getSnapshot, () => loadSnapshot());
  ipcMain.handle(CHANNEL.forgetSnapshot, () => forgetSnapshot());
  ipcMain.handle(CHANNEL.dataStatus, () => dataStatus());

  ipcMain.handle(CHANNEL.chooseInstall, async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      title: "Choose your Craft to Exile 2 instance or game folder",
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  });

  ipcMain.handle(CHANNEL.runExtract, (_event, installPath: string) => runExtract(installPath));

  // Each of these can change the recent list, and Electron cannot repopulate a submenu in place,
  // so the menu is rebuilt rather than left showing what was recent when the app started.
  ipcMain.handle(CHANNEL.openBuild, async () => {
    const result = await openBuild(mainWindow);
    installMenu(mainWindow);
    return result;
  });
  ipcMain.handle(CHANNEL.openBuildAt, (_event, path: string) => {
    const result = openBuildAt(path);
    installMenu(mainWindow);
    return result;
  });
  ipcMain.handle(CHANNEL.saveBuild, async (_event, doc, path?: string) => {
    const result = await saveBuild(mainWindow, doc, path);
    installMenu(mainWindow);
    return result;
  });
  ipcMain.handle(CHANNEL.recentBuilds, () => liveRecentBuilds());
  ipcMain.handle(CHANNEL.autosave, (_event, doc, baseline) => autosave(doc, baseline));
  ipcMain.handle(CHANNEL.loadAutosave, () => loadAutosave());
}

void app.whenReady().then(() => {
  registerAssetProtocol();
  registerHandlers();
  createWindow();
  installMenu(mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
