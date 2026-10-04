/**
 * Moving a whole build between places that are not files: a link, a chat message, the catalogue.
 *
 * Two things live here, and both are format decisions that must not exist twice:
 *
 *   - **What counts as a build.** {@link readBuild} accepts a bare `BuildDoc` or a capture — the
 *     exporter's `{name, build, observed, exporter}` envelope — and is what the planner's file
 *     dialog, its paste box, the build catalogue's upload endpoint and the Discord bot all call.
 *     A build that opens in one and is refused by another is the failure this module exists to
 *     prevent.
 *   - **The build code.** `cob1:` followed by the document's JSON, deflated and base64url-encoded.
 *     A level-100 capture is ~25 KB of pretty JSON and ~6 KB as a code, which fits in a URL
 *     fragment and a Discord message where the JSON does not.
 *
 * Only the document travels in a code. A capture's `observed` sheet is the game's answer for the
 * character *as captured*, and a code is how a build gets shared and then edited — carrying the
 * sheet along would have the planner checking an edited build against a character it no longer is.
 *
 * Uses `CompressionStream`, which browsers and Node 18+ both have, so nothing here needs a
 * dependency or knows which of the two it is running in.
 */

import { BUILD_DOC_VERSION, type BuildDoc } from "./build-doc.js";
import { parseFixture, type Observation } from "./fixture.js";

/** What every build code starts with. The digit is the code format's version, not the document's. */
export const BUILD_CODE_PREFIX = "cob1:";

/** A build, and the game's own stat sheet for it when it arrived as a capture. */
export type ReadBuild = { doc: BuildDoc; observed: Observation | null };

/**
 * Accepts either a bare `BuildDoc` or a capture wrapper, so a file from `cob-exports/` or
 * `fixtures/` opens without being unwrapped by hand first — that round trip is the whole point of
 * the exporter.
 *
 * Validation against a snapshot happens wherever the snapshot lives. This only checks that the
 * thing is shaped like a document at all.
 */
export function readBuild(parsed: unknown): ReadBuild {
  if (parsed === null || typeof parsed !== "object") throw new Error("Not a JSON object");

  const node = parsed as Record<string, unknown>;
  const isFixture =
    node["build"] !== undefined && typeof node["build"] === "object" && node["build"] !== null;
  const candidate = isFixture ? (node["build"] as Record<string, unknown>) : node;

  // A capture's `observed` block is the game's own stat sheet. Keeping it lets a viewer check
  // the planner against the character the numbers came from, which is the whole point of having
  // captured it.
  let observed: Observation | null = null;
  if (isFixture) {
    try {
      observed = parseFixture(parsed, "opened build").observed;
    } catch {
      // A build that is not a well-formed fixture still opens; it just has nothing to check
      // against. Refusing the whole file over a malformed `observed` would be perverse.
      observed = null;
    }
  }

  const character = candidate["character"];
  if (character === null || typeof character !== "object") {
    throw new Error("Missing `character` — this does not look like a build document");
  }
  if (typeof (character as Record<string, unknown>)["level"] !== "number") {
    throw new Error("Missing `character.level`");
  }
  if (typeof candidate["schemaVersion"] !== "number") {
    throw new Error("Missing `schemaVersion`");
  }
  if (candidate["schemaVersion"] !== BUILD_DOC_VERSION) {
    // Not fatal: the validator reports version drift with far more detail than this can.
    // Loading it and letting the diagnostics explain is more useful than refusing.
  }
  return { doc: candidate as unknown as BuildDoc, observed };
}

/** {@link readBuild} over JSON text. */
export function parseBuild(text: string): ReadBuild {
  return readBuild(JSON.parse(text));
}

/** Whether `text` is a build code rather than JSON, ignoring the whitespace a paste brings along. */
export function isBuildCode(text: string): boolean {
  return text.trim().startsWith(BUILD_CODE_PREFIX);
}

/**
 * The code for a document. Compact JSON — the code is not for reading — so a document and its
 * code round-trip to the same value, not the same bytes.
 */
export async function encodeBuildCode(doc: BuildDoc): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return BUILD_CODE_PREFIX + toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw")));
}

/**
 * The most a code may unpack to. Real builds are tens of KB; the cap is there so a tiny code
 * that inflates to gigabytes (a zip bomb) is refused instead of exhausting memory.
 */
export const MAX_DECODED_BYTES = 1024 * 1024;

/**
 * The document a code holds. Throws with a message a person can act on: a code cut short by a
 * chat client's length limit is the common failure, and "invalid code" says nothing about it.
 */
export async function decodeBuildCode(code: string): Promise<BuildDoc> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(BUILD_CODE_PREFIX)) {
    throw new Error(`Not a build code — codes start with "${BUILD_CODE_PREFIX}"`);
  }
  // Pasted codes pick up line breaks wherever a chat window wrapped them.
  const body = trimmed.slice(BUILD_CODE_PREFIX.length).replace(/\s+/g, "");
  let text: string;
  try {
    text = new TextDecoder().decode(
      await pipe(fromBase64Url(body), new DecompressionStream("deflate-raw"), MAX_DECODED_BYTES),
    );
  } catch (error) {
    if (error instanceof TooLarge) throw new Error("This build code unpacks to far more than any real build");
    throw new Error("This build code is damaged or incomplete — was it cut off when it was copied?");
  }
  return readBuild(JSON.parse(text)).doc;
}

/**
 * Anything a person might paste or hand over as a build — a code, a bare document or a capture —
 * read into one.
 */
export async function readBuildText(text: string): Promise<ReadBuild> {
  if (isBuildCode(text)) return { doc: await decodeBuildCode(text), observed: null };
  return parseBuild(text);
}

// ---------------------------------------------------------------------------

class TooLarge extends Error {}

async function pipe(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  maxBytes = Infinity,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // The reader reports a failure; these would only report it a second time, unhandled.
  writer.write(bytes).catch(() => undefined);
  writer.close().catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // Chunked, because `String.fromCharCode(...bytes)` overflows the argument limit on a big build.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
