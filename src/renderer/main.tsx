import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Appearance } from "../shared/preferences";
import type { OAuthEvent, ProviderState } from "../shared/providers";
import type { ProjectAccess, ProjectsState } from "../shared/projects";
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

function ProjectAccessPanel({ project, onChange }: { project: ProjectAccess; onChange(state: ProjectsState): void }) {
  const [error, setError] = useState("");
  const attempt = async (action: () => Promise<ProjectsState>) => {
    setError("");
    try { onChange(await action()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const trustLabel = project.resourceTrust.decision === null
    ? project.resourceTrust.required ? "Not decided" : "No decision needed"
    : project.resourceTrust.decision ? "Trusted" : "Not trusted";

  return <section className="project-access" aria-label="Project access">
    <header>
      <h2 id="project-access-title">Project access</h2>
      <p>Pi resource trust and agent execution are independent decisions for <code>{project.path}</code>.</p>
    </header>

    <section aria-labelledby="resource-trust-title">
      <div className="access-heading">
        <div><h3 id="resource-trust-title">Pi resource trust</h3><p>Controls whether Pi loads project settings, prompts, skills, and context files.</p></div>
        <span className="access-status" role="status" aria-label="Pi resource trust">{trustLabel}</span>
      </div>
      {project.resourceTrust.sourcePath && <p className="decision-source">Saved in Pi for <code>{project.resourceTrust.sourcePath}</code>{project.resourceTrust.sourcePath !== project.path ? " and inherited here" : ""}.</p>}
      {!project.resourceTrust.required && <p className="decision-source">This Project has no local Pi resources that currently require trust.</p>}
      <div className="access-actions">
        <button onClick={() => void attempt(() => window.pilot.setResourceTrust(project.path, true))}>Trust project resources</button>
        <button onClick={() => void attempt(() => window.pilot.setResourceTrust(project.path, false))}>Do not trust project resources</button>
      </div>
    </section>

    <section aria-labelledby="execution-title">
      <div className="access-heading">
        <div><h3 id="execution-title">Agent execution</h3><p>Allows agents started by PiLot to run unsandboxed shell commands and read, create, edit, or delete files on this computer, starting from this Project.</p></div>
        <span className="access-status" role="status" aria-label="Agent execution">{project.executionConsent ? "Granted" : "Not granted"}</span>
      </div>
      <p className="decision-source">{project.executionConsent ? "Prompts and setup commands may run without per-command approval." : "Prompts and setup commands are blocked until you grant access."}</p>
      <div className="access-actions">
        {project.executionConsent
          ? <button onClick={() => void attempt(() => window.pilot.setExecutionConsent(project.path, false))}>Revoke agent execution</button>
          : <button className="primary-action" onClick={() => void attempt(() => window.pilot.setExecutionConsent(project.path, true))}>Allow agent execution</button>}
      </div>
    </section>
    {project.admitted && <section aria-labelledby="project-removal-title">
      <div className="access-heading"><div><h3 id="project-removal-title">Project removal</h3><p>Hides this Project and its Tasks without changing Pi resource trust or task history.</p></div></div>
      <div className="access-actions"><button onClick={() => void attempt(() => window.pilot.removeProject(project.path))}>Remove Project</button></div>
    </section>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

function ProjectAccessDialog({ project, dismissible, onChange, onClose }: { project: ProjectAccess; dismissible: boolean; onChange(state: ProjectsState): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const handleCancel = (event: Event) => dismissible ? onClose() : event.preventDefault();
    element.addEventListener("cancel", handleCancel);
    element.showModal();
    return () => {
      element.removeEventListener("cancel", handleCancel);
      if (element.open) element.close();
    };
  }, [dismissible, onClose]);
  return <dialog ref={dialog} className="project-access-dialog" aria-labelledby="project-access-title">
    {dismissible && <button className="dialog-close" aria-label="Close project access" onClick={onClose}>×</button>}
    <ProjectAccessPanel project={project} onChange={onChange} />
  </dialog>;
}

function ProjectPage({ project, needsAccess, onOpenAccess, onChange }: { project: ProjectAccess; needsAccess: boolean; onOpenAccess(): void; onChange(state: ProjectsState): void }) {
  const active = project.tasks.filter(({ lifecycle }) => lifecycle === "active");
  const archived = project.tasks.filter(({ lifecycle }) => lifecycle === "archived");
  return <>
    <header className="topbar project-topbar">
      <div><p className="eyebrow">Project</p><h1>{project.name}</h1><code>{project.path}</code></div>
      <div className="project-top-actions"><button onClick={onOpenAccess}>Project access</button><span className="privacy"><i /> Local only</span></div>
    </header>
    {needsAccess ? <section className="project-empty" aria-live="polite">
      <h2>Access required</h2>
      <p>Complete the access decision to admit this Project.</p>
    </section> : <div className="task-overview">
      {project.diagnostics.length > 0 && <section className="task-diagnostics" aria-label="Task diagnostics">
        {project.diagnostics.map((diagnostic) => <div key={diagnostic.title}><strong>{diagnostic.title}</strong><p>{diagnostic.detail}</p></div>)}
      </section>}
      <section className="task-section" aria-label="Active tasks">
        <div className="task-section-heading"><h2>Active Tasks</h2><span>{active.length}</span></div>
        {active.length ? <ul>{active.map((task) => <li key={task.path}><strong>{task.title}</strong><span>Active</span><button onClick={() => void window.pilot.setTaskArchived(project.path, task.path, true).then(onChange)}>Archive</button></li>)}</ul> : <p className="muted">No active Tasks</p>}
      </section>
      <section className="task-section" aria-label="Archived tasks">
        <div className="task-section-heading"><h2>Archived Tasks</h2><span>{archived.length}</span></div>
        {archived.length ? <ul>{archived.map((task) => <li key={task.path}><strong>{task.title}</strong><span>Archived</span><button onClick={() => void window.pilot.setTaskArchived(project.path, task.path, false).then(onChange)}>Restore</button></li>)}</ul> : <p className="muted">No archived Tasks</p>}
      </section>
    </div>}
  </>;
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
  const [projects, setProjects] = useState<ProjectsState>();
  const [showSettings, setShowSettings] = useState(false);
  const [showProjectAccess, setShowProjectAccess] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(() => void Promise.all([window.pilot.getStartupState(), window.pilot.getProjects()]).then(([startup, projectState]) => {
    setState(startup);
    setProjects(projectState);
  }), []);
  const closeSettings = useCallback(() => {
    setShowSettings(false);
    requestAnimationFrame(() => settingsButton.current?.focus());
  }, []);
  const closeProjectAccess = useCallback(() => setShowProjectAccess(false), []);
  const updateProjectAccess = useCallback((next: ProjectsState) => {
    setProjects(next);
    const selected = next.selected;
    if (selected?.executionConsent && (!selected.resourceTrust.required || selected.resourceTrust.decision !== null)) setShowProjectAccess(false);
  }, []);

  useEffect(() => {
    refresh();
    void window.pilot.getPreferences().then((value) => applyAppearance(value.appearance));
  }, []);

  const selectedProject = projects?.selected;
  const needsProjectAccess = Boolean(selectedProject && (!selectedProject.executionConsent || (selectedProject.resourceTrust.required && selectedProject.resourceTrust.decision === null)));

  if (showSettings) return <><div className="window-bar" aria-hidden="true" /><SettingsPage onChange={refresh} onClose={closeSettings} /></>;

  return (
    <>
      <a className="skip-link" href="#content">Skip to content</a>
      <div className="window-bar" aria-hidden="true" />
      <div className="shell">
        <nav aria-label="Projects and tasks" className="navigation">
          <header className="brand">
            <span className="mark" aria-hidden="true">π</span>
            <strong>PiLot</strong>
          </header>
          <div className="nav-heading">
            <span>Projects</span>
            <button aria-label="Add project" title="Add Project" onClick={() => void window.pilot.addProject().then(setProjects)}>+</button>
          </div>
          {projects?.projects.length ? (
            <ul className="project-list">
              {projects.projects.map((project) => (
                <li key={project.path}>
                  <button aria-current={projects.selected?.path === project.path ? "page" : undefined} onClick={() => void window.pilot.selectProject(project.path).then(setProjects)}>
                    <span className="project-icon" aria-hidden="true">◇</span>
                    <span>{project.name}</span>
                    <small>{project.taskCount}</small>
                  </button>
                  {projects.selected?.path === project.path && <ul className="task-nav-list" aria-label={`Active Tasks in ${project.name}`}>
                    {project.tasks.filter(({ lifecycle }) => lifecycle === "active").map((task) => <li key={task.path}>{task.title}</li>)}
                  </ul>}
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
          {selectedProject ? <ProjectPage project={selectedProject} needsAccess={needsProjectAccess} onOpenAccess={() => setShowProjectAccess(true)} onChange={setProjects} /> : <>
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
                <p className="muted">Your provider, shell, and Pi environment are ready.</p>
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
          </>}
        </main>

        <aside aria-label="Inspector" className="inspector">
          <div className="tabs" role="tablist" aria-label="Inspector views">
            <button role="tab" aria-selected="true">Details</button>
            <button role="tab" aria-selected="false" disabled>Changes</button>
            <button role="tab" aria-selected="false" disabled>History</button>
          </div>
          <div className="inspector-body">
            {selectedProject ? needsProjectAccess ? <>
              <p className="eyebrow">Project</p>
              <h2>{selectedProject.name}</h2>
              <p className="muted inspector-note">Complete the open access decision to continue.</p>
            </> : <ProjectAccessPanel project={selectedProject} onChange={updateProjectAccess} /> : <>
              <p className="eyebrow">Startup</p>
              <h2>Readiness</h2>
              <dl>
                <div><dt>Checks passed</dt><dd>{state?.passed ?? "—"} / 3</dd></div>
                <div><dt>Network reporting</dt><dd>Off</dd></div>
              </dl>
            </>}
          </div>
        </aside>
      </div>
      {selectedProject && (needsProjectAccess || showProjectAccess) && <ProjectAccessDialog project={selectedProject} dismissible={!needsProjectAccess} onChange={updateProjectAccess} onClose={closeProjectAccess} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
