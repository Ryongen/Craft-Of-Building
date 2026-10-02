/**
 * Procs of procs, run tick by tick.
 *
 * `procs.ts` rates what *one skill's own hits* trigger, and stops there on purpose. A proc build
 * does not: Power Surge's hit casts Fan of Knives, whose knife casts Slice and Chain Lightning,
 * whose hits cast Blood Explosion and summon spiders, whose bites cast Fan of Knives again. The
 * pressed skill only starts it.
 *
 * Averaging that as rates (`min(triggers × chance, 1 / cooldown)` at every link, iterated to a
 * fixed point) is optimistic in exactly the way these builds feel in game: everything goes off
 * at once. The hits that start a burst land on the same tick, every one of them rolls for the
 * same procs, and only the first roll per spell gets through — the rest find it on cooldown. A
 * rate model counts those as spread out. So this simulates instead, on the game's own clock.
 *
 * ## What the game does, and where it says so (6.4.13 jar)
 *
 *   - **One cooldown per procced spell.** `ProcSpellEffect.activate` checks and stamps
 *     `procCooldownKey(spell.GUID())` — `"proc_" + spellId`, shared by every stat that procs the
 *     spell and separate from the spell's own cast cooldown — then casts. Set *before* the cast,
 *     with `proc_cooldown_ticks` read raw.
 *   - **A procced spell lands inside the hit that procced it.** `spell.attached.onCast(c)` is the
 *     last thing `activate` does, so an `on_cast` damage act resolves in the same call — the same
 *     tick. That is what stops Blood Explosion (`proc_cooldown_ticks: 1`) from chaining itself
 *     forever: its own crit finds its own cooldown, stamped a moment earlier.
 *   - **A summon's doing stays a summon's doing.** `activate` copies `IS_SUMMON_ATTACK` into
 *     `calcData.summon_triggered`, and `DamageAction` puts it back on every hit of the procced
 *     spell. So a Fan of Knives a spider started is a summon attack all the way down, and
 *     `proc_summon_spider`'s `is_is_summon_attack_true_is_false` refuses it: spiders never
 *     summon spiders, at any depth.
 *
 * Every chance is the existing condition pass's answer for that spell's hit, crit folded in per
 * element — nothing here re-derives a gate. Each spell is resolved twice, once as your cast and
 * once as a summon's, because the flag changes which gates pass.
 *
 * ## What is not modelled
 *
 * Procs spend mana or energy (`use_resource_costs`), and a chain that outruns your pool stops.
 * Kill and when-hit procs have no rate here, as in `procs.ts`. Spells with `times_to_cast` above 1
 * are cast once per proc. Pets you keep up yourself (a summoner's capped zombies) are not added as
 * a trigger; only pets the chain itself summons are. Seeded, so the same build gives the same answer; the noise left over
 * from the roll is a few percent.
 */

import type { Snapshot } from "@cte2/extractor";
import type { BuildDoc, SkillSetup } from "@cte2/schema";
import { isSkillEnabled } from "@cte2/schema";

import type { ProcHit } from "./ctx.js";
import { DEFAULT_PLACEMENT, type TargetPlacement } from "./geometry.js";
import {
  PET_ATTACK_GROUP,
  procPlacement,
  simulateDps,
  type DpsOptions,
  type DpsResult,
  type FullDpsResult,
} from "./dps.js";
import { procCooldownOf } from "./procs.js";
import { TICKS_PER_SECOND } from "./spell-calc.js";

/** One spell a hit can cast, with the chance per hit. Several stats procing it are one roll. */
export type ChainLink = { spellId: string; chance: number; position: "CASTER" | "TARGET" };

/** One hit of one cast: when it lands after the cast, how likely, and what it rolls. */
export type ChainHit = { tick: number; lands: number; links: readonly ChainLink[] };

/** A spell as one context casts it — your cast, or a summon's. */
export type ChainNode = {
  spellId: string;
  summon: boolean;
  hits: readonly ChainHit[];
  /** Damage one cast puts on the target, pets excluded. */
  damagePerCast: number;
  /** Pets one cast leaves behind, each biting on its own clock. */
  pets?: { node: string; perCast: number; lifeTicks: number; attackTicks: number; damagePerBite: number };
};

/** A pressed skill that starts the chain: its node, how often it is cast, and its first cast. */
export type ChainRoot = { node: string; periodTicks: number; offsetTicks?: number };

export type ChainGraph = {
  nodes: ReadonlyMap<string, ChainNode>;
  /** The pressed skills. One for the main skill alone; one per pressed skill for a rotation. */
  roots: readonly ChainRoot[];
  cooldownTicks: (spellId: string) => number;
  /** Which node a link from a node in `summon` context casts. */
  childOf: (link: ChainLink, summon: boolean) => string;
};

