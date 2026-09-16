/**
 * A partial where `undefined` is a legal value, meaning "remove this key".
 *
 * The repo compiles with `exactOptionalPropertyTypes`, under which `Partial<T>` says a key may
 * be *absent* but not that it may be *present and undefined*. Every editor in this app patches
 * by spreading and then deleting the undefined keys — passing `{ unique: undefined }` to clear
 * a field — so the parameter type has to say so explicitly.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * Merges a patch and drops the keys it cleared.
 *
 * Removing rather than keeping `undefined` matters beyond types: these documents get saved and
 * pasted into fixtures, and `"unique": undefined` is not valid JSON while a missing key is
 * exactly what a hand-authored document looks like.
 */
export function applyPatch<T extends object>(value: T, patch: Patch<T>): T {
  const merged = { ...value, ...patch } as T;
  for (const key of Object.keys(merged) as (keyof T)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}
