import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Clock, Lock, RefreshCw, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApiError } from "@/lib/apiClient";

/*
  What a screen shows when its data could not be loaded. A failed or timed-out
  request is never shown as "no records": that told people their jobs were
  gone when the server was only slow.

  - ErrorState: nothing loaded yet; says what went wrong and offers Retry.
  - StaleDataBanner: an earlier load is still on screen but the latest refresh
    failed; the rows stay, marked as possibly out of date.
*/

interface Described {
  icon: LucideIcon;
  title: string;
  description: string;
  retryable: boolean;
}

export function describeLoadError(error: unknown, what = "this"): Described {
  const e = (error || {}) as ApiError;
  switch (e.kind) {
    case "timeout":
      return { icon: Clock, title: "The server is taking too long", description: `We couldn't load ${what} in time. Your records are safe — try again.`, retryable: true };
    case "network":
      return { icon: WifiOff, title: "Can't reach the server", description: "Check your internet connection, then try again.", retryable: true };
    case "forbidden":
      return { icon: Lock, title: "You don't have access", description: e.message && e.message !== "API request failed" ? e.message : `Your login isn't allowed to see ${what}. Ask your admin for access.`, retryable: false };
    case "auth":
      return { icon: Lock, title: "Your session has ended", description: "Sign in again to continue.", retryable: false };
    case "subscription":
      return { icon: Lock, title: "Your plan has ended", description: e.message || "Ask your admin to renew it in Plan & billing.", retryable: false };
    default:
      return {
        icon: AlertTriangle,
        title: `Couldn't load ${what}`,
        description: e.message && e.message !== "API request failed" ? e.message : "Something went wrong on the server. Try again in a moment.",
        retryable: true
      };
  }
}

interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  /** Noun for the message: "job tickets", "the counter queue" */
  what?: string;
  retrying?: boolean;
  compact?: boolean;
  className?: string;
}

export function ErrorState({ error, onRetry, what, retrying, compact, className }: ErrorStateProps) {
  const d = describeLoadError(error, what);
  const Icon = d.icon;
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-1.5 px-4 py-8" : "gap-2 px-6 py-14", className)}>
      <span className={cn("mb-1 flex items-center justify-center rounded-full bg-destructive/10 text-destructive", compact ? "h-9 w-9" : "h-11 w-11")}>
        <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} />
      </span>
      <p className={cn("font-medium text-foreground", compact ? "text-sm" : "text-base")}>{d.title}</p>
      <p className="max-w-sm text-xs text-muted-foreground sm:text-sm">{d.description}</p>
      {onRetry && d.retryable && (
        <Button variant="outline" size="sm" className="mt-2 gap-1.5" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      )}
    </div>
  );
}

interface StaleDataBannerProps {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  /** When the rows on screen were loaded (ms since epoch) */
  updatedAt?: number;
  className?: string;
}

export function StaleDataBanner({ error, onRetry, retrying, updatedAt, className }: StaleDataBannerProps) {
  const d = describeLoadError(error);
  const when = updatedAt ? new Date(updatedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-strong", className)}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {d.title}. Showing what was loaded{when ? ` at ${when}` : " earlier"} — it may be out of date.
      </span>
      {onRetry && d.retryable && (
        <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
          Retry
        </Button>
      )}
    </div>
  );
}

/** Catches a render crash in one page so the rest of the app (sidebar, header) keeps working. */
export class PageErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page crashed:", error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunk = /Loading chunk|dynamically imported module|Failed to fetch/i.test(this.state.error.message);
    return (
      <ErrorState
        error={{ kind: chunk ? "network" : "server", message: chunk ? "" : "This page hit an unexpected problem." }}
        what="this page"
        onRetry={() => (chunk ? window.location.reload() : this.setState({ error: null }))}
      />
    );
  }
}
