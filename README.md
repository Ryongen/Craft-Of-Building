# cte2-pob

A build planner for Craft to Exile 2 (CTE2) featuring a full stat calculation engine and real
damage pipeline. It runs as a desktop app and as a website — the same planner either way.

## Build Planner Highlights

- **Complete Character Planning**: Allocate talents, skills, gear, omens, and class points with detailed stat breakdowns and damage models.
- **In-Game Build Exporter Mod**: Includes a client-side Forge mod (`mod/`) that exports your active character, gear, and exact in-game stat sheet directly into the planner—no server permissions required.
- **Portable & Zero-Install Version**: Available as a standalone `portable.exe` that runs from anywhere (like a USB drive) and keeps all local snapshot data isolated right beside the executable.
- **Local Asset Extraction**: The desktop app reads data directly from your local CTE2 installation on first run, so it always matches the pack you actually have installed.
- **Runs in a browser too**: the same planner is published to GitHub Pages with prebuilt pack data, for anyone who would rather not install anything.

## Quick Commands

- `npm run dev` — Launch the desktop app in development mode.
- `npm run dist:app` — Build the portable `.exe` and setup installer under `packages/app/dist/`.
- `npm run build:site` — Build the static website into `packages/app/out/web`.
- `npm run preview:site` — Build it and serve it locally.
- `npm run publish:site-data` — Put your local `data/` on the `site-data` branch.

## The website

The desktop app and the website are the same renderer. Every panel reaches the outside world
through a single object, `window.cte2`, and the two builds differ only in who supplies it: an
Electron preload script (`src/preload`) or a browser shim (`src/renderer/src/platform`). Neither
the panels nor the engine know which host they are in.

Three things the desktop app does cannot be done by a web page, and the site says so rather than
pretending otherwise:

| | Desktop | Website |
| --- | --- | --- |
| Pack data | extracted from your own install | prebuilt, shipped with the site |
| Staleness check | compares the recorded fingerprint against your install | not possible — there is no install to compare against |
| Open / Save | native dialogs, saves in place | saves in place in Chromium; elsewhere, opening uses a file picker and saving downloads a copy |
| Recent builds | yes | Chromium only (it needs stored file handles) |
| Autosaved session | a file in the app's data directory | IndexedDB, per browser |

If your pack version differs from the one the site was built from, the Data tab takes a
`snapshot.json` that the desktop app extracted and uses it instead. It is kept in your browser
and nothing is uploaded.

### Publishing the site

The pack data does not live on `main`. It is ~19 MB that changes on a completely different
schedule from the code and is regenerated wholesale rather than edited, so it lives on an orphan
branch called `site-data`, one directory per Mine and Slash version:

```
packs/1.20.1-6.4.13/snapshot.json
packs/1.20.1-6.4.13/assets/…
latest.json          -> { "pack": "1.20.1-6.4.13" }
```

Be clear about what that buys: a plain `git clone` still fetches every branch, so it does not
make cloning cheaper. What it buys is that `main`'s history stays free of snapshot churn, that CI
fetches one shallow revision of the data, and that a bad snapshot can be rolled back by editing
one line of `latest.json` rather than re-uploading anything.

To publish new data, extract it with the desktop app as usual, then:

```
npm run publish:site-data -- --push
```

Nothing is pushed without `--push`. Pushing either branch redeploys the site; so does running the
**Pages** workflow by hand.

### What the published snapshot does and does not contain

`tools/build-site.mjs` drops `meta.gameDir`, `meta.mineAndSlashJar`, `meta.libraryOfExileJar`,
`meta.resourcePacks` and `meta.fingerprint` before publishing. Those record the absolute paths of
the machine the data was extracted on — including a home directory and a username — and nothing
in the renderer or the engine reads any of them. It also minifies the snapshot and stages a
gzipped copy beside it, which is the one browsers actually fetch: 7.1 MB becomes about 600 KB.

The icons and pack data published to the site are redistributed **with permission** from the
Craft to Exile 2 and Mine and Slash authors. The desktop app still extracts from your own
install and redistributes nothing.

### First-time repository setup

Once, in the repository's settings: **Settings → Pages → Build and deployment → Source →
GitHub Actions**. The workflow in `.github/workflows/pages.yml` does the rest, and will fail with
a clear message if `site-data` has not been published yet.
