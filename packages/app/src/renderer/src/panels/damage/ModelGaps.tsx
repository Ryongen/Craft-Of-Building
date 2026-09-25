import { type DpsResult } from "@cte2/engine";
import { type ReactNode } from "react";

export function ModelGaps({ model }: { model: DpsResult["model"] }): ReactNode {
  const { unreachableGroups, unmodelledActs, unmodelledSummons } = model;
  if (
    unreachableGroups.length === 0 &&
    unmodelledActs.length === 0 &&
    unmodelledSummons.length === 0
  ) {
    return null;
  }

  return (
    <div className="card">
      {unmodelledSummons.length > 0 && (
        <div className="text-sm mb-2">
          <span className="badge bad">summons</span> Puts a vanilla entity in the world (
          <CodeList ids={unmodelledSummons} />) whose damage is Minecraft&apos;s rather than this
          pack&apos;s, so it sits on no stat sheet and cannot be counted.
        </div>
      )}
      {unmodelledActs.length > 0 && (
        <div className="text-sm mb-2">
          <span className="badge warn">acts</span> Uses <CodeList ids={unmodelledActs} />, which
          this app doesn&apos;t model. It might not affect damage, but there&apos;s no way to
          tell.
        </div>
      )}
      {unreachableGroups.length > 0 && (
        <div className="faint text-sm">
          <span className="badge">branches</span> {unreachableGroups.length} component group
          {unreachableGroups.length === 1 ? "" : "s"} nothing reached
          <span title={unreachableGroups.join(", ")}>
            {" "}
            ({unreachableGroups.slice(0, 4).join(", ")}
            {unreachableGroups.length > 4 ? ", …" : ""})
          </span>
          . Usually a branch that needs an effect you don&apos;t have. The blocked list above
          shows which.
        </div>
      )}
    </div>
  );
}

/**
 * What your pets do, which for a summoner is the whole of what the button does.
 *
 * A summon skill declares no `damage` act at all, so its own DPS is zero and everything it is
 * worth lives here. The three columns that are not the number are the three things a player will
 * want to argue with: how many pets, how fast each one swings, and why.
 *
 * The swing rate is vanilla's AI and **not** your attack speed — `MeleeAttackGoal` reads no
 * attribute, so a summoner stacking attack speed does not make their zombies bite faster. That is
 * counter-intuitive enough to say on screen rather than leave to a hover.
 */

/** Ids as `<code>` spans with commas between them — a joined HTML string would render as text. */
function CodeList({ ids }: { ids: readonly string[] }): ReactNode {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 ? ", " : ""}
          <code>{id}</code>
        </span>
      ))}
    </>
  );
}
