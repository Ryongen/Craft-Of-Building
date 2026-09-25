/**
 * The last thing between an engine throw and a white screen.
 *
 * `state/derived.ts` runs the whole engine synchronously on the render path — deliberately, so
 * the numbers never lag the click that caused them — which means any exception it raises is
 * thrown *during render*. React unmounts the entire tree when nothing catches that, and an
 * unmounted tree in Electron is a blank window with the build still unsaved behind it.
 *
 * Two boundaries, because they fail differently and want different answers:
 *
 *   - **around a panel**, so a throw in the Damage tab leaves the Gear tab usable and the
 *     document editable. This is the one that saves the user's work.
 *   - **around the app**, so even a throw in the chrome renders something with the error in it.
 *
 * The message is shown rather than swallowed. A planner's exceptions are almost always a
 * datapack shape the model did not expect, and the stack names the file to look in — so it is
 * copyable, and the reset button re-renders rather than reloading, because the document lives in
 * a store that survived the throw.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** What failed, for the heading: "the Damage panel", "the app". */
  what: string;
  /** Rendered instead of the default panel, when a caller wants something smaller. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type State = { error: Error | undefined; componentStack: string | undefined };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined, componentStack: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept out of `getDerivedStateFromError`, which is not allowed side effects and is not
    // handed the component stack — and the component stack is the half that says *where*.
    this.setState({ componentStack: info.componentStack ?? undefined });
    // eslint-disable-next-line no-console
    console.error(`[${this.props.what}]`, error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: undefined, componentStack: undefined });
  };

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === undefined) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback(error, this.reset);

    const detail = [error.stack ?? `${error.name}: ${error.message}`, componentStack]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n");

    return (
      <div style={{ padding: 20, maxWidth: 900 }}>
        <h2 className="mt-0">Something went wrong in {this.props.what}.</h2>
        <p className="faint">
          Only this panel crashed. Your build is still loaded and editable. If it keeps
          happening, the details below show where.
        </p>
        <p style={{ fontWeight: 600 }}>{error.message}</p>
        <div className="row mb-6">
          <button type="button" onClick={this.reset}>
            Try again
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(detail);
            }}
          >
            Copy details
          </button>
        </div>
        <pre
          className="text-sm"
          style={{
            maxHeight: 320,
            overflow: "auto",
            padding: 10,
            borderRadius: 4,
            // `--panel` was never a token; this had been falling through to the hardcoded
            // hex, so the trace block ignored the theme. The real name is `--bg-panel`.
            background: "var(--bg-panel)",
            whiteSpace: "pre-wrap",
          }}
        >
          {detail}
        </pre>
      </div>
    );
  }
}
