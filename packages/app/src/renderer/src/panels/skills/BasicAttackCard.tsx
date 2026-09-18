/**
 * Swinging the weapon: what it does, and the two numbers no registry can supply.
 *
 * It sits in the skill list because that is what it is — a damage source on its own clock, in
 * Total DPS beside every Skill — even though it is not a `SkillSetup` and must never become one:
 * the hotbar has eight slots and none of them holds "attack".
 *
 * ## Why the two fields are here
 *
 * `minecraft:generic.attack_speed` and `minecraft:generic.attack_damage` are Minecraft *item*
 * properties. `mmorpg_base_gear_types` names the item (`possible_items: roe_weapons:sword_3`)
 * and the numbers live in that mod's code, so no snapshot the extractor takes can carry them —
 * a capture taken with the weapon in hand, or these boxes, are the only two sources there are.
 *
 * They used to live on a Stats tab, which put them two clicks away from the only figure they
 * move and made both failures silent: a weapon equipped against a bare-handed attack damage is
 * every damage number on the page reading low, and a capture's unsplit attack speed is a swing
 * rate frozen at whatever the character was when the photograph was taken. Beside the figure,
 * both are visible the moment they are wrong.
 */

import { CATEGORY, entry } from "@cte2/schema";
import type { ReactNode } from "react";

import { useBuild } from "../../state/build-store.js";
import { useDerived } from "../../state/derived.js";
import { useWorld } from "../../state/snapshot.js";
import { Fact } from "../../ui/Fact.js";
import { NumberField } from "../../ui/fields.js";
import { num, smart } from "../../ui/format.js";

export function BasicAttackCard(): ReactNode {
  const derived = useDerived();
  const basic = derived.basic;

  return (
    <div className="card">
      <div className="section-title mt-0">Basic attack</div>

      {basic === undefined ? (
        <div className="faint mb-4">
          Nothing to swing. A character holding no weapon has no basic attack, and the two boxes
          below are still worth filling in — <code>attack_damage_compat</code> reads the attribute
          whether or not anything is equipped.
        </div>
      ) : (
        <>
          <div className="row wrap gap-7 mb-4">
            <Fact layout="block" label="hit" value={smart(basic.hit.average.total)} />
            <Fact layout="block" label="crit" value={smart(basic.hit.crit.total)} />
            <Fact
              layout="block"
              label="crit chance"
              value={`${num(basic.hit.critChance * 100, 2)}%`}
            />
            <Fact
              layout="block"
              label="swings"
              value={
                basic.swingsPerSecond === undefined ? null : `${num(basic.swingsPerSecond, 2)}/s`
              }
            />
            <Fact layout="block" label="weapon damage" value={smart(basic.weaponDamage)} />
            <Fact layout="block" label="DPS" value={smart(basic.dps)} />
          </div>
          {basic.untimed ? (
            <div className="notice">
              No attack-speed attribute, so there is no rate to swing at and every figure above is
              a single hit rather than a per-second one. Fill in the weapon speed below.
            </div>
          ) : basic.frozen ? (
            <div className="notice">
              The rate came from a capture&apos;s finished attribute rather than from the
              weapon&apos;s own speed times this build&apos;s <code>attack_speed</code>, so it is
              right for the character that was captured and will not move when you change gear.
              The box below is what unfreezes it.
            </div>
          ) : null}
          <div className="faint text-sm mb-4">
            On its own clock, like ailments and summons: pressing a Skill does not stop you
            swinging. It is already inside the topbar&apos;s Total DPS.
          </div>
        </>
      )}

      <WeaponSpeed />
      <WeaponAttackDamage />
    </div>
  );
}

/**
 * How fast the equipped weapon swings, which is the one half of the rate nothing can derive.
 *
 * `minecraft:generic.attack_speed` is `(4.0 + the item's own modifier) × (1 + attack_speed / 100)`
 * — MnS's stat is a `MULTIPLY_BASE` modifier on vanilla's attribute. The right factor is a stat
 * and moves with every edit; the left one belongs to a Minecraft item whose modifiers are in that
 * mod's code, not in any registry the extractor reads.
 *
 * So a capture's finished attribute cannot be the answer on its own: read whole, it froze the
 * swing rate at whatever the character was when the photograph was taken. Opening a capture
 * splits it — both numbers are in the file — and this field is the other way in, for a weapon no
 * capture ever held.
 */
