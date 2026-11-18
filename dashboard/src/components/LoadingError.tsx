import type { ReactNode } from "react";

interface LoadingErrorProps {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  children: ReactNode;
}

export function LoadingError({ loading, error, onRetry, children }: LoadingErrorProps) {
  if (loading) {
    return <p className="loading-message" role="status">Loading…</p>;
  }

  if (error !== null) {
    return (
      <section className="error-panel" role="alert">
        <p>{error}</p>
        <button className="secondary-button" type="button" onClick={onRetry}>Retry</button>
      </section>
    );
  }

  return <>{children}</>;
}
