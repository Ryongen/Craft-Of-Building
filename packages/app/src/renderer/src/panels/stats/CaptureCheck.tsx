/**
 * The app's own numbers, against the game's.
 *
 * When a build is opened from a **capture** — a file the in-game exporter wrote — it carries
 * `observed`: the server's finished stat sheet for that character. This panel diffs the
 * engine's output against it, which is the same thing `npm run fixtures` does, in front of the
 * person who actually cares.
 *
 * It matters because everything else in this app asks you to take its word for it. A planner
 * that says "4601 health" is worth very little on its own; one that says "4601 health, and the
 * game said 4601 for the character this was captured from" is worth something quite different.
 *
 * The comparison is only honest while the document still describes the captured character, so
 * the store drops `observed` on the first edit and this panel says so rather than quietly
 * comparing against a build that no longer exists.
 */

import { statName } from "@cte2/schema";
import { useState, type ReactNode } from "react";

import { useCaptureCheck } from "../../state/capture.js";
import { useWorld } from "../../state/snapshot.js";
import { SearchInput } from "../../ui/SearchInput.js";

export function CaptureCheck(): ReactNode {
  const check = useCaptureCheck();
  const { snapshot } = useWorld();
  const [onlyBad, setOnlyBad] = useState(true);
  const [query, setQuery] = useState("");

  if (check.kind === "none") {
    const dirty = check.dirty;
    return (
      <div className="panel">
        <div className="notice info">
          {dirty ? (
            <>
              This build has been edited since it was opened, so the capture it came from no
              longer describes it and the comparison has been dropped. Re-open the capture to
              check the character as it was.
            </>
          ) : (
            <>
              Nothing to check against. Open a file written by the in-game exporter (F6, or{" "}
              <code>/pobexport</code>) and this panel will diff every stat the engine computes
              against what the game actually reported for that character.
            </>
          )}
        </div>
      </div>
    );
  }

  const { observed, rows } = check;
  const bad = rows.filter((r) => !r.ok);
  // Hundreds of rows keyed by a raw id, and no way to find one. Matched on the name as well as
  // the id, the same way every other list in this app searches: you know the stat as "Crit
  // Chance" long before you know it as `crit_chance`.
  const needle = query.trim().toLowerCase();
  const shown = (onlyBad ? bad : rows).filter(
    (row) =>
      needle.length === 0 ||
      row.statId.toLowerCase().includes(needle) ||
      statName(snapshot, row.statId).toLowerCase().includes(needle),
  );
  const stale = observed.mineAndSlashVersion !== snapshot.meta.mineAndSlashVersion;

  return (
    <div className="panel">
      <div className={bad.length === 0 ? "notice" : "notice warn"}>
        {bad.length === 0 ? (
          <>
            <strong>All {rows.length} stats match.</strong> Every number this app shows for this
            character is the number the game reported for it, compared at{" "}
            {observed.source === "mod_dump" ? "float precision" : "the stat screen's 2 decimals"}.
          </>
        ) : (
          <>
            <strong>
              {bad.length} of {rows.length} stats disagree
            </strong>{" "}
            with the game. That&apos;s either a bug or a mechanic this app can&apos;t model yet.
            Diagnostics usually says which.
          </>
        )}
      </div>

      {stale && (
        <div className="notice warn">
          This capture was taken on Mine and Slash{" "}
          <strong>{observed.mineAndSlashVersion}</strong>, but the loaded snapshot is{" "}
          <strong>{snapshot.meta.mineAndSlashVersion}</strong>. Differences may be version drift
          rather than engine bugs.
        </div>
      )}

      <div className="row mb-4">
        <label className="row gap-2">
          <input type="checkbox" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} />
          <span className="faint text-sm">
            only disagreements
          </span>
        </label>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={`Filter ${rows.length} stats…`}
          width={200}
        />
        <span className="faint text-sm">
          captured {observed.capturedAt} · pack {observed.packVersion}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="faint text-sm">
          {needle.length > 0
            ? `Nothing matches “${query}”.`
            : `Nothing to show. Untick the box to see all ${rows.length}.`}
        </div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Stat</th>
              <th style={{ textAlign: "right" }}>Game</th>
              <th style={{ textAlign: "right" }}>This app</th>
              <th style={{ textAlign: "right" }}>Off by</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.statId}>
                {/* The name is what a player knows the stat by; the id stays on the hover,
                    because a capture disagreement is something you go and grep for. */}
                <td title={r.statId}>{statName(snapshot, r.statId)}</td>
                <td style={{ textAlign: "right" }}>{trim(r.expected)}</td>
                <td style={{ textAlign: "right" }}>{trim(r.actual)}</td>
                <td style={{ textAlign: "right" }} className={r.ok ? "faint" : ""}>
                  {r.ok ? "—" : trim(r.delta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Short enough to scan in a column, without inventing precision the number lacks. */
function trim(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.001 || abs >= 1e6) return value.toExponential(2);
  return String(Number(value.toPrecision(6)));
}
