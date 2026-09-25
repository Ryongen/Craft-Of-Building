#!/usr/bin/env node
/**
 * Put the local `data/` on the `site-data` branch, where the Pages workflow can find it.
 *
 * The pack data does not belong in `main`. It is 19 MB that changes on a completely different
 * schedule from the code, it is regenerated wholesale rather than edited, and a `git log -p` that
 * has to step over a rewritten snapshot is a `git log -p` nobody runs. So it lives on an orphan
 * branch — no shared history with `main`, nothing to merge, and it can be pruned or force-pushed
 * without touching a line of the app's history.
 *
 * Be clear about what that does and does not buy. A plain `git clone` still fetches every branch,
 * so this does not make cloning cheaper. What it buys is that `main`'s history stays free of
 * snapshot churn, that CI takes `--depth 1 --single-branch` and downloads one revision, and that
 * the data can be re-cut without rewriting anything anyone has checked out.
 *
 * Each extraction lands in its own directory:
 *
 *   packs/<mine-and-slash-version>/snapshot.json
 *   packs/<mine-and-slash-version>/assets/…
 *   latest.json          -> { "pack": "1.20.1-6.4.13" }
 *
 * so several pack versions can sit side by side and `latest.json` decides which one the site is
 * built from. Rolling back a bad snapshot is then a one-line edit rather than a re-upload.
 *
 * Usage:
 *   node tools/publish-site-data.mjs              # stage and commit locally, print what it did
 *   node tools/publish-site-data.mjs --push       # …and push to origin
 *   node tools/publish-site-data.mjs --no-latest  # add the pack without making it the live one
 *
 * Nothing is pushed without `--push`. Publishing is the irreversible half.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BRANCH = "site-data";

const push = process.argv.includes("--push");
const setLatest = !process.argv.includes("--no-latest");

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...options }).trim();
}

function fail(message) {
  console.error(`publish-site-data: ${message}`);
  process.exit(1);
}

const dataDir = join(repoRoot, "data");
const snapshotFile = join(dataDir, "snapshot.json");
if (!existsSync(snapshotFile)) fail(`no snapshot at ${snapshotFile}`);
if (!existsSync(join(dataDir, "assets"))) fail(`no assets at ${join(dataDir, "assets")}`);

const meta = JSON.parse(readFileSync(snapshotFile, "utf8")).meta ?? {};
const version = meta.mineAndSlashVersion;
if (typeof version !== "string" || version === "") {
  fail("the snapshot records no `meta.mineAndSlashVersion`, so there is nothing to name it after");
}
// The version becomes a directory name and a URL segment. Anything else in it is a bug in the
// extractor, not something to sanitise around quietly.
if (!/^[\w.+-]+$/.test(version)) fail(`\`${version}\` is not usable as a directory name`);

/**
 * A worktree, not a checkout.
 *
 * Switching `main` to `site-data` in place would mean stashing whatever the user is working on,
 * and this script is run from the middle of a working session by definition — you have just
 * extracted. A worktree in a temp directory touches nothing.
 */
const worktree = join(repoRoot, ".site-data-worktree");
rmSync(worktree, { recursive: true, force: true });

function remoteHasBranch() {
  try {
    return git(["ls-remote", "--heads", "origin", BRANCH]).includes(BRANCH);
  } catch {
    // No remote configured, or no network. Neither is a reason to stop: the branch can be
    // created locally now and pushed whenever.
    return false;
  }
}

const hasBranch = git(["branch", "--list", BRANCH]) !== "" || remoteHasBranch();

