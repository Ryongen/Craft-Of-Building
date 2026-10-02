/**
 * Build links: how a build gets from somewhere else — the build catalogue, a chat message — into
 * the planner without a file in between.
 *
 * Three spellings of two things:
 *
 *   - `cob://build/<id>` and `…/Craft-Of-Building/?build=<id>` name a build in the catalogue,
 *     fetched from {@link CATALOGUE_API}.
 *   - `cob://code/<code>` and `…/Craft-Of-Building/#code=<code>` carry the build itself as a
 *     `cob1:` code. A fragment rather than a query, so the build never reaches a server log.
 *
 * Desktop and web read the same links through the same function, so a link that opens in one
 * opens in the other — the catalogue's "Open in CoB" button offers both.
 */

import { readBuild, readBuildText, type ReadBuild } from "@cte2/schema";

import { LINK_SCHEME } from "@shared/ipc";

/**
 * Where catalogue builds are fetched from. Set per build of the app (`VITE_CATALOGUE_API`), and
 * empty until the catalogue exists — a `?build=` link then explains itself instead of fetching
 * from a guess.
 */
export const CATALOGUE_API: string = import.meta.env.VITE_CATALOGUE_API ?? "";

export type BuildLink = { kind: "catalogue"; id: string } | { kind: "code"; code: string };

/** Catalogue ids are opaque, but they are never anything that could escape a URL path. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The build a link names, or `null` for a link that names none — including every ordinary URL,
 * so this can be handed `location.href` without checking it first.
 */
export function parseBuildLink(href: string): BuildLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol === `${LINK_SCHEME}:`) {
    // `cob://build/abc` parses with `build` as the host on some platforms and as the first path
    // segment on others, so read both as one path.
    const [kind, ...rest] = `${url.host}${url.pathname}`.split("/").filter((s) => s.length > 0);
    const value = decodeURIComponent(rest.join("/"));
    if (kind === "build" && ID.test(value)) return { kind: "catalogue", id: value };
    if (kind === "code" && value.length > 0) return { kind: "code", code: value };
    return null;
  }

  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = fragment.get("code");
  if (code !== null && code.length > 0) return { kind: "code", code };

  const id = url.searchParams.get("build");
  if (id !== null && ID.test(id)) return { kind: "catalogue", id };
  return null;
}

/**
 * The build behind a link. Throws with a message meant for a person: these surface in a dialog
 * after someone clicked a button on another site, and "fetch failed" is not an explanation.
 */
export async function resolveBuildLink(link: BuildLink): Promise<ReadBuild> {
  if (link.kind === "code") return readBuildText(link.code);

  if (CATALOGUE_API === "") {
    throw new Error("This copy of Craft of Building does not know where the build catalogue is.");
  }
  let response: Response;
  try {
    response = await fetch(`${CATALOGUE_API.replace(/\/$/, "")}/builds/${encodeURIComponent(link.id)}/doc`);
  } catch {
    throw new Error("Could not reach the build catalogue. Are you online?");
  }
  if (response.status === 404) throw new Error("That build is not in the catalogue any more.");
  if (!response.ok) throw new Error(`The build catalogue answered ${response.status}.`);
  return readBuild(await response.json());
}
