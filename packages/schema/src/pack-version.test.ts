import { strict as assert } from "node:assert";
import { test } from "node:test";

import { packModVersion, samePackVersion } from "./pack-version.js";

test("the two spellings of one version are the same version", () => {
  // The case this exists for: the extractor's jar-filename spelling against the mod's.
  assert.equal(samePackVersion("6.4.13", "1.20.1-6.4.13"), true);
  assert.equal(samePackVersion("1.20.1-6.4.13", "6.4.13"), true);
  assert.equal(samePackVersion("1.20.1-6.4.13", "1.20.1-6.4.13"), true);
});

test("a real difference in the mod version is still a difference", () => {
  assert.equal(samePackVersion("6.4.13", "1.20.1-6.4.14"), false);
  assert.equal(samePackVersion("1.20.1-6.4.5", "1.20.1-6.4.13"), false);
  assert.equal(samePackVersion("6.4.5", "6.4.13"), false);
});

test("a two-part Minecraft version is a prefix too", () => {
  assert.equal(samePackVersion("6.4.13", "1.20-6.4.13"), true);
});

test("`unknown` never matches a real version, or another `unknown`-ish value", () => {
  // The mod writes this when it could not determine one. Treating it as a match would hide
  // exactly the case the warning is for.
  assert.equal(samePackVersion("unknown", "1.20.1-6.4.13"), false);
  assert.equal(samePackVersion("unknown", "unknown"), true);
});

test("a missing version is not a match, because there is nothing to compare", () => {
  assert.equal(samePackVersion(undefined, "1.20.1-6.4.13"), false);
  assert.equal(samePackVersion("6.4.13", undefined), false);
  assert.equal(samePackVersion(undefined, undefined), false);
});

test("the mod version is what is left after the prefix", () => {
  assert.equal(packModVersion("1.20.1-6.4.13"), "6.4.13");
  assert.equal(packModVersion("6.4.13"), "6.4.13");
  assert.equal(packModVersion("  1.20.1-6.4.13  "), "6.4.13");
  assert.equal(packModVersion("unknown"), "unknown");
});

test("only a leading Minecraft version is stripped, and only once", () => {
  // A mod version containing a dash keeps everything after the first prefix.
  assert.equal(packModVersion("1.20.1-6.4.13-beta"), "6.4.13-beta");
  // Nothing that is not a version-and-dash is treated as a prefix.
  assert.equal(packModVersion("mmorpg-6.4.13"), "mmorpg-6.4.13");
});