function WeaponSpeed(): ReactNode {
  const doc = useBuild((s) => s.doc);
  const setBaseAttackSpeed = useBuild((s) => s.setBaseAttackSpeed);
  const derived = useDerived();

  const base = doc.character.baseAttackSpeed;
  const percent = derived.stats.get("attack_speed")?.value ?? 0;
  const captured = doc.character.attributes?.["minecraft:generic.attack_speed"];
  const swings = base === undefined ? captured : base * (1 + percent / 100);

  return (
    <div className="mt-7">
      <div className="section-title">Weapon speed</div>
      <div className="row wrap">
        {/* 0 is "not recorded"; the setter deletes the field rather than storing a zero. */}
        <NumberField
          value={base ?? 0}
          min={0}
          step={0.1}
          width={64}
          onChange={(next) => setBaseAttackSpeed(next)}
        />
        <span className="faint text-sm">the weapon&apos;s own swings per second</span>
        {swings !== undefined && (
          <span className="badge" title="The weapon's own rate times your attack_speed stat">
            {swings.toFixed(2)}/s at {percent.toFixed(1)}% attack speed
          </span>
        )}
        {base === undefined && captured !== undefined && (
          <span
            className="badge warn"
            title="Your capture's attribute already has this build's attack_speed baked into it, so the rate cannot respond to an edit until the two halves are separated."
          >
            frozen at the captured {captured.toFixed(2)}/s
          </span>
        )}
      </div>

      <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
        Vanilla&apos;s <code>attack_speed</code> attribute is the weapon&apos;s own rate multiplied
        by your <code>attack_speed</code> stat, and a capture records only the finished product.
        Splitting them is what lets the figure above move when your gear does. An axe is about
        1.2/s, a dagger about 2.5/s; opening a capture fills this in for the weapon you had.
      </div>
    </div>
  );
}

/**
 * The weapon's vanilla attack damage — the other half of it no registry carries.
 *
 * `attack_damage_compat` converts `minecraft:generic.attack_damage` into `total_damage` at 0.5x,
 * and `total_damage` is the only additive-damage stat in the pack with no condition on it: it
 * multiplies every element of every hit, conversion children included. So a build that names a
 * sword in its gear while this reads vanilla's bare-handed 1.0 is not a rounding error — it is
 * every damage figure on the page, low.
 *
 * It is a separate field from the swing rate above because it fails differently. Attack speed
 * has to be *split*, since MnS multiplies into the attribute and a capture records the product.
 * Nothing writes onto attack damage, so a capture taken with the weapon in hand is already right
 * and this box is only ever for a weapon no capture held — which is why it shows the captured
 * number rather than fighting it.
 */
function WeaponAttackDamage(): ReactNode {
  const { snapshot } = useWorld();
  const doc = useBuild((s) => s.doc);
  const setWeaponAttackDamage = useBuild((s) => s.setWeaponAttackDamage);
  const derived = useDerived();

  const value = doc.character.attributes?.["minecraft:generic.attack_damage"];
  const total = derived.stats.get("total_damage")?.value ?? 0;

  // Vanilla's player base is 1.0 and every weapon in the pack raises it, so a weapon plus a 1
  // can only mean the attributes were read before the weapon went on.
  const weapons = (doc.gear ?? [])
    .map((item) => entry(snapshot, CATEGORY.baseGearType, item.base)?.data["weapon_type"])
    .filter((type): type is string => typeof type === "string" && type !== "" && type !== "none");
  const stale = weapons.length > 0 && (value === undefined || value <= 1);

  return (
    <div className="mt-7">
      <div className="section-title">Weapon attack damage</div>
      <div className="row wrap">
        {/* 0 removes the key, so "not recorded" stays distinct from "recorded bare-handed". */}
        <NumberField
          value={value ?? 0}
          min={0}
          step={0.5}
          width={64}
          onChange={(next) => setWeaponAttackDamage(next)}
        />
        <span className="faint text-sm">
          vanilla <code>generic.attack_damage</code>, 1.0 bare-handed
        </span>
        {total > 0 && (
          <span className="badge" title="attack_damage_compat converts it at 0.5x into total_damage">
            +{smart(total)}% to every hit
          </span>
        )}
        {stale && (
          <span
            className="badge warn"
            title="A weapon is equipped but this is still the bare-handed value, so total_damage reads zero and every damage number on the page is low."
          >
            {weapons.join(", ")} equipped, still bare-handed
          </span>
        )}
      </div>

      <div className="faint text-sm mt-3" style={{ lineHeight: 1.5 }}>
        A weapon&apos;s attack damage is a Minecraft item property, so no registry the extractor
        reads can supply it — only a capture taken <em>with the weapon in hand</em>, or this box.{" "}
        <code>attack_damage_compat</code> halves it into <code>total_damage</code>, which is
        additive damage with no condition attached: it moves every element of every hit, so a
        missing weapon here is a flat shortfall on the whole Damage tab.
      </div>
    </div>
  );
}
