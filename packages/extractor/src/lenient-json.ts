/**
 * Gson-lenient JSON parsing.
 *
 * Minecraft parses datapacks with Gson, which tolerates input that `JSON.parse` rejects.
 * Craft to Exile 2 relies on this: all three `mmorpg_talent_tree/*.json` files embed the
 * talent grid as a string containing **raw unescaped newlines**, so a strict parse of
 * talents.json / ascendancy.json / atlas_passives.json fails outright.
 *
 * Rather than silently accepting anything, this repairs the specific divergences Gson
 * allows and reports which ones were applied, so a future pack revision introducing
 * something new is visible instead of quietly tolerated.
 */

export type Repair = "control-char-in-string" | "line-comment" | "block-comment" | "trailing-comma";

export type LenientParseResult<T> = {
  value: T;
  /** Repairs applied, in no particular order. Empty means the input was strict JSON. */
  repairs: Repair[];
};

const CONTROL_ESCAPES: Record<number, string> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r",
};

/**
 * Normalises `text` into strict JSON, then parses it.
 *
 * @throws if the result still isn't valid JSON — a genuine syntax error, not a leniency gap.
 */
export function parseLenient<T = unknown>(text: string, source = "<input>"): LenientParseResult<T> {
  const repairs = new Set<Repair>();
  const out: string[] = [];

  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);

    if (inString) {
      if (ch === "\\") {
        // Copy the escape pair verbatim so an escaped quote doesn't end the string.
        out.push(text.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out.push(ch);
        i++;
        continue;
      }
      if (code < 0x20) {
        // The talent-tree case: a literal newline (or tab) inside a string literal.
        out.push(CONTROL_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, "0")}`);
        repairs.add("control-char-in-string");
        i++;
        continue;
      }
      out.push(ch);
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out.push(ch);
      i++;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      const end = indexOfLineEnd(text, i);
      repairs.add("line-comment");
      i = end;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`${source}: unterminated block comment at offset ${i}`);
      repairs.add("block-comment");
      i = end + 2;
      continue;
    }

    if (ch === "," && isTrailingComma(text, i)) {
      repairs.add("trailing-comma");
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  if (inString) throw new Error(`${source}: unterminated string literal`);

  const repaired = out.join("");
  try {
    return { value: JSON.parse(repaired) as T, repairs: [...repairs] };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${source}: invalid JSON even after leniency repairs: ${detail}`);
  }
}

function indexOfLineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl < 0 ? text.length : nl;
}

/**
 * True if the comma at `at` is followed only by whitespace/comments before a closing
 * bracket. Gson rejects trailing commas in strict mode but tolerates them when lenient,
 * and hand-edited datapacks pick them up easily.
 */
function isTrailingComma(text: string, at: number): boolean {
  let j = at + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      j++;
      continue;
    }
    if (c === "/" && text[j + 1] === "/") {
      j = indexOfLineEnd(text, j);
      continue;
    }
    if (c === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      if (end < 0) return false;
      j = end + 2;
      continue;
    }
    return c === "}" || c === "]";
  }
  return false;
}
