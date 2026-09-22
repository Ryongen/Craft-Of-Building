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
 *  - **an item copied in game with Ctrl+Shift+C**, which is exact and is the only one of the
 *    three that works for a jewel, an omen, a Skill, a support gem or an Augment. It is also the
 *    only one that needs no operator level: `/data get` is refused on a server where you are not
 *    one, and there is no way to copy a tooltip in vanilla at all.
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

import {
  KIND_LABEL,
  auraName,
  importPaste,
  jewelName,
  omenName,
  spellName,
  supportGemName,
  type AffixRoll,
  type ImportIssue,
  type ImportedThing,
  type Item,
  type PasteResult,
} from "@cte2/schema";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useWorld } from "../../state/snapshot.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

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
const FORMAT_LABEL: Record<PasteResult["format"], string> = {
  "copied-item": "copied in game — exact",
  document: "this app's item JSON — exact",
  nbt: "item NBT — exact",
  tooltip: "tooltip text",
  unknown: "nothing recognisable",
};

/** The button, and so the promise it makes about where the paste is going. */
const DESTINATION: Record<ImportedThing["kind"], string> = {
  gear: "Add to gear",
  jewel: "Add to jewels",
  omen: "Set as your omen",
  skill: "Add to skills",
  support: "Link into a skill",
  aura: "Add to Augments",
};

export function ImportDialog({
  onImport,
  onClose,
}: {
  /** Gear only: it goes to the editor, so the slot it lands in is still a choice being made. */
  onImport: (item: Item) => void;
  onClose: () => void;
}): ReactNode {
  const { snapshot } = useWorld();
  const [text, setText] = useState("");

  const doc = useBuild((s) => s.doc);
  const addJewel = useBuild((s) => s.addJewel);
  const setOmen = useBuild((s) => s.setOmen);
  const addSkill = useBuild((s) => s.addSkill);
  const updateSkill = useBuild((s) => s.updateSkill);
  const setAuras = useBuild((s) => s.setAuras);

  // Parsing is cheap and pure, so there is no reason to make the user press a button before
  // they can see whether it worked.
  const result = useMemo<PasteResult | undefined>(
    () => (text.trim().length === 0 ? undefined : importPaste(text, snapshot)),
    [text, snapshot],
  );

  const thing = result?.thing;

  /*
    A support gem is the one paste with nowhere obvious to go.

    The other five describe themselves: a jewel is a jewel, there is one omen, a Skill goes on
    the bar. A support gem is a modifier *of* a skill, and which skill it is linked into is the
    whole question it raises — so it is asked here rather than guessed, defaulting to the skill
    damage is reported for, which is the one you are usually looking at.
  */
  const skills = doc.skills ?? [];
  const mainSkill = Math.max(0, skills.findIndex((s) => s.main === true));
  const [linkTo, setLinkTo] = useState<number | null>(null);
  const target = linkTo ?? mainSkill;

  const blocked = thing?.kind === "support" && skills.length === 0;

  /** Where each kind lands. Gear is the only one that goes back to the caller. */
  const apply = (): void => {
    if (thing === undefined) return;
    switch (thing.kind) {
      case "gear":
        onImport(thing.item);
        return;
      case "jewel":
        addJewel(thing.jewel);
        break;
      case "omen":
        setOmen(thing.omen);
        break;
      case "skill":
        addSkill(thing.skill);
        break;
      case "aura":
        setAuras([...(doc.auras ?? []), thing.aura]);
        break;
      case "support": {
        const skill = skills[target];
        if (skill === undefined) return;
        updateSkill(target, {
          ...skill,
          supports: [...(skill.supports ?? []), thing.support],
        });
        break;
      }
    }
    onClose();
  };

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

        <>
        <Plain>
          <div className="notice info mb-5">
            With the exporter mod installed, press Ctrl+Shift+C in game over any item — gear, a jewel, an omen, a Skill, a support gem or an Augment — and paste it here. That is exact and needs no permissions. Otherwise: hold Shift while hovering the item, then copy its tooltip. Without Shift the game merges every affix into one list with no ranges and no tiers, and two affixes granting the same stat arrive already added together, with no way to tell them apart afterwards.
          </div>
        </Plain>
        <Tech>
          <div className="notice info mb-5">
            <strong>Ctrl+Shift+C in game is exact and reads all five item kinds</strong> — the
            mod writes the document shape straight out of the stack&apos;s own{" "}
            <code>StackSaving</code> data, so no roll is inverted out of a displayed value.
            Failing that: <strong>hold Shift over the item before copying its tooltip.</strong> Without it the
            game merges every affix into one list with no ranges and no tiers
            (<code>GearTooltipUtils</code> branches on <code>useInDepthStats()</code>), and two
            affixes granting the same stat are already added together — there is nothing left to
            take apart. <code>/data get entity @s SelectedItem</code> works whatever you are
            holding and is exact.
          </div>
        </Tech>
        </>

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
          {thing?.kind === "support" && skills.length > 0 && (
            <select
              value={target}
              title="Which skill this support gem links into"
              onChange={(event) => setLinkTo(Number(event.target.value))}
            >
              {skills.map((skill, index) => (
                <option key={index} value={index}>
                  {spellName(snapshot, skill.spellId) ?? skill.spellId}
                  {skill.main === true ? " (main)" : ""}
                </option>
              ))}
            </select>
          )}
          <button className="primary" disabled={thing === undefined || blocked} onClick={apply}>
            {thing === undefined ? "Add to gear" : DESTINATION[thing.kind]}
          </button>
        </div>

        {result !== undefined && (
          <>
            {thing !== undefined && <Landing thing={thing} name={result.name} />}
            {blocked && (
              <div className="notice mt-4">
                This is a support gem, and there is no skill to link it into yet. Add a skill on the
                Skills tab first.
              </div>
            )}
            {thing?.kind === "gear" && <Summary item={thing.item} />}
            <IssueList title="Cannot import" issues={errors} tone="bad" />
            <IssueList title="Check these" issues={warnings} tone="warn" />
            <IssueList title="Notes" issues={notes} tone="faint" />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * What arrived, and where the button is about to put it.
 *
 * One paste box now accepts six different things, which is the right shape for a clipboard — you
 * copied an item, not a category — but it means the button's label is the only thing saying what
 * is about to happen, and a button label is read last. So the reading is stated in full first, in
 * the game's own words for the item, before anything is added to the build.
 */
function Landing({ thing, name }: { thing: ImportedThing; name?: string | undefined }): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);

  const detail = ((): string => {
    switch (thing.kind) {
      case "gear":
        return name ?? thing.item.base;
      case "jewel":
        return jewelName(snapshot, thing.jewel);
      case "omen":
        return omenName(snapshot, thing.omen.id);
      case "skill":
        return spellName(snapshot, thing.skill.spellId);
      case "support":
        return supportGemName(snapshot, thing.support.id);
      case "aura":
        return auraName(snapshot, thing.aura.id);
    }
  })();

  // The one destructive landing: there is exactly one omen slot (`CURIO_BLOCKS` gives OMEN a
  // count of 1), so pasting one over a build that has one is a replacement, and says so.
  const replaces = thing.kind === "omen" && doc.omen !== undefined;

  return (
    <div className="notice info mt-4">
      Read as {KIND_LABEL[thing.kind]}: <strong>{detail}</strong>
      {replaces && " — this replaces the omen this build already has."}
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
