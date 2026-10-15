/**
 * Anonymous usage counts for the web build: which parts of the planner get used, never who
 * uses them.
 *
 * A count is the tool and an event name and nothing else — no cookies, no ids, no build data.
 * They go to the CTE2 Archives Worker, which keeps one number per day, tool and event (its
 * `src/usage.ts` lists the events it accepts, so a new one here needs adding there too).
 *
 * Only the live site counts. The desktop app loads from `file://` and a dev server from
 * localhost, so neither ever sends anything.
 */

const USAGE_URL = "https://cob-codex-api.ryongenn.workers.dev/usage";
const LIVE = location.hostname === "ryongen.github.io";
const sent = new Set<string>();

/** Counts `event` once per page load. Fire and forget: a count that fails must never show. */
export function countUsage(event: string): void {
  if (!LIVE || sent.has(event)) return;
  sent.add(event);
  fetch(`${USAGE_URL}?tool=cob&event=${event}`, { method: "POST", mode: "no-cors" }).catch(() => {});
}

/**
 * `open` on every page load, and `day` once per browser per day, which reads as roughly people.
 * The key names the tool because every tool on ryongen.github.io shares one localStorage.
 */
export function countVisit(): void {
  countUsage("open");
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem("cob.usage-day") === today) return;
    localStorage.setItem("cob.usage-day", today);
  } catch {
    return;
  }
  countUsage("day");
}
