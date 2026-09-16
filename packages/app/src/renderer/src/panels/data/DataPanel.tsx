/**
 * What data the app is running on, and how to replace it.
 *
 * Extraction used to happen exactly once, on the first run where no snapshot was found: there
 * was no way to change the folder afterwards and no way to notice a modpack update, so the only
 * cure was deleting files out of `userData` by hand. The pieces to fix that — `forgetSnapshot`,
 * a persisted `installPath` — were already wired end to end and called from nowhere.
 *
 * The staleness line is the part that matters most. A pack update swaps the Mine and Slash jar
 * and the OpenLoader packs underneath a snapshot that then keeps confidently answering with the
 * old registry, and every number in the app inherits that. `snapshot.meta.fingerprint` records
 * the sizes and mtimes at extraction so a launch can tell.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { DataStatus, ExtractSummary } from "@shared/ipc";

export function DataPanel(): ReactNode {
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ExtractSummary | null>(null);

  const refresh = useCallback(() => {
    void window.cte2.dataStatus().then(setStatus);
  }, []);

  useEffect(() => refresh(), [refresh]);

  const extractFrom = async (installPath: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const result = await window.cte2.runExtract(installPath);
      if (result.ok) setSummary(result.summary);
      else setError(result.error);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const chooseAndExtract = async (): Promise<void> => {
    const chosen = await window.cte2.chooseInstall();
    if (chosen !== null) await extractFrom(chosen);
  };

  if (status === null) {
    return (
      <div className="panel">
        <div className="empty">Reading…</div>
      </div>
    );
  }

  return (
    <div className="panel">
      {status.stale && (
        <div className="notice bad">
          <strong>This snapshot no longer matches your install.</strong> {status.staleReason} Every
          number in the app is computed from the snapshot, so re-extract before trusting one.
        </div>
      )}

      {!status.stale && status.staleReason !== null && (
        <div className="notice">{status.staleReason}</div>
      )}

      {status.fromRepo && (
        <div className="notice info">
          Running on the repository&apos;s <code>data/snapshot.json</code> rather than one this app
          produced. Re-extracting writes to the app&apos;s own data directory, which then takes
          precedence — the committed <code>data/</code> is never overwritten by a click.
        </div>
      )}

      <div className="card">
        <div className="section-title mt-0">
          Extracted data
        </div>
        <dl className="summary-grid">
          <Row label="Modpack folder" value={status.installPath ?? "not recorded"} mono />
          <Row label="Mine and Slash" value={status.mineAndSlashVersion ?? "unknown"} />
          <Row
            label="OpenLoader packs"
            value={status.packIds.length > 0 ? status.packIds.join(", ") : "none"}
          />
          <Row label="Extracted" value={formatWhen(status.extractedAt)} />
          <Row label="Snapshot" value={status.snapshotPath ?? "none"} mono />
          <Row label="Registry entries" value={status.entries.toLocaleString()} />
          <Row label="Lang keys" value={status.langKeys.toLocaleString()} />
          <Row label="GUI textures" value={status.assetsWritten.toLocaleString()} />
          <Row label="Gear sprites" value={status.itemIcons.toLocaleString()} />
        </dl>

        <div className="row mt-6">
          <button
            className="primary"
            disabled={busy || status.installPath === null}
            onClick={() => status.installPath !== null && void extractFrom(status.installPath)}
          >
            {busy ? "Extracting…" : "Re-extract now"}
          </button>
          <button disabled={busy} onClick={() => void chooseAndExtract()}>
            Change modpack folder…
          </button>
        </div>

        <div className="faint text-sm mt-4">
          Your modpack folder is only ever <strong>read from</strong>, and nothing extracted is
          redistributed. Re-extracting reads every jar in <code>mods/</code> to resolve gear
          sprites, so it takes a few seconds longer than the registry pass alone.
        </div>
      </div>

      {error !== null && (
        <div className="notice bad">
          <strong>Extraction failed.</strong> {error}
        </div>
      )}

      {summary !== null && <Summary summary={summary} />}
    </div>
  );
}

function Summary({ summary }: { summary: ExtractSummary }): ReactNode {
  return (
    <div className="card">
      <div className="section-title mt-0">
        Last extraction
      </div>
      <dl className="summary-grid">
        <Row label="Mine and Slash" value={summary.mineAndSlashVersion} />
        <Row label="Registry entries" value={summary.entries.toLocaleString()} />
        <Row label="Lang keys" value={summary.langKeys.toLocaleString()} />
        <Row label="Textures written" value={summary.assetsWritten.toLocaleString()} />
        <Row
          label="Gear sprites"
          value={`${summary.itemIcons.resolved} of ${summary.itemIcons.total}`}
        />
        <Row label="Code-only stats" value={summary.codeOnlyStats.toLocaleString()} />
        <Row label="Duplicate GUIDs" value={summary.duplicateIds.toLocaleString()} />
        <Row label="Id/filename mismatches" value={summary.idMismatches.toLocaleString()} />
      </dl>

      {summary.unresolvedItems.length > 0 && (
        <div className="faint text-sm mt-3">
          {/*
            Almost always vanilla items, whose textures live in the client jar rather than under
            `mods/`. Reported rather than substituted, in the same spirit as the 51 perk icons
            the pack names but does not ship.
          */}
          No sprite found for {summary.unresolvedItems.length}:{" "}
          <code>{summary.unresolvedItems.slice(0, 8).join(", ")}</code>
          {summary.unresolvedItems.length > 8 && " …"}
        </div>
      )}

      {summary.fatal.length > 0 ? (
        <div className="notice bad mt-5">
          <strong>This snapshot is not trustworthy.</strong>
          <ul className="mt-3 mb-0" style={{ paddingLeft: 18 }}>
            {summary.fatal.slice(0, 8).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="notice info mt-5">
          Duplicate GUIDs and id mismatches are properties of the pack as shipped, not extraction
          errors. They are reported because the engine reproduces what the game actually does
          rather than correcting it.
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  return (
    <>
      <dt className="faint">{label}</dt>
      <dd className={mono === true ? "mono" : undefined} title={value}>
        {value}
      </dd>
    </>
  );
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "unknown";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString();
}
