import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Appearance } from "../shared/preferences";
import type { OAuthEvent, ProviderState } from "../shared/providers";
import type { StartupState } from "../shared/readiness";
import "./styles.css";

function ProviderSettings({ onChange }: { onChange(): void }) {
  const [state, setState] = useState<ProviderState>();
  const [providerId, setProviderId] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [oauth, setOAuth] = useState<OAuthEvent>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void window.pilot.getProviderState().then((next) => {
      setState(next);
      setProviderId(next.providers.find(({ configured }) => configured)?.id ?? next.providers[0]?.id ?? "");
    });
    return window.pilot.onOAuthEvent(setOAuth);
  }, []);

  const provider = state?.providers.find(({ id }) => id === providerId);
  const update = (next: ProviderState, notice: string) => {
    setState(next);
    setProviderId((current) => next.providers.some(({ id }) => id === current) ? current : next.providers.find(({ configured }) => configured)?.id ?? next.providers[0]?.id ?? "");
    setOAuth(undefined);
    setMessage(notice);
    setError("");
    setEditingKey(false);
    onChange();
  };
  const attempt = async (action: () => Promise<ProviderState>, notice: string) => {
    setMessage("");
    setError("");
    try { update(await action(), notice); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  if (!state) return <section className="provider-setup" aria-label="Provider authentication"><p role="status">Loading providers…</p></section>;

  const providerModels = state.models.filter((model) => model.provider === providerId);
  return (
    <section className="provider-setup" aria-label="Provider authentication">
      <div className="setup-heading">
        <div><p className="eyebrow">Pi environment</p><h2>Provider authentication</h2></div>
        <div className="setup-controls"><span className="muted">Secrets stay in Pi's credential store.</span><button onClick={() => void attempt(() => window.pilot.getProviderState(), "Providers refreshed")}>Refresh providers</button></div>
      </div>
      <ul className="credential-summary" aria-label="Detected credentials">
        {state.providers.filter(({ configured }) => configured).map((item) => <li key={item.id}><span>{item.name}</span><small>{item.sourceLabel}</small></li>)}
      </ul>

      <label>Provider
        <select aria-label="Provider" value={providerId} onChange={(event) => { setProviderId(event.target.value); setEditingKey(false); setMessage(""); }}>
          {state.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>

      {provider && <>
        <div className="provider-detail">
          <div><strong>{provider.name}</strong><span className={provider.configured ? "connected" : "muted"}>{provider.sourceLabel ?? "Not configured"}</span><span className="muted">{providerModels.length} model{providerModels.length === 1 ? "" : "s"} available</span></div>
          <div className="actions">
            <button onClick={() => setEditingKey(true)}>{provider.credentialType === "api_key" ? "Replace API key" : "Add API key"}</button>
            {provider.credentialType === "api_key" && <button onClick={() => void attempt(() => window.pilot.removeApiKey(provider.id), "API key removed")}>Remove API key</button>}
            {provider.supportsOAuth && <button onClick={() => void attempt(() => window.pilot.login(provider.id), "Signed in")}>{provider.credentialType === "oauth" ? "Reauthenticate" : "Use subscription"}</button>}
            {provider.credentialType === "oauth" && <button onClick={() => void attempt(() => window.pilot.logout(provider.id), "Logged out")}>Log out</button>}
          </div>
        </div>
        <section className="model-inspection" aria-labelledby="available-models-title">
          <h3 id="available-models-title">Available models</h3>
          {providerModels.length ? <ul aria-labelledby="available-models-title">
            {providerModels.map((model) => <li key={model.id}><strong>{model.name}</strong><code>{model.id}</code></li>)}
          </ul> : <p className="muted">No models are available with this provider's current credentials.</p>}
          <p className="muted task-model-guidance">Switch models from the contextual control in a Task.</p>
        </section>
      </>}

      {editingKey && provider && <form className="key-form" onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void attempt(() => window.pilot.setApiKey(provider.id, String(form.get("key") ?? "")), "API key saved");
        event.currentTarget.reset();
      }}>
        <label>API key for {provider.name}<input name="key" aria-label={`API key for ${provider.name}`} type="password" autoComplete="off" required autoFocus /></label>
        <button type="submit">Save API key</button>
        <button type="button" onClick={() => setEditingKey(false)}>Cancel</button>
      </form>}

      {oauth && <div className="oauth-flow" role="region" aria-label={`${oauth.providerName} authentication`}>
        <strong>{oauth.providerName}</strong>
        {oauth.type === "device_code" && <><p>Enter this code in your browser:</p><code>{oauth.userCode}</code></>}
        {oauth.type === "auth" && <p>{oauth.instructions ?? "Finish signing in in your browser."}</p>}
        {oauth.type === "progress" && <p>{oauth.message}</p>}
        {(oauth.type === "prompt" || (oauth.type === "auth" && oauth.manualInput)) && <form onSubmit={(event) => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get("oauth") ?? "");
          void window.pilot.respondToOAuth(value);
        }}>
          <label>{oauth.type === "prompt" ? oauth.message : "Paste the redirect URL if the browser does not return automatically"}
            <input name="oauth" placeholder={oauth.type === "prompt" ? oauth.placeholder : undefined} required={oauth.type === "prompt" ? !oauth.allowEmpty : true} />
          </label><button type="submit">Continue</button>
        </form>}
        {oauth.type === "select" && <div><p>{oauth.message}</p>{oauth.options.map((option) => <button key={option.id} onClick={() => void window.pilot.respondToOAuth(option.id)}>{option.label}</button>)}</div>}
      </div>}

      {message && <p className="success" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function applyAppearance(appearance: Appearance) {
  document.documentElement.dataset.appearance = appearance;
}

function GeneralSettings() {
  const [appearance, setAppearance] = useState<Appearance>();
  useEffect(() => { void window.pilot.getPreferences().then((value) => { setAppearance(value.appearance); applyAppearance(value.appearance); }); }, []);

  return <section className="general-settings" aria-labelledby="general-title">
    <p className="eyebrow">Application</p>
    <h2 id="general-title">General</h2>
    <p className="muted">Choose how PiLot looks on this device.</p>
    <fieldset disabled={!appearance}>
      <legend>Appearance</legend>
      {(["system", "light", "dark"] as const).map((value) => <label key={value}>
        <input type="radio" name="appearance" value={value} checked={appearance === value} onChange={() => {
          setAppearance(value);
          applyAppearance(value);
          void window.pilot.setAppearance(value).then((next) => { setAppearance(next.appearance); applyAppearance(next.appearance); });
        }} />
        <span><strong>{value[0].toUpperCase() + value.slice(1)}</strong><small>{value === "system" ? "Follow your operating system" : `Always use ${value} appearance`}</small></span>
      </label>)}
    </fieldset>
  </section>;
}

function SettingsPage({ onChange, onClose }: { onChange(): void; onClose(): void }) {
  const [destination, setDestination] = useState<"general" | "providers">("general");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="settings-shell">
    <aside className="settings-navigation">
      <button className="back-button" aria-label="Back to command center" onClick={onClose}>‹ <span>Command center</span></button>
      <h1 id="settings-title" ref={heading} tabIndex={-1}>Settings</h1>
      <nav aria-label="Settings">
        <button aria-current={destination === "general" ? "page" : undefined} onClick={() => setDestination("general")}>General</button>
        <button aria-current={destination === "providers" ? "page" : undefined} onClick={() => setDestination("providers")}>Providers</button>
      </nav>
    </aside>
    <main className="settings-main" aria-label="Settings">
      {destination === "general" ? <GeneralSettings /> : <ProviderSettings onChange={onChange} />}
    </main>
  </div>;
}

function App() {
  const [state, setState] = useState<StartupState>();
  const [showSettings, setShowSettings] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(() => void window.pilot.getStartupState().then(setState), []);
  const closeSettings = useCallback(() => {
    setShowSettings(false);
    requestAnimationFrame(() => settingsButton.current?.focus());
  }, []);

  useEffect(() => {
    refresh();
    void window.pilot.getPreferences().then((value) => applyAppearance(value.appearance));
  }, []);

  if (showSettings) return <><div className="window-bar" aria-hidden="true" /><SettingsPage onChange={refresh} onClose={closeSettings} /></>;

  return (
    <>
      <a className="skip-link" href="#content">Skip to readiness</a>
      <div className="window-bar" aria-hidden="true" />
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
          <div className="nav-footer">
            <span className="command-center"><span aria-hidden="true">⌘</span> Command center</span>
            <button ref={settingsButton} className="settings-button" aria-label="Settings" title="Settings" onClick={() => setShowSettings(true)}><span aria-hidden="true">⚙</span></button>
          </div>
        </nav>

        <main id="content" className="workspace-main">
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
