import assert from "node:assert/strict";
import { test } from "node:test";

import { registryLoadOrder } from "./registry-order.js";

/**
 * These pin the two items whose in-game tooltips were read off directly. Both have a stale
 * copy at the category root and a rebalanced one in a subfolder, and both show the subfolder's
 * numbers in game — see `registry-order.ts` for the readings.
 */

test("the deeper copy of a colliding id is registered last, so it wins", () => {
  const order = registryLoadOrder(["honourhome", "chainmail_helmet/honourhome"]);
  assert.deepEqual(order, ["honourhome", "chainmail_helmet/honourhome"]);
});

test("Honourhome and Sundance both resolve to their subfolder copy", () => {
  // Honourhome shows +14% Gear's Defense (subfolder 12.5-15, root 50-60); Sundance shows
  // +5% Physical as Added Fire Damage, which only the subfolder copy has at all.
  const paths = ["sundance", "vest_boots/sundance", "honourhome", "chainmail_helmet/honourhome"];
  const order = registryLoadOrder(paths);
  for (const [root, nested] of [
    ["sundance", "vest_boots/sundance"],
    ["honourhome", "chainmail_helmet/honourhome"],
  ]) {
    assert.ok(
      order.indexOf(nested!) > order.indexOf(root!),
      `${nested} must be registered after ${root}`,
    );
  }
});

test("depth beats alphabetical order in both directions", () => {
  // The subfolder name sorts after its root twin here and before it in the other case, so a
  // plain path sort would get one of them wrong.
  assert.deepEqual(registryLoadOrder(["sundance", "vest_boots/sundance"]), [
    "sundance",
    "vest_boots/sundance",
  ]);
  assert.deepEqual(registryLoadOrder(["honourhome", "chainmail_helmet/honourhome"]), [
    "honourhome",
    "chainmail_helmet/honourhome",
  ]);
});

test("deeper still wins over merely nested", () => {
  const order = registryLoadOrder([
    "genji_domaru",
    "set_armor/genji_domaru",
    "set_armor/genji/genji_domaru",
  ]);
  assert.equal(order[order.length - 1], "set_armor/genji/genji_domaru");
});

test("the order is a permutation, with nothing dropped or invented", () => {
  const paths = ["a", "b/a", "c", "d/e/f", "g"];
  const order = registryLoadOrder(paths);
  assert.equal(order.length, paths.length);
  assert.deepEqual([...order].sort(), [...paths].sort());
});

test("the order does not depend on how the files were discovered", () => {
  // Files reach the extractor in directory-walk order, which differs between the jar and a
  // pack and is not something the game sees.
  const paths = ["sundance", "vest_boots/sundance", "honourhome", "chainmail_helmet/honourhome"];
  assert.deepEqual(registryLoadOrder([...paths].reverse()), registryLoadOrder(paths));
});

test("equally deep files claiming one id still resolve deterministically", () => {
  const order = registryLoadOrder(["bow/chin_sol", "axe/chin_sol"]);
  assert.deepEqual(order, ["axe/chin_sol", "bow/chin_sol"]);
});
