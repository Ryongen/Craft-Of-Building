/**
 * The layer accumulators.
 *
 * These cases are all quirks rather than arithmetic: the disabled clamp on `getNumber`, the
 * pinned `double_damage` multiplier, the mitigation floors. Plain `1 + n/100` needs no test —
 * the reasons this file exists are the places the game does something a re-implementation
 * would naturally get wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { engineSnapshot } from "../test-support.js";
import { DamageEventState } from "./event.js";
import { LayerData, layerIndex } from "./layers.js";

const index = layerIndex(engineSnapshot());

function dataFor(id: string): LayerData {
  const layer = index.get(id);
  assert.ok(layer, `missing layer ${id}`);
  return new LayerData(layer, "number", "Source");
}

test("layers are sorted by priority, offence before defence", () => {
  const order = index.sorted().map((l) => l.id);
  assert.deepEqual(order.slice(0, 4), [
    "flat_damage",
    "damage_conversion",
    "ele_as_extra_flat",
    "additive_damage",
  ]);
  assert.equal(order.at(-1), "flat_damage_reduction");
});

test("getNumber does not clamp: the ADD layers ignore their declared bounds", () => {
  // `StatLayerData.getNumber()` has its clamp commented out in the source. `flat_damage`
  // declares +/-1e8 and `flat_damage_reduction` a -1000 floor; both are dead numbers.
  const flat = dataFor("flat_damage");
  flat.add(500_000_000);
  assert.equal(flat.getNumber(), 500_000_000);

  const reduction = dataFor("flat_damage_reduction");
  reduction.reduce(9_999);
  assert.equal(reduction.getNumber(), -9_999);
});

test("getMultiplier does clamp", () => {
  const additive = dataFor("additive_damage");
  additive.add(50);
  assert.equal(additive.getMultiplier(), 1.5);

  // `min_multi: -1` — enough "reduced damage" cannot flip the sign.
  additive.reduce(1000);
  assert.equal(additive.getMultiplier(), -1);
});

test("double_damage is pinned to exactly 2x by its own clamp", () => {
  // min_multi == max_multi == 2, so the accumulated number is irrelevant once anything writes
  // to it. A 1% chance of double damage and a 500% one are the same multiplier.
  const small = dataFor("double_damage");
  small.add(1);
  assert.equal(small.getMultiplier(), 2);

  const large = dataFor("double_damage");
  large.add(500);
  assert.equal(large.getMultiplier(), 2);
});

test("damage_suppression can never increase damage", () => {
  const layer = dataFor("damage_suppression");
  layer.add(400);
  assert.equal(layer.getMultiplier(), 1);

  layer.reduce(450);
  assert.equal(layer.getMultiplier(), 0.5);
});

test("mitigation floors cap each layer at 90% independently", () => {
  for (const id of ["armor_mitigation", "physical_mitigation", "elemental_mitigation"]) {
    const layer = dataFor(id);
    layer.reduce(10_000);
    assert.equal(layer.getMultiplier(), 0.1, id);
  }
  // `damage_reduction` floors at 0.5 instead — half, not a tenth.
  const reduction = dataFor("damage_reduction");
  reduction.reduce(10_000);
  assert.equal(reduction.getMultiplier(), 0.5);
});

test("conversion percentages normalise proportionally past 100", () => {
  const layer = dataFor("damage_conversion");
  layer.addConversion("Fire", 90);
  layer.addConversion("Cold", 90);

  const normalized = layer.normalizedConversion();
  assert.equal(normalized.get("Fire"), 50);
  assert.equal(normalized.get("Cold"), 50);
});

test("conversion under 100 is left alone", () => {
  const layer = dataFor("damage_conversion");
  layer.addConversion("Fire", 30);
  layer.addConversion("Cold", 20);

  const normalized = layer.normalizedConversion();
  assert.equal(normalized.get("Fire"), 30);
  assert.equal(normalized.get("Cold"), 20);
});

test("one accumulator per (layer, number) — the side is not part of the key", () => {
  //     public StatLayerData getLayer(StatLayer layer, String number, EffectSides side) {
  //         String id = layer.GUID() + "_" + number;
  //
  // — EffectEvent.java:110-119. The side is stamped when the accumulator is created and never
  // consulted again, so both halves of an event add into the same one and the `[Source]` /
  // `[Target]` label is whichever wrote first.
  //
  // Keying by side instead turns one summed `ADD` into two multiplied `MULTIPLY` layers, which
  // is a different number and a different row on screen. Caught against a damage log where
  // `attack_damage_received` (a Target-side stat) appeared inside the `[Source]` additive row.
  const event = new DamageEventState(index, undefined, undefined);

  const source = event.getLayer("additive_damage", "number", "Source");
  const target = event.getLayer("additive_damage", "number", "Target");
  assert.equal(source, target, "both sides must land in the same accumulator");

  source!.add(57.76);
  target!.add(10.8);
  // Summed, not compounded: 1.6856, never 1.5776 x 1.1080 = 1.7480.
  assert.ok(Math.abs(source!.getMultiplier() - 1.6856) < 1e-9);
  assert.equal(event.sortedLayers().length, 1);
  // The label belongs to whoever created it.
  assert.equal(source!.side, "Source");
});

test("a different number id is a different accumulator, because the key says so", () => {
  // The key is `layer + "_" + number`, so the one thing that does separate two accumulators is
  // the number they modify — `magic_shield` runs the same layers over a different number.
  const event = new DamageEventState(index, undefined, undefined);
  const a = event.getLayer("additive_damage", "number", "Source");
  const b = event.getLayer("additive_damage", "before_conversion_number", "Source");
  assert.notEqual(a, b);
  assert.equal(event.sortedLayers().length, 2);
});

test("a conversion layer separates by element and still ignores the side", () => {
  //     String id = layer.GUID() + "_" + number + "_" + ele.GUID();
  const event = new DamageEventState(index, undefined, undefined);
  const fire = event.getConversionLayer("damage_conversion", "Fire", "number", "Source");
  const fireAgain = event.getConversionLayer("damage_conversion", "Fire", "number", "Target");
  const cold = event.getConversionLayer("damage_conversion", "Cold", "number", "Source");
  assert.equal(fire, fireAgain);
  assert.notEqual(fire, cold);
});
