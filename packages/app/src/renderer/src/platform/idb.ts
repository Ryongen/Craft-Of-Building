/**
 * The browser build's disk: a tiny IndexedDB store, wrapped so the rest of the shim can `await`.
 *
 * IndexedDB rather than `localStorage` for two reasons that both bite in practice. An autosaved
 * session is a whole `BuildDoc` plus a pinned baseline — two documents — and a geared character
 * with a full tree serialises past the 5 MB `localStorage` ceiling on a bad day; losing the
 * session at exactly the moment the build got interesting is the worst possible failure. And
 * `localStorage` holds strings only, while a `FileSystemFileHandle` is structured-cloneable and
 * has to survive a reload for the recent list to mean anything.
 *
 * Every function here swallows its errors and degrades. Storage can be denied outright — private
 * windows, blocked site data, Safari's eviction — and a planner that refuses to open because it
 * could not write an autosave would be worse than one that quietly forgets.
 */

const DB_NAME = "cte2-pob";
const DB_VERSION = 1;

/** Small values, keyed by name: the autosaved session, a user-supplied snapshot. */
const KV = "kv";
/** Recently opened files, keyed by an opaque id, each holding a handle we can reopen. */
const RECENTS = "recents";

export type RecentRecord = {
  id: string;
  name: string;
  fileName: string;
  openedAt: string;
  /** Absent in browsers with no File System Access API — such an entry cannot be reopened. */
  handle?: FileSystemFileHandle;
};

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening !== null) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // `indexedDB` itself throws in some locked-down configurations rather than failing the
      // request, so the call is inside the try and not only the handlers.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(RECENTS)) db.createObjectStore(RECENTS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (db === null) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(store, mode);
          const request = work(tx.objectStore(store));
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function getValue<T>(key: string): Promise<T | null> {
  const value = await run<T>(KV, "readonly", (store) => store.get(key));
  return value ?? null;
}

export async function setValue(key: string, value: unknown): Promise<void> {
  await run(KV, "readwrite", (store) => store.put(value, key));
}

export async function deleteValue(key: string): Promise<void> {
  await run(KV, "readwrite", (store) => store.delete(key));
}

/** Newest first, capped — the same ten the desktop app's recent list holds. */
export async function listRecents(limit = 10): Promise<RecentRecord[]> {
  const all = (await run<RecentRecord[]>(RECENTS, "readonly", (store) => store.getAll())) ?? [];
  return all.sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, limit);
}

export async function putRecent(record: RecentRecord): Promise<void> {
  await run(RECENTS, "readwrite", (store) => store.put(record));
  // Prune past the cap here rather than on read, so the store cannot grow without bound across
  // a long-lived profile. Handles are small, but they pin a permission grant each.
  const all = (await run<RecentRecord[]>(RECENTS, "readonly", (store) => store.getAll())) ?? [];
  const stale = all.sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(10);
  for (const entry of stale) await run(RECENTS, "readwrite", (store) => store.delete(entry.id));
}

export async function getRecent(id: string): Promise<RecentRecord | null> {
  return (await run<RecentRecord>(RECENTS, "readonly", (store) => store.get(id))) ?? null;
}

export async function deleteRecent(id: string): Promise<void> {
  await run(RECENTS, "readwrite", (store) => store.delete(id));
}
