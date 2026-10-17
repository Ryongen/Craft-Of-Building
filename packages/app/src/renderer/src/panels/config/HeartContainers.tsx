/**
 * Paraglider Heart Containers.
 *
 * Each one raises `minecraft:generic.max_health` by a heart, and Mine and Slash adds vanilla max
 * health straight into its own flat health pool before every percent multiplies it. A capture
 * already records the total, so this is for builds made in the app — the field locks when the
 * document carries a captured max health, because that number includes every container and
 * there is no way to tell them apart from food diversity's share.
 */

import type { ReactNode } from "react";

import { HEALTH_PER_HEART_CONTAINER, paragliderHearts } from "@cte2/schema";
import { useBuild } from "../../state/build-store.js";
import { useWorld } from "@cte2/view";
import { NumberField } from "../../ui/fields.js";
import { Plain, Tech } from "../../ui/copy/hint.js";

export function HeartContainers(): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setHeartContainers = useBuild((s) => s.setHeartContainers);

  const { maxHeartContainers, fromPack } = paragliderHearts(snapshot);
  const captured = doc.character.attributes?.["minecraft:generic.max_health"];
  const locked = captured !== undefined && captured !== 0;
  const count = doc.character.heartContainers ?? 0;

  return (
    <>
      <div className="section-title">Heart Containers</div>
      <div className="card">
        <div className="row wrap">
          <NumberField
            value={count}
            min={0}
            max={maxHeartContainers}
            width={64}
            disabled={locked}
            onChange={(value) => setHeartContainers(value)}
          />
          <span className="faint text-sm">
            consumed{maxHeartContainers !== undefined ? ` (max ${maxHeartContainers})` : ""}
          </span>
          {!locked && count > 0 && (
            <span className="badge">+{count * HEALTH_PER_HEART_CONTAINER} vanilla max health</span>
          )}
          {!locked && count > 0 && (
            <button onClick={() => setHeartContainers(undefined)}>Clear</button>
          )}
        </div>

        {locked ? (
          <div className="notice mt-3">
            <Plain>
              This build's maximum health was captured from the game ({captured}), and that already
              includes your Heart Containers.
            </Plain>
            <Tech>
              This build carries a captured <code>minecraft:generic.max_health</code> of {captured},
              which already includes every Heart Container, so the field is locked.
            </Tech>
          </div>
        ) : (
          <>
            <Plain>
              <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
                Each Heart Container is one more heart, which Mine and Slash adds to your health
                before your health percentages multiply it. Imported builds already include them.
                {fromPack ? "" : " No Paraglider config was found in your install, so no cap is applied."}
              </div>
            </Plain>
            <Tech>
              <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
                Each container is +{HEALTH_PER_HEART_CONTAINER} <code>generic.max_health</code>, which{" "}
                <code>InCalc.addVanillaHpToStats</code> adds as flat health (clamped to 500), and{" "}
                <code>health_compat</code> also reads it for magic shield. The cap comes from{" "}
                <code>paraglider-server.toml</code>
                {fromPack ? "." : ", which was not found in your install, so none is applied."}
              </div>
            </Tech>
          </>
        )}
      </div>
    </>
  );
}