export type ChainSpell = {
  spellId: string;
  castsPerSecond: number;
  /** `20 / proc_cooldown_ticks` — the most it could. */
  capPerSecond: number;
  /** Rolls that succeeded and found the spell on cooldown, per second. */
  blockedPerSecond: number;
  /** Share of its casts a summon's hit started. */
  fromSummons: number;
  /** Its own damage plus its pets', per second. */
  dps: number;
};

export type ProcChain = {
  /** The pressed skills the chain was started from. */
  rootSpellIds: string[];
  /** Everything the chain casts, per second, once it has built up. The pressed skill is not in it. */
  dps: number;
  spells: ChainSpell[];
  /** Pets alive on average. */
  petsAlive: number;
  /** Chain damage in each of the first seconds after the first press. */
  rampDps: number[];
  /** Seconds until a two-second average first reaches 90% of {@link dps}; undefined if never. */
  rampSeconds?: number;
  /** Seconds the average is taken over, after the warm-up. */
  seconds: number;
};

export type ChainOptions = DpsOptions & {
  /**
   * Start the chain from every skill this rotation presses, each at its own rate in the pass,
   * rather than from the main skill alone. Ignored when it ticks nothing.
   */
  rotation?: FullDpsResult;
  /** Seconds measured, after the warm-up. */
  seconds?: number;
  warmupSeconds?: number;
  seed?: number;
};

const DEFAULT_SECONDS = 300;
const DEFAULT_WARMUP = 30;
const RAMP_SECONDS = 15;
/** Distinct (spell, context, position) nodes resolved, so a pathological sheet cannot stall a UI. */
const MAX_NODES = 40;

/**
 * The chain the pressed skills start, or undefined when they proc nothing that procs anything.
 *
 * The main skill alone by default; every skill a ticked rotation presses when `rotation` is given,
 * which is the chain whose first link the Full DPS figure counts. Builds the graph with one
 * `simulateDps` per reachable spell and context — rolls only, no proc resolution — then
 * {@link runChain}s it.
 */
export function procChain(build: BuildDoc, snapshot: Snapshot, options: ChainOptions = {}): ProcChain | undefined {
  const { seconds, warmupSeconds, seed, rotation, ...dpsOptions } = options;
  const placement: TargetPlacement = dpsOptions.placement ?? build.config?.target ?? DEFAULT_PLACEMENT;
  const base: DpsOptions = { ...dpsOptions, procs: true, procRollsOnly: true, granted: false, breakdown: false };

  const pressed = rootsOf(build, snapshot, base, rotation);
  if (pressed.length === 0) return undefined;

  const disabled = new Set((build.skills ?? []).filter((s) => !isSkillEnabled(s)).map((s) => s.spellId));
  const setupOf = (spellId: string): SkillSetup =>
    (build.skills ?? []).find((s) => s.spellId === spellId) ?? { spellId };

  const nodes = new Map<string, ChainNode>();
  const keyOf = (spellId: string, summon: boolean, position: string): string =>
    `${spellId}|${summon ? "summon" : "you"}|${position}`;
  const childOf = (link: ChainLink, summon: boolean): string => keyOf(link.spellId, summon, link.position);

  const roots: ChainRoot[] = pressed.map((p, i) => ({
    node: keyOf(p.result.spellId, false, `root${i}`),
    periodTicks: p.periodTicks,
    offsetTicks: p.offsetTicks,
  }));
  const queue: { key: string; result: DpsResult; summon: boolean }[] = roots.map((r, i) => ({
    key: r.node,
    result: pressed[i]!.result,
    summon: false,
  }));
  const pending = new Set(roots.map((r) => r.node));

  while (queue.length > 0 && nodes.size < MAX_NODES) {
    const { key, result, summon } = queue.shift()!;
    const node = nodeOf(result, summon, disabled);

    // Pets this cast leaves: their bites are hits of the pet's basic attack, always a summon's.
    const pet = (result.summons ?? []).find(
      (s) => !s.capped && Number.isFinite(s.lifeSeconds) && s.attackSeconds > 0 && s.petsPerCast > 0,
    );
    if (pet !== undefined) {
      const biteKey = keyOf(pet.basicSpellId, true, "pet");
      node.pets = {
        node: biteKey,
        perCast: pet.petsPerCast,
        lifeTicks: Math.round(pet.lifeSeconds * TICKS_PER_SECOND),
        attackTicks: Math.max(1, Math.round(pet.attackSeconds * TICKS_PER_SECOND)),
        damagePerBite: pet.damagePerAttack,
      };
      if (!pending.has(biteKey)) {
        const bite = simulateDps(build, snapshot, {
          ...base,
          skill: setupOf(pet.basicSpellId),
          summons: false,
          entryGroup: PET_ATTACK_GROUP,
          summonAttack: true,
          placement,
        });
        if (bite !== undefined) {
          pending.add(biteKey);
          queue.push({ key: biteKey, result: bite, summon: true });
        }
      }
    }
    // A bite's damage is the pet's, counted where the pet is.
    nodes.set(key, key.endsWith("|pet") ? { ...node, damagePerCast: 0 } : node);

    for (const hit of node.hits) {
      for (const link of hit.links) {
        const child = childOf(link, summon);
        if (pending.has(child)) continue;
        pending.add(child);
        const procced = simulateDps(build, snapshot, {
          ...base,
          skill: setupOf(link.spellId),
          summonAttack: summon,
          placement: procPlacement(placement, link.position),
        });
        if (procced !== undefined) queue.push({ key: child, result: procced, summon });
      }
    }
  }

  // Nothing procs a second link: the single-skill proc figures already say everything.
  const rootNodes = new Set(roots.map((r) => nodes.get(r.node)));
  const reachesAChain = [...nodes.values()].some(
    (n) => !rootNodes.has(n) && (n.hits.some((h) => h.links.length > 0) || n.pets !== undefined),
  );
  if (!reachesAChain) return undefined;

  const cooldowns = new Map<string, number>();
  return runChain(
    {
      nodes,
      roots,
      cooldownTicks: (spellId) => {
        let ticks = cooldowns.get(spellId);
        if (ticks === undefined) cooldowns.set(spellId, (ticks = procCooldownOf(snapshot, spellId)));
        return ticks;
      },
      childOf,
    },
    { seconds: seconds ?? DEFAULT_SECONDS, warmupSeconds: warmupSeconds ?? DEFAULT_WARMUP, seed: seed ?? 1 },
  );
}

