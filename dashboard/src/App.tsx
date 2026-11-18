import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "./auth/AuthProvider";
import { OverviewPage } from "./pages/OverviewPage";
import { SourcesPage } from "./pages/SourcesPage";
import { ArticlesPage } from "./pages/ArticlesPage";
import { RunsPage } from "./pages/RunsPage";
import { ErrorsPage } from "./pages/ErrorsPage";
import { ExportsPage } from "./pages/ExportsPage";

function currentLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function routeName(path: string): string {
  const pathname = new URL(path, window.location.origin).pathname;
  if (pathname === "/runs") return "Runs";
  if (pathname === "/errors") return "Errors";
  if (pathname === "/pending") return "Pending items";
  if (pathname === "/articles") return "Articles and feed";
  if (pathname === "/exports") return "Exports and backups";
  return "Dashboard view";
}

export function App() {
  const { token, session, login, logout } = useAuth();
  const [draftToken, setDraftToken] = useState("");
  const [location, setLocation] = useState(currentLocation);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setLocation(currentLocation());
  }, []);

  useEffect(() => {
    const handlePopState = () => setLocation(currentLocation());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const submitToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    login(draftToken);
    setDraftToken("");
  };

  if (token === null) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="dashboard-title">
          <p className="eyebrow">Private operations</p>
          <h1 id="dashboard-title">Media Aggregator</h1>
          <p className="intro">Sign in with the dashboard Bearer token. It stays in memory for this tab and is cleared after 15 minutes without activity.</p>
          <form onSubmit={submitToken}>
            <label htmlFor="api-token">API token</label>
            <input
              id="api-token"
              name="api-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draftToken}
              onChange={(event) => setDraftToken(event.currentTarget.value)}
              required
            />
            <button type="submit" disabled={draftToken.trim() === ""}>Sign in</button>
          </form>
        </section>
      </main>
    );
  }

  const pathname = new URL(location, window.location.origin).pathname;
  const isOverview = pathname === "/" || pathname === "/overview";
  const isSources = pathname === "/sources";
  const isArticles = pathname === "/articles";
  const isRuns = pathname === "/runs";
  const isErrors = pathname === "/errors";
  const isExports = pathname === "/exports";

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Private operations</p>
          <h1>Media Aggregator</h1>
        </div>
        <div className="topbar-actions">
          <p className="status-dot">Signed in</p>
          <button className="secondary-button" type="button" onClick={logout}>Log out</button>
        </div>
      </header>
      <nav className="primary-nav" aria-label="Main navigation">
        <a href="/overview" aria-current={isOverview ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate("/overview"); }}>Overview</a>
        <a href="/sources" aria-current={isSources ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate("/sources"); }}>Sources</a>
        <a href="/articles" aria-current={isArticles ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate("/articles"); }}>Articles/Feed</a>
        <a href="/runs" aria-current={isRuns ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate("/runs"); }}>Runs</a>
        <a href="/errors" aria-current={isErrors ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate("/errors"); }}>Errors</a>
        <a href="/exports" aria-current={isExports ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate("/exports"); }}>Exports and Backups</a>
      </nav>
      {isOverview ? (
        <OverviewPage session={session} onNavigate={navigate} />
      ) : isSources ? (
        <SourcesPage session={session} onNavigate={navigate} />
      ) : isArticles ? (
        <ArticlesPage session={session} />
      ) : isRuns ? (
        <RunsPage session={session} />
      ) : isErrors ? (
        <ErrorsPage session={session} />
      ) : isExports ? (
        <ExportsPage session={session} />
      ) : (
        <section className="future-view empty-state" aria-live="polite">
          <p className="eyebrow">Filtered view</p>
          <h2>{routeName(location)}</h2>
          <p>This filter will open when its dashboard screen is available. Your Overview and Sources screens are ready.</p>
          <a href="/overview" onClick={(event) => { event.preventDefault(); navigate("/overview"); }}>Back to Overview</a>
        </section>
      )}
    </main>
  );
}
