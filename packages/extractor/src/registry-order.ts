/**
 * Which file wins when two of them declare the same registry GUID.
 *
 * Craft to Exile 2 has 466 such collisions — 170 unique gears, 139 spells, 146 stats — nearly
 * all from the pack shipping one copy of an entry at the category root and a second, rebalanced
 * copy in a subfolder: `mmorpg_unique_gears/honourhome.json` beside
 * `mmorpg_unique_gears/chainmail_helmet/honourhome.json`. Picking wrong is not a rounding
 * error. Across 145 of the 152 colliding pairs that carry one, the root file's `gear_defense`
 * or `gear_weapon_damage` is **exactly 4x** the subfolder's: the pack divided those by four and
 * multiplied base gear stats by 1.35 in the same pass, and the root files were left behind at
 * the old values. Their mtimes are months older.
 *
 * ## The rule: the deepest path wins
 *
 * This is an **empirical** rule, confirmed against the game, not one derived from the loader.
 * Two items whose two copies differ visibly were read off in-game tooltips:
 *
 *   - Honourhome — `+14% Gear's Defense`, matching the subfolder's 12.5-15 range, not the
 *     root's 50-60. Base stats 135 armor / 270 magic shield at level 100 agree.
 *   - Sundance — `+14.5% Gear's Defense` and `+5% Physical as Added Fire Damage`, the
 *     subfolder's stat list. The root copy has no `plus_phys_to_fire` at all and carries
 *     `magic_find`, which the item does not show.
 *
 * ## Why this is not derived from the loader
 *
 * Worth writing down, because the obvious reading of the Java says something else and it took
 * a wrong answer to find that out. `BaseDataPackLoader.prepare` collects resources into a
 * plain `java.util.HashMap` (confirmed in the shipped `Library_of_Exile-1.20.1-2.1.14.jar`
 * bytecode, not just a source checkout), `apply` iterates that map and registers each entry
 * under its GUID, and `ExileRegistryContainer.unRegister` removes by GUID — so the reading is
 * "last entry in Java HashMap iteration order wins". That emulates cleanly, and the emulation
 * was checked byte-for-byte against real `java.util.HashMap` on this pack's 480 paths.
 *
 * It is still wrong. A HashMap's bucket index is `(capacity - 1) & spread(hash)`, so for a
 * given pair the answer depends only on the table capacity — and at **every** capacity from
 * 256 to 8192, `sundance` sorts into a later bucket than `vest_boots/sundance`, i.e. the root
 * copy would win. The game shows the subfolder's. So the premise is false somewhere no amount
 * of reading the decompiled loader has located, and the honest thing is to encode what the
 * game demonstrably does rather than a derivation that contradicts it.
 *
 * If a future reading ever contradicts *this* rule, that is a real finding — record the item
 * and its tooltip rather than quietly tuning the tie-break.
 */

/** How specific a resource path is: `chainmail_helmet/honourhome` beats `honourhome`. */
function depth(path: string): number {
  let count = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) count++;
  return count;
}

/**
 * Orders `paths` so that a caller registering by declared id, letting later entries overwrite
 * earlier ones, ends up with the entry the game has.
 *
 * `paths` are category-relative and `.json`-stripped (`honourhome`,
 * `chainmail_helmet/honourhome`) — the `ResourceLocation` paths `FileToIdConverter.fileToId`
 * produces. Shallowest first, so the deepest copy of a colliding id is registered last and
 * wins. Ties break on the path itself, which only matters between two equally deep files
 * claiming one GUID; nothing in this pack does that, but the result stays deterministic if
 * something ever does.
 *
 * Ordering the whole category rather than just the collisions keeps this independent of the
 * order files are discovered in — jar before pack, directory walk order within each — none of
 * which the game sees.
 */
export function registryLoadOrder(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const byDepth = depth(a) - depth(b);
    if (byDepth !== 0) return byDepth;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
