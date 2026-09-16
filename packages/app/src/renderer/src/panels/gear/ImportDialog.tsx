/**
 * Paste an item in rather than rebuilding it by hand.
 *
 * Entering a level 94 amulet through the editor means picking a base, a rarity, a level, four
 * affixes, four tiers and four roll percents — and the roll percent is a number no player can
 * read anywhere, because the tooltip prints values. So the two things the game *will* show you
 * are what this takes, and which one you pasted is detected rather than asked:
 *
 *  - **the tooltip**, held with Shift so the `[min - max] [Tier]` suffix renders;
 *  - **the NBT**, from `/data get entity @s SelectedItem`, which is exact.
 *
 * It also reads **this app's own item JSON**, which the ⧉ JSON button on every gear row writes.
 * That is what moves an item between two builds, and it is the same shape a fixture holds, so
 * there is one paste box rather than one per format.
 *
 * Everything the parse was unsure about is listed rather than hidden, and the item still lands
 * in the editor so a warning is something to check rather than something to start over from.
 * That is the same posture as the rest of this project: a number nobody verified is labelled,
 * never quietly assumed.
 */

import { importItem, type AffixRoll, type ImportIssue, type ImportResult, type Item } from "@cte2/schema";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useWorld } from "../../state/snapshot.js";

/** What the in-game tooltip looks like when Shift is held, as a worked example. */
const EXAMPLE = `Promised Lapis Amulet of the Wind
Player Level Min: 94

Implicit Stats:
+25 Intelligence

Prefix Stats:
+3.2% Attack Hits Health Leech   [3.1 - 3.7] [Epic]
+103 Magic Shield Regen   [90 - 109] [Epic]

Suffix Stats:
+10.3% Cold Damage   [9.2 - 11.2] [Epic]
+11.9 Dexterity   [10.4 - 12.6] [Epic]

Item Type: Necklace
Tags: Jewelry Family, Necklace

Epic Item`;

/**
 * What each reader is called on screen.
 *
 * A map rather than a ternary, which is what this was: adding the document reader to a
 * `format === "nbt" ? … : "tooltip text"` would have labelled a pasted item "tooltip text" and
 * quietly implied its rolls had been inferred when they are exact.
 */
const FORMAT_LABEL: Record<ImportResult["format"], string> = {
  document: "this app's item JSON — exact",
  nbt: "item NBT — exact",
  tooltip: "tooltip text",
  unknown: "nothing recognisable",
};

export function ImportDialog({
  onImport,
  onClose,
}: {
  onImport: (item: Item) => void;
  onClose: () => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const [text, setText] = useState("");

  // Parsing is cheap and pure, so there is no reason to make the user press a button before
  // they can see whether it worked.
  const result = useMemo<ImportResult | undefined>(
    () => (text.trim().length === 0 ? undefined : importItem(text, snapshot)),
    [text, snapshot],
  );

  // Escape closes it. A dialog you can only leave by aiming at a button is the kind of thing
  // nobody reports as a bug and everybody resents. Bound on `window` rather than on the dialog
  // because focus starts on the backdrop, which is not focusable, so a local handler never fires.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const errors = result?.issues.filter((i) => i.severity === "error") ?? [];
  const warnings = result?.issues.filter((i) => i.severity === "warning") ?? [];
  const notes = result?.issues.filter((i) => i.severity === "info") ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="row mb-4">
          <strong style={{ fontSize: 14 }}>Import an item</strong>
          <span className="grow" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="notice info mb-5">
          <strong>Hold Shift over the item before copying its tooltip.</strong> Without it the
          game merges every affix into one list with no ranges and no tiers
          (<code>GearTooltipUtils</code> branches on <code>useInDepthStats()</code>), and two
          affixes granting the same stat are already added together — there is nothing left to
          take apart. <code>/data get entity @s SelectedItem</code> works whatever you are
          holding and is exact.
        </div>

        <textarea
          className="paste"
          autoFocus
          spellCheck={false}
          placeholder={EXAMPLE}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="row wrap mt-4">
          <button onClick={() => setText(EXAMPLE)} disabled={text.length > 0}>
            Paste the example
          </button>
          <button
            title="Read whatever is on the clipboard — a tooltip, item NBT, or an item copied from another build"
            onClick={() => void navigator.clipboard.readText().then(setText, () => undefined)}
          >
            Paste from clipboard
          </button>
          <button onClick={() => setText("")} disabled={text.length === 0}>
            Clear
          </button>
          <span className="grow" />
          {result !== undefined && (
            <span className="badge">read as {FORMAT_LABEL[result.format]}</span>
          )}
          <button
            className="primary"
            disabled={result?.item === undefined}
            onClick={() => result?.item !== undefined && onImport(result.item)}
          >
            Add to gear
          </button>
        </div>

        {result !== undefined && (
          <>
            {result.item !== undefined && <Summary item={result.item} />}
            <IssueList title="Cannot import" issues={errors} tone="bad" />
            <IssueList title="Check these" issues={warnings} tone="warn" />
            <IssueList title="Notes" issues={notes} tone="faint" />
          </>
        )}
      </div>
    </div>
  );
}

/** What the reader made of it, in the document's own vocabulary. */
function Summary({ item }: { item: Item }): ReactNode {
  const rows: [string, string][] = [
    ["base", item.base],
    ["rarity", item.rarity],
    ["item level", String(item.itemLevel)],
  ];

  // `tier` is absent on implicits, which the game stores without one — show just the roll.
  const affixes = (label: string, rolls: readonly AffixRoll[] | undefined) =>
    rolls === undefined || rolls.length === 0
      ? []
      : ([
          [
            label,
            rolls
              .map((r) =>
                r.tier === undefined
                  ? `${r.affixId} (@ ${r.rollPercent}%)`
                  : `${r.affixId} (${r.tier} @ ${r.rollPercent}%)`,
              )
              .join(", "),
          ],
        ] as [string, string][]);

  rows.push(
    ...affixes("implicits", item.implicits),
    ...affixes("prefixes", item.prefixes),
    ...affixes("suffixes", item.suffixes),
    ...affixes("corruptions", item.corruptions),
  );
  if (item.unique !== undefined) rows.push(["unique", item.unique]);

  return (
    <div className="card mt-5">
      <div className="section-title mt-0">
        Read as
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="row text-md">
          <span className="faint" style={{ width: 92, flex: "0 0 auto" }}>
            {label}
          </span>
          <span className="mono ellipsis">{value}</span>
        </div>
      ))}
    </div>
  );
}

function IssueList({
  title,
  issues,
  tone,
}: {
  title: string;
  issues: readonly ImportIssue[];
  tone: "bad" | "warn" | "faint";
}): ReactNode {
  if (issues.length === 0) return null;
  const colour = tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--text-faint)";

  return (
    <div className="card mt-4">
      <div className="section-title mt-0" style={{ color: colour }}>
        {title} <span className="faint">({issues.length})</span>
      </div>
      {issues.map((issue, index) => (
        <div key={index} className="text-md" style={{ marginBottom: 5 }}>
          <div className="row">
            <span style={{ color: colour }}>{issue.message}</span>
            <span className="grow" />
            <span className="code faint text-xs">
              {issue.code}
            </span>
          </div>
          {issue.line !== undefined && (
            <div className="mono faint text-sm" style={{ paddingLeft: 8 }}>
              {issue.line}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