/**
 * What starts the chain, and how often each is cast.
 *
 * Alone, the main skill on its own cycle. In a rotation, each skill at its share of the pass:
 * a step once per pass, an upkeep press as often as it is re-cast, staggered by the presses
 * before it. A skill holding an aura lands its pulses on the aura's clock whatever the pass does,
 * so it keeps its own cycle — the same answer the single-skill chain gives it. A toggle pressed
 * once, and a proc-only skill, start nothing.
 */
function rootsOf(
  build: BuildDoc,
  snapshot: Snapshot,
  base: DpsOptions,
  rotation: FullDpsResult | undefined,
): { result: DpsResult; periodTicks: number; offsetTicks: number }[] {
  const ticksOf = (seconds: number): number => Math.max(1, Math.round(seconds * TICKS_PER_SECOND));
  const ownCycle = (result: DpsResult): number =>
    result.rate.cycleSeconds / Math.max(1, result.rate.castsPerCycle);

  if (rotation === undefined || rotation.skills.length === 0) {
    const result = simulateDps(build, snapshot, base);
    if (result === undefined || result.rate.cycleSeconds <= 0) return [];
    return [{ result, periodTicks: ticksOf(ownCycle(result)), offsetTicks: 0 }];
  }

  const out: { result: DpsResult; periodTicks: number; offsetTicks: number }[] = [];
  let offset = 0;
  for (const entry of rotation.skills) {
    const result = simulateDps(build, snapshot, { ...base, skill: entry.skill });
    if (result === undefined || result.rate.cycleSeconds <= 0) continue;
    const presses = entry.role === "rotation" ? 1 : (entry.pressesPerRotation ?? 0);
    const period =
      entry.role === "aura" || result.auraDps > 0
        ? ownCycle(result)
        : presses > 0 && rotation.rotationSeconds > 0
          ? rotation.rotationSeconds / (presses * Math.max(1, result.rate.castsPerCycle))
          : Number.POSITIVE_INFINITY;
    if (Number.isFinite(period)) {
      out.push({ result, periodTicks: ticksOf(period), offsetTicks: Math.round(offset * TICKS_PER_SECOND) });
    }
    if (entry.role === "rotation") offset += entry.pressSeconds;
  }
  return out;
}

