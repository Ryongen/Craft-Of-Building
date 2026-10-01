/**
 * The tick loop behind procs of procs, on hand-built graphs small enough to count by hand.
 *
 * Every rule here is one `ProcSpellEffect.activate` (6.4.13 jar) states: one cooldown per procced
 * spell, stamped before the cast; the cast lands inside the hit that procced it; and a summon's
 * doing stays a summon's, so the summon-only gates read the context the cast came from.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeTo } from "../test-support.js";
import { runChain, type ChainGraph, type ChainLink, type ChainNode } from "./chain.js";

const link = (spellId: string, chance = 1): ChainLink => ({ spellId, chance, position: "CASTER" });

function graph(
  nodes: Record<string, Omit<ChainNode, "spellId" | "summon"> & { summon?: boolean }>,
  { rootPeriodTicks = 20, cooldowns = {} as Record<string, number> } = {},
): ChainGraph {
  const map = new Map<string, ChainNode>();
  for (const [key, node] of Object.entries(nodes)) {
    map.set(key, { spellId: key.split("|")[0]!, summon: node.summon ?? false, ...node });
  }
  return {
    nodes: map,
    root: "root",
    rootPeriodTicks,
    cooldownTicks: (spellId) => cooldowns[spellId] ?? 10,
    childOf: (l, summon) => (summon && map.has(`${l.spellId}|summon`) ? `${l.spellId}|summon` : l.spellId),
  };
}

const run = (g: ChainGraph) => runChain(g, { seconds: 200, warmupSeconds: 10, seed: 7 });
const spell = (result: ReturnType<typeof run>, id: string) => result.spells.find((s) => s.spellId === id);

test("hits on the same tick share one cooldown: one cast, the rest blocked", () => {
  // Five knives land together once a second, each a certain proc of `a`. The first casts it and
  // stamps its cooldown; the other four find it on cooldown. Counted as five, this was 5/s.
  const result = run(
    graph({
      root: { hits: Array.from({ length: 5 }, () => ({ tick: 0, lands: 1, links: [link("a")] })), damagePerCast: 0 },
      a: { hits: [], damagePerCast: 100 },
    }),
  );
  closeTo(spell(result, "a")!.castsPerSecond, 1);
  closeTo(spell(result, "a")!.blockedPerSecond, 4);
  closeTo(result.dps, 100);
});

test("a spell cannot re-proc itself off its own hit: the cooldown is stamped before it lands", () => {
  // Blood Explosion's case: a 1-tick proc cooldown and a hit that lands on the cast tick.
  const result = run(
    graph(
      {
        root: { hits: [{ tick: 0, lands: 1, links: [link("a")] }], damagePerCast: 0 },
        a: { hits: [{ tick: 0, lands: 1, links: [link("a")] }], damagePerCast: 100 },
      },
      { cooldowns: { a: 1 } },
    ),
  );
  closeTo(spell(result, "a")!.castsPerSecond, 1);
});

test("a hit that lands a tick later does chain, up to the cooldown", () => {
  // The same spell with its hit one tick after the cast: every cast procs the next, so it runs at
  // its cap of 20 a second, and nothing else ever has to press it again.
  const result = run(
    graph(
      {
        root: { hits: [{ tick: 0, lands: 1, links: [link("a")] }], damagePerCast: 0 },
        a: { hits: [{ tick: 1, lands: 1, links: [link("a")] }], damagePerCast: 1 },
      },
      { cooldowns: { a: 1 } },
    ),
  );
  closeTo(spell(result, "a")!.castsPerSecond, 20);
});

test("a chain is capped by each link's own cooldown, not by the press", () => {
  // root -> a (cd 10) -> b (cd 5), every roll certain, `a` hitting four times over its cast.
  // `a` fires once a press; `b` gets one cast per `a` hit that finds it off cooldown.
  const result = run(
    graph(
      {
        root: { hits: [{ tick: 0, lands: 1, links: [link("a")] }], damagePerCast: 0 },
        a: {
          hits: [0, 5, 10, 15].map((tick) => ({ tick, lands: 1, links: [link("b")] })),
          damagePerCast: 0,
        },
        b: { hits: [], damagePerCast: 10 },
      },
      { cooldowns: { a: 10, b: 5 } },
    ),
  );
  closeTo(spell(result, "a")!.castsPerSecond, 1);
  closeTo(spell(result, "b")!.castsPerSecond, 4);
});

test("a summon's procs cannot summon, so pets do not feed themselves", () => {
  // The root summons a pet that bites five times. Its bites cast `a` — in summon context, where the
  // summon link is gone (that is `is_is_summon_attack_true_is_false`). So the pet population is the
  // root's doing alone: one a second, five seconds each, five alive.
  const pets = { node: "bite", perCast: 1, lifeTicks: 100, attackTicks: 20, damagePerBite: 10 };
  const result = run(
    graph({
      root: { hits: [{ tick: 0, lands: 1, links: [link("summon")] }], damagePerCast: 0 },
      summon: { hits: [], damagePerCast: 0, pets },
      bite: { hits: [{ tick: 0, lands: 1, links: [link("a")] }], damagePerCast: 0, summon: true },
      "a|summon": { hits: [{ tick: 0, lands: 1, links: [] }], damagePerCast: 1, summon: true },
      a: { hits: [{ tick: 0, lands: 1, links: [link("summon")] }], damagePerCast: 1 },
    }),
  );
  closeTo(spell(result, "summon")!.castsPerSecond, 1);
  closeTo(result.petsAlive, 5, "five seconds of life, one a second");
  // Five bites a second, each 10.
  closeTo(spell(result, "summon")!.dps, 50);
  // `a` off those bites. Its 10-tick cooldown would allow 2 a second, but the bites come at
  // scattered ticks, so after each cooldown it waits for the next one: about 20 / (10 + 3).
  // A rate model's `min(5, 2)` says 2 — this gap is what it cannot see.
  const a = spell(result, "a")!.castsPerSecond;
  assert.ok(a > 1.4 && a < 1.7, `expected about 1.54 a second, got ${a}`);
  closeTo(spell(result, "a")!.fromSummons, 1);
});

test("the same build gives the same answer", () => {
  const g = graph({
    root: { hits: [{ tick: 0, lands: 0.5, links: [link("a", 0.3), link("b", 0.7)] }], damagePerCast: 0 },
    a: { hits: [{ tick: 2, lands: 1, links: [link("b", 0.5)] }], damagePerCast: 7 },
    b: { hits: [{ tick: 3, lands: 1, links: [link("a", 0.5)] }], damagePerCast: 11 },
  });
  assert.deepEqual(run(g), run(g));
});
