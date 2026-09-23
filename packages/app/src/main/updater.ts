/**
 * Updates, from GitHub Releases.
 *
 * The installed build does it all itself: on launch it checks the latest release, downloads the
 * new installer in the background (only the changed blocks, via the `.blockmap` electron-builder
 * writes beside it), and installs on the next quit — or at once, if the user takes the offer in
 * the status bar. What it compares against is `latest.yml`, which `npm run dist` writes into
 * `dist/` and which has to be uploaded to the release along with the installer and its blockmap.
 * A release without it is invisible to every installed copy.
 *
 * The portable .exe cannot do this: there is no installation for it to replace, and the only
 * installer a release carries is the NSIS one, which would install a second copy. So it only
 * checks — against the same feed, since it carries the same `app-update.yml` — and the status
 * bar links to the release page.
 *
 * A dev run checks nothing — it is not a release and has no `app-update.yml` to read.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

import { CHANNEL, type UpdateStatus } from "@shared/ipc";

/** Where the portable build sends people. The feed itself comes from `publish` in electron-builder.yml. */
const RELEASES_URL = "https://github.com/Ryongen/cte2-pob/releases/latest";

const portable = process.env["PORTABLE_EXECUTABLE_DIR"] !== undefined;

let status: UpdateStatus = { kind: "idle" };
/** Whether the check in flight was asked for. Carried onto whatever status it ends in. */
let manual = false;

function publish(next: UpdateStatus): void {
  status = next;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(CHANNEL.updateStatus, status);
  }
}

/**
 * Wire the updater up and run the startup check.
 *
 * Call once, after `ready`. The startup check is silent on failure: most of those are "offline",
 * and an app that opens with an error it cannot do anything about is worse than one that says
 * nothing.
 */
export function initUpdater(): void {
  ipcMain.handle(CHANNEL.getUpdateStatus, () => status);
  ipcMain.handle(CHANNEL.installUpdate, () => {
    if (status.kind !== "ready") return;
    // isSilent=false shows the installer's progress window; isForceRunAfter relaunches the app.
    autoUpdater.quitAndInstall(false, true);
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = !portable;
  autoUpdater.autoInstallOnAppQuit = !portable;

  autoUpdater.on("checking-for-update", () => publish({ kind: "checking", manual }));
  autoUpdater.on("update-not-available", () => publish({ kind: "current", manual }));
  autoUpdater.on("update-available", (info) => {
    publish(
      portable
        ? { kind: "available", version: info.version, url: RELEASES_URL }
        : { kind: "downloading", version: info.version, percent: 0 },
    );
  });
  autoUpdater.on("download-progress", (progress) => {
    if (status.kind !== "downloading") return;
    publish({ ...status, percent: progress.percent });
  });
  autoUpdater.on("update-downloaded", (info) => publish({ kind: "ready", version: info.version }));
  autoUpdater.on("error", (err) => {
    publish({ kind: "error", message: err.message, manual });
  });

  void checkForUpdates(false);
}

/** Check now. `userAsked` makes the outcome visible even when there is nothing to update to. */
export async function checkForUpdates(userAsked: boolean): Promise<void> {
  if (!app.isPackaged) {
    publish({ kind: "unsupported", manual: userAsked });
    return;
  }
  // A check already running answers this one too, so it inherits the request to be heard.
  if (status.kind === "checking") {
    manual ||= userAsked;
    publish({ kind: "checking", manual });
    return;
  }
  // A download already under way, or finished, is its own answer.
  if (status.kind === "downloading" || status.kind === "ready") {
    if (userAsked) publish(status);
    return;
  }
  manual = userAsked;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // Already reported through the `error` event.
  }
}
