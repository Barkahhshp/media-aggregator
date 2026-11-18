import { useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "./auth/AuthProvider";

export function App() {
  const { token, login, logout } = useAuth();
  const [draftToken, setDraftToken] = useState("");

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

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Private operations</p>
          <h1>Media Aggregator</h1>
        </div>
        <button className="secondary-button" type="button" onClick={logout}>Log out</button>
      </header>
      <section className="welcome-card" aria-live="polite">
        <p className="status-dot">Signed in</p>
        <h2>Dashboard workspace is ready</h2>
        <p>Operational views will appear here. Your session is held only in this tab.</p>
      </section>
    </main>
  );
}