/** One cast's hits, read off its sources: each landing tick, and that source's rolls. */
function nodeOf(result: DpsResult, summon: boolean, disabled: ReadonlySet<string>): ChainNode {
  const hits: ChainHit[] = [];
  for (const source of result.sources) {
    const ticks = source.coverage.landedTicks;
    if (ticks.length === 0 || source.coverage.hitsPerCast <= 0) continue;
    const lands = Math.min(1, source.coverage.hitsPerCast / ticks.length);
    const links = linksOf(source.hit.procs ?? [], disabled);
    for (const tick of ticks) hits.push({ tick: Math.max(0, Math.round(tick)), lands, links });
  }
  return { spellId: result.spellId, summon, hits, damagePerCast: result.damagePerCast };
}

/**
 * One roll per procced spell. Two stats for the same spell share its cooldown, so on one hit the
 * first to roll blocks the other and together they are `1 − Π(1 − c)`.
 */
function linksOf(procs: readonly ProcHit[], disabled: ReadonlySet<string>): ChainLink[] {
  const bySpell = new Map<string, ChainLink>();
  for (const proc of procs) {
    if (proc.side !== "Source" || proc.chance <= 0 || disabled.has(proc.spellId)) continue;
    const seen = bySpell.get(proc.spellId);
    const position = proc.position === "TARGET" ? "TARGET" : "CASTER";
    if (seen === undefined) bySpell.set(proc.spellId, { spellId: proc.spellId, chance: Math.min(1, proc.chance), position });
    else seen.chance = 1 - (1 - seen.chance) * (1 - Math.min(1, proc.chance));
  }
  return [...bySpell.values()];
}

/**
 * The tick loop. Pure, seeded, and the part the tests pin.
 *
 * Each tick: press the root if it is due, then drain that tick's hits in order. A hit that lands
 * rolls every link in a shuffled order; a success casts the child at once if its proc cooldown
 * has run out — which puts the child's tick-0 hits on the same queue — and is counted as blocked
 * otherwise.
 */
