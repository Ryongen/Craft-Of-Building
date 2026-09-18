/**
 * Decide which host we are in, once, before React mounts.
 *
 * The test is whether a preload already put `window.cte2` there. That is a runtime check rather
 * than a build-time flag on purpose: there is one renderer bundle's worth of source and two
 * builds of it, and a `import.meta.env.MODE` branch would mean the web shim could be compiled
 * out of the desktop build and then silently rot — nobody would run it until the day it was the
 * only thing standing between the site and a blank page.
 *
 * The cost is a few kilobytes of unused shim inside the Electron bundle, which is nothing
 * against a code path that is exercised by every `npm run dev` of either target.
 */

import { createWebApi } from "./web-api.js";

export function installPlatformApi(): void {
  if (typeof window.cte2 !== "undefined") return;
  window.cte2 = createWebApi();
}