console.log(`publish-site-data: ${hasBranch ? "updating" : "creating"} ${BRANCH}`);
if (hasBranch) {
  // `git fetch` first so a branch that exists only on the remote is there to check out.
  try {
    git(["fetch", "origin", `${BRANCH}:${BRANCH}`]);
  } catch {
    // Already up to date, or no remote branch yet. Either is fine.
  }
  git(["worktree", "add", worktree, BRANCH]);
} else {
  git(["worktree", "add", "--detach", worktree]);
  // Listed *before* the index is emptied, which is the whole trick. `git checkout --orphan`
  // keeps the index and the working tree of whatever it branched from, so the first commit on
  // `site-data` would otherwise be the entire contents of `main` with the pack data on top —
  // and after `rm --cached` the index is empty, so asking `ls-files` then returns nothing while
  // the files themselves are still sitting on disk waiting for `add -A` to pick them up.
  const inherited = git(["ls-files"], { cwd: worktree }).split("\n").filter(Boolean);
  git(["checkout", "--orphan", BRANCH], { cwd: worktree });
  git(["rm", "-rf", "--cached", "."], { cwd: worktree });
  for (const entry of inherited) rmSync(join(worktree, entry), { force: true });
}

try {
  const packDir = join(worktree, "packs", version);
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  cpSync(snapshotFile, join(packDir, "snapshot.json"));
  cpSync(join(dataDir, "assets"), join(packDir, "assets"), { recursive: true });

  if (setLatest) {
    writeFileSync(
      join(worktree, "latest.json"),
      `${JSON.stringify({ pack: version, publishedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  /*
   * Hands off every byte on this branch.
   *
   * `core.autocrlf` is on for whoever extracted the data, so without this git rewrites the line
   * endings of `snapshot.json` and `assets/index.json` on checkout — which means the branch
   * checks out differently on Windows and in CI, and every republish shows a whole-file diff
   * from the normalisation rather than from anything that changed. There is no source code here
   * to normalise; it is all generated data.
   */
  writeFileSync(join(worktree, ".gitattributes"), "* -text\n");

  writeFileSync(
    join(worktree, "README.md"),
    [
      "# site-data",
      "",
      "Pack data for the GitHub Pages build, one directory per Mine and Slash version.",
      "Written by `tools/publish-site-data.mjs` on `main`; `latest.json` names the version the",
      "site is currently built from. There is no code here and this branch shares no history",
      "with `main` — do not merge it into anything.",
      "",
      "Redistributed with permission from the Craft to Exile 2 and Mine and Slash authors.",
      "",
    ].join("\n"),
  );

  /*
   * The branch carries its own LICENSE because it is cloned and mirrored independently of
   * `main`, and what is on it is not what the MIT license covers. Rewritten on every
   * publish so it cannot drift from the note in the repository root.
   */
  writeFileSync(
    join(worktree, "LICENSE"),
    [
      "The files on this branch are not covered by the MIT license on `main`.",
      "",
      "They are game data and art extracted from Craft to Exile 2 and Mine and Slash, and",
      "they remain the property of their authors. Mine and Slash is by robertx22; Craft to",
      "Exile 2 is by the CTE team. They are redistributed here with those authors' permission,",
      "so that the GitHub Pages build of this project has data to load.",
      "",
      "That permission was given to this project. It is not sublicensed to you: forking the",
      "planner does not carry a right to redistribute the art. See NOTICE on `main`.",
      "",
    ].join("\n"),
  );

  git(["add", "-A"], { cwd: worktree });
  const staged = git(["status", "--porcelain"], { cwd: worktree });
  if (staged === "") {
    console.log("publish-site-data: nothing changed; the branch already has this data");
  } else {
    git(["commit", "-m", `Publish pack data for Mine and Slash ${version}`], { cwd: worktree });
    console.log(`publish-site-data: committed ${version} to ${BRANCH}`);
  }

  if (push) {
    git(["push", "-u", "origin", BRANCH], { cwd: worktree, stdio: "inherit" });
    console.log(`publish-site-data: pushed ${BRANCH} to origin`);
  } else {
    console.log(`publish-site-data: not pushed. Run again with --push, or:`);
    console.log(`  git push origin ${BRANCH}`);
  }
} finally {
  git(["worktree", "remove", "--force", worktree]);
}
