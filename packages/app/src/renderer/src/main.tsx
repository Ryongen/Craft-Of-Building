import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installPlatformApi } from "./platform/install.js";
import { Root } from "./root.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import "./styles.css";

// Before anything renders. `Root` calls `window.cte2.getSnapshot()` in its first effect, and
// every panel below it assumes the bridge is there — in Electron the preload has already put it
// there, and in a browser this is where it comes from.
installPlatformApi();

const container = document.getElementById("root");
if (container === null) throw new Error("No #root element");

createRoot(container).render(
  <StrictMode>
    {/*
      The outer boundary, for a throw in the chrome itself or before any panel mounts. The
      per-panel ones in `app.tsx` catch everything below them first, so reaching this means the
      app could not draw itself at all — and even then it draws the reason.
    */}
    <ErrorBoundary what="the app">
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
