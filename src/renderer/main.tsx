import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { StartupState } from "../shared/readiness";
import "./styles.css";

function App() {
  const [state, setState] = useState<StartupState>();

  useEffect(() => {
    void window.pilot.getStartupState().then(setState);
  }, []);

  return (
    <>
      <a className="skip-link" href="#content">Skip to readiness</a>
      <div className="shell">
        <nav aria-label="Projects and tasks" className="navigation">
          <header className="brand">
            <span className="mark" aria-hidden="true">π</span>
            <strong>PiLot</strong>
          </header>
          <div className="nav-heading">
            <span>Projects</span>
            <button aria-label="Add project" disabled title="Project creation is coming next">+</button>
          </div>
          {state?.projects.length ? (
            <ul className="project-list">
              {state.projects.map((project) => (
                <li key={project.name}>
                  <span className="project-icon" aria-hidden="true">◇</span>
                  <span>{project.name}</span>
                  <small>{project.taskCount}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted nav-empty">Projects with Pi tasks will appear here.</p>
          )}
          <div className="nav-footer"><span aria-hidden="true">⌘</span> Command center</div>
        </nav>

        <main id="content">
          <header className="topbar">
            <div>
              <span className="eyebrow">Command center</span>
              <h1>Good to have you here.</h1>
            </div>
            <span className="privacy"><i /> Local only</span>
          </header>

          {!state ? (
            <p role="status" className="loading">Checking your Pi environment…</p>
          ) : state.gaps.length === 0 ? (
            <section className="ready" aria-label={`${state.passed} readiness checks passed`}>
              <span className="ready-mark" aria-hidden="true">✓</span>
              <p className="eyebrow">Environment ready</p>
              <h2>Ready to work</h2>
              <p className="muted">Your provider, shell, Pi environment, and task history are compatible.</p>
            </section>
          ) : (
            <section className="readiness" aria-labelledby="readiness-title" tabIndex={0}>
              <p className="eyebrow">Action required</p>
              <h2 id="readiness-title">Readiness</h2>
              <p className="muted">Resolve these items before starting a task.</p>
              <ol>
                {state.gaps.map((gap) => (
                  <li key={gap.area}>
                    <span className="gap-mark" aria-hidden="true">!</span>
                    <div><h3>{gap.title}</h3><p>{gap.detail}</p></div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </main>

        <aside aria-label="Inspector" className="inspector">
          <div className="tabs" role="tablist" aria-label="Inspector views">
            <button role="tab" aria-selected="true">Details</button>
            <button role="tab" aria-selected="false" disabled>Changes</button>
            <button role="tab" aria-selected="false" disabled>History</button>
          </div>
          <div className="inspector-body">
            <p className="eyebrow">Startup</p>
            <h2>Readiness</h2>
            <dl>
              <div><dt>Checks passed</dt><dd>{state?.passed ?? "—"} / 4</dd></div>
              <div><dt>Tasks found</dt><dd>{state?.projects.reduce((sum, project) => sum + project.taskCount, 0) ?? "—"}</dd></div>
              <div><dt>Network reporting</dt><dd>Off</dd></div>
            </dl>
          </div>
        </aside>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
