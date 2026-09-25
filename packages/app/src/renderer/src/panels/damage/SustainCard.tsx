import { type DpsResult } from "@cte2/engine";
import { type ReactNode } from "react";

import { num, smart } from "../../ui/fields.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

/**
 * The verdict, in one line, for the folding panel's head.
 *
 * Exported rather than rendered inside the card because the whole point of a card that folds is
 * that its answer is readable while it is folded — and for most builds most of the time "every
 * pool keeps up" *is* the answer and the two tables below are the working. It is computed here
 * rather than in the panel so the sentence and the rows it summarises cannot drift.
 */
export function sustainVerdict(dps: DpsResult): { text: string; bad: boolean; blood: boolean } {
  const { cost } = dps;
  const tooSmall = cost.budget.find((row) => !row.holdsACast);
  const worst = cost.budget.reduce<(typeof cost.budget)[number] | undefined>(
    (found, row) => (found === undefined || row.netPerSecond < found.netPerSecond ? row : found),
    undefined,
  );

  return {
    text: cost.sustainable
      ? "every pool keeps up"
      : tooSmall !== undefined
        ? `${tooSmall.resource.replace(/_/g, " ")} cannot hold one cast`
        : `${worst?.resource.replace(/_/g, " ")} runs dry in ${num(worst?.secondsToEmpty ?? 0, 1)}s`,
    bad: !cost.sustainable,
    blood: cost.manaSpentAs === "blood" || cost.energySpentAs === "blood",
  };
}

/**
 * Whether the pools keep up, and what happens when they do not.
 *
 * Three incomes and one spend, and the game meters two of the three. Regeneration is a restore
 * event once a second with `<r>_regen`, `<r>_per_sec` and every `on_restore_resource` percent
 * feeding it; leech is banked and paid out at `<r>_leech_cap`% of the pool per second — base 5,
 * so a build that leeches hard is usually throwing most of it away and the number worth improving
 * is the pool, not the leech. The spend is this cast at this rate.
 *
 * `in_combat` is a ten-second cooldown re-stamped by every hit you land or take, so the column
 * used here is the in-combat one. Anything gated on `is_in_combat_is_false` — `out_of_combat_regen`
 * — is worth nothing during a rotation, however good it looks on the Defence tab.
 *
 * The verdict this used to print on its own heading is `sustainVerdict` above, because the card
 * now folds and its head is where the answer goes.
 */
export function SustainCard({ dps }: { dps: DpsResult }): ReactNode {
  const { cost } = dps;
  const rows = cost.budget;
  if (rows.length === 0 && cost.leech.unrated.length === 0) return null;

  return (
    <div className="card">
      {rows.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Pool</th>
              <th className="num">Max</th>
              <th className="num">Regen</th>
              <th className="num">Leech</th>
              <th className="num">Spent</th>
              <th className="num">Net</th>
              <th className="num">Empty in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.resource} className={row.sustainable ? undefined : "highlight"}>
                <td>{row.resource.replace(/_/g, " ")}</td>
                <td className="num">{smart(row.max)}</td>
                <td className="num" title="In-combat regeneration, which is what applies during a rotation">
                  {smart(row.regenPerSecond)}/s
                </td>
                <td className="num">
                  {row.leechPerSecond === 0 ? "—" : `${smart(row.leechPerSecond)}/s`}
                </td>
                <td className="num">
                  {row.costPerSecond === 0 ? "—" : `${smart(row.costPerSecond)}/s`}
                </td>
                <td className="num" style={{ color: row.sustainable ? undefined : "var(--warn)" }}>
                  {row.netPerSecond >= 0 ? "+" : ""}
                  {smart(row.netPerSecond)}/s
                </td>
                <td className="num">
                  {!row.holdsACast ? (
                    <span
                      style={{ color: "var(--warn)" }}
                      title={`The pool caps at ${smart(row.max)} and one cast costs ${smart(row.costPerCast)}. A pool never fills past its maximum, so regeneration cannot close this.`}
                    >
                      never casts
                    </span>
                  ) : row.secondsToEmpty === undefined ? (
                    "never"
                  ) : (
                    `${num(row.secondsToEmpty, 1)}s` +
                    (row.castsBeforeEmpty === undefined
                      ? ""
                      : ` · ${Math.floor(row.castsBeforeEmpty)} casts`)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <LeechDetail leech={cost.leech} />
    </div>
  );
}

/** The leech cap, which is usually the binding constraint and never says so on its own. */
function LeechDetail({ leech }: { leech: DpsResult["cost"]["leech"] }): ReactNode {
  const capped = leech.byResource.filter((entry) => entry.capped);

  return (
    <>
      {leech.byResource.length > 0 && (
        <table className="grid mt-5">
          <thead>
            <tr>
              <th>Leech</th>
              <th className="num">Generated</th>
              <th className="num">Cap</th>
              <th className="num">Paid out</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {leech.byResource.map((entry) => (
              <tr key={entry.resource} className={entry.capped ? "highlight" : undefined}>
                <td>{entry.resource.replace(/_/g, " ")}</td>
                <td className="num">{smart(entry.generatedPerSecond)}/s</td>
                <td
                  className="num"
                  title={`${entry.resource}_leech_cap is ${num(entry.capPercent, 1)}% of a ${smart(entry.max)} pool. The bank holds five seconds of it: ${smart(entry.bankCeiling)}.`}
                >
                  {smart(entry.capPerSecond)}/s
                </td>
                <td className="num">{smart(entry.perSecond)}/s</td>
                <td className="faint">{entry.sources.map((s) => s.statId).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {capped.length > 0 && (
        <div className="faint text-sm mt-4 prose">
          <Plain>
            <strong>Capped.</strong> Leech pays out a percentage of your pool each second, up to
            five seconds&apos; worth. More leech won&apos;t help your{" "}
            {capped.map((entry) => entry.resource.replace(/_/g, " ")).join(" or ")} here; a bigger
            pool or a higher cap will. The base cap is 5% for every pool.
          </Plain>
          <Tech>
            <strong>Capped.</strong> Leech is banked, not restored:{" "}
            <code>onSecondUseLeeches</code> pays out{" "}
            <code>&lt;resource&gt;_leech_cap</code>% of the pool each second and clamps the bank to
            five seconds of that. More leech on gear buys{" "}
            {capped.map((entry) => entry.resource.replace(/_/g, " ")).join(" or ")} nothing here; a
            bigger pool or a higher cap does. The base cap is 5% on every pool.
          </Tech>
        </div>
      )}

      {leech.unrated.length > 0 && (
        <div className="faint text-sm mt-4 prose">
          <strong>Not counted:</strong>{" "}
          {leech.unrated.map((entry) => `${entry.statId} (${num(entry.value, 1)})`).join(", ")}.
          {" "}
          {leech.unrated[0]?.reason}. It does sustain you, but there&apos;s no fixed rate to count.
        </div>
      )}
    </>
  );
}

/**
 * What you have to press before this skill will fire.
 *
 * A finisher's cycle is how often the button comes back, not how often it does anything.
 * `raging_dragon` spends `combo_extender`, which only `spirit_offensive` grants, which spends
 * `combo_linker`, which `elemental_assault` grants, which spends `combo_starter` — and that comes
 * off a basic attack. Four presses to see one dragon, and only the last of them is the 0.5s the
 * rate card shows.
 */
