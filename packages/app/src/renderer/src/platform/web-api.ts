/**
 * `window.cte2`, for a browser.
 *
 * The renderer talks to exactly one object and has done since the app was written — every panel
 * reaches the outside world through `window.cte2` and nothing else. That is what makes a static
 * site possible without touching the panels: implement the same `Cte2Api` against `fetch`, the
 * File System Access API and IndexedDB, install it before React mounts, and the 80 files under
 * `renderer/src` neither know nor care which host they are running in.
 *
 * Three things genuinely cannot be carried across, and are reported rather than faked:
 *
 * - **Extraction.** A web page cannot read your `mods/` folder. The site ships one snapshot,
 *   built from one pack version; `loadSnapshotFile` is the escape hatch for anyone on another.
 * - **Staleness.** The desktop app compares `meta.fingerprint` against the install it extracted
 *   from. There is no install here, so the check is not made — and `dataStatus` says that
 *   instead of reporting a clean bill of health it has not earned.
 * - **The native menu.** `onMenuCommand` never fires. Every command it carried is a button in
 *   the chrome or a key handled in `app.tsx`, which is why this can be a no-op rather than a
 *   reimplementation.
 */

import type { BuildDoc } from "@cte2/schema";

import {
  parseBuild,
  parseSession,
  serializeBuild,
  serializeSession,
  suggestedFileName,
} from "@shared/build-file";
import {
  assetUrlFor,
  type AutosaveSession,
  type Cte2Api,
  type DataStatus,
  type OpenResult,
  type PinnedBaseline,
  type RecentBuild,
  type SaveResult,
  type SnapshotFileResult,
  type SnapshotPayload,
  UNKNOWN_ICON,
} from "@shared/ipc";

import {
  deleteValue,
  getRecent,
  getValue,
  listRecents,
  putRecent,
  setValue,
  type RecentRecord,
} from "./idb.js";

/** What `tools/build-site.mjs` writes beside the data it stages. */
type SiteManifest = {
  version: number;
  /** Minified snapshot. Every path here is relative to the site root — see `siteUrl`. */
  snapshot: string;
  /** The same snapshot, gzipped. Preferred — see `fetchSnapshotText`. */
  snapshotGzip?: string;
  /** Directory the GUI textures live in, with a trailing slash. */
  assets: string;
  assetIndex: string;
  builtAt: string;
  source: {
    mineAndSlashVersion: string | null;
    packIds: string[];
    extractedAt: string | null;
    /** Counted at build time, so the Data panel can report them without a second parse. */
    entries: number;
    langKeys: number;
  };
};

type AssetIndexFile = {
  assets?: Record<string, string>;
  items?: Record<string, string>;
  version?: number;
};

/** A snapshot the user supplied, kept so a reload does not throw it away. */
type StoredSnapshot = { name: string; json: string };

const SESSION_KEY = "session";
const SNAPSHOT_KEY = "snapshot";

/**
 * Resolve against the page rather than against `/`.
 *
 * The site lives at `/<repo>/` on a project page and at `/` behind a custom domain, and the two
 * must not need different builds. `document.baseURI` is the deployed directory in both cases, so
 * every data URL here is relative and the build has no base path baked into it.
 */
function siteUrl(relative: string): string {
  return new URL(relative, document.baseURI).href;
}

/** Non-2xx is an error here; a 404 that silently became `undefined` would surface much later. */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return (await response.json()) as T;
}

/**
 * The snapshot text, preferring the gzipped copy.
 *
 * The snapshot is 7.4 MB minified and around 800 KB gzipped, so which of the two crosses the
 * wire is the difference between a fast first load and a slow one. GitHub Pages will usually
 * negotiate `Content-Encoding: gzip` for the plain JSON on its own — but "usually" is not good
 * enough for the one asset the whole app blocks on, so the build stages a `.gz` and this
 * inflates it explicitly. `DecompressionStream` has been in every engine since Safari 16.4;
 * where it is missing, the plain file still works and is merely bigger.
 */
