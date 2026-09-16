/**
 * Everything the validator and the engine had to say.
 *
 * This project's engine reports rather than assumes — unimplemented context modifiers, rolls
 * it had to floor at 0%, conditions no static document can answer, effects it knows it left
 * out. That posture is only worth anything if the reports are somewhere a person reads, which
 * is why this is a first-class panel and not a console log.
 */

import type { Diagnostic } from "@cte2/schema";
import { useMemo, useState, type ReactNode } from "react";

import { useDerived } from "../../state/derived.js";
import { SearchInput } from "../../ui/SearchInput.js";

export function Diagnostics(): ReactNode {
  const derived = useDerived();
  const [query, setQuery] = useState("");

  const { errors, warnings, notes } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = derived.diagnostics.filter(
      (d) =>
        needle.length === 0 ||
        d.message.toLowerCase().includes(needle) ||
        d.code.toLowerCase().includes(needle) ||
        d.path.toLowerCase().includes(needle),
    );
    return {
      errors: matching.filter((d) => d.severity === "error"),
      warnings: matching.filter((d) => d.severity === "warning"),
      notes: matching.filter((d) => d.severity === "info"),
    };
  }, [derived.diagnostics, query]);

  return (
    <div className="panel">
      <div className="notice info">
        An <strong>error</strong> means the game could not have produced this character. A{" "}
        <strong>warning</strong> means the engine did something it wants you to know about —
        usually a value it had to floor, or a mechanic it has not implemented and is therefore
        under-reporting. A <strong>note</strong> is neither: it is the damage model showing its
        working, so a figure can be read rather than trusted.
      </div>

      <div className="row mb-4">
        <SearchInput grow placeholder="Filter diagnostics…" value={query} onChange={setQuery} />
        <span className={`badge ${errors.length > 0 ? "bad" : "good"}`}>
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </span>
        <span className={`badge ${warnings.length > 0 ? "warn" : ""}`}>
          {warnings.length} warning{warnings.length === 1 ? "" : "s"}
        </span>
        <span className="badge">
          {notes.length} note{notes.length === 1 ? "" : "s"}
        </span>
      </div>

      {errors.length === 0 && warnings.length === 0 && notes.length === 0 && (
        <div className="empty">Nothing to report.</div>
      )}

      {errors.length > 0 && (
        <>
          <div className="section-title">Errors</div>
          {errors.map((d, index) => (
            <Row key={`${d.code}-${d.path}-${index}`} diagnostic={d} />
          ))}
        </>
      )}

      {warnings.length > 0 && (
        <>
          <div className="section-title">Warnings</div>
          {warnings.map((d, index) => (
            <Row key={`${d.code}-${d.path}-${index}`} diagnostic={d} />
          ))}
        </>
      )}

      {notes.length > 0 && (
        <>
          <div className="section-title">Notes</div>
          {notes.map((d, index) => (
            <Row key={`${d.code}-${d.path}-${index}`} diagnostic={d} />
          ))}
        </>
      )}
    </div>
  );
}

function Row({ diagnostic }: { diagnostic: Diagnostic }): ReactNode {
  return (
    <div className={`diag ${diagnostic.severity}`}>
      <span className="dot">
        {diagnostic.severity === "error" ? "✖" : diagnostic.severity === "warning" ? "▲" : "·"}
      </span>
      <span className="grow">
        {stripBackticks(diagnostic.message)}
        <span className="faint mono text-sm" style={{ marginLeft: 6 }}>
          {diagnostic.path}
        </span>
      </span>
      <span className="code">{diagnostic.code}</span>
    </div>
  );
}

/** The engine writes messages in markdown-ish backticks; render them as plain emphasis. */
function stripBackticks(message: string): ReactNode {
  const parts = message.split("`");
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="mono" style={{ color: "var(--accent)" }}>
        {part}
      </code>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}
