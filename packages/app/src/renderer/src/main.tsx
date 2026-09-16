import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Root } from "./root.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import "./styles.css";

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
