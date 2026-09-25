/**
 * Boot: get a snapshot, or help the user produce one.
 *
 * Nothing else in the renderer runs without a snapshot, so this is the only component that has
 * to cope with its absence. Everything below `SnapshotProvider` can assume one exists.
 */

import type { Snapshot } from "@cte2/extractor";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { ExtractSummary } from "@shared/ipc";

import { App } from "./app.js";
import { SnapshotProvider } from "./state/snapshot.js";
import { Plain, Tech } from "./ui/copy/hint.js";

type Phase =
  | { kind: "loading" }
  | { kind: "setup"; error?: string }
  | { kind: "extracting" }
  | { kind: "extracted"; summary: ExtractSummary }
  | { kind: "ready"; snapshot: Snapshot; path: string };

export function Root(): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const load = useCallback(async () => {
    let payload: Awaited<ReturnType<typeof window.cte2.getSnapshot>>;
    try {
      // In Electron this reads a local file and cannot really fail. On the web it is three
      // network requests, and a site deployed without its `data/` would otherwise reject here
      // and leave the app on "Loading snapshot…" for ever with the reason only in the console.
      payload = await window.cte2.getSnapshot();
    } catch (err) {
      setPhase({
        kind: "setup",
        error: `The snapshot could not be loaded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }
    if (payload === null) {
      setPhase({ kind: "setup" });
      return;
    }
    try {
      // Parsed here rather than in main: 9.3 MB of text crosses the bridge once, and the
      // object graph it becomes never has to.
      const snapshot = JSON.parse(payload.json) as Snapshot;
      setPhase({ kind: "ready", snapshot, path: payload.path });
    } catch (err) {
      setPhase({
        kind: "setup",
        error: `The snapshot at ${payload.path} could not be parsed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const extract = useCallback(async () => {
    const installPath = await window.cte2.chooseInstall();
    if (installPath === null) return;

    setPhase({ kind: "extracting" });
    const result = await window.cte2.runExtract(installPath);
    if (!result.ok) {
      setPhase({ kind: "setup", error: result.error });
      return;
    }
    setPhase({ kind: "extracted", summary: result.summary });
  }, []);

  if (phase.kind === "ready") {
    return (
      <SnapshotProvider snapshot={phase.snapshot} path={phase.path}>
        <App />
      </SnapshotProvider>
    );
  }

  if (phase.kind === "loading") {
    return <Centered>Loading snapshot…</Centered>;
  }

  if (phase.kind === "extracting") {
    return (
      <Centered>
        <div>Reading your install…</div>
        <>
        <Plain>
          <p className="muted mt-4">
            Merging game registries, copying interface textures, and loading gear sprites from installed mod files. This takes a few seconds and reads exclusively from your modpack folder.
          </p>
        </Plain>
        <Tech>
          <p className="muted mt-4">
            Merging every <code>mmorpg</code> registry, copying the GUI textures, and resolving gear
            sprites out of every jar in <code>mods/</code>. This takes a few seconds and only ever
            reads from the modpack folder.
          </p>
        </Tech>
        </>
      </Centered>
    );
  }

  if (phase.kind === "extracted") {
    return <ExtractReport summary={phase.summary} onContinue={() => void load()} />;
  }

  return <Setup error={phase.error} onChoose={() => void extract()} />;
}

function Centered({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="setup">
      <div className="setup-inner">{children}</div>
    </div>
  );
}

/**
 * First run, or a run that could not find data.
 *
 * The two hosts arrive here for opposite reasons. The desktop app has nothing until you point it
 * at an install, and that is the normal first launch. The site ships its own snapshot, so
 * reaching this screen there means the deployment is broken — which is worth saying plainly
 * rather than offering a folder picker the browser does not have.
 */
function Setup({ error, onChoose }: { error?: string | undefined; onChoose: () => void }): ReactNode {
  const canExtract = window.cte2.capabilities.extract;
  return (
    <div className="setup">
      <div className="setup-inner">
        <h1>Path of Building for Craft to Exile 2</h1>
        {canExtract ? (
          <>
            <p>
              Point this at your Craft to Exile 2 instance and it will read the pack&apos;s
              registries into a snapshot. Your modpack folder is only ever{" "}
              <strong>read from</strong>, and the extracted data stays on this machine.
            </p>
            <p className="faint">
              Either the Prism instance folder or the <code>minecraft</code> game directory inside
              it will do.
            </p>
          </>
        ) : (
          <p>
            This site's copy of the pack data could not be loaded. That's a problem on our end,
            not yours. Try reloading; the error is below.
          </p>
        )}
        {error !== undefined && (
          <div className="notice mt-7">
            {error}
          </div>
        )}
        {canExtract ? (
          <button className="primary mt-7" onClick={onChoose}>
            Choose install folder…
          </button>
        ) : (
          <button className="primary mt-7" onClick={() => window.location.reload()}>
            Reload
          </button>
        )}
      </div>
    </div>
  );
}

function ExtractReport({
  summary,
  onContinue,
}: {
  summary: ExtractSummary;
  onContinue: () => void;
}): ReactNode {
  return (
    <div className="setup">
      <div className="setup-inner">
        <h1>Extraction complete</h1>
        <dl className="summary-grid mt-7 mb-7">
          <dt>Mine and Slash</dt>
          <dd>{summary.mineAndSlashVersion}</dd>
          <dt>OpenLoader packs</dt>
          <dd>{summary.packIds.join(", ") || "(none)"}</dd>
          <dt>registry entries</dt>
          <dd>{summary.entries.toLocaleString()}</dd>
          <dt>lang keys</dt>
          <dd>{summary.langKeys.toLocaleString()}</dd>
          <dt>textures</dt>
          <dd>{summary.assetsWritten.toLocaleString()}</dd>
          <dt>gear sprites</dt>
          <dd>
            {summary.itemIcons.resolved} of {summary.itemIcons.total}
            {summary.unresolvedItems.length > 0 && (
              <span className="faint">
                {" "}
                (the rest are vanilla items, textured by the client jar)
              </span>
            )}
          </dd>
          <dt>code-only stats</dt>
          <dd>{summary.codeOnlyStats.toLocaleString()}</dd>
          <dt>duplicate GUIDs</dt>
          <dd>{summary.duplicateIds.toLocaleString()}</dd>
          <dt>id / filename mismatches</dt>
          <dd>{summary.idMismatches.toLocaleString()}</dd>
        </dl>

        <div className="notice info">
          Duplicate GUIDs and id mismatches are properties of the pack as shipped, not extraction
          errors. They are reported because the engine reproduces what the game actually does
          rather than correcting it.
        </div>

        {summary.fatal.length > 0 && (
          <div className="notice">
            <strong>This snapshot is not trustworthy.</strong> The extractor met{" "}
            {summary.fatal.length} thing{summary.fatal.length === 1 ? "" : "s"} it has no schema
            for, which means the engine would be guessing:
            <ul className="mt-3 mb-0" style={{ paddingLeft: 18 }}>
              {summary.fatal.slice(0, 8).map((line) => (
                <li key={line} className="mono text-sm">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button className="primary" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
