/**
 * `StatPriority` — the order stat effects get to write to the damage layers.
 *
 * This is **not** the order the layers are applied in; that is a separate list keyed on
 * `StatLayer.priority` and it runs entirely inside one slot of this one (`calc_damage_layers`,
 * 30). Keeping the two straight is the whole trick to reading the pipeline: a stat at priority
 * 19 and a stat at priority 21 both write to the `additive_damage` layer *before* it is
 * applied, so their relative order does not change the arithmetic — but a stat that writes a
 * boolean the later one reads absolutely does.
 *
 * Source: StatPriority.java:55-88.
 */

/**
 * The declared priorities, by the id a datapack stat's `order` field names.
 *
 * `damage_layers` resolving to 21 rather than 20 is not a typo here. The Java declares two
 * constants with the same id string:
 *
 *     StatPriority DAMAGE_LAYERS = damage("DAMAGE_LAYERS", 20);
 *     StatPriority AFTER_DAMAGE_LAYERS = damage("DAMAGE_LAYERS", 21);
 *
 * and the constructor registers every instance into a shared map keyed on the lowercased id:
 *
 *     public StatPriority(String id, String event, int priority) {
 *         this.id = id.toLowerCase(Locale.ROOT);
 *         ...
 *         MAP.put(this.id, this);
 *     }
 *
 * Interface fields initialise in declaration order, so a duplicate id overwrites its
 * predecessor in `MAP`. In **6.4.8** `AFTER_DAMAGE_LAYERS` was declared as
 * `damage("DAMAGE_LAYERS", 21)` — the same id at a different number — so
 * `MAP.get("damage_layers")` returned 21 while in-code effects, which hold the object
 * reference directly, kept 20. This table encoded that.
 *
 * **6.4.13 does not have the collision, and this is checked against the jar rather than a
 * checkout.** `javap` on
 * `Mine_and_Slash-1.20.1-6.4.13.jar!com/.../StatPriority$Damage` shows the static initialiser
 * registering three distinct ids where there used to be two:
 *
 *     ldc "DAMAGE_LAYERS"        bipush 20
 *     ldc "AFTER_DAMAGE_LAYERS"  bipush 21
 *     ldc "AFTER_CALC_LAYER"     bipush 31
 *
 * So `damage_layers` resolves to **20** for a datapack stat as well as an in-code one, and
 * `after_damage_layers` and `after_calc_layer` are resolvable ids this table used to lack
 * entirely — an `order` naming either resolved to 0 through the unknown-id fallback below.
 *
 * The jar is the authority here for a reason beyond the usual one. The checkout at
 * `G:/Projects/Mine-And-Slash-Rework-1.20-Forge` sits on a feature branch with local commits
 * and still declares `mod_version=6.4.8` in `gradle.properties`, so it is evidence about
 * neither version; only the jar the game loads is.
 *
 * What this does *not* change: `ElementalResistEffect` and `ArmorEffect` still run at 20, and
 * a datapack stat at `damage_layers` now ties with them rather than following them. The game's
 * own tie order at one priority is `HashMap` iteration and therefore undefined; this engine
 * sorts ties by stat id (`simulate.ts`), which is a choice it already documents. Craft to Exile
 * 2 puts nothing order-sensitive in that band — every boolean-writing datapack stat declares
 * `before_damage_layers`, `first` or `data_modification` — so no figure in this pack moves.
 */
export const DATAPACK_PRIORITY: Record<string, number> = {
  first: 0,
  // `StatPriority.Spell.FIRST = damage("DATA_MODIFICATION", 0)` — the bucket every
  // `on_spell_stat_calc` stat uses. Same number, different event.
  data_modification: 0,
  before_hit_prevention: 9,
  hit_prevention: 10,
  before_damage_layers: 19,
  damage_layers: 20,
  after_damage_layers: 21,
  calc_damage_layers: 30,
  after_calc_layer: 31,
  after_damage_bonuses: 32,
  final_damage: 100,
  post_final_damage_checks: 101,
};

/** The same numbers, as in-code effects hold them — by object reference rather than by id. */
export const PRIORITY = {
  FIRST: 0,
  BEFORE_HIT_PREVENTION: 9,
  HIT_PREVENTION: 10,
  BEFORE_DAMAGE_LAYERS: 19,
  /** What `ElementalResistEffect` and `ArmorEffect` run at. */
  DAMAGE_LAYERS: 20,
  AFTER_DAMAGE_LAYERS: 21,
  CALC_DAMAGE_LAYERS: 30,
  AFTER_CALC_LAYER: 31,
  AFTER_DAMAGE_BONUSES: 32,
  FINAL_DAMAGE: 100,
  POST_FINAL_DAMAGE_CHECKS: 101,
} as const;

/**
 * Resolves a datapack `order` string.
 *
 * `DataPackStatEffect.GetPriority()` falls back to `StatPriority.Spell.FIRST` with a warning
 * when the id is unknown, so an unrecognised `order` behaves as priority 0 rather than being
 * dropped. Returning `undefined` lets the caller report it and then do the same.
 */
export function datapackPriority(order: string): number | undefined {
  return DATAPACK_PRIORITY[order];
}

/** The fallback the game uses for an unrecognised `order`. */
export const UNKNOWN_ORDER_PRIORITY = 0;