async function fetchSnapshotText(manifest: SiteManifest): Promise<string> {
  const gz = manifest.snapshotGzip;
  if (gz !== undefined && typeof DecompressionStream === "function") {
    try {
      const response = await fetch(siteUrl(gz), { cache: "no-cache" });
      if (response.ok && response.body !== null) {
        const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).text();
      }
    } catch {
      // Fall through to the plain file. A CDN that transparently decoded the `.gz` for us would
      // land here too, and re-fetching uncompressed is the correct answer in both cases.
    }
  }
  const response = await fetch(siteUrl(manifest.snapshot), { cache: "no-cache" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for the snapshot`);
  return await response.text();
}

/** True when this browser can open and write files in place. Chromium only, today. */
function hasFileSystemAccess(): boolean {
  return (
    typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function" &&
    typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function"
  );
}

const PICKER_TYPES = [
  { description: "CTE2 build", accept: { "application/json": [".json"] as string[] } },
];

/** A user gesture that ended without a choice. Distinguished so the UI stays quiet about it. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a file the classic way, for browsers with no picker. Resolves null if dismissed. */
function promptForFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    // A dismissed file input fires nothing at all in older engines, so the element is removed on
    // the next interaction rather than being leaked one per cancelled open.
    const done = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoked on a timer rather than immediately: Safari has not started the download by the time
  // `click()` returns, and revoking synchronously produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function createWebApi(): Cte2Api {
  const pickers = hasFileSystemAccess();

  /** Resolved on the first `getSnapshot`, and read afterwards by `assetUrl` and `dataStatus`. */
  let manifest: SiteManifest | null = null;
  let assetsBase = "";
  let assetIndex: Record<string, string> = {};
  let itemIconIndex: Record<string, string> = {};
  /** The published index's own version, so the Data panel can say when the site's are behind. */
  let assetIndexVersion = 0;
  let loadedFrom = "";
  /** True when what is loaded came from the user rather than from the site. */
  let userSupplied = false;

  async function rememberFile(
    handle: FileSystemFileHandle | undefined,
    fileName: string,
    doc: BuildDoc,
  ): Promise<string> {
    // The id is the handle's own identity where there is one, so reopening the same file twice
    // updates its entry rather than adding a second. Without handles there is nothing stable to
    // key on, and the entry is written anyway only so the title bar has a name to show.
    const id = handle === undefined ? `file:${fileName}` : `handle:${fileName}`;
    const record: RecentRecord = {
      id,
      name: doc.meta?.name ?? fileName.replace(/\.json$/i, ""),
      fileName,
      openedAt: new Date().toISOString(),
      ...(handle === undefined ? {} : { handle }),
    };
    await putRecent(record);
    return id;
  }

  async function readHandle(handle: FileSystemFileHandle): Promise<string> {
    return await (await handle.getFile()).text();
  }

  const api: Cte2Api = {
    platform: "web",

    capabilities: {
      extract: false,
      saveInPlace: pickers,
      recentBuilds: pickers,
      nativeMenu: false,
      loadOwnSnapshot: true,
    },

    async getSnapshot(): Promise<SnapshotPayload | null> {
      manifest = await fetchJson<SiteManifest>(siteUrl("data/manifest.json"));
      assetsBase = siteUrl(manifest.assets);

      const index = await fetchJson<AssetIndexFile>(siteUrl(manifest.assetIndex)).catch(
        // Missing icons are a degraded UI, not a dead app — the desktop build treats a
        // malformed index the same way. Every panel already copes with a null `assetUrl`.
        () => ({}) as AssetIndexFile,
      );
      assetIndex = index.assets ?? {};
      itemIconIndex = index.items ?? {};
      assetIndexVersion = typeof index.version === "number" ? index.version : 0;

      // A snapshot the user handed over wins over the one the site shipped, and survives a
      // reload: someone on a different pack version should not have to re-pick it every visit.
      const stored = await getValue<StoredSnapshot>(SNAPSHOT_KEY);
      if (stored !== null) {
        userSupplied = true;
        loadedFrom = stored.name;
        return {
          json: stored.json,
          path: stored.name,
          assetsDir: assetsBase,
          assets: assetIndex,
          itemIcons: itemIconIndex,
          assetIndexVersion,
        };
      }

      userSupplied = false;
      loadedFrom = `Mine and Slash ${manifest.source.mineAndSlashVersion ?? "unknown"}`;
      return {
        json: await fetchSnapshotText(manifest),
        path: loadedFrom,
        assetsDir: assetsBase,
        assets: assetIndex,
        itemIcons: itemIconIndex,
        assetIndexVersion,
      };
    },

    // No install to point at, and nothing that could read one. The Data panel hides both of
    // these behind `capabilities.extract`; they are here so the contract stays total.
    chooseInstall: () => Promise.resolve(null),

    runExtract: () =>
      Promise.resolve({
        ok: false,
        error:
          "Extraction reads your modpack folder, which a web page cannot do. Run the desktop " +
          "app to extract, then load the snapshot it produced here.",
      }),

    async forgetSnapshot(): Promise<void> {
      await deleteValue(SNAPSHOT_KEY);
    },

    async loadSnapshotFile(): Promise<SnapshotFileResult> {
      let file: File | null = null;
      if (pickers) {
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: "CTE2 snapshot", accept: { "application/json": [".json"] } }],
            multiple: false,
          });
          file = handle === undefined ? null : await handle.getFile();
        } catch (err) {
          if (isAbort(err)) return { ok: false, cancelled: true };
          return { ok: false, cancelled: false, error: errorText(err) };
        }
      } else {
        file = await promptForFile("application/json,.json");
      }
      if (file === null) return { ok: false, cancelled: true };

      try {
        const json = await file.text();
        // Parsed to prove it is a snapshot before it is stored. Storing an unreadable one would
        // brick the site on next load, and the only cure would be clearing site data by hand.
        const parsed: unknown = JSON.parse(json);
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          (parsed as { registries?: unknown }).registries === undefined
        ) {
          return {
            ok: false,
            cancelled: false,
            error: "That file has no `registries` block — it does not look like a snapshot.",
          };
        }
        await setValue(SNAPSHOT_KEY, { name: file.name, json } satisfies StoredSnapshot);
        return { ok: true, name: file.name };
      } catch (err) {
        return { ok: false, cancelled: false, error: errorText(err) };
      }
    },

    dataStatus(): Promise<DataStatus> {
      const source = manifest?.source;
      return Promise.resolve({
        snapshotPath: loadedFrom === "" ? null : loadedFrom,
        assetsDir: assetsBase === "" ? null : assetsBase,
        // There is no install here and there never will be. Null rather than a placeholder
        // string, because the panel already renders "not recorded" for exactly this case.
        installPath: null,
        mineAndSlashVersion: source?.mineAndSlashVersion ?? null,
        packIds: source?.packIds ?? [],
        extractedAt: source?.extractedAt ?? null,
        entries: source?.entries ?? 0,
        langKeys: source?.langKeys ?? 0,
        assetsWritten: Object.keys(assetIndex).length,
        itemIcons: Object.keys(itemIconIndex).length,
        // Not "fresh" — *unknowable*. The desktop app earns `stale: false` by comparing the
        // recorded fingerprint against the install; with no install to compare against, saying
        // false and leaving it there would be the app claiming a check it never made.
        stale: false,
        staleReason: userSupplied
          ? "Running on a snapshot you supplied. It is not checked against any install."
          : "This is the snapshot the site was built from. It cannot be checked against your " +
            "install — if your pack version differs from the one above, the numbers here " +
            "describe a different pack.",
        fromRepo: false,
        userSupplied,
      });
    },

    async openBuild(): Promise<OpenResult> {
      if (pickers) {
        let handle: FileSystemFileHandle;
        try {
          [handle] = (await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false })) as [
            FileSystemFileHandle,
          ];
        } catch (err) {
          if (isAbort(err)) return { ok: false, cancelled: true };
          return { ok: false, cancelled: false, error: errorText(err) };
        }
        try {
          const { doc, observed } = parseBuild(await readHandle(handle));
          const id = await rememberFile(handle, handle.name, doc);
          return { ok: true, path: id, doc, ...(observed === null ? {} : { observed }) };
        } catch (err) {
          return { ok: false, cancelled: false, error: errorText(err) };
        }
      }

      const file = await promptForFile("application/json,.json");
      if (file === null) return { ok: false, cancelled: true };
      try {
        const { doc, observed } = parseBuild(await file.text());
        const id = await rememberFile(undefined, file.name, doc);
        return { ok: true, path: id, doc, ...(observed === null ? {} : { observed }) };
      } catch (err) {
        return { ok: false, cancelled: false, error: errorText(err) };
      }
    },

    async openBuildAt(id: string): Promise<OpenResult> {
      const record = await getRecent(id);
      if (record?.handle === undefined) {
        return {
          ok: false,
          cancelled: false,
          error: "That file cannot be reopened in this browser. Use Open to pick it again.",
        };
      }
      try {
        // The grant does not survive a reload, so the first click on a recent entry after
        // returning to the site prompts. That prompt is the browser's, and asking for it here
        // is what stops `getFile()` from failing with a bare NotAllowedError.
        const permission = await record.handle.queryPermission({ mode: "readwrite" });
        if (permission !== "granted") {
          const asked = await record.handle.requestPermission({ mode: "readwrite" });
          if (asked !== "granted") return { ok: false, cancelled: true };
        }
        const { doc, observed } = parseBuild(await readHandle(record.handle));
        await rememberFile(record.handle, record.fileName, doc);
        return { ok: true, path: id, doc, ...(observed === null ? {} : { observed }) };
      } catch (err) {
        return { ok: false, cancelled: false, error: errorText(err) };
      }
    },

    async saveBuild(doc: BuildDoc, path?: string): Promise<SaveResult> {
      const text = serializeBuild(doc);
      const fallbackName = suggestedFileName(doc);

      if (!pickers) {
        // No way to write back to anything, so every save is a new file in Downloads. The
        // chrome says "Download" rather than "Save" here — see `capabilities.saveInPlace`.
        download(fallbackName, text);
        return { ok: true, path: fallbackName };
      }

      // Save (rather than Save as) over a file this session opened: write through the handle we
      // already hold, no dialog. This is the whole reason recents store handles.
      if (path !== undefined) {
        const record = await getRecent(path);
        if (record?.handle !== undefined) {
          try {
            const permission = await record.handle.requestPermission({ mode: "readwrite" });
            if (permission === "granted") {
              const writable = await record.handle.createWritable();
              await writable.write(text);
              await writable.close();
              await rememberFile(record.handle, record.fileName, doc);
              return { ok: true, path };
            }
          } catch (err) {
            return { ok: false, cancelled: false, error: errorText(err) };
          }
        }
        // The handle is gone or was never granted. Falling through to the picker is better than
        // an error: the user asked to save, and a dialog still saves.
      }

      let handle: FileSystemFileHandle;
      try {
        handle = (await window.showSaveFilePicker({
          suggestedName: fallbackName,
          types: PICKER_TYPES,
        })) as FileSystemFileHandle;
      } catch (err) {
        if (isAbort(err)) return { ok: false, cancelled: true };
        return { ok: false, cancelled: false, error: errorText(err) };
      }

      try {
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        const id = await rememberFile(handle, handle.name, doc);
        return { ok: true, path: id };
      } catch (err) {
        return { ok: false, cancelled: false, error: errorText(err) };
      }
    },

    async recentBuilds(): Promise<RecentBuild[]> {
      const records = await listRecents();
      return records
        .filter((record) => record.handle !== undefined)
        .map((record) => ({
          path: record.id,
          name: record.name,
          openedAt: record.openedAt,
          detail: record.fileName,
        }));
    },

    async autosave(doc: BuildDoc, baseline: PinnedBaseline | null): Promise<void> {
      await setValue(SESSION_KEY, serializeSession(doc, baseline));
    },

    async loadAutosave(): Promise<AutosaveSession | null> {
      const text = await getValue<string>(SESSION_KEY);
      return text === null ? null : parseSession(text);
    },

    // No menu bar to issue commands. Every command the menu carried is also a button in the
    // chrome or a key handled in `app.tsx`, so nothing is lost but the menu itself.
    onMenuCommand() {
      return () => {};
    },

    assetUrl(resourcePath: string): string | null {
      const relative = assetIndex[resourcePath] ?? assetIndex[UNKNOWN_ICON];
      return relative === undefined ? null : assetUrlFor(relative, assetsBase);
    },

    itemIconUrl(itemId: string): string | null {
      const relative = itemIconIndex[itemId];
      return relative === undefined ? null : assetUrlFor(relative, assetsBase);
    },
  };

  return api;
}
