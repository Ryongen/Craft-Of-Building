/**
 * Comparing two Mine and Slash version strings that were not written by the same thing.
 *
 * There are two spellings of the same version in circulation, and neither side is wrong:
 *
 *   - The extractor reads the jar's filename, so it records `1.20.1-6.4.13` — the Minecraft
 *     version the jar was built for, then the mod's own version.
 *   - The exporter mod asks Forge for the `mmorpg` mod version, which is just `6.4.13`. The
 *     Minecraft version is not part of a mod's version metadata, so the client cannot report
 *     one even if it wanted to.
 *
 * A build imported from the game therefore carries `6.4.13` while the snapshot beside it says
 * `1.20.1-6.4.13`, and a `!==` between them fires on every single import — a drift warning that
 * is never once about drift. Compare the mod versions, which is the part both sides agree on.
 */

/** A Minecraft version and the dash that separates it from the mod's own version. */
const MC_PREFIX = /^\d+\.\d+(?:\.\d+)?-/;

/**
 * The mod's own version, with any Minecraft prefix removed.
 *
 * Anything that is not recognisably prefixed comes back trimmed but otherwise untouched —
 * including `unknown`, which the mod writes when it could not determine a version and which
 * must keep comparing unequal to a real one.
 */
export function packModVersion(version: string): string {
  return version.trim().replace(MC_PREFIX, "");
}

/**
 * Whether two version strings name the same Mine and Slash build, whichever spelling each uses.
 *
 * `undefined` on either side is not a match: a document with no recorded version has nothing to
 * compare, and callers decide separately whether that is worth reporting.
 */
export function samePackVersion(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return packModVersion(a).toLowerCase() === packModVersion(b).toLowerCase();
}