export function runChain(
  graph: ChainGraph,
  opts: { seconds: number; warmupSeconds: number; seed: number },
): ProcChain {
  const rand = mulberry32(opts.seed);
  const warmup = Math.round(opts.warmupSeconds * TICKS_PER_SECOND);
  const total = warmup + Math.round(opts.seconds * TICKS_PER_SECOND);
  const rampTicks = Math.min(total, RAMP_SECONDS * TICKS_PER_SECOND);

  const scheduled = new Map<number, string[]>();
  const schedule = (tick: number, nodeKey: string, queue: string[] | undefined): void => {
    if (queue !== undefined) {
      queue.push(nodeKey);
      return;
    }
    if (tick >= total) return;
    const list = scheduled.get(tick);
    if (list === undefined) scheduled.set(tick, [nodeKey]);
    else list.push(nodeKey);
  };
  // Hits are queued as `node#index` so a cast's later hits know which roll table they use.
  const hitKey = (nodeKey: string, index: number): string => `${nodeKey}#${index}`;

  const readyAt = new Map<string, number>();
  type Tally = { casts: number; blocked: number; fromSummons: number; damage: number };
  const tallies = new Map<string, Tally>();
  const tally = (spellId: string): Tally => {
    let t = tallies.get(spellId);
    if (t === undefined) tallies.set(spellId, (t = { casts: 0, blocked: 0, fromSummons: 0, damage: 0 }));
    return t;
  };
  const ramp = new Array<number>(Math.ceil(rampTicks / TICKS_PER_SECOND)).fill(0);
  let measuredDamage = 0;
  let petTicks = 0;
  const petExpiries: number[] = [];

  const cast = (nodeKey: string, tick: number, queue: string[], counted: boolean): void => {
    const node = graph.nodes.get(nodeKey);
    if (node === undefined) return;
    const measured = tick >= warmup;
    const damage = counted ? node.damagePerCast : 0;
    node.hits.forEach((hit, i) => schedule(tick + hit.tick, hitKey(nodeKey, i), hit.tick === 0 ? queue : undefined));
    if (node.pets !== undefined && counted) {
      for (let p = 0; p < node.pets.perCast; p++) {
        petExpiries.push(tick + node.pets.lifeTicks);
        // The first bite waits on the pet reaching its target — `MeleeAttackGoal` swings when in
        // range and off its 20-tick reset — so it lands somewhere in the first interval, not on a
        // fixed beat. Pinned to one beat, every pet summoned off the same press bit on the same
        // tick for its whole life and they all queued behind one another's proc cooldowns.
        const first = 1 + Math.floor(rand() * node.pets.attackTicks);
        for (let b = first; b <= node.pets.lifeTicks; b += node.pets.attackTicks) {
          schedule(tick + b, `${node.pets.node}#bite`, undefined);
        }
      }
    }
    if (counted && measured) {
      const t = tally(node.spellId);
      t.casts++;
      if (node.summon) t.fromSummons++;
      t.damage += damage;
    }
    record(tick, damage);
  };

  const record = (tick: number, damage: number): void => {
    if (damage <= 0) return;
    if (tick >= warmup) measuredDamage += damage;
    if (tick < rampTicks) ramp[Math.floor(tick / TICKS_PER_SECOND)]! += damage;
  };

  // Whose pet a bite node is, and what one bite deals — so a bite's damage is the summoning spell's.
  const bites = new Map<string, { owner: string; damage: number }>();
  for (const node of graph.nodes.values()) {
    if (node.pets !== undefined && !bites.has(node.pets.node)) {
      bites.set(node.pets.node, { owner: node.spellId, damage: node.pets.damagePerBite });
    }
  }

  const rollHit = (hit: ChainHit, summon: boolean, tick: number, queue: string[]): void => {
    if (rand() >= hit.lands) return;
    const links = hit.links.slice();
    for (let i = links.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [links[i], links[j]] = [links[j]!, links[i]!];
    }
    for (const link of links) {
      if (rand() >= link.chance) continue;
      if (tick < (readyAt.get(link.spellId) ?? 0)) {
        if (tick >= warmup) tally(link.spellId).blocked++;
        continue;
      }
      readyAt.set(link.spellId, tick + graph.cooldownTicks(link.spellId));
      cast(graph.childOf(link, summon), tick, queue, true);
    }
  };

  for (let tick = 0; tick < total; tick++) {
    const queue: string[] = scheduled.get(tick) ?? [];
    scheduled.delete(tick);

    for (const root of graph.roots) {
      const since = tick - (root.offsetTicks ?? 0);
      // The press itself: not a proc, so no proc cooldown, and its damage is the skill's own figure.
      if (since >= 0 && since % root.periodTicks === 0) cast(root.node, tick, queue, false);
    }

    while (queue.length > 0) {
      const entry = queue.shift()!;
      const hash = entry.lastIndexOf("#");
      const nodeKey = entry.slice(0, hash);
      const node = graph.nodes.get(nodeKey);
      if (node === undefined) continue;
      if (entry.endsWith("#bite")) {
        // One bite: the pet's damage, then the bite's own rolls.
        const bite = bites.get(nodeKey);
        if (bite !== undefined) {
          if (tick >= warmup) tally(bite.owner).damage += bite.damage;
          record(tick, bite.damage);
        }
        for (const hit of node.hits) rollHit(hit, true, tick, queue);
        continue;
      }
      const hit = node.hits[Number(entry.slice(hash + 1))];
      if (hit !== undefined) rollHit(hit, node.summon, tick, queue);
    }

    if (tick >= warmup) {
      let alive = 0;
      for (const expiry of petExpiries) if (expiry > tick) alive++;
      petTicks += alive;
    }
    // Drop the long dead, so the scan above stays short.
    if (tick % TICKS_PER_SECOND === 0 && petExpiries.length > 0) {
      const live = petExpiries.filter((e) => e > tick);
      petExpiries.length = 0;
      petExpiries.push(...live);
    }
  }

  const measuredTicks = total - warmup;
  const perSecond = (n: number): number => (measuredTicks > 0 ? (n * TICKS_PER_SECOND) / measuredTicks : 0);
  const dps = perSecond(measuredDamage);

  const spells: ChainSpell[] = [...tallies.entries()]
    .map(([spellId, t]) => ({
      spellId,
      castsPerSecond: perSecond(t.casts),
      capPerSecond: TICKS_PER_SECOND / Math.max(1, graph.cooldownTicks(spellId)),
      blockedPerSecond: perSecond(t.blocked),
      fromSummons: t.casts > 0 ? t.fromSummons / t.casts : 0,
      dps: perSecond(t.damage),
    }))
    .filter((s) => s.castsPerSecond > 0 || s.blockedPerSecond > 0 || s.dps > 0)
    .sort((a, b) => b.dps - a.dps);

  let rampSeconds: number | undefined;
  for (let s = 1; s < ramp.length; s++) {
    if ((ramp[s - 1]! + ramp[s]!) / 2 >= 0.9 * dps) {
      rampSeconds = s + 1;
      break;
    }
  }

  return {
    rootSpellIds: graph.roots.map((r) => graph.nodes.get(r.node)?.spellId ?? r.node),
    dps,
    spells,
    petsAlive: measuredTicks > 0 ? petTicks / measuredTicks : 0,
    rampDps: ramp,
    ...(rampSeconds === undefined ? {} : { rampSeconds }),
    seconds: opts.seconds,
  };
}

/** A small seeded generator, so a build gives the same chain every time it is asked. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
