/// <reference types="vite/client" />

import type { Cte2Api } from "@shared/ipc";

declare global {
  interface Window {
    cte2: Cte2Api;
  }
}

export {};
