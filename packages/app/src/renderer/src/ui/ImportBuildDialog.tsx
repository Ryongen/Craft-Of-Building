/**
 * Open a whole build from text: a `cob1:` build code, a build's JSON, or a capture the exporter
 * mod put on the clipboard.
 *
 * The item import dialog reads one item into the build you have open; this replaces the build.
 * Both read through `@cte2/schema`, so what opens here is exactly what opens from a file and
 * what the build catalogue accepts.
 */

import { readBuildText, type ReadBuild } from "@cte2/schema";
import { useEffect, useState, type ReactNode } from "react";

type Props = {
  onImport(read: ReadBuild): void;
  onClose(): void;
};

type Reading = { kind: "empty" } | { kind: "ok"; read: ReadBuild } | { kind: "error"; message: string };

export function ImportBuildDialog({ onImport, onClose }: Props): ReactNode {
  const [text, setText] = useState("");
  const [reading, setReading] = useState<Reading>({ kind: "empty" });

  // Decoding a code is async, so a slow answer for old text must not overwrite a newer one.
  useEffect(() => {
    if (text.trim().length === 0) {
      setReading({ kind: "empty" });
      return;
    }
    let current = true;
    readBuildText(text).then(
      (read) => current && setReading({ kind: "ok", read }),
      (err: unknown) =>
        current && setReading({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      current = false;
    };
  }, [text]);

  // Escape closes it — see the same handler in the item import dialog for why it is on `window`.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const read = reading.kind === "ok" ? reading.read : undefined;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="row mb-4">
          <strong style={{ fontSize: 14 }}>Import a build</strong>
          <span className="grow" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="notice info mb-5">
          Paste a build code (it starts with <code>cob1:</code>), a build&apos;s JSON, or a character
          you exported from the game with F6. It replaces the build you have open.
        </div>

        <textarea
          className="paste"
          autoFocus
          spellCheck={false}
          placeholder="cob1:…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="row wrap mt-4">
          <button onClick={() => void navigator.clipboard.readText().then(setText, () => undefined)}>
            Paste from clipboard
          </button>
          <button onClick={() => setText("")} disabled={text.length === 0}>
            Clear
          </button>
          <span className="grow" />
          {read !== undefined && (
            <span className="badge">
              {read.doc.meta?.name ?? "Unnamed build"} · level {read.doc.character.level}
              {read.observed !== null ? " · captured in game" : ""}
            </span>
          )}
          <button className="primary" disabled={read === undefined} onClick={() => read && onImport(read)}>
            Open this build
          </button>
        </div>

        {reading.kind === "error" && <div className="notice mt-4">{reading.message}</div>}
      </div>
    </div>
  );
}
