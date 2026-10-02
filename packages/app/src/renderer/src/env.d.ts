/// <reference types="vite/client" />

import type { Cte2Api } from "@shared/ipc";

declare global {
  interface Window {
    cte2: Cte2Api;
  }
}

interface ImportMetaEnv {
  /** The build catalogue's API root. Unset in a build that should not offer catalogue links. */
  readonly VITE_CATALOGUE_API?: string;
}

export {};
