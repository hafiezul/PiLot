import { memo, StrictMode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { desktopActions, type DesktopActionId } from "../shared/actions";
import { diagnosticCategories, diagnosticCategoryLabels, type DiagnosticBundle, type DiagnosticCategory } from "../shared/diagnostics";
import type { ApplicationId, ApplicationState, TerminalState } from "../shared/editors";
import { DEFAULT_INSPECTOR_PANE_WIDTH, DEFAULT_NAVIGATION_PANE_WIDTH, MAXIMUM_GLOBAL_RUN_CAP, MAXIMUM_INSPECTOR_PANE_WIDTH, MAXIMUM_NAVIGATION_PANE_WIDTH, MINIMUM_GLOBAL_RUN_CAP, MINIMUM_INSPECTOR_PANE_WIDTH, MINIMUM_NAVIGATION_PANE_WIDTH, MINIMUM_PRIMARY_PANE_WIDTH, type Appearance, type PreferenceInspectorView, type NotificationPreferences, type Preferences, type RecentSelection } from "../shared/preferences";
import type { OAuthEvent, ProviderState } from "../shared/providers";
import { detectSupportedImageMimeType, IMAGE_MIME_LABELS, MAXIMUM_IMAGE_BYTES, MAXIMUM_IMAGES, type ChangedFile, type CommandEvidence, type CompactionEvidence, type DiffLine, type ImageAttachment, type LiveInputMode, type ProjectAccess, type ProjectEnvironmentOverride, type ProjectsState, type RetryEvidence, type RunEvidence, type RunStatus, type TaskChanges, type TaskCreationRequest, type TaskCreationState, type TaskFileDiff, type TaskHistoryNode, type TaskHistoryState, type TaskHistoryTaskResult, type TaskModelState, type TaskResourceState, type TaskRunState, type TaskSetupState, type TaskSummary, type TaskWorktreeState, type ToolEvidence } from "../shared/projects";
import type { StartupState } from "../shared/readiness";
import { AgentSettings } from "./agent-settings";
import { COMPACT_LAYOUT_MEDIA, DEFAULT_PANE_WIDTHS, PaneDivider, constrainedPaneWidths, type PaneName, type PaneShellStyle, type PaneWidths } from "./panes";
import { ProviderIcon } from "./provider-icons";
import "./styles.css";

type TaskAttentionStatus = "running" | "waiting" | "failed" | "interrupted";

function taskRunStatus(task: TaskSummary, state?: TaskRunState): RunStatus | undefined {
  return state?.runs.find(({ id }) => id === state.activeRunId)?.status ?? state?.runs.at(-1)?.status ?? task.runStatus;
}

function taskAttentionStatus(task: TaskSummary, state?: TaskRunState): TaskAttentionStatus | undefined {
  const status = taskRunStatus(task, state);
  if (status === "queued") return "waiting";
  if (status === "preparing" || status === "running" || status === "retrying" || status === "compacting") return "running";
  return status === "failed" || status === "interrupted" ? status : undefined;
}

const taskStatusPresentation: Record<TaskAttentionStatus, { label: string; symbol: string }> = {
  running: { label: "Running", symbol: "▶" },
  waiting: { label: "Waiting", symbol: "◷" },
  failed: { label: "Failed", symbol: "!" },
  interrupted: { label: "Interrupted", symbol: "‖" },
};

function TaskStateIndicator({ status }: { status?: TaskAttentionStatus }) {
  if (!status) return null;
  const presentation = taskStatusPresentation[status];
  return <span className={`task-state task-state-${status}`} aria-label={`Task status: ${presentation.label}`}>
    <span aria-hidden="true">{presentation.symbol}</span><span>{presentation.label}</span>
  </span>;
}

function ProviderSettings({ onChange }: { onChange(): void }) {
  const [state, setState] = useState<ProviderState>();
  const [providerId, setProviderId] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [oauth, setOAuth] = useState<OAuthEvent>();
  const [startingLogin, setStartingLogin] = useState(false);
  const [cancellingLogin, setCancellingLogin] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const flowId = useRef<string | undefined>(undefined);
  const settledFlowId = useRef<string | undefined>(undefined);
  const mounted = useRef(false);

  const applyState = useCallback((next: ProviderState) => {
    setState(next);
    setProviderId((current) => next.activeLogin?.providerId
      ?? (next.providers.some(({ id }) => id === current) ? current : next.providers.find(({ configured }) => configured)?.id ?? next.providers[0]?.id ?? ""));
  }, []);

  useEffect(() => {
    mounted.current = true;
    void window.pilot.getProviderState().then((next) => {
      if (!mounted.current) return;
      flowId.current = next.activeLogin?.id;
      applyState(next);
    });
    const stopListening = window.pilot.onOAuthEvent((event) => {
      if (event.type === "started") {
        flowId.current = event.flowId;
        setStartingLogin(false);
        setOAuth(undefined);
        setMessage("");
        setError("");
        setState((current) => current ? { ...current, activeLogin: { id: event.flowId, providerId: event.providerId, providerName: event.providerName } } : current);
        return;
      }
      if (event.flowId !== flowId.current) return;
      if (event.type === "success" || event.type === "failure" || event.type === "cancelled") {
        settledFlowId.current = event.flowId;
        flowId.current = undefined;
        setStartingLogin(false);
        setCancellingLogin(false);
        setOAuth(undefined);
        setState((current) => {
          if (!current || current.activeLogin?.id !== event.flowId) return current;
          const { activeLogin: _activeLogin, ...idle } = current;
          return idle;
        });
        if (event.type === "success") {
          void window.pilot.getProviderState().then((next) => {
            if (!mounted.current) return;
            applyState(next);
            setMessage(`Signed in to ${event.providerName}`);
            setError("");
            onChange();
          }).catch((reason) => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); });
        } else if (event.type === "failure") {
          setMessage("");
          setError(event.message);
        } else {
          setMessage("Authentication cancelled");
          setError("");
        }
        return;
      }
      setOAuth(event);
    });
    return () => {
      mounted.current = false;
      stopListening();
      const activeFlowId = flowId.current;
      flowId.current = undefined;
      if (activeFlowId) void window.pilot.cancelLogin(activeFlowId);
    };
  }, [applyState, onChange]);

  const provider = state?.providers.find(({ id }) => id === providerId);
  const activeLogin = state?.activeLogin;
  const loginBusy = startingLogin || Boolean(activeLogin);
  const update = (next: ProviderState, notice: string) => {
    applyState(next);
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
  const startLogin = async () => {
    if (!provider || loginBusy) return;
    setStartingLogin(true);
    setOAuth(undefined);
    setMessage("");
    setError("");
    try {
      const next = await window.pilot.login(provider.id);
      if (!mounted.current) {
        if (next.activeLogin) await window.pilot.cancelLogin(next.activeLogin.id).catch(() => undefined);
        return;
      }
      if (next.activeLogin?.id === settledFlowId.current) return;
      flowId.current = next.activeLogin?.id;
      applyState(next);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setStartingLogin(false);
    }
  };
  const cancelAuthentication = async () => {
    if (!activeLogin || cancellingLogin) return;
    setCancellingLogin(true);
    setError("");
    try {
      const next = await window.pilot.cancelLogin(activeLogin.id);
      if (flowId.current === activeLogin.id) flowId.current = undefined;
      applyState(next);
      setOAuth(undefined);
      setMessage("Authentication cancelled");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCancellingLogin(false);
    }
  };
  const reply = (event: Extract<OAuthEvent, { type: "prompt" | "select" }> | Extract<OAuthEvent, { type: "auth"; manualInput: true }>, value?: string) => {
    void window.pilot.respondToOAuth(event.flowId, event.requestId, value).then((accepted) => {
      if (!accepted) setError("That authentication request is no longer active.");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  if (!state) return <section className="provider-setup" aria-label="Provider authentication"><p role="status">Loading providers…</p></section>;

  const providerModels = state.models.filter((model) => model.provider === providerId);
  return (
    <section className="provider-setup" aria-label="Provider authentication" aria-busy={startingLogin || cancellingLogin}>
      <div className="setup-heading">
        <div><p className="eyebrow">Pi environment</p><h2>Provider authentication</h2></div>
        <div className="setup-controls"><span className="muted">Secrets stay in Pi's credential store.</span><button disabled={loginBusy} onClick={() => void attempt(() => window.pilot.getProviderState(), "Providers refreshed")}>Refresh providers</button></div>
      </div>
      <ul className="credential-summary" aria-label="Detected credentials">
        {state.providers.filter(({ configured }) => configured).map((item) => <li key={item.id}><span>{item.name}</span><small>{item.sourceLabel}</small></li>)}
      </ul>

      <label>Provider
        <select aria-label="Provider" value={providerId} disabled={loginBusy} onChange={(event) => { setProviderId(event.target.value); setEditingKey(false); setMessage(""); }}>
          {state.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>

      {provider && <>
        <div className="provider-detail">
          <div><strong>{provider.name}</strong><span className={provider.configured ? "connected" : "muted"}>{provider.sourceLabel ?? "Not configured"}</span><span className="muted">{providerModels.length} model{providerModels.length === 1 ? "" : "s"} available</span></div>
          <div className="actions">
            <button disabled={loginBusy} onClick={() => setEditingKey(true)}>{provider.credentialType === "api_key" ? "Replace API key" : "Add API key"}</button>
            {provider.credentialType === "api_key" && <button disabled={loginBusy} onClick={() => void attempt(() => window.pilot.removeApiKey(provider.id), "API key removed")}>Remove API key</button>}
            {provider.supportsOAuth && <button disabled={loginBusy} onClick={() => void startLogin()}>{provider.credentialType === "oauth" ? "Reauthenticate" : "Use subscription"}</button>}
            {provider.credentialType === "oauth" && <button disabled={loginBusy} onClick={() => void attempt(() => window.pilot.logout(provider.id), "Logged out")}>Log out</button>}
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
        <label>API key for {provider.name}<input name="key" aria-label={`API key for ${provider.name}`} type="password" autoComplete="off" required autoFocus disabled={loginBusy} /></label>
        <button type="submit" disabled={loginBusy}>Save API key</button>
        <button type="button" disabled={loginBusy} onClick={() => setEditingKey(false)}>Cancel</button>
      </form>}

      {(startingLogin || activeLogin) && <div className="provider-login-status">
        <p role="status" aria-label="Authentication status">{activeLogin
          ? `Authentication in progress for ${activeLogin.providerName}. Only one provider can sign in at a time.`
          : `Starting authentication for ${provider?.name ?? "provider"}…`}</p>
        {activeLogin && <button type="button" disabled={cancellingLogin} onClick={() => void cancelAuthentication()}>{cancellingLogin ? "Cancelling…" : "Cancel authentication"}</button>}
      </div>}

      {oauth && oauth.type !== "started" && oauth.type !== "success" && oauth.type !== "failure" && oauth.type !== "cancelled" && <div className="oauth-flow" role="region" aria-label={`${oauth.providerName} authentication`}>
        <strong>{oauth.providerName}</strong>
        {oauth.type === "device_code" && <><p>Enter this code in your browser:</p><code>{oauth.userCode}</code></>}
        {oauth.type === "auth" && <p>{oauth.instructions ?? "Finish signing in in your browser."}</p>}
        {oauth.type === "progress" && <p>{oauth.message}</p>}
        {(oauth.type === "prompt" || (oauth.type === "auth" && oauth.manualInput)) && <form onSubmit={(formEvent) => {
          formEvent.preventDefault();
          const value = String(new FormData(formEvent.currentTarget).get("oauth") ?? "");
          reply(oauth, value);
          formEvent.currentTarget.reset();
        }}>
          <label>{oauth.type === "prompt" ? oauth.message : "Paste the redirect URL if the browser does not return automatically"}
            <input name="oauth" type="password" autoComplete="off" placeholder={oauth.type === "prompt" ? oauth.placeholder : undefined} required={oauth.type === "prompt" ? !oauth.allowEmpty : true} />
          </label><button type="submit">Continue</button>
        </form>}
        {oauth.type === "select" && <div><p>{oauth.message}</p>{oauth.options.map((option) => <button type="button" key={option.id} onClick={() => reply(oauth, option.id)}>{option.label}</button>)}</div>}
      </div>}

      {message && <p className="success" role="status" aria-label="Authentication status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

function ProjectEnvironmentEditor({ project, onChange }: { project: ProjectAccess; onChange(state: ProjectsState): void }) {
  const savedKey = JSON.stringify(project.environmentOverrides);
  const [overrides, setOverrides] = useState<ProjectEnvironmentOverride[]>(project.environmentOverrides);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setOverrides(project.environmentOverrides);
    setError("");
  }, [project.path, savedKey]);
  const normalized = overrides.map(({ name, value }) => ({ name: name.trim(), value }));
  const names = normalized.map(({ name }) => window.pilot.platform === "win32" ? name.toLocaleLowerCase() : name);
  const valid = normalized.every(({ name }) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) && new Set(names).size === names.length;
  const showValidationError = !valid && normalized.some(({ name }) => name.length > 0);
  const changed = JSON.stringify(normalized) !== savedKey;
  const update = (index: number, field: keyof ProjectEnvironmentOverride, value: string) => {
    setOverrides((current) => current.map((override, item) => item === index ? { ...override, [field]: value } : override));
    setError("");
  };
  const save = () => {
    if (busy || !changed || !valid) return;
    setBusy(true);
    setError("");
    void window.pilot.setProjectEnvironment(project.path, normalized).then(onChange).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setBusy(false));
  };

  return <section className="project-environment" aria-label="Project environment overrides">
    <div className="access-heading">
      <div><h3>Project environment</h3><p>Overrides the login-shell environment captured when PiLot opened. Changes apply to future agent tools, inline commands, and Worktree setup.</p></div>
      <span className="access-status" role="status">{project.environmentOverrides.length} saved</span>
    </div>
    <p className="decision-source">Values stay in PiLot's local Project settings; they do not modify shell files, the Project, or Pi settings.</p>
    {overrides.length ? <ul className="project-environment-list" aria-label="Environment variables">
      {overrides.map((override, index) => <li key={index}>
        <label><span>Name</span><input aria-label="Variable name" value={override.name} maxLength={128} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => update(index, "name", event.target.value)} /></label>
        <label><span>Value</span><input aria-label="Variable value" value={override.value} maxLength={32768} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => update(index, "value", event.target.value)} /></label>
        <button type="button" aria-label={`Remove ${override.name.trim() || "variable"}`} disabled={busy} onClick={() => { setOverrides((current) => current.filter((_, item) => item !== index)); setError(""); }}>Remove</button>
      </li>)}
    </ul> : <p className="project-environment-empty">No Project overrides. Runs use the environment captured at launch.</p>}
    {showValidationError && <p className="error project-environment-error" role="alert">Use unique variable names beginning with a letter or underscore; only letters, numbers, and underscores are allowed.</p>}
    {error && <p className="error project-environment-error" role="alert">{error}</p>}
    <div className="project-environment-actions">
      <button type="button" disabled={busy || overrides.length >= 128} onClick={() => setOverrides((current) => [...current, { name: "", value: "" }])}>Add variable</button>
      <button type="button" className="primary-action" disabled={busy || !changed || !valid} onClick={save}>{busy ? "Saving…" : "Save environment"}</button>
    </div>
  </section>;
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
    {project.admitted && <ProjectEnvironmentEditor project={project} onChange={onChange} />}
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

function TaskCreationDialog({ project, state, contextNote, onCreate, onClose }: {
  project: ProjectAccess;
  state: TaskCreationState;
  contextNote?: string;
  onCreate(request: TaskCreationRequest): Promise<void>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const refListId = useId();
  const [kind, setKind] = useState<"local" | "worktree">("local");
  const [ref, setRef] = useState(state.defaultRef ?? "");
  const [setupCommand, setSetupCommand] = useState(project.resourceTrust.decision === true ? state.setupCommand : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await onCreate(kind === "local" ? { kind } : { kind, ref, setupCommand: setupCommand.trim() || undefined }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <dialog ref={dialog} className="task-creation-dialog" aria-labelledby="task-creation-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header><h2 id="task-creation-title">Create Task</h2><p>Choose where this Task can read and change files in {project.name} before its first Run.</p></header>
      {contextNote && <p className="task-creation-note" role="note">{contextNote}</p>}
      <fieldset disabled={busy}>
        <legend>Execution location</legend>
        <label><input type="radio" name="execution" checked={kind === "local"} onChange={() => setKind("local")} /><span><strong>Local</strong><small>Use the Project's current checkout.</small></span></label>
        <label><input type="radio" name="execution" checked={kind === "worktree"} disabled={!state.defaultRef} onChange={() => setKind("worktree")} /><span><strong>Worktree</strong><small>{state.defaultRef ? "Create an isolated checkout for this Task." : "Commit the Project before creating a worktree."}</small></span></label>
      </fieldset>
      {kind === "worktree" && <section className="worktree-options" aria-label="Worktree options">
        <label>Branch or commit
          <input list={refListId} value={ref} autoFocus disabled={busy} onChange={(event) => setRef(event.target.value)} placeholder="Branch name or commit SHA" required />
          <datalist id={refListId}>{state.refs.map((item) => <option key={`${item.value}:${item.label}`} value={item.value}>{item.label}</option>)}</datalist>
        </label>
        <p className="worktree-boundary" role="note"><strong>Committed files only.</strong> Dirty, untracked, and ignored files in Local are excluded.</p>
        {state.dirty && <p className="worktree-dirty" role="status">Local currently has uncommitted files. They will remain only in Local.</p>}
        <label>Project setup command <span className="optional">Optional</span>
          <textarea value={setupCommand} rows={3} maxLength={20000} aria-label="Project setup command" disabled={busy || project.resourceTrust.decision !== true} onChange={(event) => setSetupCommand(event.target.value)} placeholder={project.resourceTrust.decision === true ? "For example: npm ci" : "Trust Project resources to enable setup"} />
          <small>{project.resourceTrust.decision === true ? "Saved for this Project. PiLot never infers setup, and runs this only when you choose Run setup." : "Setup commands require trusted Project resources."}</small>
        </label>
      </section>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-action" disabled={busy || (kind === "worktree" && !ref.trim())}>{busy ? "Creating…" : kind === "worktree" ? "Create Worktree Task" : "Create Local Task"}</button></footer>
    </form>
  </dialog>;
}

function ProjectActions({ project, onOpenAccess, onChange, onActionStart, onError }: { project: ProjectAccess; onOpenAccess(): void; onChange(state: ProjectsState): void; onActionStart(): void; onError(reason: unknown, recovery: string): void }) {
  const details = useRef<HTMLDetailsElement>(null);
  const close = () => details.current?.removeAttribute("open");
  return <details ref={details} className="project-actions" onToggle={(event) => {
    const menu = event.currentTarget;
    if (menu.open) requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
  }} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) close();
  }} onKeyDown={(event) => {
    if (event.key === "Escape") {
      close();
      details.current?.querySelector("summary")?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  }}>
    <summary role="button" aria-label="Project actions" title="Project actions">•••</summary>
    <div className="project-actions-menu" role="menu" aria-label="Project actions">
      <button role="menuitem" onClick={() => { close(); onOpenAccess(); }}>Project access</button>
      <button role="menuitem" onClick={() => { close(); onActionStart(); void window.pilot.removeProject(project.path).then(onChange).catch((reason) => onError(reason, "Check Project access and try removing it again.")); }}>Remove Project</button>
    </div>
  </details>;
}

function CompleteOutput({ path }: { path?: string }) {
  const [error, setError] = useState("");
  if (!path) return null;
  return <><button className="output-link" onClick={() => {
    setError("");
    void window.pilot.openOutput(path).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }}>Open complete output</button>{error && <p className="error" role="alert">{error}</p>}</>;
}

function CommandBlock({ item }: { item: CommandEvidence }) {
  const status = item.status === "queued" ? "Waiting" : item.status[0].toUpperCase() + item.status.slice(1);
  return <section className={`command-block ${item.status}`} role="region" aria-label={`Command: ${item.command}`}>
    <header><code>$ {item.command}</code><span>{status}</span></header>
    <p className="context-semantics">{item.includeInContext ? "Included in next Pi context" : "Local only — not sent to Pi"}</p>
    {item.output && <pre tabIndex={0} aria-label="Command output">{item.output}</pre>}
    {item.outputTruncated && <p className="output-bound">Output is bounded in the timeline.</p>}
    <CompleteOutput path={item.fullOutputPath} />
  </section>;
}

function ToolBlock({ item, changePaths, onOpenChange }: { item: ToolEvidence; changePaths: string[]; onOpenChange(path: string): void }) {
  const status = item.status === "succeeded" ? "Succeeded" : item.status === "failed" ? "Failed" : item.status === "interrupted" ? "Interrupted" : "Running";
  return <div className="tool-record">
    <details key={`${item.id}-${item.status}`} className={`tool-evidence ${item.status}`} aria-label={`${item.name} tool, ${item.status}`} open={item.status !== "succeeded" || undefined}>
      <summary><span>{item.summary}</span><span>{status}</span></summary>
      <div className="evidence-detail">
        <h4>Input</h4><pre tabIndex={0}>{item.input}</pre>
        <h4>Output</h4>{item.output ? <pre tabIndex={0}>{item.output}</pre> : <p className="muted">No output yet.</p>}
        {item.details && <><h4>Details</h4><pre tabIndex={0}>{item.details}</pre></>}
        {item.outputTruncated && <p className="output-bound">Output is bounded in the timeline.</p>}
        <CompleteOutput path={item.fullOutputPath} />
      </div>
    </details>
    {item.status === "succeeded" && item.changedFiles?.filter((file) => changePaths.includes(file)).map((file) => <button key={file} type="button" className="tool-change-link" onClick={() => onOpenChange(file)}>Review {file} in Changes</button>)}
  </div>;
}

function RetryBlock({ item }: { item: RetryEvidence }) {
  const waiting = item.status === "waiting";
  return <section className={`lifecycle-evidence retry-evidence ${item.status}`} aria-label={`Provider retry ${item.status}`}>
    <header><strong>{waiting ? "Retrying" : item.status === "succeeded" ? "Retry succeeded" : "Retry failed"}</strong><span>{waiting ? "Waiting" : item.status === "succeeded" ? "Succeeded" : "Failed"}</span></header>
    <p>Attempt {item.attempt} of {item.maxAttempts} · retrying in {item.delayMs < 1000 ? `${item.delayMs} ms` : `${item.delayMs / 1000} s`}</p>
    <p>{item.finalError ?? item.error}</p>
  </section>;
}

function CompactionBlock({ item }: { item: CompactionEvidence }) {
  const title = item.reason === "manual" ? "Manual compaction" : item.reason === "threshold" ? "Threshold compaction" : "Overflow recovery";
  const status = item.status[0].toUpperCase() + item.status.slice(1);
  return <details className={`lifecycle-evidence compaction-evidence ${item.status}`} open={item.status !== "succeeded" || undefined}>
    <summary><strong>{item.status === "failed" ? "Compaction failed" : title}</strong><span>{status}</span></summary>
    <div>
      <p>{title}</p>
      {item.tokensBefore !== undefined && <p>{item.tokensBefore.toLocaleString()} tokens before{item.estimatedTokensAfter === undefined ? "" : ` · about ${item.estimatedTokensAfter.toLocaleString()} after`}.</p>}
      {item.summary && <pre tabIndex={0}>{item.summary}</pre>}
      {item.error && <p className="error">{item.error}</p>}
      {item.status === "succeeded" && <p>Full Task history remains in the Pi session.</p>}
    </div>
  </details>;
}

const RunBlock = memo(function RunBlock({ run, index, expandThinking, changePaths, onOpenChange }: { run: RunEvidence; index: number; expandThinking: boolean; changePaths: string[]; onOpenChange(path: string): void }) {
  const status = run.status === "queued" ? "Waiting" : run.status[0].toUpperCase() + run.status.slice(1);
  const title = run.input.kind === "command" ? "Inline command" : run.input.kind === "compaction" ? "Context compaction" : "Agent run";
  return <article className={`run-evidence ${run.status}`} aria-labelledby={`run-${run.id}`}>
    <header className="run-heading">
      <div><span className="run-number">Run {index + 1}</span><h3 id={`run-${run.id}`}>{title}</h3></div>
      <span className={`run-status ${run.status}`} aria-label={`Run status: ${status}`}>{status}</span>
    </header>
    {run.input.kind === "prompt" && <section className="accepted-input" aria-label="Accepted input"><span>You</span><p>{run.input.text}</p></section>}
    <div className="run-items">
      {run.items.map((item) => {
        if (item.kind === "assistant") return <div className="assistant-evidence" key={item.id}>
          {item.thinking && <details key={`${item.id}-${expandThinking}`} className="thinking-evidence" aria-label="Thinking" open={expandThinking || undefined}>
            <summary>Thinking</summary><p>{item.thinking}</p>
          </details>}
          {item.text && <div className="assistant-text"><span>Pi</span><p>{item.text}</p></div>}
        </div>;
        if (item.kind === "tool") return <ToolBlock key={item.id} item={item} changePaths={changePaths} onOpenChange={onOpenChange} />;
        if (item.kind === "command") return <CommandBlock key={item.id} item={item} />;
        if (item.kind === "retry") return <RetryBlock key={item.id} item={item} />;
        if (item.kind === "compaction") return <CompactionBlock key={item.id} item={item} />;
        return <details key={item.id} className={`run-notice ${item.tone}`} open>
          <summary>{item.title}</summary>{item.detail && <p>{item.detail}</p>}
        </details>;
      })}
    </div>
  </article>;
});

const RunList = memo(function RunList({ runs, expandThinking, changePaths, onOpenChange }: { runs: RunEvidence[]; expandThinking: boolean; changePaths: string[]; onOpenChange(path: string): void }) {
  return runs.map((run, index) => <RunBlock key={run.id} run={run} index={index} expandThinking={expandThinking} changePaths={changePaths} onOpenChange={onOpenChange} />);
});

type InspectorView = PreferenceInspectorView;
type DiffRow = { kind: "hunk"; text: string } | { kind: "line"; line: DiffLine };

const changeStatusLabels: Record<ChangedFile["status"], string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "type-changed": "Type changed",
  unmerged: "Unmerged",
  untracked: "Untracked",
};

function InspectorTabs({ selected, changeCount, historyPaths, onSelect }: { selected: InspectorView; changeCount: number; historyPaths: number; onSelect(view: InspectorView): void }) {
  const tabs: Array<{ id: InspectorView; label: string }> = [{ id: "details", label: "Details" }, { id: "changes", label: "Changes" }, { id: "history", label: "History" }];
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, direction: number) => {
    const index = tabs.findIndex(({ id }) => id === selected);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    onSelect(next.id);
    requestAnimationFrame(() => document.getElementById(`inspector-${next.id}-tab`)?.focus());
    event.preventDefault();
  };
  return <div className="tabs" role="tablist" aria-label="Inspector views">
    {tabs.map(({ id, label }) => <button key={id} id={`inspector-${id}-tab`} role="tab" data-action={id === "details" ? "view.details" : undefined} aria-controls={`inspector-${id}-panel`} aria-selected={selected === id} aria-label={id === "changes" ? `Changes, ${changeCount} changed file${changeCount === 1 ? "" : "s"}` : id === "history" ? `History, ${historyPaths} active path${historyPaths === 1 ? "" : "s"}` : label} tabIndex={selected === id ? 0 : -1} onClick={() => onSelect(id)} onKeyDown={(event) => {
      if (event.key === "ArrowLeft") move(event, -1);
      else if (event.key === "ArrowRight") move(event, 1);
      else if (event.key === "Home") move(event, -tabs.findIndex(({ id: value }) => value === selected));
      else if (event.key === "End") move(event, tabs.length - 1 - tabs.findIndex(({ id: value }) => value === selected));
    }}><span>{label}</span>{id === "changes" && changeCount > 0 && <span className="tab-badge" aria-hidden="true">{changeCount}</span>}{id === "history" && historyPaths > 1 && <span className="tab-badge" aria-hidden="true">{historyPaths}</span>}</button>)}
  </div>;
}

function VirtualDiff({ diff }: { diff: TaskFileDiff }) {
  const rows = useMemo<DiffRow[]>(() => diff.hunks.flatMap((hunk) => [
    { kind: "hunk" as const, text: hunk.header },
    ...hunk.lines.map((line) => ({ kind: "line" as const, line })),
  ]), [diff]);
  const grid = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, "");
  const rowHeight = 23;
  const overscan = 10;
  const [viewport, setViewport] = useState({ top: 0, height: 360 });
  const [active, setActive] = useState(0);
  const activeRow = Math.max(0, Math.min(active, rows.length - 1));

  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    element.scrollTop = 0;
    setActive(0);
    setViewport({ top: 0, height: element.clientHeight || 360 });
    const observer = new ResizeObserver(() => setViewport((current) => ({ ...current, height: element.clientHeight || 360 })));
    observer.observe(element);
    return () => observer.disconnect();
  }, [diff.path]);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const top = Math.min(element.scrollTop, Math.max(0, rows.length * rowHeight - element.clientHeight));
    if (top !== element.scrollTop) element.scrollTop = top;
    setViewport({ top, height: element.clientHeight || 360 });
    setActive((current) => Math.max(0, Math.min(current, rows.length - 1)));
  }, [rows.length]);

  const first = rows.length ? Math.min(rows.length - 1, Math.max(0, Math.floor(viewport.top / rowHeight) - overscan)) : 0;
  const last = Math.min(rows.length, Math.max(first + 1, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan));
  const move = (next: number) => {
    const index = Math.max(0, Math.min(rows.length - 1, next));
    const element = grid.current;
    setActive(index);
    if (!element) return;
    let top = element.scrollTop;
    if (index * rowHeight < top) top = index * rowHeight;
    else if ((index + 1) * rowHeight > top + element.clientHeight) top = (index + 1) * rowHeight - element.clientHeight;
    if (top !== element.scrollTop) element.scrollTop = top;
    setViewport({ top, height: element.clientHeight || viewport.height });
  };
  const lineLabel = (line: DiffLine) => line.kind === "addition"
    ? `Added line ${line.newLine}: ${line.text || "blank line"}`
    : line.kind === "deletion" ? `Deleted line ${line.oldLine}: ${line.text || "blank line"}`
      : line.kind === "context" ? `Unchanged line ${line.newLine}: ${line.text || "blank line"}` : line.text;

  return <div ref={grid} className="diff-grid" role="grid" aria-label={`Unified diff for ${diff.path}`} aria-rowcount={rows.length} aria-colcount={3} aria-activedescendant={rows.length ? `${id}-row-${activeRow}` : undefined} tabIndex={0} onScroll={(event) => {
    const { scrollTop: top, clientHeight: height } = event.currentTarget;
    const visibleFirst = Math.floor(top / rowHeight);
    const visibleLast = Math.max(visibleFirst, Math.ceil((top + height) / rowHeight) - 1);
    setViewport({ top, height });
    setActive((current) => current < visibleFirst || current > visibleLast ? visibleFirst : current);
  }} onKeyDown={(event) => {
    if (!rows.length) return;
    if (event.key === "ArrowDown") move(activeRow + 1);
    else if (event.key === "ArrowUp") move(activeRow - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(rows.length - 1);
    else if (event.key === "PageDown") move(activeRow + Math.max(1, Math.floor(viewport.height / rowHeight)));
    else if (event.key === "PageUp") move(activeRow - Math.max(1, Math.floor(viewport.height / rowHeight)));
    else return;
    event.preventDefault();
  }}>
    <div role="presentation" style={{ height: first * rowHeight }} />
    {rows.slice(first, last).map((row, offset) => {
      const index = first + offset;
      if (row.kind === "hunk") return <div key={index} id={`${id}-row-${index}`} className="diff-row diff-hunk" role="row" aria-rowindex={index + 1} aria-selected={activeRow === index} aria-label={`Diff hunk ${row.text}`} onClick={() => setActive(index)}>
        <span role="gridcell" aria-colspan={3}>{row.text}</span>
      </div>;
      const { line } = row;
      return <div key={index} id={`${id}-row-${index}`} className={`diff-row diff-${line.kind}`} role="row" aria-rowindex={index + 1} aria-selected={activeRow === index} aria-label={lineLabel(line)} onClick={() => setActive(index)}>
        <span className="diff-line-number" role="gridcell" aria-label={line.oldLine === undefined ? "No old line" : `Old line ${line.oldLine}`}>{line.oldLine ?? ""}</span>
        <span className="diff-line-number" role="gridcell" aria-label={line.newLine === undefined ? "No new line" : `New line ${line.newLine}`}>{line.newLine ?? ""}</span>
        <code role="gridcell"><span className="diff-marker" aria-hidden="true">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span>{line.text}</code>
      </div>;
    })}
    <div role="presentation" style={{ height: Math.max(0, rows.length - last) * rowHeight }} />
  </div>;
}

function ApplicationOpenControl({ targetLabel, state, disabled = false, onOpen }: {
  targetLabel: string;
  state?: ApplicationState;
  disabled?: boolean;
  onOpen(application: ApplicationId): void;
}) {
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeApplication, setActiveApplication] = useState<ApplicationId>();
  const preferred = state?.available.find(({ id }) => id === state.preferred);
  const action = preferred?.kind === "file-manager" ? "Show" : "Open";
  const close = () => {
    if (picker.current?.matches(":popover-open")) picker.current.hidePopover();
    trigger.current?.focus();
  };
  const show = () => {
    if (!picker.current || !trigger.current || disabled || !state?.available.length) return;
    placePicker(picker.current, trigger.current, 220, true);
    const active = state.preferred ?? state.available[0].id;
    setActiveApplication(active);
    if (!picker.current.matches(":popover-open")) picker.current.showPopover();
    requestAnimationFrame(() => picker.current?.querySelector<HTMLElement>(`[data-application-id="${active}"]`)?.focus());
  };
  const move = (event: React.KeyboardEvent, direction: number) => {
    const options = [...(picker.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const index = options.indexOf(event.currentTarget as HTMLElement);
    options[(index + direction + options.length) % options.length]?.focus();
    event.preventDefault();
  };
  const unavailable = state && !state.available.length;
  const applications = state?.available ?? [];

  return <div className="editor-open-control" role="group" aria-label={`Open ${targetLabel} externally`}>
    <button type="button" className="editor-open-primary" aria-label={preferred ? `${action} ${targetLabel} in ${preferred.label}` : unavailable ? "No supported applications found" : "Finding installed applications"} disabled={disabled || !preferred} onClick={() => preferred && onOpen(preferred.id)}>
      {preferred ? <>{action} in <strong>{preferred.label}</strong></> : unavailable ? "No apps found" : "Finding apps…"}
    </button>
    <button ref={trigger} type="button" className="editor-open-picker" aria-label={`Choose application for ${targetLabel}`} aria-haspopup="menu" aria-expanded={pickerOpen} disabled={disabled || !state?.available.length} onClick={show}><span aria-hidden="true">⌄</span></button>
    <div ref={picker} popover="auto" className="model-picker-popover editor-picker-popover" role="menu" aria-label="Applications" onToggle={(event) => setPickerOpen(event.currentTarget.matches(":popover-open"))} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") { picker.current?.hidePopover(); trigger.current?.focus(); }
    }}>
      {applications.map((application, index) => <button key={application.id} type="button" role="menuitemradio" data-application-id={application.id} aria-checked={application.id === state?.preferred} tabIndex={application.id === activeApplication ? 0 : -1} onFocus={() => setActiveApplication(application.id)} onClick={() => { onOpen(application.id); close(); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown") move(event, 1);
        if (event.key === "ArrowUp") move(event, -1);
        if (event.key === "Home") move(event, -index);
        if (event.key === "End") move(event, applications.length - 1 - index);
      }}><span>{application.label}</span>{application.id === state?.preferred && <span aria-hidden="true">✓</span>}</button>)}
    </div>
  </div>;
}

function WorktreeRemovalDialog({ project, task, worktree, onClose, onRemoved }: {
  project: ProjectAccess;
  task: TaskSummary;
  worktree: TaskWorktreeState;
  onClose(): void;
  onRemoved(state: ProjectsState): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = worktree.files.length > 0;
  useEffect(() => {
    dialog.current?.showModal();
    return () => { if (dialog.current?.open) dialog.current.close(); };
  }, []);
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await window.pilot.removeTaskWorktree(project.path, task.path, dirty, worktree.files);
      onClose();
      onRemoved(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
      requestAnimationFrame(() => removeButton.current?.focus());
    }
  };
  const action = dirty ? `Discard ${worktree.files.length} file${worktree.files.length === 1 ? "" : "s"} and remove worktree` : "Remove worktree";

  return <dialog ref={dialog} className="worktree-removal-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); void remove(); }}>
      <header><h2 id={titleId}>Remove managed worktree</h2><p>Removing deletes the managed Execution location and archives the Task. Task history remains, but this Task cannot run or be restored after removal.</p></header>
      {dirty ? <>
        <p className="worktree-removal-warning"><strong>These uncommitted changes will be permanently discarded.</strong> Review them before continuing.</p>
        <ul className="worktree-removal-files" aria-label="Files that will be discarded">
          {worktree.files.map((file) => <li key={`${file.previousPath ?? ""}:${file.path}`}><span>{changeStatusLabels[file.status]}</span><code>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</code></li>)}
        </ul>
      </> : <p className="worktree-removal-clean">Git reports a clean working tree. Any named branch and its commits remain in the Project.</p>}
      <p className="worktree-removal-note">All files inside this managed worktree are deleted, including ignored build or dependency files. Nothing is applied to Local. If detached HEAD contains new commits, create a branch first.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <footer><button type="button" autoFocus disabled={busy} onClick={onClose}>Cancel</button><button ref={removeButton} type="submit" className="danger-action" disabled={busy}>{busy ? "Removing…" : action}</button></footer>
    </form>
  </dialog>;
}

function WorktreeActions({ project, task, disabled, onRemoved }: {
  project: ProjectAccess;
  task: TaskSummary;
  disabled: boolean;
  onRemoved(state: ProjectsState): void;
}) {
  const branchTrigger = useRef<HTMLButtonElement>(null);
  const terminalTrigger = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<TaskWorktreeState>();
  const [branching, setBranching] = useState(false);
  const [branch, setBranch] = useState("");
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setError("");
      void window.pilot.getTaskWorktree(project.path, task.path).then((next) => { if (!cancelled) setState(next); })
        .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    };
    setState(undefined);
    load();
    window.addEventListener("focus", load);
    return () => { cancelled = true; window.removeEventListener("focus", load); };
  }, [project.path, task.path]);

  const createBranch = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await window.pilot.createTaskWorktreeBranch(project.path, task.path, branch);
      setState(next);
      setBranching(false);
      setBranch("");
      setNotice(`Created branch ${next.branch}`);
      requestAnimationFrame(() => terminalTrigger.current?.focus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const openTerminal = async () => {
    setError("");
    setNotice("");
    try { await window.pilot.openTaskWorktreeTerminal(project.path, task.path); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const openRemoval = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setState(await window.pilot.getTaskWorktree(project.path, task.path));
      setRemoving(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const closeRemoval = () => {
    setRemoving(false);
    requestAnimationFrame(() => removeTrigger.current?.focus());
  };

  return <section className="worktree-actions" aria-label="Worktree actions">
    <div className="worktree-action-row">
      <span className="worktree-branch-status" role="status" aria-label="Branch status">{state ? state.branch ? `On branch ${state.branch}` : `Detached at ${state.head.slice(0, 8)}` : "Reading branch…"}</span>
      <div>
        {!state?.branch && !branching && <button ref={branchTrigger} type="button" disabled={disabled || busy || !state} onClick={() => { setBranching(true); setError(""); setNotice(""); }}>Create branch</button>}
        <button ref={terminalTrigger} type="button" disabled={busy} onClick={() => void openTerminal()}>Open in terminal</button>
        <button ref={removeTrigger} type="button" className="worktree-remove-trigger" disabled={disabled || busy || !state} onClick={() => void openRemoval()}>Remove worktree</button>
      </div>
    </div>
    {branching && <form className="worktree-branch-form" onSubmit={(event) => { event.preventDefault(); void createBranch(); }}>
      <label>New branch name<input value={branch} maxLength={255} autoFocus disabled={busy} required onChange={(event) => setBranch(event.target.value)} /></label>
      <div><button type="submit" disabled={busy || !branch.trim()}>Create branch</button><button type="button" disabled={busy} onClick={() => { setBranching(false); setBranch(""); requestAnimationFrame(() => branchTrigger.current?.focus()); }}>Cancel</button></div>
    </form>}
    {disabled && <p className="worktree-action-note">Stop the active Run or resolve external Task changes before changing this Worktree.</p>}
    {notice && <p className="success worktree-action-note" role="status">{notice}</p>}
    {error && <p className="error worktree-action-note" role="alert">{error}</p>}
    {removing && state && <WorktreeRemovalDialog project={project} task={task} worktree={state} onClose={closeRemoval} onRemoved={onRemoved} />}
  </section>;
}

function ChangesPanel({ project, task, changes, loadError, selectedPath, disabled, onSelect, onWorktreeRemoved }: {
  project: ProjectAccess;
  task: TaskSummary;
  changes?: TaskChanges;
  loadError: string;
  selectedPath?: string;
  disabled: boolean;
  onSelect(path: string): void;
  onWorktreeRemoved(state: ProjectsState): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [diff, setDiff] = useState<TaskFileDiff>();
  const [diffError, setDiffError] = useState("");
  const [openError, setOpenError] = useState("");
  const [applicationError, setApplicationError] = useState("");
  const [applicationState, setApplicationState] = useState<ApplicationState>();
  const selected = changes?.files.find(({ path }) => path === selectedPath);

  useEffect(() => {
    let cancelled = false;
    setApplicationState(undefined);
    const loadApplications = () => {
      setApplicationError("");
      void window.pilot.getApplicationState(project.path, task.path).then((state) => {
        if (!cancelled) setApplicationState(state);
      }).catch((reason) => {
        if (!cancelled) { setApplicationState(undefined); setApplicationError(reason instanceof Error ? reason.message : String(reason)); }
      });
    };
    loadApplications();
    window.addEventListener("focus", loadApplications);
    return () => { cancelled = true; window.removeEventListener("focus", loadApplications); };
  }, [project.path, task.path]);

  useEffect(() => {
    let cancelled = false;
    setDiffError("");
    if (!selected) { setDiff(undefined); return; }
    setDiff((current) => current?.path === selected.path ? current : undefined);
    void window.pilot.getTaskFileDiff(project.path, task.path, selected.path).then((value) => {
      if (cancelled) return;
      const focused = document.activeElement;
      const preserveFocus = focused === panel.current?.querySelector(".diff-grid");
      setDiff(value);
      if (preserveFocus) requestAnimationFrame(() => {
        if (document.activeElement === focused || document.activeElement === document.body) panel.current?.querySelector<HTMLElement>(".diff-grid")?.focus({ preventScroll: true });
      });
    }).catch((reason) => {
      if (!cancelled) setDiffError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [project.path, task.path, selected?.path, changes?.checkedAt]);

  const open = (application: ApplicationId, filePath?: string) => {
    setOpenError("");
    const remember = applicationState?.storedPreferred !== application;
    setApplicationState((current) => current ? { ...current, preferred: application } : current);
    void window.pilot.openTaskPathInApplication(project.path, task.path, application, filePath)
      .catch((reason) => setOpenError(reason instanceof Error ? reason.message : String(reason)));
    if (remember) void window.pilot.setPreferredApplication(project.path, task.path, application).then(setApplicationState)
      .catch((reason) => setOpenError(`Could not remember that application: ${reason instanceof Error ? reason.message : String(reason)}`));
  };

  if (!changes) return loadError
    ? <div className="changes-empty" role="alert"><strong>Could not read Git changes</strong><p>{loadError}</p></div>
    : <p className="muted changes-loading" role="status">Reading Git changes…</p>;
  return <section ref={panel} className="changes-panel" aria-label="Task changes">
    <header className="changes-heading">
      <div><p className="eyebrow">Working tree</p><h2>Task changes</h2></div>
      <div className="change-totals" aria-label={`${changes.files.length} changed files, ${changes.additions} additions, ${changes.deletions} deletions`}>
        <strong>{changes.files.length} file{changes.files.length === 1 ? "" : "s"}</strong><span className="additions">+{changes.additions.toLocaleString()}</span><span className="deletions">−{changes.deletions.toLocaleString()}</span>
      </div>
    </header>
    <div className="execution-editor-row"><code title={changes.executionPath}>{changes.executionPath}</code><ApplicationOpenControl targetLabel="execution location" state={applicationState} onOpen={(application) => open(application)} /></div>
    {applicationState?.notice && <p className="editor-discovery-note" role="status">{applicationState.notice}</p>}
    {applicationState && !applicationState.available.length && <p className="editor-discovery-note" role="status">No supported external application was detected. Install an editor, then return to PiLot.</p>}
    {task.execution.kind === "worktree" && !task.execution.removedAt && <WorktreeActions project={project} task={task} disabled={disabled} onRemoved={onWorktreeRemoved} />}
    {!changes.repository ? <div className="changes-empty"><strong>Git changes unavailable</strong><p>This Execution location is not a Git working tree.</p></div>
      : !changes.files.length ? <div className="changes-empty"><strong>No current changes</strong><p>Git reports a clean working tree.</p></div>
        : <>
          <ul className="changed-file-list" aria-label="Changed files">
            {changes.files.map((file) => <li key={file.path}><button type="button" aria-current={file.path === selected?.path ? "true" : undefined} aria-label={`${changeStatusLabels[file.status]} ${file.path}${file.previousPath ? `, from ${file.previousPath}` : ""}, ${file.binary ? "binary file" : `${file.additions} additions, ${file.deletions} deletions`}`} onClick={() => onSelect(file.path)}>
              <span className={`change-status status-${file.status}`} aria-hidden="true">{file.status === "untracked" ? "?" : file.status[0].toUpperCase()}</span>
              <span className="change-file-name"><strong>{file.path}</strong>{file.previousPath && <small>from {file.previousPath}</small>}</span>
              <span className="change-file-stat">{file.binary ? "Binary" : <><span className="additions">+{file.additions}</span> <span className="deletions">−{file.deletions}</span></>}</span>
            </button></li>)}
          </ul>
          {selected && <section className="file-diff" aria-labelledby="selected-change-title">
            <header><div><span>{changeStatusLabels[selected.status]}</span><h3 id="selected-change-title">{selected.path}</h3></div><ApplicationOpenControl targetLabel={selected.path} state={applicationState} disabled={selected.status === "deleted"} onOpen={(application) => open(application, selected.path)} /></header>
            {!diff && !diffError ? <p className="muted" role="status">Loading unified diff…</p>
              : diff?.binary ? <p className="muted">Binary file content is not shown.</p>
                : diff?.truncated ? <p className="muted">This diff is too large to display. Open the file in your editor to review it.</p>
                  : diff ? <>
                    {diff.metadata.length > 0 && <ul className="diff-metadata" aria-label="Git change metadata">{diff.metadata.map((line) => <li key={line}><code>{line}</code></li>)}</ul>}
                    {diff.hunks.length ? <VirtualDiff key={diff.path} diff={diff} /> : <p className="muted">No text hunks to display.</p>}
                  </> : null}
          </section>}
        </>}
    {(diffError || openError || applicationError) && <p className="error changes-error" role="alert">{diffError || openError || applicationError}</p>}
  </section>;
}

type FlatHistoryNode = { node: TaskHistoryNode; depth: number; parentId?: string; position: number; setSize: number };
type HistoryTaskCreationAction = { kind: "clone" } | { kind: "fork"; entryId: string };

function HistoryPanel({ project, task, history, loadError, disabled, readOnly = false, onChange, onNavigate, onTaskCreated }: {
  project: ProjectAccess;
  task: TaskSummary;
  history?: TaskHistoryState;
  loadError: string;
  disabled: boolean;
  readOnly?: boolean;
  onChange(next: TaskHistoryState): void;
  onNavigate(editorText?: string): void;
  onTaskCreated(result: TaskHistoryTaskResult): Promise<void>;
}) {
  const tree = useRef<HTMLDivElement>(null);
  const creationReturnFocus = useRef<HTMLElement | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState("");
  const [summarize, setSummarize] = useState(false);
  const [summaryFocus, setSummaryFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [creation, setCreation] = useState<{ state: TaskCreationState; action: HistoryTaskCreationAction }>();
  const allNodes = useMemo(() => {
    const values: TaskHistoryNode[] = [];
    const visit = (nodes: TaskHistoryNode[]) => nodes.forEach((node) => { values.push(node); visit(node.children); });
    visit(history?.roots ?? []);
    return values;
  }, [history]);

  useEffect(() => {
    setExpanded(new Set(allNodes.filter(({ children }) => children.length).map(({ id }) => id)));
    setSelectedId((current) => allNodes.some(({ id }) => id === current) ? current : history?.currentLeafId ?? allNodes[0]?.id ?? "");
  }, [history?.taskPath, history?.currentLeafId, history?.pathCount]);
  const selected = allNodes.find(({ id }) => id === selectedId);
  useEffect(() => setLabel(selected?.label ?? ""), [selected?.id, selected?.label]);
  useLayoutEffect(() => {
    requestAnimationFrame(() => tree.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ block: "nearest" }));
  }, [history?.taskPath, history?.currentLeafId]);

  const flat = useMemo(() => {
    const values: FlatHistoryNode[] = [];
    const visit = (nodes: TaskHistoryNode[], depth: number, parentId?: string) => nodes.forEach((node, index) => {
      values.push({ node, depth, parentId, position: index + 1, setSize: nodes.length });
      if (expanded.has(node.id)) visit(node.children, depth + 1, node.id);
    });
    visit(history?.roots ?? [], 1);
    return values;
  }, [history, expanded]);
  const focusIndex = (index: number) => {
    const next = Math.max(0, Math.min(flat.length - 1, index));
    const id = flat[next]?.node.id;
    if (!id) return;
    setSelectedId(id);
    requestAnimationFrame(() => tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[next]?.focus());
  };
  const attempt = async (operation: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    setError("");
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const createFromHistory = async (action: HistoryTaskCreationAction, request: TaskCreationRequest) => {
    const result = action.kind === "clone"
      ? await window.pilot.cloneTaskHistory(project.path, task.path, request)
      : await window.pilot.forkTaskFromHistory(project.path, task.path, action.entryId, request);
    setCreation(undefined);
    await onTaskCreated(result);
  };
  const chooseExecution = (action: HistoryTaskCreationAction) => void attempt(async () => {
    creationReturnFocus.current = document.activeElement as HTMLElement | null;
    const state = await window.pilot.getTaskCreation(project.path);
    if (state.repository) setCreation({ state, action });
    else await createFromHistory(action, { kind: "local" });
  });

  if (!history) return loadError
    ? <div className="history-empty" role="alert"><strong>Could not read Task history</strong><p>{loadError}</p></div>
    : <p className="muted history-loading" role="status">Reading Task history…</p>;

  return <section className="history-panel" aria-label="Task history inspector" aria-busy={busy}>
    <header className="history-heading"><div><p className="eyebrow">Pi session tree</p><h2>Task history</h2></div><div><span>{history.pathCount} path{history.pathCount === 1 ? "" : "s"}</span>{readOnly ? <span>Read only</span> : <button type="button" disabled={disabled || busy} onClick={() => chooseExecution({ kind: "clone" })}>Clone active path</button>}</div></header>
    {readOnly && <p className="history-root-branch" role="note">History remains available after Worktree removal. Editing and navigation actions are unavailable.</p>}
    {!history.roots.length ? <div className="history-empty"><strong>No history entries yet</strong><p>{readOnly ? "This Task has no recorded Run history." : "Submit a prompt to begin this Task's history."}</p></div> : <>
      {history.roots.length > 1 && <p className="history-root-branch" role="note">Task start · {history.roots.length} branches</p>}
      <div ref={tree} className="history-tree" role="tree" aria-label="Task history">
        {flat.map(({ node, depth, parentId, position, setSize }, index) => <button key={node.id} type="button" role="treeitem" data-current={node.current || undefined} aria-level={depth} aria-posinset={position} aria-setsize={setSize} aria-selected={node.id === selectedId} aria-expanded={node.children.length ? expanded.has(node.id) : undefined} tabIndex={node.id === selectedId ? 0 : -1} style={{ paddingInlineStart: `${8 + (depth - 1) * 17}px` }} onFocus={() => setSelectedId(node.id)} onClick={() => setSelectedId(node.id)} onKeyDown={(event) => {
          if (event.key === "ArrowDown") focusIndex(index + 1);
          else if (event.key === "ArrowUp") focusIndex(index - 1);
          else if (event.key === "Home") focusIndex(0);
          else if (event.key === "End") focusIndex(flat.length - 1);
          else if (event.key === "ArrowRight" && node.children.length) {
            if (!expanded.has(node.id)) setExpanded((current) => new Set(current).add(node.id));
            else focusIndex(index + 1);
          } else if (event.key === "ArrowLeft") {
            if (node.children.length && expanded.has(node.id)) setExpanded((current) => { const next = new Set(current); next.delete(node.id); return next; });
            else if (parentId) focusIndex(flat.findIndex(({ node: candidate }) => candidate.id === parentId));
          } else return;
          event.preventDefault();
        }}>
          <span className={`history-marker history-${node.kind}`} aria-hidden="true">{node.children.length ? expanded.has(node.id) ? "−" : "+" : "·"}</span>
          <span className="history-entry-copy"><span><strong>{node.title}</strong>{node.label && <span className="history-label">{node.label}</span>}</span>{node.description && <small>{node.description}</small>}<span className="history-entry-meta"><time dateTime={node.timestamp}>{new Date(node.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{node.children.length > 1 && <span>{node.children.length} branches</span>}{node.current && <span className="history-current">Current leaf</span>}</span></span>
        </button>)}
      </div>
      {selected && !readOnly && <section className="history-actions" aria-label={`Actions for ${selected.title}`}>
        {selected.kind === "prompt" && <button className="history-fork" type="button" disabled={disabled || busy} onClick={() => chooseExecution({ kind: "fork", entryId: selected.id })}>Fork from prompt</button>}
        <form onSubmit={(event) => { event.preventDefault(); void attempt(async () => { const next = await window.pilot.setTaskHistoryLabel(project.path, task.path, selected.id, label); onChange(next); setNotice("Label saved"); }); }}>
          <label>History label<input aria-label="History label" value={label} maxLength={80} disabled={disabled || busy} onChange={(event) => setLabel(event.target.value)} /></label>
          <div><button type="submit" disabled={disabled || busy || !label.trim()}>Save label</button><button type="button" disabled={disabled || busy || !selected.label} onClick={() => void attempt(async () => { const next = await window.pilot.setTaskHistoryLabel(project.path, task.path, selected.id); onChange(next); setLabel(""); setNotice("Label cleared"); })}>Clear label</button></div>
        </form>
        <fieldset disabled={disabled || busy || selected.current}>
          <legend>Continue from this entry</legend>
          <label className="history-summary-choice"><input type="checkbox" checked={summarize} onChange={(event) => setSummarize(event.target.checked)} />Summarize abandoned branch</label>
          {summarize && <label>Summary focus<input aria-label="Summary focus" value={summaryFocus} maxLength={2000} placeholder="Optional instructions" onChange={(event) => setSummaryFocus(event.target.value)} /></label>}
          <button type="button" onClick={() => void attempt(async () => { const result = await window.pilot.navigateTaskHistory(project.path, task.path, selected.id, summarize, summaryFocus.trim() || undefined); onChange(result.history); onNavigate(result.editorText); setNotice("History position changed"); })}>Navigate here</button>
        </fieldset>
      </section>}
    </>}
    {creation && <TaskCreationDialog project={project} state={creation.state} contextNote="Task history is copied, but uncommitted files are never transferred between Execution locations." onCreate={(request) => createFromHistory(creation.action, request)} onClose={() => {
      setCreation(undefined);
      requestAnimationFrame(() => creationReturnFocus.current?.focus());
    }} />}
    {busy && <p className="muted history-notice" role="status">Updating Task history…</p>}
    {notice && <p className="success history-notice" role="status">{notice}</p>}
    {error && <p className="error history-notice" role="alert">{error}</p>}
  </section>;
}

type TaskModel = TaskModelState["providers"][number]["models"][number];
type TaskProvider = TaskModelState["providers"][number];

function fuzzyMatchScore(value: string, query: string) {
  const candidate = value.toLocaleLowerCase();
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 10 + candidate.length - query.length;
  const includedAt = candidate.indexOf(query);
  if (includedAt >= 0) return 30 + includedAt;

  let queryIndex = 0;
  let previous = -1;
  let first = -1;
  let gaps = 0;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index++) {
    if (candidate[index] !== query[queryIndex]) continue;
    if (first < 0) first = index;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    queryIndex++;
  }
  return queryIndex === query.length ? 100 + first * 2 + gaps * 3 + candidate.length - query.length : null;
}

async function imageAttachment(file: File): Promise<ImageAttachment> {
  if (!file.size || file.size > MAXIMUM_IMAGE_BYTES) throw new Error(`${file.name || "Image"} must be 20 MB or smaller`);
  const mimeType = detectSupportedImageMimeType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  if (!mimeType) throw new Error(`${file.name || "Image"} is not a supported PNG, JPEG, GIF, or WebP image`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name || "Image"} could not be read`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
  return { name: file.name || "Pasted image", mimeType, size: file.size, data };
}

function resourceProvenance(resource: TaskResourceState["commands"][number]) {
  const scope = resource.provenance.scope[0].toUpperCase() + resource.provenance.scope.slice(1);
  const source = resource.provenance.source;
  return source === "auto" || source === "local" ? scope : `${scope} · ${source}`;
}

function UnsupportedResourceNotice({ resources }: { resources: TaskResourceState["unsupported"] }) {
  if (!resources.length) return null;
  const extensions = resources.filter(({ kind }) => kind === "extension");
  const themes = resources.filter(({ kind }) => kind === "theme");
  const keybindings = resources.filter(({ kind }) => kind === "keybindings");
  const summaries = [
    extensions.length ? `${extensions.length} extension${extensions.length === 1 ? "" : "s"} not executed` : "",
    themes.length ? `${themes.length} TUI theme${themes.length === 1 ? "" : "s"} ignored` : "",
    keybindings.length ? "TUI keybindings ignored" : "",
  ].filter(Boolean);
  const labels = {
    extension: "Extension",
    theme: "TUI theme",
    keybindings: "TUI keybindings",
  } as const;

  return <section className="unsupported-resources" aria-label="Unsupported Pi resources">
    <header><strong>Terminal-only Pi resources</strong><span>Not used by PiLot</span></header>
    <p>{summaries.join(" · ")}. PiLot keeps its desktop controls predictable and does not execute or approximate these resources.</p>
    <ul>{resources.map((resource) => <li key={`${resource.kind}:${resource.path}`}>
      <span>{labels[resource.kind]} · {resource.scope}</span><code>{resource.path}</code>
    </li>)}</ul>
  </section>;
}

function modelSearchScore(provider: TaskProvider, model: TaskModel, query: string) {
  let total = 0;
  for (const token of query.toLocaleLowerCase().trim().split(/\s+/)) {
    const scores = [provider.name, provider.id, model.name, model.id]
      .map((value) => fuzzyMatchScore(value, token))
      .filter((score): score is number => score !== null);
    if (!scores.length) return null;
    total += Math.min(...scores);
  }
  return total;
}

function placePicker(popover: HTMLElement, trigger: HTMLElement, preferredWidth: number, adaptive = false) {
  const bounds = trigger.getBoundingClientRect();
  const width = Math.min(preferredWidth, window.innerWidth - 24);
  popover.style.width = `${width}px`;
  popover.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
  if (!adaptive) { popover.style.top = `${bounds.top - 7}px`; return; }
  const roomBelow = window.innerHeight - bounds.bottom - 12;
  const above = roomBelow < 180 && bounds.top > roomBelow;
  popover.style.top = `${above ? bounds.top - 7 : bounds.bottom + 7}px`;
  popover.style.transform = above ? "translateY(-100%)" : "none";
  popover.style.maxHeight = `${Math.max(120, Math.min(320, above ? bounds.top - 19 : roomBelow))}px`;
}

function thinkingLevelLabel(level: TaskModelState["thinkingLevel"]) {
  return level[0].toUpperCase() + level.slice(1);
}

function ThinkingPicker({ state, disabled, onSelect }: {
  state: TaskModelState;
  disabled: boolean;
  onSelect(level: TaskModelState["thinkingLevel"]): Promise<boolean>;
}) {
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    if (popover.current?.matches(":popover-open")) popover.current.hidePopover();
    trigger.current?.focus();
  };
  const show = () => {
    if (!popover.current || !trigger.current || disabled) return;
    placePicker(popover.current, trigger.current, Math.max(180, trigger.current.offsetWidth));
    if (!popover.current.matches(":popover-open")) popover.current.showPopover();
    requestAnimationFrame(() => {
      const current = popover.current;
      if (!current || (document.activeElement !== trigger.current && document.activeElement !== document.body)) return;
      current.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
  };
  const move = (event: React.KeyboardEvent, direction: number) => {
    const options = [...(popover.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const index = options.indexOf(event.currentTarget as HTMLElement);
    options[(index + direction + options.length) % options.length]?.focus();
    event.preventDefault();
  };

  return <>
    <button ref={trigger} type="button" data-action="task.chooseThinking" className="thinking-picker-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={`Thinking level: ${thinkingLevelLabel(state.thinkingLevel)}`} disabled={disabled} onClick={show}>
      <span>Thinking · {thinkingLevelLabel(state.thinkingLevel)}</span><span aria-hidden="true">⌄</span>
    </button>
    <div ref={popover} popover="auto" className="model-picker-popover thinking-picker-popover" role="dialog" aria-label="Choose thinking level" onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    }}>
      <div className="model-results" role="listbox" aria-label="Thinking levels">
        {state.thinkingLevels.map((level) => {
          const selected = level === state.thinkingLevel;
          return <button key={level} type="button" role="option" aria-selected={selected} onClick={() => {
            void onSelect(level).then(close);
          }} onKeyDown={(event) => {
            if (event.key === "ArrowDown") move(event, 1);
            if (event.key === "ArrowUp") move(event, -1);
          }}>
            <span><strong>{thinkingLevelLabel(level)}</strong></span>
            {selected && <span className="model-selected" aria-hidden="true">✓</span>}
          </button>;
        })}
      </div>
    </div>
  </>;
}

function TaskModelControls({ project, task, state, disabled, onChange, onOpenSettings, onActionStart, onError }: {
  project: ProjectAccess;
  task: TaskSummary;
  state?: TaskModelState;
  disabled: boolean;
  onChange(next: TaskModelState): void;
  onOpenSettings(): void;
  onActionStart(): void;
  onError(reason: unknown, recovery: string): void;
}) {
  const picker = useRef<HTMLDivElement>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const modelListId = useId();
  const [providerId, setProviderId] = useState("");
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const providers = state?.providers.filter(({ models }) => models.length) ?? [];
  const selectedProvider = providers.find(({ id }) => id === state?.selected?.provider);
  const activeProvider = providers.find(({ id }) => id === providerId) ?? selectedProvider ?? providers[0];
  const searching = Boolean(query.trim());
  const models = searching
    ? providers.flatMap((provider) => provider.models.map((model) => ({ provider, model, score: modelSearchScore(provider, model, query) })))
      .filter((item): item is { provider: TaskProvider; model: TaskModel; score: number } => item.score !== null)
      .sort((left, right) => left.score - right.score || left.model.name.localeCompare(right.model.name))
    : (activeProvider?.models ?? []).map((model) => ({ provider: activeProvider!, model, score: 0 }));

  useEffect(() => {
    if (state?.selected?.provider) setProviderId(state.selected.provider);
  }, [state?.selected?.provider]);

  const attempt = async (action: () => Promise<TaskModelState>) => {
    onActionStart();
    try { onChange(await action()); return true; } catch (reason) {
      if (picker.current?.matches(":popover-open")) picker.current.hidePopover();
      pickerTrigger.current?.focus();
      onError(reason, "Check provider access or choose another model, then try again.");
      return false;
    }
  };
  const closePicker = (restoreFocus = true) => {
    if (picker.current?.matches(":popover-open")) picker.current.hidePopover();
    if (restoreFocus) pickerTrigger.current?.focus();
  };
  const openPicker = () => {
    if (!picker.current || !pickerTrigger.current || disabled) return;
    setQuery("");
    setProviderId(state?.selected?.provider ?? providers[0]?.id ?? "");
    placePicker(picker.current, pickerTrigger.current, 420);
    if (!picker.current.matches(":popover-open")) picker.current.showPopover();
    requestAnimationFrame(() => {
      picker.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      searchInput.current?.focus();
    });
  };
  const moveFocus = (event: React.KeyboardEvent, selector: string, direction: number) => {
    const items = [...(picker.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
    if (!items.length) return;
    const index = items.indexOf(event.currentTarget as HTMLElement);
    const next = items[(index + direction + items.length) % items.length];
    next?.focus();
    event.preventDefault();
    return next;
  };

  return <div className="task-model-controls">
    {state?.fallback && <div className="model-fallback" role="status" aria-label="Model fallback">
      <span>{state.fallback}</span>
      {state.selected && <button type="button" onClick={() => {
        void attempt(() => window.pilot.setTaskModel(project.path, task.path, state.selected!.provider, state.selected!.id));
      }}>Use fallback model</button>}
      <button type="button" onClick={openPicker}>Choose another model</button>
      <button type="button" onClick={onOpenSettings}>Open provider Settings</button>
    </div>}
    {state?.selected && selectedProvider && <>
      <div className="model-control-row">
        <button ref={pickerTrigger} type="button" data-action="task.chooseModel" className="model-picker-trigger" aria-haspopup="dialog" aria-expanded={pickerOpen} aria-label={`Provider and model: ${selectedProvider.name} · ${state.selected.name} · ${state.selected.id}`} disabled={disabled} onClick={openPicker}>
          <ProviderIcon id={selectedProvider.id} builtIn={selectedProvider.builtIn} />
          <span className="model-trigger-label">{state.selected.name}</span><span aria-hidden="true">⌄</span>
        </button>
        <ThinkingPicker state={state} disabled={disabled || state.thinkingLevels.length === 1} onSelect={(level) => attempt(() => window.pilot.setTaskThinking(project.path, task.path, level))} />
      </div>
      <div ref={picker} popover="auto" className="model-picker-popover" role="dialog" aria-label="Choose model" onToggle={(event) => {
        const open = event.currentTarget.matches(":popover-open");
        setPickerOpen(open);
        if (!open) setQuery("");
      }} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); closePicker(); }
      }}>
        <div className="model-picker-layout">
          {!searching && providers.length > 1 && <div className="model-provider-rail" role="tablist" aria-label="Available providers" aria-orientation="vertical">
            {providers.map((provider) => <button key={provider.id} type="button" role="tab" data-provider-id={provider.id} aria-label={provider.name} title={provider.name} aria-selected={provider.id === activeProvider?.id} tabIndex={provider.id === activeProvider?.id ? 0 : -1} onClick={() => { setProviderId(provider.id); searchInput.current?.focus(); }} onKeyDown={(event) => {
              const next = event.key === "ArrowUp" ? moveFocus(event, '[role="tab"]', -1)
                : event.key === "ArrowDown" ? moveFocus(event, '[role="tab"]', 1) : undefined;
              if (next?.dataset.providerId) setProviderId(next.dataset.providerId);
            }}><ProviderIcon id={provider.id} builtIn={provider.builtIn} /></button>)}
          </div>}
          <div className="model-picker-main">
            <label className="model-search">
              <span>Search models</span>
              <input ref={searchInput} type="search" role="combobox" aria-expanded="true" aria-controls={modelListId} aria-autocomplete="list" placeholder="Search models…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  picker.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
                  event.preventDefault();
                }
              }} />
            </label>
            <div className="model-results" id={modelListId} role="listbox" aria-label={searching ? "Models from all providers" : `${activeProvider?.name ?? "Provider"} models`}>
              {models.map(({ provider, model }) => {
                const selected = model.provider === state.selected!.provider && model.id === state.selected!.id;
                return <button key={`${model.provider}/${model.id}`} type="button" role="option" aria-selected={selected} onClick={() => {
                  void attempt(() => window.pilot.setTaskModel(project.path, task.path, model.provider, model.id)).then((changed) => { if (changed) closePicker(); });
                }} onKeyDown={(event) => {
                  if (event.key === "ArrowDown") moveFocus(event, '[role="option"]', 1);
                  if (event.key === "ArrowUp") moveFocus(event, '[role="option"]', -1);
                }}>
                  <span><strong>{model.name}</strong><code>{model.id}</code></span>
                  {searching && <small><ProviderIcon id={provider.id} builtIn={provider.builtIn} /><span>{provider.name}</span></small>}
                  {selected && <span className="model-selected" aria-hidden="true">✓</span>}
                </button>;
              })}
              {!models.length && <p>No models found</p>}
            </div>
          </div>
        </div>
      </div>
    </>}
  </div>;
}

function reconcileRunEvent(current: TaskRunState | undefined, next: TaskRunState) {
  // IPC cloning loses references, but settled Runs stay immutable while one active Run streams.
  if (!current || current.taskPath !== next.taskPath || (!current.activeRunId && !next.activeRunId)) return next;
  const evidenceChanged = current.evidenceRevision !== next.evidenceRevision;
  const changing = evidenceChanged
    ? new Set([current.activeRunId, next.activeRunId].filter((id): id is string => Boolean(id)))
    : new Set<string>();
  const stable = new Map(current.runs.filter(({ id }) => !changing.has(id)).map((run) => [run.id, run]));
  return { ...next, runs: next.runs.map((run) => stable.get(run.id) ?? run) };
}

function TaskPage({ project, task, reloadToken, revision, historyDraft, changePaths, onCreate, onFork, onDetails, onHistoryChange, onOpenSettings, onOpenChange, onRunChange, onSetupChange, onContinuityChange, onActionStart, onError }: {
  project: ProjectAccess;
  task: TaskSummary;
  reloadToken: number;
  revision: number;
  historyDraft?: { text: string; version: number };
  changePaths: string[];
  onCreate(): void;
  onFork(task: TaskSummary): void;
  onDetails(next: TaskModelState): void;
  onHistoryChange(): void;
  onOpenSettings(): void;
  onOpenChange(path: string): void;
  onRunChange(active: boolean): void;
  onSetupChange(active: boolean): void;
  onContinuityChange(changed: boolean): void;
  onActionStart(): void;
  onError(reason: unknown, recovery: string): void;
}) {
  const [timeline, setTimeline] = useState<TaskRunState>();
  const [setupState, setSetupState] = useState<TaskSetupState>();
  const [modelState, setModelState] = useState<TaskModelState>();
  const [resources, setResources] = useState<TaskResourceState>();
  const [expandThinking, setExpandThinking] = useState(false);
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [dismissedCompletion, setDismissedCompletion] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [attachingImages, setAttachingImages] = useState(false);
  const [liveMode, setLiveMode] = useState<LiveInputMode>("steer");
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [error, setError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [attachmentError, setAttachmentError] = useState("");
  const [forkCreation, setForkCreation] = useState<TaskCreationState>();
  const taskPage = useRef<HTMLDivElement>(null);
  const followingLatest = useRef(true);
  const positionedTask = useRef("");
  const lastScrollTop = useRef(0);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const imageDragDepth = useRef(0);
  const forkReturnFocus = useRef<HTMLElement | null>(null);
  const currentTaskPath = useRef(task.path);
  const modelRequestSequence = useRef(0);
  currentTaskPath.current = task.path;
  const completionListId = useId();
  const imageHelpId = useId();
  const applyModelState = (next: TaskModelState) => { setModelState(next); onDetails(next); };
  const updateModelState = (next: TaskModelState) => {
    modelRequestSequence.current += 1;
    applyModelState(next);
  };
  const refreshDetails = () => window.pilot.getTaskModel(project.path, task.path).then(updateModelState);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    setSetupState(task.setup ? { taskPath: task.path, ...task.setup } : undefined);
    const unsubscribe = window.pilot.onTaskSetupEvent((next) => {
      if (next.taskPath === task.path) {
        receivedEvent = true;
        setSetupState(next);
      }
    });
    void window.pilot.getTaskSetup(project.path, task.path).then((next) => {
      if (!cancelled && !receivedEvent) setSetupState(next);
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; unsubscribe(); };
  }, [project.path, task.path]);

  useLayoutEffect(() => {
    let cancelled = false;
    let receivedRunEvent = false;
    const modelRequest = ++modelRequestSequence.current;
    setTimeline(undefined);
    setResources(undefined);
    setImages([]);
    setImageDragActive(false);
    setAttachingImages(false);
    imageDragDepth.current = 0;
    setAttachmentError("");
    setError("");
    setActionNotice("");
    const unsubscribe = window.pilot.onTaskRunEvent((next) => {
      if (next.taskPath !== task.path) return;
      receivedRunEvent = true;
      if (next.recoveredInput) setDraft((current) => [next.recoveredInput, current].filter((value) => value?.trim()).join("\n\n"));
      setTimeline((current) => reconcileRunEvent(current, next));
    });
    void Promise.all([
      window.pilot.getTaskRun(project.path, task.path),
      window.pilot.getPreferences(),
      window.pilot.getTaskModel(project.path, task.path),
    ]).then(([next, preferences, model]) => {
      if (cancelled) return;
      if (!receivedRunEvent) setTimeline(next);
      setExpandThinking(preferences.expandThinking);
      if (modelRequest === modelRequestSequence.current) applyModelState(model);
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    void window.pilot.getTaskResources(project.path, task.path).then((taskResources) => {
      if (!cancelled) {
        setResources(taskResources);
        if (reloadToken) {
          const failure = taskResources.diagnostics.find(({ severity }) => severity === "error");
          if (failure) onError(new Error(failure.message), "Fix the reported Pi resource or settings file, then reload resources again.");
          else setActionNotice("Pi resources reloaded");
        }
      }
    }).catch((reason) => {
      if (!cancelled && reloadToken) onError(reason, "Fix the reported Pi resource, then reload resources again.");
      if (!cancelled) setResources({
        taskPath: task.path,
        commands: [],
        files: [],
        diagnostics: [{ severity: "error", message: reason instanceof Error ? reason.message : String(reason) }],
        unsupported: [],
      });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [project.path, task.path, reloadToken, revision, onError]);

  useEffect(() => {
    if (!historyDraft) return;
    setDraft(historyDraft.text);
    setCursor(historyDraft.text.length);
    requestAnimationFrame(() => {
      promptInput.current?.focus();
      promptInput.current?.setSelectionRange(historyDraft.text.length, historyDraft.text.length);
    });
  }, [historyDraft?.version]);
  useEffect(() => setLiveMode("steer"), [timeline?.activeRunId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => promptInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [task.path]);

  useEffect(() => {
    const scroller = taskPage.current?.closest("main");
    if (!scroller) return;
    followingLatest.current = true;
    lastScrollTop.current = scroller.scrollTop;
    setShowJumpLatest(false);
    const handleScroll = () => {
      const nearLatest = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 32;
      if (nearLatest) {
        followingLatest.current = true;
        setShowJumpLatest(false);
      } else if (scroller.scrollTop < lastScrollTop.current) {
        followingLatest.current = false;
      }
      lastScrollTop.current = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", handleScroll);
  }, [task.path]);

  const latestRunEvidence = timeline?.runs.at(-1);

  useLayoutEffect(() => {
    if (!timeline) return;
    const scroller = taskPage.current?.closest("main");
    if (!scroller) return;
    const initialPosition = positionedTask.current !== task.path;
    positionedTask.current = task.path;
    if (initialPosition || followingLatest.current) {
      scroller.scrollTop = scroller.scrollHeight;
      lastScrollTop.current = scroller.scrollTop;
      followingLatest.current = true;
      setShowJumpLatest(false);
    } else if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 32) {
      setShowJumpLatest(true);
    }
  }, [task.path, latestRunEvidence]);

  const jumpToLatest = () => {
    const scroller = taskPage.current?.closest("main");
    if (!scroller) return;
    followingLatest.current = true;
    setShowJumpLatest(false);
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const activeRun = timeline?.runs.find(({ id }) => id === timeline.activeRunId);
  const active = Boolean(activeRun);
  const waitingForCapacity = activeRun?.status === "queued";
  const setupBlocked = Boolean(setupState && setupState.status !== "succeeded" && setupState.status !== "bypassed");
  const externallyChanged = Boolean(timeline?.externalChange);
  const interrupted = !externallyChanged && timeline?.runs.at(-1)?.status === "interrupted";
  const createContinuityFork = async (request: TaskCreationRequest) => {
    const next = await window.pilot.forkChangedTask(project.path, task.path, request);
    setForkCreation(undefined);
    onFork(next);
  };
  const chooseForkExecution = () => {
    forkReturnFocus.current = document.activeElement as HTMLElement | null;
    setError("");
    void window.pilot.getTaskCreation(project.path).then((state) => {
      if (state.repository) setForkCreation(state);
      else void createContinuityFork({ kind: "local" }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  useEffect(() => {
    onRunChange(active);
    return () => onRunChange(false);
  }, [active, onRunChange]);
  useEffect(() => {
    onSetupChange(setupState?.status === "running");
    return () => onSetupChange(false);
  }, [setupState?.status, onSetupChange]);
  useEffect(() => {
    onContinuityChange(externallyChanged);
    return () => onContinuityChange(false);
  }, [externallyChanged, onContinuityChange]);
  const live = activeRun?.input.kind === "prompt" && !waitingForCapacity;
  const liveReady = live && activeRun.status === "running";
  const beforeCursor = draft.slice(0, cursor);
  const slashMatch = beforeCursor.match(/^\/([^\s]*)$/);
  const fileMatch = slashMatch ? null : beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  const completionKind = slashMatch ? "resource" : fileMatch ? "file" : undefined;
  const completionQuery = (slashMatch?.[1] ?? fileMatch?.[1] ?? "").toLocaleLowerCase();
  const completions: Array<{ value: string; score: number; resource?: TaskResourceState["commands"][number] }> = completionKind === "resource"
    ? (resources?.commands ?? []).map((resource) => ({ resource, value: resource.name, score: fuzzyMatchScore(resource.name, completionQuery) }))
      .filter((item): item is { resource: TaskResourceState["commands"][number]; value: string; score: number } => item.score !== null)
      .sort((left, right) => left.score - right.score || left.value.localeCompare(right.value)).slice(0, 8)
    : completionKind === "file"
      ? (resources?.files ?? []).map((value) => ({ value, score: fuzzyMatchScore(value, completionQuery) }))
        .filter((item): item is { value: string; score: number } => item.score !== null)
        .sort((left, right) => left.score - right.score || left.value.localeCompare(right.value)).slice(0, 8)
      : [];
  const completionKey = `${completionKind ?? "none"}:${completionQuery}:${cursor}`;
  const showCompletions = Boolean(completionKind && completions.length && dismissedCompletion !== completionKey);

  useEffect(() => setCompletionIndex(0), [completionKey]);

  const applyCompletion = (index: number) => {
    const completion = completions[index];
    if (!completion || !completionKind) return;
    const start = completionKind === "resource" ? 0 : beforeCursor.lastIndexOf("@");
    const inserted = `${completionKind === "resource" ? "/" : "@"}${completion.value} `;
    const next = draft.slice(0, start) + inserted + draft.slice(cursor);
    const nextCursor = start + inserted.length;
    setDraft(next);
    setCursor(nextCursor);
    setDismissedCompletion("");
    requestAnimationFrame(() => {
      promptInput.current?.focus();
      promptInput.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };
  const attachFiles = async (files: File[]) => {
    if (!files.length) return;
    setAttachmentError("");
    setAttachingImages(true);
    try {
      if (images.length + files.length > MAXIMUM_IMAGES) throw new Error(`Attach no more than ${MAXIMUM_IMAGES} images at once`);
      const attached = await Promise.all(files.map(imageAttachment));
      if (currentTaskPath.current === task.path) setImages((current) => [...current, ...attached]);
    } catch (reason) {
      if (currentTaskPath.current === task.path) setAttachmentError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (currentTaskPath.current === task.path) setAttachingImages(false);
    }
  };
  const submit = (mode?: LiveInputMode) => {
    const input = draft.trim();
    if (!input || setupBlocked || externallyChanged || (active && (!liveReady || !mode))) return;
    setError("");
    setDraft("");
    const hiddenCommand = !active && input.startsWith("!!");
    const command = hiddenCommand ? input.slice(2) : !active && input.startsWith("!") ? input.slice(1) : undefined;
    const operation = active
      ? window.pilot.queuePrompt(task.path, input, mode!)
      : command !== undefined
        ? window.pilot.executeCommand(project.path, task.path, command, !hiddenCommand)
        : window.pilot.submitPrompt(project.path, task.path, input, images);
    void operation.then(async () => {
      if (!active) setImages([]);
      await refreshDetails();
      onHistoryChange();
    }).catch((reason) => {
      setDraft((current) => [input, current].filter((value) => value.trim()).join("\n\n"));
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  const queues = timeline?.queues ?? { steering: [], followUp: [] };
  const setupStatus = setupState ? setupState.status[0].toUpperCase() + setupState.status.slice(1) : "";

  return <div ref={taskPage} className="task-page">
    <header className="topbar task-topbar">
      <div><p className="eyebrow">Active Task</p><h1>{task.title}</h1><span className="execution-location">{task.execution.kind === "worktree" ? `Worktree · ${task.execution.ref}` : "Local execution location"}</span></div>
      <button className="new-task-button" data-action="task.new" onClick={onCreate}>New Task</button>
    </header>
    {setupState && <section className={`worktree-setup setup-${setupState.status}`} aria-label="Worktree setup">
      <header><div><h2>Worktree setup</h2><p>Run the trusted Project command before this Task's first Run.</p></div><span role="status" aria-label="Setup status">{setupStatus}</span></header>
      <code>{setupState.command}</code>
      {setupState.output && <pre role="log" aria-label="Setup output" aria-live="polite">{setupState.output}</pre>}
      {setupState.outputTruncated && <p className="output-bound">Earlier setup output is not shown.</p>}
      <div className="worktree-setup-actions">
        {setupState.status === "pending" && <button type="button" onClick={() => {
          setError("");
          void window.pilot.runTaskSetup(project.path, task.path).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}>Run setup</button>}
        {setupState.status === "running" && <button type="button" onClick={() => void window.pilot.abortTaskSetup(task.path).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))}>Stop setup</button>}
        {["failed", "aborted", "interrupted"].includes(setupState.status) && <>
          <button type="button" onClick={() => {
            setError("");
            void window.pilot.runTaskSetup(project.path, task.path).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
          }}>Run setup again</button>
          <button type="button" onClick={() => {
            setError("");
            void window.pilot.bypassTaskSetup(project.path, task.path).then(setSetupState).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
          }}>Continue without setup</button>
        </>}
      </div>
    </section>}
    <section className="run-timeline" aria-label="Run timeline">
      <div className="timeline-heading"><h2>Run timeline</h2><div><span aria-live="polite">{waitingForCapacity ? "Waiting for capacity" : active ? "Run active" : `${timeline?.runs.length ?? 0} Runs`}</span><button type="button" disabled={active || externallyChanged} onClick={() => {
        setError("");
        onActionStart();
        void window.pilot.compactTask(project.path, task.path).then(async () => { await refreshDetails(); onHistoryChange(); }).catch((reason) => onError(reason, "Add more Task history or check provider access, then try compacting again."));
      }} data-action="run.compact">Compact context</button></div></div>
      {timeline?.runs.length ? <RunList runs={timeline.runs} expandThinking={expandThinking} changePaths={changePaths} onOpenChange={onOpenChange} /> : <p className="muted">Submit a prompt or inline command to start this Task.</p>}
      {waitingForCapacity && <p className="queue-position" role="status"><strong>Waiting for capacity.</strong> Queue position {timeline?.queuePosition ?? 1} · global limit {timeline?.runLimit ?? 4} active Runs.</p>}
      {interrupted && <section className="interrupted-recovery" role="status" aria-label="Interrupted Run recovery"><strong>Run interrupted</strong><p>PiLot did not retry the interrupted input. Review the timeline and Changes before continuing.</p></section>}
      {actionNotice && <p className="success action-notice" role="status">{actionNotice}</p>}
    </section>
    <div className="composer-dock">
      {showJumpLatest && <button type="button" className="jump-latest" aria-label="Jump to latest Run evidence" title="Jump to latest" onClick={jumpToLatest}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.75 6.25 3.25 3.25 3.25-3.25" /></svg>
      </button>}
      {externallyChanged && <section className="continuity-alert" role="alert" aria-labelledby="continuity-alert-title">
        <div><strong id="continuity-alert-title">Task changed outside PiLot</strong><p>PiLot paused Task history writes to protect both paths. Review the Run timeline and Changes before continuing. Forking copies the last PiLot path and asks for a new Execution location.</p></div>
        <div className="continuity-actions">
          <button type="button" disabled={active} onClick={() => {
            setError("");
            void window.pilot.reloadTask(project.path, task.path).then(async (next) => {
              setTimeline(next);
              await refreshDetails();
              onHistoryChange();
              setActionNotice("External Task history reloaded");
            }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
          }}>Reload Task</button>
          <button type="button" disabled={active} onClick={chooseForkExecution}>Fork Task</button>
        </div>
      </section>}
      <form className="task-composer" aria-label="Task composer" aria-disabled={externallyChanged || undefined} onDragEnter={(event) => {
      if (active || externallyChanged || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      imageDragDepth.current += 1;
      setImageDragActive(true);
    }} onDragOver={(event) => {
      if (event.dataTransfer.types.includes("Files") && !active && !externallyChanged) event.preventDefault();
    }} onDragLeave={(event) => {
      if (!imageDragActive) return;
      event.preventDefault();
      imageDragDepth.current = Math.max(0, imageDragDepth.current - 1);
      if (!imageDragDepth.current) setImageDragActive(false);
    }} onDrop={(event) => {
      imageDragDepth.current = 0;
      setImageDragActive(false);
      if (active || externallyChanged || !event.dataTransfer.files.length) return;
      event.preventDefault();
      void attachFiles([...event.dataTransfer.files]);
    }} onSubmit={(event) => { event.preventDefault(); submit(active ? liveMode : undefined); }}>
      {imageDragActive && <div className="image-drop-feedback" aria-hidden="true"><span>＋</span> Drop images to attach</div>}
      <label htmlFor="task-prompt">{externallyChanged ? "Prompts paused — choose Reload or Fork" : waitingForCapacity ? "Run waiting for capacity" : setupBlocked ? "Finish Worktree setup before the first Run" : live ? "Guide the active Run" : "Prompt or inline command"}</label>
      {error && <p className="error task-submit-error" role="alert">{error}</p>}
      <UnsupportedResourceNotice resources={resources?.unsupported ?? []} />
      {resources?.diagnostics.length ? <section className="resource-diagnostics" aria-label="Pi resource diagnostics">
        {resources.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.path ?? "resource"}-${index}`} className={diagnostic.severity}><strong>Pi resource {diagnostic.severity}:</strong> {diagnostic.message}{diagnostic.path && <code>{diagnostic.path}</code>}</p>)}
      </section> : null}
      {live && <fieldset className="live-input-mode" role="radiogroup" aria-label="Live input mode">
        <legend>Delivery</legend>
        <label><input type="radio" name="live-input-mode" checked={liveMode === "steer"} onChange={() => setLiveMode("steer")} />Steer <small>after the current tool batch</small></label>
        <label><input type="radio" name="live-input-mode" checked={liveMode === "followUp"} onChange={() => setLiveMode("followUp")} />Follow-up <small>after this Run settles</small></label>
      </fieldset>}
      <div className="composer-editor">
        <textarea ref={promptInput} id="task-prompt" data-action="view.focusPrompt" role="combobox" aria-label="Prompt" aria-autocomplete="list" aria-expanded={showCompletions} aria-controls={completionListId} aria-activedescendant={showCompletions ? `${completionListId}-${completionIndex}` : undefined} value={draft} disabled={externallyChanged || (active && !live)} onChange={(event) => {
          setDraft(event.target.value);
          setCursor(event.target.selectionStart);
          setDismissedCompletion("");
        }} onSelect={(event) => setCursor(event.currentTarget.selectionStart)} onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!active && !externallyChanged && files.length) {
            event.preventDefault();
            void attachFiles(files);
          }
        }} onKeyDown={(event) => {
          if (showCompletions && !event.nativeEvent.isComposing) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              setCompletionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + completions.length) % completions.length);
              event.preventDefault();
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              applyCompletion(completionIndex);
              return;
            }
            if (event.key === "Escape") {
              setDismissedCompletion(completionKey);
              event.preventDefault();
              return;
            }
          }
          if (!liveReady || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const mode = event.altKey ? "followUp" : liveMode;
          if (event.altKey) setLiveMode(mode);
          submit(mode);
        }} placeholder={live ? "Steer Pi now, or queue work for later…" : "Ask Pi to work, use / resources, reference @files, or run !command…"} rows={3} />
        {showCompletions && <div id={completionListId} className="composer-completions" role="listbox" aria-label="Resource completion">
          {completions.map((completion, index) => <button id={`${completionListId}-${index}`} key={`${completionKind}-${completion.value}`} type="button" role="option" tabIndex={-1} aria-selected={index === completionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => applyCompletion(index)}>
            <span><strong>{completionKind === "resource" ? `/${completion.value}` : completion.value}</strong>{completion.resource && <small>{completion.resource.description}</small>}</span>
            {completion.resource && <small>{resourceProvenance(completion.resource)}</small>}
          </button>)}
        </div>}
      </div>
      {images.length > 0 && <ul className="attachment-list" aria-label="Image attachments" aria-live="polite">
        {images.map((image, index) => <li key={`${image.name}-${index}`}>
          <img src={`data:${image.mimeType};base64,${image.data}`} alt="" draggable={false} />
          <span><strong>{image.name}</strong><small>{IMAGE_MIME_LABELS[image.mimeType]} · {image.size < 1024 ? `${image.size} B` : `${(image.size / 1024).toFixed(1)} KB`}</small></span>
          <button type="button" aria-label={`Remove ${image.name}`} disabled={active} onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><span aria-hidden="true">×</span></button>
        </li>)}
      </ul>}
      {attachmentError && <p className="error attachment-error" role="alert">{attachmentError}</p>}
      {live && <div className="pending-queues" aria-label="Pending live input">
        <ul className="pending-queue" aria-label="Pending steering">{queues.steering.length ? queues.steering.map((text, index) => <li key={`${text}-${index}`}><strong>Steer</strong><span>{text}</span></li>) : <li className="queue-empty"><strong>Steer</strong><span>None pending</span></li>}</ul>
        <ul className="pending-queue" aria-label="Pending follow-ups">{queues.followUp.length ? queues.followUp.map((text, index) => <li key={`${text}-${index}`}><strong>Follow-up</strong><span>{text}</span></li>) : <li className="queue-empty"><strong>Follow-up</strong><span>None pending</span></li>}</ul>
      </div>}
      <div className="composer-controls">
        <div className="composer-leading-controls">
          <TaskModelControls project={project} task={task} state={modelState} disabled={active || externallyChanged} onChange={(next) => { updateModelState(next); onHistoryChange(); }} onOpenSettings={onOpenSettings} onActionStart={onActionStart} onError={onError} />
        </div>
        <div className="composer-submit-controls">
          {!active && <>
            <input ref={imagePicker} className="visually-hidden" type="file" aria-label="Choose images" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={externallyChanged} onChange={(event) => {
              void attachFiles([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = "";
            }} />
            <button type="button" className="attachment-trigger" aria-label={attachingImages ? "Preparing images" : "Attach images"} aria-describedby={imageHelpId} aria-busy={attachingImages} title="Attach images — PNG, JPEG, GIF, or WebP, up to 20 MB" disabled={attachingImages || externallyChanged} onClick={() => imagePicker.current?.click()}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.3 8.8 9.7 4.4a2.1 2.1 0 0 1 3 3l-5.5 5.5a3.5 3.5 0 0 1-5-5l5.6-5.5" /></svg>
            </button>
            <span id={imageHelpId} className="visually-hidden">Paste, drop, or select PNG, JPEG, GIF, or WebP images up to 20 MB each</span>
          </>}
          {active && !draft.trim()
            ? <button type="button" data-action="run.stop" className="composer-action stop-action" aria-label="Stop Run" title="Stop Run" onClick={() => { onActionStart(); void window.pilot.abortTask(task.path).catch((reason) => onError(reason, "The Run may already be settled. Reload the Task if its status looks stale.")); }}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" rx="1" /></svg>
            </button>
            : <button type="submit" className="composer-action send-action" aria-label="Send" title="Send" disabled={setupBlocked || externallyChanged || !draft.trim() || (active && !liveReady)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12V4M4.75 7.25 8 4l3.25 3.25" /></svg>
            </button>}

        </div>
      </div>
      </form>
    </div>
    {forkCreation && <TaskCreationDialog project={project} state={forkCreation} contextNote="The last PiLot history path is copied, but uncommitted files are never transferred between Execution locations." onCreate={createContinuityFork} onClose={() => {
      setForkCreation(undefined);
      requestAnimationFrame(() => forkReturnFocus.current?.focus());
    }} />}
  </div>;
}

function RemovedWorktreeTaskPage({ task, onCreate }: { task: TaskSummary; onCreate(): void }) {
  const removedAt = task.execution.kind === "worktree" ? task.execution.removedAt : undefined;
  return <div className="task-page removed-worktree-page">
    <header className="topbar task-topbar">
      <div><p className="eyebrow">Archived Task</p><h1 id="removed-task-title" tabIndex={-1}>{task.title}</h1><span className="execution-location">Managed Worktree removed</span></div>
      <button className="new-task-button" data-action="task.new" onClick={onCreate}>New Task</button>
    </header>
    <section className="removed-worktree-summary" aria-labelledby="removed-worktree-title">
      <h2 id="removed-worktree-title">Task history is still available</h2>
      <p>The managed Worktree was removed{removedAt ? ` on ${new Date(removedAt).toLocaleString()}` : ""}. This Task cannot run or be restored because its Execution location no longer exists.</p>
      <p>Review its Pi history in the History inspector. Any named Git branch and commits remain in the Project.</p>
    </section>
  </div>;
}

function CommandCenter({ startup, projects, runStates, onOpenTask, onCreateTask }: {
  startup?: StartupState;
  projects?: ProjectsState;
  runStates: Record<string, TaskRunState>;
  onOpenTask(projectPath: string, taskPath: string): void;
  onCreateTask(): void;
}) {
  const tasks = (projects?.projects ?? []).flatMap((project) => project.tasks
    .filter(({ lifecycle, execution }) => lifecycle === "active" && !(execution.kind === "worktree" && execution.removedAt))
    .map((task) => ({ project, task, status: taskAttentionStatus(task, runStates[task.path]) })));
  const attention = tasks.filter((item): item is typeof item & { status: TaskAttentionStatus } => Boolean(item.status));
  const groups: Array<{ status: TaskAttentionStatus; label: string }> = [
    { status: "interrupted", label: "Interrupted" },
    { status: "failed", label: "Failed" },
    { status: "waiting", label: "Waiting" },
    { status: "running", label: "Running" },
  ];
  const recent = [...tasks].sort((left, right) => right.task.modified.localeCompare(left.task.modified)).slice(0, 8);

  return <div className="command-center-page">
    <header className="topbar command-center-topbar">
      <div><h1>Command center</h1><p>Runs and Tasks across your Projects.</p></div>
      <div className="command-center-actions">
        {projects?.selected?.admitted && projects.selected.executionConsent && <button type="button" className="new-task-button" data-action="task.new" onClick={onCreateTask}>New Task</button>}
        <span className="privacy"><i /> Local only</span>
      </div>
    </header>
    {attention.length > 0 ? <section className="attention-overview" aria-label="Task attention overview">
      <header><h2>Current work</h2><p>Attention and active Runs, ordered by consequence.</p></header>
      {groups.map(({ status, label }) => {
        const items = attention.filter((item) => item.status === status);
        if (!items.length) return null;
        return <section key={status} className={`attention-group attention-${status}`} aria-label={`${label} Tasks`}>
          <div className="attention-group-heading"><h3>{label}</h3><span>{items.length}</span></div>
          <ul>{items.map(({ project, task }) => <li key={task.path}>
            <button type="button" onClick={() => onOpenTask(project.path, task.path)}>
              <TaskStateIndicator status={status} />
              <span className="attention-task-copy"><strong>{task.title}</strong><small>{project.name}</small></span>
              <span className="attention-location">{task.execution.kind === "worktree" ? "Worktree" : "Local"}</span>
            </button>
          </li>)}</ul>
        </section>;
      })}
    </section> : recent.length > 0 ? <section className="recent-tasks" aria-label="Recent Tasks">
      <header><h2>Recent Tasks</h2><p>Nothing needs attention. Continue where you left off.</p></header>
      <ul>{recent.map(({ project, task }) => <li key={task.path}><button type="button" onClick={() => onOpenTask(project.path, task.path)}>
        <span><strong>{task.title}</strong><small>{project.name} · {task.execution.kind === "worktree" ? "Worktree" : "Local"}</small></span>
        <time dateTime={task.modified}>{new Date(task.modified).toLocaleDateString()}</time>
      </button></li>)}</ul>
    </section> : null}

    {!startup ? <p role="status" className="loading">Checking your Pi environment…</p>
      : startup.gaps.length > 0 ? <section className="readiness command-readiness" aria-labelledby="readiness-title" tabIndex={0}>
        <p className="eyebrow">Action required</p>
        <h2 id="readiness-title">Readiness</h2>
        <p className="muted">Resolve these items before starting a Task.</p>
        <ol>{startup.gaps.map((gap) => <li key={gap.area}><span className="gap-mark" aria-hidden="true">!</span><div><h3>{gap.title}</h3><p>{gap.detail}</p></div></li>)}</ol>
      </section> : !attention.length && !recent.length ? <section className="ready" aria-label={`${startup.passed} readiness checks passed`}>
        <span className="ready-mark" aria-hidden="true">✓</span>
        <p className="eyebrow">Environment ready</p>
        <h2>Ready to work</h2>
        <p className="muted">Your provider, shell, and Pi environment are ready.</p>
      </section> : null}
  </div>;
}

function ProjectPage({ project, needsAccess, selectedTaskPath, reloadToken, revision, historyDraft, changePaths, onSelectTask, onCreateTask, onForkTask, onOpenAccess, onChange, onDetails, onHistoryChange, onOpenSettings, onOpenChange, onRunChange, onSetupChange, onContinuityChange, onActionStart, onError }: {
  project: ProjectAccess;
  needsAccess: boolean;
  selectedTaskPath?: string;
  reloadToken: number;
  revision: number;
  historyDraft?: { text: string; version: number };
  changePaths: string[];
  onSelectTask(path: string): void;
  onCreateTask(): void;
  onForkTask(task: TaskSummary): void;
  onOpenAccess(): void;
  onChange(state: ProjectsState): void;
  onDetails(state: TaskModelState): void;
  onHistoryChange(): void;
  onOpenSettings(): void;
  onOpenChange(path: string): void;
  onRunChange(active: boolean): void;
  onSetupChange(active: boolean): void;
  onContinuityChange(changed: boolean): void;
  onActionStart(): void;
  onError(reason: unknown, recovery: string): void;
}) {
  const active = project.tasks.filter(({ lifecycle }) => lifecycle === "active");
  const archived = project.tasks.filter(({ lifecycle }) => lifecycle === "archived");
  const selectedTask = active.find(({ path }) => path === selectedTaskPath);
  const removedTask = archived.find(({ path, execution }) => path === selectedTaskPath && execution.kind === "worktree" && execution.removedAt);
  if (selectedTask && !needsAccess) return <TaskPage project={project} task={selectedTask} reloadToken={reloadToken} revision={revision} historyDraft={historyDraft} changePaths={changePaths} onCreate={onCreateTask} onFork={onForkTask} onDetails={onDetails} onHistoryChange={onHistoryChange} onOpenSettings={onOpenSettings} onOpenChange={onOpenChange} onRunChange={onRunChange} onSetupChange={onSetupChange} onContinuityChange={onContinuityChange} onActionStart={onActionStart} onError={onError} />;
  if (removedTask && !needsAccess) return <RemovedWorktreeTaskPage task={removedTask} onCreate={onCreateTask} />;
  return <>
    <header className="topbar project-topbar">
      <div><p className="eyebrow">Project</p><h1>{project.name}</h1><code>{project.path}</code></div>
      <div className="project-top-actions"><span className="privacy"><i /> Local only</span><ProjectActions project={project} onOpenAccess={onOpenAccess} onChange={onChange} onActionStart={onActionStart} onError={onError} /></div>
    </header>
    {needsAccess ? <section className="project-empty" aria-live="polite">
      <h2>Access required</h2>
      <p>Complete the access decision to admit this Project.</p>
    </section> : <div className="task-overview">
      {project.diagnostics.length > 0 && <section className="task-diagnostics" aria-label="Task diagnostics">
        {project.diagnostics.map((diagnostic) => <div key={diagnostic.title}><strong>{diagnostic.title}</strong><p>{diagnostic.detail}</p></div>)}
      </section>}
      <section className="task-section" aria-label="Active tasks">
        <div className="task-section-heading"><h2>Active Tasks</h2><div><span>{active.length}</span><button className="new-task-button" data-action="task.new" onClick={onCreateTask}>New Task</button></div></div>
        {active.length ? <ul>{active.map((task) => <li key={task.path}><button className="task-title-button" onClick={() => onSelectTask(task.path)}>{task.title}</button><span>Active</span><button onClick={() => { onActionStart(); void window.pilot.setTaskArchived(project.path, task.path, true).then(onChange).catch((reason) => onError(reason, "Stop the Run or reload the Task, then try archiving again.")); }}>Archive</button></li>)}</ul> : <p className="muted">No active Tasks</p>}
      </section>
      <section className="task-section" aria-label="Archived tasks">
        <div className="task-section-heading"><h2>Archived Tasks</h2><span>{archived.length}</span></div>
        {archived.length ? <ul>{archived.map((task) => <li key={task.path}><strong>{task.title}</strong><span>{task.execution.kind === "worktree" ? task.execution.removedAt ? "Worktree removed" : "Archived · Worktree retained" : "Archived"}</span>{task.execution.kind === "worktree" && task.execution.removedAt ? <button onClick={() => onSelectTask(task.path)}>View history</button> : <button onClick={() => { onActionStart(); void window.pilot.setTaskArchived(project.path, task.path, false).then(onChange).catch((reason) => onError(reason, "Reload the Project and try restoring the Task again.")); }}>Restore</button>}</li>)}</ul> : <p className="muted">No archived Tasks</p>}
      </section>
    </div>}
  </>;
}

function applyAppearance(appearance: Appearance) {
  document.documentElement.dataset.appearance = appearance;
}

function GeneralSettings() {
  const [appearance, setAppearance] = useState<Appearance>();
  const [expandThinking, setExpandThinking] = useState(false);
  const [globalRunCap, setGlobalRunCap] = useState<string>();
  const [savedGlobalRunCap, setSavedGlobalRunCap] = useState(4);
  const [runCapSaving, setRunCapSaving] = useState(false);
  const [runCapError, setRunCapError] = useState("");
  const [notifications, setNotifications] = useState<NotificationPreferences>();
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const [terminals, setTerminals] = useState<TerminalState>();
  const [terminalSaving, setTerminalSaving] = useState(false);
  const [terminalError, setTerminalError] = useState("");
  useEffect(() => {
    void window.pilot.getPreferences().then((value) => {
      setAppearance(value.appearance);
      setExpandThinking(value.expandThinking);
      setGlobalRunCap(String(value.globalRunCap));
      setSavedGlobalRunCap(value.globalRunCap);
      setNotifications(value.notifications);
      applyAppearance(value.appearance);
    });
    void window.pilot.getTerminalState().then(setTerminals).catch((reason) => setTerminalError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  const saveNotification = (key: keyof NotificationPreferences, enabled: boolean) => {
    if (!notifications || notificationSaving) return;
    const previous = notifications;
    const next = { ...notifications, [key]: enabled };
    setNotificationError("");
    setNotificationSaving(true);
    setNotifications(next);
    void window.pilot.setNotificationPreferences(next).then((saved) => setNotifications(saved.notifications)).catch((reason) => {
      setNotifications(previous);
      setNotificationError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setNotificationSaving(false));
  };
  const saveRunCap = () => {
    const limit = Number(globalRunCap);
    if (!Number.isInteger(limit) || limit < MINIMUM_GLOBAL_RUN_CAP || limit > MAXIMUM_GLOBAL_RUN_CAP) {
      setRunCapError(`Choose a whole number from ${MINIMUM_GLOBAL_RUN_CAP} to ${MAXIMUM_GLOBAL_RUN_CAP}.`);
      setGlobalRunCap(String(savedGlobalRunCap));
      return;
    }
    if (limit === savedGlobalRunCap || runCapSaving) return;
    setRunCapError("");
    setRunCapSaving(true);
    void window.pilot.setGlobalRunCap(limit).then((next) => {
      setGlobalRunCap(String(next.globalRunCap));
      setSavedGlobalRunCap(next.globalRunCap);
    }).catch((reason) => {
      setGlobalRunCap(String(savedGlobalRunCap));
      setRunCapError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setRunCapSaving(false));
  };

  return <section className="general-settings" aria-labelledby="general-title">
    <p className="eyebrow">Application</p>
    <h2 id="general-title">General</h2>
    <p className="muted">Choose how PiLot looks, presents Run evidence, and opens external tools on this device.</p>
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
    <fieldset className="run-cap-setting" disabled={globalRunCap === undefined || runCapSaving} aria-busy={runCapSaving}>
      <legend>Concurrent Runs</legend>
      <label>
        <span><strong>Active Run limit</strong><small>Additional starts wait in order until capacity is available.</small></span>
        <input type="number" aria-label="Active Run limit" min={MINIMUM_GLOBAL_RUN_CAP} max={MAXIMUM_GLOBAL_RUN_CAP} step="1" inputMode="numeric" value={globalRunCap ?? ""} onChange={(event) => setGlobalRunCap(event.target.value)} onBlur={saveRunCap} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      </label>
      {runCapError && <p className="error run-cap-error" role="alert">Could not update the active Run limit: {runCapError}</p>}
    </fieldset>
    <fieldset className="notification-setting" disabled={!notifications || notificationSaving} aria-busy={notificationSaving}>
      <legend>Notifications</legend>
      <p className="notification-guidance" role="note">PiLot sends these only while its window is unfocused or running in the background. Click a notification to return to PiLot.</p>
      {notifications && ([
        ["runCompleted", "Run completed", "When a Run settles successfully."],
        ["runFailed", "Run failed", "When a Run fails or is interrupted."],
        ["attentionRequired", "Attention required", "When Pi needs a decision or input."],
      ] as const).map(([key, label, detail]) => <label key={key}>
        <input type="checkbox" aria-label={label} checked={notifications[key]} onChange={(event) => saveNotification(key, event.target.checked)} />
        <span><strong>{label}</strong><small>{detail}</small></span>
      </label>)}
      {notificationError && <p className="error terminal-setting-notice" role="alert">Could not update notification preferences: {notificationError}</p>}
    </fieldset>
    <fieldset className="terminal-setting" disabled={!terminals || terminalSaving}>
      <legend>External terminal</legend>
      {terminals?.available.map((terminal) => <label key={terminal.id}>
        <input type="radio" name="terminal" value={terminal.id} checked={terminals.preferred === terminal.id} onChange={() => {
          const previous = terminals;
          setTerminalError("");
          setTerminalSaving(true);
          setTerminals({ ...terminals, preferred: terminal.id, storedPreferred: terminal.id, notice: undefined });
          void window.pilot.setPreferredTerminal(terminal.id).then(setTerminals).catch((reason) => {
            setTerminals(previous);
            setTerminalError(reason instanceof Error ? reason.message : String(reason));
          }).finally(() => setTerminalSaving(false));
        }} />
        <span><strong>{terminal.label}</strong><small>{terminal.id === "system" ? "Use the host-platform default" : `Open Worktrees in ${terminal.label}`}</small></span>
      </label>)}
      {terminals?.notice && <p className="muted terminal-setting-notice" role="note">{terminals.notice}</p>}
      {terminalError && <p className="error terminal-setting-notice" role="alert">Could not update the terminal preference: {terminalError}</p>}
    </fieldset>
    <fieldset className="thinking-setting">
      <legend>Run evidence</legend>
      <label>
        <input type="checkbox" checked={expandThinking} onChange={(event) => {
          const checked = event.target.checked;
          setExpandThinking(checked);
          void window.pilot.setExpandThinking(checked).then((next) => setExpandThinking(next.expandThinking));
        }} />
        <span><strong>Expand thinking by default</strong><small>Thinking remains available as a keyboard-accessible disclosure in every Run.</small></span>
      </label>
    </fieldset>
  </section>;
}

type SettingsDestination = "general" | "agent" | "providers" | "diagnostics";

function DiagnosticsSettings() {
  const [preview, setPreview] = useState<DiagnosticBundle>();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    setMessage("");
    void window.pilot.getDiagnosticPreview().then(setPreview).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const events = preview ? [...preview.events].reverse() : [];
  const grouped = diagnosticCategories.flatMap((category) => {
    const items = events.filter((event) => event.category === category);
    return items.length ? [{ category, items }] : [];
  });
  const exportBundle = () => {
    if (exporting) return;
    setExporting(true);
    setError("");
    setMessage("");
    void window.pilot.exportDiagnosticBundle().then((exported) => {
      if (exported) setMessage("Diagnostic bundle exported to the selected local file.");
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => setExporting(false));
  };

  return <section className="diagnostics-settings" aria-labelledby="diagnostics-title">
    <div className="settings-page-heading">
      <div><p className="eyebrow">Support</p><h2 id="diagnostics-title">Diagnostics</h2></div>
      <button type="button" disabled={loading || exporting} onClick={load}>Refresh preview</button>
    </div>
    <p className="settings-introduction">Inspect bounded local support events before choosing whether to export them.</p>
    <div className="diagnostic-privacy" role="note">
      <strong>Local only</strong>
      <p>PiLot collects no analytics and makes no automatic crash uploads. Diagnostic events stay on this device until you explicitly export a bundle.</p>
      <p>Secrets are redacted; Task transcripts, source, paths, and diffs are excluded by default.</p>
    </div>
    {loading ? <p role="status" className="muted">Loading diagnostic preview…</p> : error && !preview ? <p className="error" role="alert">Could not load diagnostics: {error}</p> : preview && <>
      <dl className="diagnostic-environment" aria-label="Diagnostic environment">
        <div><dt>PiLot</dt><dd>{preview.application.version}</dd></div>
        <div><dt>Runtime</dt><dd>Electron {preview.application.electronVersion} · Node {preview.application.nodeVersion}</dd></div>
        <div><dt>Platform</dt><dd>{preview.application.platform} · {preview.application.architecture} · {preview.application.packaged ? "Packaged" : "Development"}</dd></div>
      </dl>
      <section className="diagnostic-preview" aria-label="Diagnostic preview">
        <header>
          <div><h3>Included events</h3><p>{events.length} bounded event{events.length === 1 ? "" : "s"}</p></div>
          <button type="button" className="primary-action" disabled={exporting} onClick={exportBundle}>{exporting ? "Exporting…" : "Export diagnostic bundle"}</button>
        </header>
        {grouped.length ? grouped.map(({ category, items }: { category: DiagnosticCategory; items: typeof events }) => <section key={category} className="diagnostic-category" aria-labelledby={`diagnostic-${category}`}>
          <h3 id={`diagnostic-${category}`}>{diagnosticCategoryLabels[category]} <span>{items.length}</span></h3>
          <ol>{items.map((event, index) => <li key={`${event.timestamp}-${event.operation}-${index}`}>
            <div><strong>{event.summary}</strong><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString()}</time></div>
            <p>{event.guidance}</p>
            <code>{event.operation}{event.code ? ` · ${event.code}` : ""}</code>
          </li>)}</ol>
        </section>) : <p className="diagnostic-empty">No support failures have been recorded. The bounded local log contains only application startup.</p>}
      </section>
    </>}
    {message && <p className="success settings-feedback" role="status">{message}</p>}
    {error && preview && <p className="error settings-feedback" role="alert">Diagnostic action failed: {error}</p>}
  </section>;
}

function SettingsPage({ initialDestination, onChange, onClose }: { initialDestination: SettingsDestination; onChange(): void; onClose(): void }) {
  const [destination, setDestination] = useState<SettingsDestination>(initialDestination);
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
        <button aria-current={destination === "agent" ? "page" : undefined} onClick={() => setDestination("agent")}>Agent</button>
        <button aria-current={destination === "providers" ? "page" : undefined} onClick={() => setDestination("providers")}>Providers</button>
        <button aria-current={destination === "diagnostics" ? "page" : undefined} onClick={() => setDestination("diagnostics")}>Diagnostics</button>
      </nav>
    </aside>
    <main className="settings-main" aria-label="Settings">
      {destination === "general" ? <GeneralSettings /> : destination === "agent" ? <AgentSettings /> : destination === "providers" ? <ProviderSettings onChange={onChange} /> : <DiagnosticsSettings />}
    </main>
  </div>;
}

type ActionAvailability = Record<DesktopActionId, { enabled: boolean; reason?: string; label?: string; hidden?: boolean }>;

function shortcutLabel(accelerator?: string) {
  if (!accelerator) return "";
  const parts = accelerator.split("+");
  if (window.pilot.platform !== "darwin") return parts.map((part) => part === "CommandOrControl" ? "Ctrl" : part).join("+");
  const symbols: Record<string, string> = { Control: "⌃", Alt: "⌥", Shift: "⇧", CommandOrControl: "⌘" };
  const order = ["Control", "Alt", "Shift", "CommandOrControl"];
  return [...parts.filter((part) => order.includes(part)).sort((left, right) => order.indexOf(left) - order.indexOf(right)), ...parts.filter((part) => !order.includes(part))]
    .map((part) => symbols[part] ?? part).join("");
}

function CommandPalette({ open, availability, onClose, onInvoke }: {
  open: boolean;
  availability: ActionAvailability;
  onClose(): void;
  onInvoke(id: DesktopActionId, returnFocus?: HTMLElement | null): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const labelFor = (action: typeof desktopActions[number]) => availability[action.id].label ?? action.label;
  const matches = desktopActions.flatMap((action, order) => {
    if (action.id === "view.commandPalette" || availability[action.id].hidden) return [];
    const fields = [labelFor(action), action.menu, ...action.keywords.split(/\s+/)];
    const scores = words.map((word) => fields.map((field) => fuzzyMatchScore(field, word)).filter((score): score is number => score !== null));
    if (scores.some((fieldScores) => !fieldScores.length)) return [];
    return [{ action, order, score: scores.reduce((total, fieldScores) => total + Math.min(...fieldScores), 0) }];
  });
  const menuOrder = ["File", "Task", "Run", "View"];
  const results = matches.sort((left, right) => Number(availability[right.action.id].enabled) - Number(availability[left.action.id].enabled)
    || menuOrder.indexOf(left.action.menu) - menuOrder.indexOf(right.action.menu)
    || left.score - right.score || left.order - right.order).map(({ action }) => action);
  const enabledIndices = results.flatMap((action, index) => availability[action.id].enabled ? [index] : []);
  const activeIndex = enabledIndices.includes(selected) ? selected : enabledIndices[0] ?? -1;
  const groups = results.reduce<Array<{ label: string; items: Array<{ action: typeof desktopActions[number]; index: number }> }>>((value, action, index) => {
    const state = availability[action.id];
    const label = state.enabled ? `${words.length ? "Results" : "Available now"} · ${action.menu}` : `Unavailable · ${action.menu}`;
    const group = value.at(-1);
    if (!group || group.label !== label) value.push({ label, items: [{ action, index }] });
    else group.items.push({ action, index });
    return value;
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      previousFocus.current = document.activeElement as HTMLElement | null;
      restoreFocus.current = true;
      setQuery("");
      setSelected(0);
      element.showModal();
      requestAnimationFrame(() => search.current?.focus());
    } else if (!open && element.open) {
      element.close();
      if (restoreFocus.current) requestAnimationFrame(() => previousFocus.current?.focus());
    }
  }, [open]);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    if (activeIndex >= 0) dialog.current?.querySelector<HTMLElement>(`#command-palette-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [query, activeIndex]);

  const invoke = (id: DesktopActionId) => {
    if (!availability[id].enabled) return;
    restoreFocus.current = !["task.new", "task.archive", "task.chooseModel", "task.chooseThinking", "run.compact", "view.focusPrompt", "view.details", "view.settings"].includes(id);
    onClose();
    requestAnimationFrame(() => onInvoke(id, previousFocus.current));
  };

  return <dialog ref={dialog} className="command-palette" aria-label="Command Palette" onCancel={(event) => { event.preventDefault(); restoreFocus.current = true; onClose(); }}>
    <label><span className="visually-hidden">Search actions</span><input ref={search} type="search" role="combobox" aria-label="Search actions" aria-expanded="true" aria-controls="command-palette-results" aria-activedescendant={activeIndex >= 0 ? `command-palette-option-${activeIndex}` : undefined} placeholder="Type an action…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        restoreFocus.current = true;
        onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (enabledIndices.length) {
          const current = Math.max(0, enabledIndices.indexOf(activeIndex));
          setSelected(enabledIndices[(current + (event.key === "ArrowDown" ? 1 : -1) + enabledIndices.length) % enabledIndices.length]);
        }
        event.preventDefault();
      } else if (event.key === "Home" || event.key === "End") {
        if (enabledIndices.length) setSelected(event.key === "Home" ? enabledIndices[0] : enabledIndices.at(-1)!);
        event.preventDefault();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (activeIndex >= 0) invoke(results[activeIndex].id);
      }
    }} /></label>
    <span className="visually-hidden" role="status" aria-live="polite">{results.length} action{results.length === 1 ? "" : "s"} found</span>
    <div id="command-palette-results" className="command-palette-results" role="listbox" aria-label="Actions">
      {!enabledIndices.length && results.length > 0 && <p className="command-palette-empty-state" role="status">No actions are available here. Return to the command center to continue.</p>}
      {groups.map((group) => <div key={`${group.label}-${group.items[0].index}`} className="command-palette-result-group" role="group" aria-label={group.label}>
        <div className="command-palette-group" aria-hidden="true">{group.label}</div>
        {group.items.map(({ action, index }) => {
          const state = availability[action.id];
          return <button id={`command-palette-option-${index}`} key={action.id} type="button" role="option" tabIndex={-1} aria-selected={activeIndex === index} aria-disabled={!state.enabled} onMouseMove={() => { if (state.enabled) setSelected(index); }} onClick={() => invoke(action.id)}>
            <span><strong>{labelFor(action)}</strong><small>{state.enabled ? action.menu : state.reason}</small></span>
            {"accelerator" in action && <kbd>{shortcutLabel(action.accelerator)}</kbd>}
          </button>;
        })}
      </div>)}
      {!results.length && <p role="status">No actions found</p>}
    </div>
  </dialog>;
}

type ActionFailure = { message: string; recovery: string; retryProjectState?: boolean; preserveOnContextChange?: boolean };
type LoadedDesktopState = {
  startup: StartupState;
  projects: ProjectsState;
  preferences: Preferences;
  selectionFailure?: { reason: unknown };
};

const failureMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

class ProjectStateLoadFailure extends Error {
  constructor(reason: unknown) {
    super(failureMessage(reason), { cause: reason });
    this.name = "ProjectStateLoadFailure";
  }
}

function startupFailure(reason: unknown): ActionFailure {
  const projectStateLoadFailed = reason instanceof ProjectStateLoadFailure;
  return {
    message: failureMessage(reason),
    recovery: projectStateLoadFailed
      ? "Repair projects.json or restore read access. Delete it only to reset recent Projects and execution consent."
      : "Check PiLot's local state and Pi environment file access, then reopen the app.",
    preserveOnContextChange: true,
    ...(projectStateLoadFailed ? { retryProjectState: true } : {}),
  };
}

function ActionError({ failure, onDismiss, onRetry }: { failure: ActionFailure; onDismiss(): void; onRetry(): void }) {
  return <div className="action-error" role="alert">
    <span><strong>Action failed.</strong> {failure.message}<small>{failure.recovery}</small></span>
    <div className="action-error-actions">
      {failure.retryProjectState && <button type="button" className="action-error-retry" aria-label="Retry Project state" onClick={onRetry}>Retry</button>}
      <button type="button" aria-label="Dismiss error" onClick={onDismiss}>×</button>
    </div>
  </div>;
}

function useWindowActive() {
  const [windowActive, setWindowActive] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const stopListening = window.pilot.onWindowActivity((active) => {
      receivedEvent = true;
      if (!cancelled) setWindowActive(active);
    });
    void window.pilot.getWindowActivity().then((active) => {
      if (!cancelled && !receivedEvent) setWindowActive(active);
    }).catch(() => { if (!cancelled && !receivedEvent) setWindowActive(false); });
    return () => {
      cancelled = true;
      stopListening();
    };
  }, []);
  return windowActive;
}

function App() {
  const [state, setState] = useState<StartupState>();
  const [projects, setProjects] = useState<ProjectsState>();
  const [selectedTaskPath, setSelectedTaskPath] = useState<string>();
  const [showHome, setShowHome] = useState(true);
  const [recentSelection, setRecentSelection] = useState<RecentSelection>({});
  const [desktopPreferencesLoaded, setDesktopPreferencesLoaded] = useState(false);
  const [runStates, setRunStates] = useState<Record<string, TaskRunState>>({});
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDestination, setSettingsDestination] = useState<SettingsDestination>("general");
  const [showProjectAccess, setShowProjectAccess] = useState(false);
  const [taskCreation, setTaskCreation] = useState<TaskCreationState>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [runActive, setRunActive] = useState(false);
  const [setupActive, setSetupActive] = useState(false);
  const [taskExternallyChanged, setTaskExternallyChanged] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => matchMedia(COMPACT_LAYOUT_MEDIA).matches);
  const [shellWidth, setShellWidth] = useState(() => window.innerWidth);
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(DEFAULT_PANE_WIDTHS);
  const [committedPaneWidths, setCommittedPaneWidths] = useState<PaneWidths>(DEFAULT_PANE_WIDTHS);
  const windowActive = useWindowActive();
  const [actionError, setActionError] = useState<ActionFailure>();
  const [taskDetails, setTaskDetails] = useState<TaskModelState>();
  const [inspectorView, setInspectorView] = useState<InspectorView>("details");
  const [taskChanges, setTaskChanges] = useState<TaskChanges>();
  const [changesError, setChangesError] = useState("");
  const [selectedChangePath, setSelectedChangePath] = useState<string>();
  const [taskHistory, setTaskHistory] = useState<TaskHistoryState>();
  const [historyError, setHistoryError] = useState("");
  const [taskRevision, setTaskRevision] = useState(0);
  const [historyDraft, setHistoryDraft] = useState<{ taskPath: string; text: string; version: number }>();
  const shell = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const mobileNavigationButton = useRef<HTMLButtonElement>(null);
  const navigationPanel = useRef<HTMLElement>(null);
  const detailsReturnFocus = useRef<HTMLElement | null>(null);
  const lastInspectorFocus = useRef<HTMLElement | null>(null);
  const focusWasInInspector = useRef(false);
  const taskCreationReturnFocus = useRef<HTMLElement | null>(null);
  const taskCreationPreviousTask = useRef<string | undefined>(undefined);
  const taskChangesRef = useRef<TaskChanges | undefined>(undefined);
  useLayoutEffect(() => { taskChangesRef.current = taskChanges; }, [taskChanges]);
  const loadDesktopState = useCallback(async (): Promise<LoadedDesktopState> => {
    const [startup, projectState, preferences] = await Promise.all([
      window.pilot.getStartupState(),
      window.pilot.loadProjectsState().then((result) => {
        if (result.status === "unreadable") throw new ProjectStateLoadFailure(result.message);
        return result.state;
      }),
      window.pilot.getPreferences(),
    ]);
    let projects = projectState;
    let selectionFailure: { reason: unknown } | undefined;
    const recentProject = preferences.recentSelection.projectPath;
    if (recentProject && projectState.projects.some(({ path }) => path === recentProject) && projectState.selected?.path !== recentProject) {
      try {
        projects = await window.pilot.selectProject(recentProject);
      } catch (reason) {
        selectionFailure = { reason };
      }
    }
    return { startup, projects, preferences, ...(selectionFailure ? { selectionFailure } : {}) };
  }, []);
  const applyDesktopState = useCallback(({ startup, projects: nextProjects, preferences, selectionFailure }: LoadedDesktopState) => {
    setState(startup);
    setProjects(nextProjects);
    setRecentSelection(preferences.recentSelection);
    const recentTask = nextProjects.selected?.tasks.find(({ path }) => path === preferences.recentSelection.taskPath);
    setSelectedTaskPath(recentTask?.path);
    setShowDetails(preferences.panes.inspectorVisible);
    setInspectorView(preferences.panes.inspectorView);
    const preferredPaneWidths = {
      navigation: preferences.panes.navigationWidth,
      inspector: preferences.panes.inspectorWidth,
    };
    setPaneWidths(preferredPaneWidths);
    setCommittedPaneWidths(preferredPaneWidths);
    applyAppearance(preferences.appearance);
    setDesktopPreferencesLoaded(true);
    setActionError(selectionFailure ? startupFailure(selectionFailure.reason) : undefined);
  }, []);
  const retryProjectState = useCallback(() => {
    setActionError(undefined);
    void loadDesktopState().then(applyDesktopState).catch((reason) => setActionError(startupFailure(reason)));
  }, [applyDesktopState, loadDesktopState]);
  const refresh = useCallback(() => void Promise.all([window.pilot.getStartupState(), window.pilot.getProjects()]).then(([startup, projectState]) => {
    setState(startup);
    setProjects(projectState);
  }), []);
  const closeSettings = useCallback(() => {
    setShowSettings(false);
    requestAnimationFrame(() => requestAnimationFrame(() => (
      matchMedia("(max-width: 679px)").matches ? mobileNavigationButton.current : settingsButton.current
    )?.focus()));
  }, []);
  const closeNavigation = useCallback((restoreFocus = false) => {
    setNavigationOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mobileNavigationButton.current?.focus());
  }, []);
  const closeNavigationToContent = useCallback(() => {
    setNavigationOpen(false);
    requestAnimationFrame(() => document.getElementById("content")?.focus());
  }, []);
  const closeProjectAccess = useCallback(() => setShowProjectAccess(false), []);
  const updateProjectAccess = useCallback((next: ProjectsState) => {
    setProjects(next);
    const selected = next.selected;
    if (!showProjectAccess && selected?.executionConsent && (!selected.resourceTrust.required || selected.resourceTrust.decision !== null)) {
      setShowProjectAccess(false);
      setShowHome(false);
    }
  }, [showProjectAccess]);
  const createTaskFromRequest = useCallback(async (request: TaskCreationRequest) => {
    const project = projects?.selected;
    if (!project) return;
    const task = await window.pilot.createTask(project.path, request);
    setTaskCreation(undefined);
    setProjects(await window.pilot.getProjects());
    setTaskDetails(undefined);
    setSelectedTaskPath(task.path);
    setShowHome(false);
  }, [projects?.selected?.path]);
  const createSelectedTask = useCallback(async (returnFocus?: HTMLElement | null) => {
    const project = projects?.selected;
    if (!project) return;
    taskCreationPreviousTask.current = selectedTaskPath;
    taskCreationReturnFocus.current = returnFocus ?? (document.activeElement as HTMLElement | null);
    setSelectedTaskPath(undefined);
    setActionError(undefined);
    try {
      const creation = await window.pilot.getTaskCreation(project.path);
      if (creation.repository) setTaskCreation(creation);
      else await createTaskFromRequest({ kind: "local" });
    } catch (reason) {
      setSelectedTaskPath(taskCreationPreviousTask.current);
      setActionError({ message: reason instanceof Error ? reason.message : String(reason), recovery: "Check Project access and try creating the Task again." });
    }
  }, [createTaskFromRequest, projects?.selected?.path, selectedTaskPath]);
  const closeTaskCreation = useCallback(() => {
    setTaskCreation(undefined);
    setSelectedTaskPath(taskCreationPreviousTask.current);
    requestAnimationFrame(() => taskCreationReturnFocus.current?.focus());
  }, []);
  const openProviderSettings = useCallback(() => {
    setSettingsDestination("providers");
    setShowSettings(true);
  }, []);
  const closeDetails = useCallback(() => {
    setShowDetails(false);
    requestAnimationFrame(() => detailsReturnFocus.current?.focus());
  }, []);
  const openChange = useCallback((filePath: string) => {
    const target = taskChangesRef.current?.files.find((file) => file.path === filePath || file.previousPath === filePath)?.path;
    if (!target) return;
    detailsReturnFocus.current = document.activeElement as HTMLElement | null;
    setSelectedChangePath(target);
    setInspectorView("changes");
    setShowDetails(true);
    requestAnimationFrame(() => document.getElementById("inspector-changes-tab")?.focus());
  }, []);
  const clearActionError = useCallback(() => setActionError(undefined), []);
  const reportActionError = useCallback((reason: unknown, recovery: string) => {
    setActionError({ message: reason instanceof Error ? reason.message : String(reason), recovery });
  }, []);
  const refreshTaskProjection = useCallback((taskPath: string) => {
    setRunStates((current) => {
      const next = { ...current };
      delete next[taskPath];
      return next;
    });
    setTaskRevision((value) => value + 1);
    void window.pilot.getProjects().then(setProjects).catch((reason) => reportActionError(reason, "Reload the Project to refresh Task state."));
  }, [reportActionError]);
  const openTaskFromHome = useCallback((projectPath: string, taskPath: string) => {
    setActionError(undefined);
    void window.pilot.selectProject(projectPath).then((next) => {
      setProjects(next);
      setTaskDetails(undefined);
      setSelectedTaskPath(taskPath);
      setShowHome(false);
    }).catch((reason) => reportActionError(reason, "Reload the Project list and try opening the Task again."));
  }, [reportActionError]);
  const handleRunChange = useCallback((active: boolean) => setRunActive(active), []);
  const handleSetupChange = useCallback((active: boolean) => setSetupActive(active), []);
  const handleContinuityChange = useCallback((changed: boolean) => setTaskExternallyChanged(changed), []);
  const applyTaskChanges = useCallback((next: TaskChanges) => {
    setTaskChanges(next);
    setChangesError("");
    setSelectedChangePath((current) => current && next.files.some(({ path }) => path === current) ? current : next.files[0]?.path);
  }, []);
  const requestTaskChanges = useCallback(async (projectPath: string, taskPath: string, cancelled: () => boolean) => {
    try {
      const next = await window.pilot.getTaskChanges(projectPath, taskPath);
      if (!cancelled()) applyTaskChanges(next);
    } catch (reason) {
      if (!cancelled()) {
        setTaskChanges(undefined);
        setChangesError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [applyTaskChanges]);

  const selectedProject = projects?.selected;
  const surfaceProject = showHome ? undefined : selectedProject;
  const selectedTask = surfaceProject?.tasks.find(({ path }) => path === selectedTaskPath);
  const mobileContextTitle = showHome ? "Command center" : selectedTask?.title ?? selectedProject?.name ?? "Workspace";
  const mobileContextKind = showHome ? "PiLot" : selectedTask ? selectedProject?.name ?? "Task" : "Project";
  const removedWorktreeAt = selectedTask?.execution.kind === "worktree" ? selectedTask.execution.removedAt : undefined;
  const needsProjectAccess = Boolean(selectedProject && (!selectedProject.executionConsent || (selectedProject.resourceTrust.required && selectedProject.resourceTrust.decision === null)));
  const workspaceAvailable = !showSettings;
  const taskAvailable = Boolean(workspaceAvailable && selectedTask && !removedWorktreeAt && !needsProjectAccess);
  const taskChangesAvailable = Boolean(workspaceAvailable && selectedProject && selectedTask && !removedWorktreeAt && !needsProjectAccess);
  const changesInspectorVisible = (!compactLayout || showDetails) && inspectorView === "changes";
  const changesPollingInterval = changesInspectorVisible ? 1_500 : 3_000;
  const changePathsKey = taskChanges?.files.flatMap(({ path, previousPath }) => previousPath ? [path, previousPath] : [path]).join("\0") ?? "";
  const changePaths = useMemo(() => changePathsKey ? changePathsKey.split("\0") : [], [changePathsKey]);
  const effectivePaneWidths = useMemo(() => constrainedPaneWidths(shellWidth, paneWidths), [paneWidths, shellWidth]);
  const navigationMaximum = MAXIMUM_NAVIGATION_PANE_WIDTH;
  const inspectorMaximum = Math.min(MAXIMUM_INSPECTOR_PANE_WIDTH, Math.max(
    MINIMUM_INSPECTOR_PANE_WIDTH,
    shellWidth - MINIMUM_PRIMARY_PANE_WIDTH - effectivePaneWidths.navigation,
  ));
  const paneShellStyle: PaneShellStyle = {
    "--navigation-pane-width": `${effectivePaneWidths.navigation}px`,
    "--inspector-pane-width": `${effectivePaneWidths.inspector}px`,
    "--primary-pane-min-width": `${MINIMUM_PRIMARY_PANE_WIDTH}px`,
  };
  const previewPaneWidth = useCallback((pane: PaneName, width: number) => {
    setPaneWidths((current) => ({ ...current, [pane]: width }));
  }, []);
  const commitPaneWidth = useCallback((pane: PaneName, width: number) => {
    setPaneWidths((current) => ({ ...current, [pane]: width }));
    setCommittedPaneWidths((current) => ({ ...current, [pane]: width }));
  }, []);
  useEffect(() => {
    setTaskChanges(undefined);
    setChangesError("");
    setSelectedChangePath(undefined);
  }, [selectedProject?.path, selectedTask?.path, removedWorktreeAt, needsProjectAccess]);
  useEffect(() => {
    if (!taskChangesAvailable || !windowActive || !selectedProject || !selectedTask) return;
    // Refresh on context/focus changes; use a faster cadence only while Changes is visible.
    let cancelled = false;
    let timer = 0;
    const refreshChanges = async () => {
      await requestTaskChanges(selectedProject.path, selectedTask.path, () => cancelled);
      if (!cancelled) timer = window.setTimeout(refreshChanges, changesPollingInterval);
    };
    void refreshChanges();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [selectedProject?.path, selectedTask?.path, taskChangesAvailable, taskRevision, changesPollingInterval, windowActive, requestTaskChanges]);
  useEffect(() => {
    let cancelled = false;
    setTaskHistory(undefined);
    setHistoryError("");
    if (!selectedProject || !selectedTask || needsProjectAccess) return;
    void window.pilot.getTaskHistory(selectedProject.path, selectedTask.path).then((next) => {
      if (!cancelled) setTaskHistory(next);
    }).catch((reason) => {
      if (!cancelled) setHistoryError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [selectedProject?.path, selectedTask?.path, removedWorktreeAt, needsProjectAccess, taskRevision]);
  const unavailable = (reason: string) => ({ enabled: false, reason });
  const availability: ActionAvailability = {
    "project.add": workspaceAvailable ? { enabled: true } : unavailable("Return to the command center to add a Project"),
    "task.new": taskAvailable || Boolean(workspaceAvailable && selectedProject?.admitted && !needsProjectAccess) ? { enabled: true } : unavailable("Select a Project with access enabled"),
    "task.exportJsonl": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task"),
    "task.exportHtml": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task"),
    "task.archive": taskAvailable && !runActive && !setupActive && !taskExternallyChanged ? { enabled: true } : unavailable(taskExternallyChanged ? "Reload or fork the externally changed Task first" : setupActive ? "Stop Worktree setup first" : runActive ? "Stop the active Run first" : "Select a Task"),
    "task.chooseModel": taskAvailable && !runActive && !taskExternallyChanged && Boolean(taskDetails?.selected) ? { enabled: true } : unavailable(taskExternallyChanged ? "Reload or fork the externally changed Task first" : runActive ? "Stop the active Run first" : "Select a Task with an available model"),
    "task.chooseThinking": taskAvailable && !runActive && !taskExternallyChanged && (taskDetails?.thinkingLevels.length ?? 0) > 1 ? { enabled: true } : unavailable(taskExternallyChanged ? "Reload or fork the externally changed Task first" : runActive ? "Stop the active Run first" : "No alternative thinking levels"),
    "resources.reload": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task"),
    "run.compact": taskAvailable && !runActive && !taskExternallyChanged ? { enabled: true } : unavailable(taskExternallyChanged ? "Reload or fork the externally changed Task first" : runActive ? "A Run is active" : "Select a Task"),
    "run.stop": runActive ? { enabled: true } : unavailable("No Run is active"),
    "view.focusPrompt": taskAvailable && !taskExternallyChanged ? { enabled: true } : unavailable(taskExternallyChanged ? "Reload or fork the externally changed Task first" : "Select a Task"),
    "view.details": workspaceAvailable ? { enabled: true, label: compactLayout ? showDetails ? "Hide Details" : "Show Details" : "Focus Details" } : unavailable("Return to the command center"),
    "view.settings": showSettings ? { enabled: false, hidden: true, reason: "Settings are open" } : { enabled: true },
    "view.commandPalette": { enabled: true },
  };

  const invokeAction = useCallback((id: DesktopActionId, returnFocus?: HTMLElement | null) => {
    if (!availability[id].enabled) return;
    const attempt = (operation: Promise<unknown>, recovery: string) => {
      setActionError(undefined);
      void operation.catch((reason) => setActionError({ message: reason instanceof Error ? reason.message : String(reason), recovery }));
    };
    if (id === "view.commandPalette") { setPaletteOpen(true); return; }
    if (id === "view.settings") { setSettingsDestination("general"); setShowSettings(true); return; }
    if (id === "view.details") {
      if (compactLayout && showDetails) { closeDetails(); return; }
      detailsReturnFocus.current = returnFocus ?? document.activeElement as HTMLElement | null;
      setInspectorView("details");
      setShowDetails(true);
      requestAnimationFrame(() => document.getElementById("inspector-details-tab")?.focus());
      return;
    }
    if (id === "project.add") { attempt(window.pilot.addProject().then(setProjects), "Choose another folder or check its permissions, then try again."); return; }
    if (id === "task.new") { void createSelectedTask(returnFocus); return; }
    if (id === "task.archive" && selectedProject && selectedTask) {
      attempt(window.pilot.setTaskArchived(selectedProject.path, selectedTask.path, true).then((next) => {
        setProjects(next);
        setSelectedTaskPath(undefined);
        setTaskDetails(undefined);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-action="task.new"]')?.focus());
      }), "Stop the Run or reload the Task, then try archiving again.");
      return;
    }
    if ((id === "task.exportJsonl" || id === "task.exportHtml") && selectedProject && selectedTask) {
      attempt(window.pilot.exportTask(selectedProject.path, selectedTask.path, id === "task.exportJsonl" ? "jsonl" : "html"), "Choose another destination or check folder permissions, then try again.");
      return;
    }
    if (id === "resources.reload") { setActionError(undefined); setReloadToken((value) => value + 1); return; }
    if (id === "run.stop" && selectedTask) { attempt(window.pilot.abortTask(selectedTask.path), "The Run may already be settled. Reload the Task if its status looks stale."); return; }
    const target = document.querySelector<HTMLElement>(`[data-action="${id}"]`);
    if (!target) return;
    target.focus();
    if (id !== "view.focusPrompt") target.click();
  }, [availability, closeDetails, compactLayout, createSelectedTask, selectedProject?.path, selectedTask?.path, showDetails]);

  const actionState = desktopActions.map(({ id }) => ({ id, enabled: availability[id].enabled, label: availability[id].label }));
  const actionStateKey = JSON.stringify(actionState);
  useEffect(() => window.pilot.setActionState(actionState), [actionStateKey]);
  useEffect(() => window.pilot.onAction(invokeAction), [invokeAction]);
  useEffect(() => {
    const trackFocus = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      focusWasInInspector.current = Boolean(target && document.querySelector(".inspector")?.contains(target));
      if (focusWasInInspector.current) lastInspectorFocus.current = target;
    };
    window.addEventListener("focusin", trackFocus);
    return () => window.removeEventListener("focusin", trackFocus);
  }, []);
  useEffect(() => {
    const media = matchMedia(COMPACT_LAYOUT_MEDIA);
    const updateLayout = () => {
      if (media.matches && focusWasInInspector.current) {
        detailsReturnFocus.current = document.getElementById("content");
        setShowDetails(true);
        requestAnimationFrame(() => lastInspectorFocus.current?.focus());
      }
      setCompactLayout(media.matches);
    };
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);
  useLayoutEffect(() => {
    if (showSettings || !shell.current) return;
    const element = shell.current;
    const updateWidth = () => setShellWidth(element.clientWidth || window.innerWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showSettings]);
  useEffect(() => {
    const media = matchMedia("(max-width: 679px)");
    const hideNavigationWhenWide = () => { if (!media.matches) setNavigationOpen(false); };
    media.addEventListener("change", hideNavigationWhenWide);
    return () => media.removeEventListener("change", hideNavigationWhenWide);
  }, []);
  useEffect(() => {
    if (!navigationOpen) return;
    const focusFrame = requestAnimationFrame(() => navigationPanel.current?.querySelector<HTMLElement>("button")?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeNavigation(true);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeNavigation, navigationOpen]);
  useEffect(() => {
    const openPalette = (event: KeyboardEvent) => {
      if ((window.pilot.platform === "darwin" ? event.metaKey : event.ctrlKey) && event.shiftKey && event.key.toLocaleLowerCase() === "p") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", openPalette);
    return () => window.removeEventListener("keydown", openPalette);
  }, []);
  useEffect(() => window.pilot.onTaskRunEvent((next) => {
    setRunStates((current) => ({ ...current, [next.taskPath]: next }));
  }), []);
  useEffect(() => {
    let cancelled = false;
    void loadDesktopState().then((loaded) => {
      if (!cancelled) applyDesktopState(loaded);
    }).catch((reason) => {
      if (!cancelled) setActionError(startupFailure(reason));
    });
    return () => { cancelled = true; };
  }, [applyDesktopState, loadDesktopState]);
  useEffect(() => {
    if (!desktopPreferencesLoaded) return;
    const timer = window.setTimeout(() => {
      void window.pilot.setPanePreferences({
        inspectorVisible: showDetails,
        inspectorView,
        navigationWidth: committedPaneWidths.navigation,
        inspectorWidth: committedPaneWidths.inspector,
      })
        .catch((reason) => reportActionError(reason, "Check PiLot preference-file access and try changing the pane layout again."));
    }, 100);
    return () => window.clearTimeout(timer);
  }, [committedPaneWidths.inspector, committedPaneWidths.navigation, desktopPreferencesLoaded, showDetails, inspectorView, reportActionError]);
  useEffect(() => {
    if (!desktopPreferencesLoaded || showHome || !selectedProject) return;
    const taskPath = selectedProject.tasks.some(({ path }) => path === selectedTaskPath) ? selectedTaskPath : undefined;
    const next = { projectPath: selectedProject.path, ...(taskPath ? { taskPath } : {}) };
    setRecentSelection(next);
    void window.pilot.setRecentSelection(next.projectPath, next.taskPath)
      .catch((reason) => reportActionError(reason, "Check PiLot preference-file access and select the Project or Task again."));
  }, [desktopPreferencesLoaded, showHome, selectedProject?.path, selectedTaskPath, reportActionError]);
  useEffect(() => setActionError((current) => current?.preserveOnContextChange ? current : undefined), [selectedProject?.path, selectedTask?.path, showSettings]);

  if (showSettings) return <>
    <div className="window-bar" aria-hidden="true" />
    <SettingsPage initialDestination={settingsDestination} onChange={refresh} onClose={closeSettings} />
    <CommandPalette open={paletteOpen} availability={availability} onClose={() => setPaletteOpen(false)} onInvoke={invokeAction} />
    {actionError && <ActionError failure={actionError} onDismiss={() => setActionError(undefined)} onRetry={retryProjectState} />}
  </>;

  return (
    <>
      <a className="skip-link" href="#content">Skip to content</a>
      <div className="window-bar" aria-hidden="true" />
      <div ref={shell} className="shell" style={paneShellStyle}>
        <header className="mobile-toolbar">
          <button ref={mobileNavigationButton} type="button" className="mobile-navigation-button" aria-label={navigationOpen ? "Close navigation" : "Open navigation"} aria-controls="workspace-navigation" aria-expanded={navigationOpen} onClick={() => navigationOpen ? closeNavigation(true) : setNavigationOpen(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
          </button>
          <div className="mobile-context"><span>{mobileContextKind}</span><strong title={mobileContextTitle}>{mobileContextTitle}</strong></div>
          <button type="button" className="mobile-details-button" aria-label={showDetails ? "Close Inspector" : "Open Inspector"} onClick={(event) => invokeAction("view.details", event.currentTarget)}>{showDetails ? "Hide" : "Details"}</button>
        </header>
        <nav id="workspace-navigation" ref={navigationPanel} aria-label="Projects and tasks" className={`navigation${navigationOpen ? " mobile-visible" : ""}`}>
          <header className="brand">
            <button type="button" className="brand-home" aria-label="Open command center" aria-current={showHome ? "page" : undefined} onClick={() => {
              setShowHome(true);
              setSelectedTaskPath(undefined);
              setTaskDetails(undefined);
              setShowDetails(false);
              closeNavigationToContent();
            }}><span className="mark" aria-hidden="true">π</span><strong>PiLot</strong></button>
          </header>
          <div className="nav-heading">
            <span>Projects</span>
            <button data-action="project.add" aria-label="Add project" title="Add Project" onClick={() => { setNavigationOpen(false); invokeAction("project.add"); }}>+</button>
          </div>
          {projects?.projects.length ? (
            <ul className="project-list">
              {projects.projects.map((project) => (
                <li key={project.path}>
                  <button aria-label={project.name} aria-current={!showHome && projects.selected?.path === project.path ? "page" : undefined} onClick={() => {
                    const reopeningCurrentProject = !showHome && projects.selected?.path === project.path;
                    const recentTask = !reopeningCurrentProject && recentSelection.projectPath === project.path
                      ? project.tasks.find(({ path }) => path === recentSelection.taskPath)
                      : undefined;
                    setShowHome(false);
                    setSelectedTaskPath(recentTask?.path);
                    setTaskDetails(undefined);
                    closeNavigationToContent();
                    void window.pilot.selectProject(project.path).then(setProjects).catch((reason) => reportActionError(reason, "Reload the Project list and try selecting it again."));
                  }}>
                    <span className="project-icon" aria-hidden="true">◇</span>
                    <span>{project.name}</span>
                    <small>{project.taskCount}</small>
                  </button>
                  {projects.selected?.path === project.path && <ul className="task-nav-list" aria-label={`Active Tasks in ${project.name}`}>
                    {project.tasks.filter(({ lifecycle }) => lifecycle === "active").map((task) => {
                      const status = taskAttentionStatus(task, runStates[task.path]);
                      return <li key={task.path}><button aria-current={!showHome && selectedTaskPath === task.path ? "page" : undefined} onClick={() => { setShowHome(false); setTaskDetails(undefined); setSelectedTaskPath(task.path); closeNavigationToContent(); }}>
                        <span className="task-nav-title">{task.title}</span><TaskStateIndicator status={status} />
                      </button></li>;
                    })}
                  </ul>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted nav-empty">Projects with Pi tasks will appear here.</p>
          )}
          <div className="nav-footer">
            <button type="button" className="command-center" data-action="view.commandPalette" onClick={() => { setNavigationOpen(false); invokeAction("view.commandPalette"); }}><span>Command Palette</span><kbd>{shortcutLabel("CommandOrControl+Shift+P")}</kbd></button>
            <button ref={settingsButton} data-action="view.settings" className="settings-button" aria-label="Settings" title="Settings" onClick={() => { setNavigationOpen(false); setSettingsDestination("general"); setShowSettings(true); }}><span aria-hidden="true">⚙</span></button>
          </div>
        </nav>
        <PaneDivider pane="navigation" controls="workspace-navigation" width={effectivePaneWidths.navigation} preferredWidth={paneWidths.navigation} defaultWidth={DEFAULT_NAVIGATION_PANE_WIDTH} minimum={MINIMUM_NAVIGATION_PANE_WIDTH} maximum={navigationMaximum} enabled={!compactLayout} onPreview={(width) => previewPaneWidth("navigation", width)} onCommit={(width) => commitPaneWidth("navigation", width)} />
        {navigationOpen && <button type="button" className="navigation-scrim" aria-label="Close navigation" onClick={() => closeNavigation(true)} />}

        <main id="content" className="workspace-main" tabIndex={-1}>
          {surfaceProject ? <ProjectPage
            project={surfaceProject}
            needsAccess={needsProjectAccess}
            selectedTaskPath={selectedTaskPath}
            reloadToken={reloadToken}
            revision={taskRevision}
            historyDraft={historyDraft?.taskPath === selectedTaskPath ? historyDraft : undefined}
            changePaths={changePaths}
            onSelectTask={(path) => {
              setTaskDetails(undefined);
              setSelectedTaskPath(path);
              const task = surfaceProject.tasks.find((candidate) => candidate.path === path);
              if (task?.execution.kind === "worktree" && task.execution.removedAt) {
                detailsReturnFocus.current = null;
                setInspectorView("history");
                setShowDetails(true);
                requestAnimationFrame(() => {
                  detailsReturnFocus.current = document.getElementById("removed-task-title");
                  document.getElementById("inspector-history-tab")?.focus();
                });
              }
            }}
            onCreateTask={() => void createSelectedTask()}
            onForkTask={(task) => { void window.pilot.getProjects().then((next) => {
              setProjects(next);
              setTaskDetails(undefined);
              setSelectedTaskPath(task.path);
              setTaskRevision((value) => value + 1);
            }); }}
            onOpenAccess={() => setShowProjectAccess(true)}
            onChange={setProjects}
            onDetails={setTaskDetails}
            onHistoryChange={() => { if (selectedTaskPath) refreshTaskProjection(selectedTaskPath); }}
            onOpenSettings={openProviderSettings}
            onOpenChange={openChange}
            onRunChange={handleRunChange}
            onSetupChange={handleSetupChange}
            onContinuityChange={handleContinuityChange}
            onActionStart={clearActionError}
            onError={reportActionError}
          /> : <CommandCenter startup={state} projects={projects} runStates={runStates} onOpenTask={openTaskFromHome} onCreateTask={() => void createSelectedTask()} />}
        </main>
        <PaneDivider pane="inspector" controls="workspace-inspector" width={effectivePaneWidths.inspector} preferredWidth={paneWidths.inspector} defaultWidth={DEFAULT_INSPECTOR_PANE_WIDTH} minimum={MINIMUM_INSPECTOR_PANE_WIDTH} maximum={inspectorMaximum} enabled={!compactLayout} onPreview={(width) => previewPaneWidth("inspector", width)} onCommit={(width) => commitPaneWidth("inspector", width)} />

        <aside id="workspace-inspector" aria-label="Inspector" className={`inspector${showDetails ? " details-visible" : ""}`}>
          <InspectorTabs selected={inspectorView} changeCount={taskChanges?.files.length ?? 0} historyPaths={taskHistory?.pathCount ?? 0} onSelect={setInspectorView} />
          <button type="button" className="inspector-close" aria-label="Close Inspector" onClick={closeDetails}>×</button>
          {inspectorView === "details" ? <div id="inspector-details-panel" className="inspector-body" role="tabpanel" aria-labelledby="inspector-details-tab">
            {surfaceProject ? needsProjectAccess ? <>
              <p className="eyebrow">Project</p>
              <h2>{surfaceProject.name}</h2>
              <p className="muted inspector-note">Complete the open access decision to continue.</p>
            </> : selectedTask && removedWorktreeAt ? <section className="task-details" aria-label="Removed Task details">
              <p className="eyebrow">Archived Task</p>
              <h2>{selectedTask.title}</h2>
              <p className="muted inspector-note">Its managed Worktree was removed on {new Date(removedWorktreeAt).toLocaleString()}.</p>
              <dl>
                <div><dt>Lifecycle</dt><dd>Archived</dd></div>
                <div><dt>Execution location</dt><dd>Worktree removed</dd></div>
                <div><dt>Run access</dt><dd>Unavailable</dd></div>
              </dl>
            </section> : selectedTask && taskDetails ? <section className="task-details" aria-label="Task details">
              <p className="eyebrow">Task details</p>
              <h2>{selectedTask.title}</h2>
              <dl>
                <div><dt>Model</dt><dd>{taskDetails.selected ? `${taskDetails.selected.provider}/${taskDetails.selected.id}` : "Unavailable"}</dd></div>
                <div><dt>Thinking</dt><dd>{taskDetails.thinkingLevel}</dd></div>
                <div><dt>Context</dt><dd>{taskDetails.usage.contextWindow ? `${taskDetails.usage.contextTokens === null ? "Calculating" : taskDetails.usage.contextTokens.toLocaleString()} / ${taskDetails.usage.contextWindow.toLocaleString()}` : "Unavailable"}</dd></div>
                <div><dt>Total tokens</dt><dd>{taskDetails.usage.totalTokens.toLocaleString()}</dd></div>
                <div><dt>Cost</dt><dd>${taskDetails.usage.cost.toFixed(5)}</dd></div>
                <div><dt>Execution location</dt><dd>{selectedTask.execution.kind === "worktree" ? "Worktree" : "Local"}</dd></div>
              </dl>
            </section> : <section className="project-details" aria-label="Project details">
              <p className="eyebrow">Project</p>
              <h2>{surfaceProject.name}</h2>
              <p className="muted inspector-note">{surfaceProject.path}</p>
              <dl>
                <div><dt>Active Tasks</dt><dd>{surfaceProject.tasks.filter(({ lifecycle }) => lifecycle === "active").length}</dd></div>
                <div><dt>Archived Tasks</dt><dd>{surfaceProject.tasks.filter(({ lifecycle }) => lifecycle === "archived").length}</dd></div>
                <div><dt>Execution location</dt><dd>Chosen per Task</dd></div>
              </dl>
            </section> : <>
              <p className="eyebrow">Startup</p>
              <h2>Readiness</h2>
              <dl>
                <div><dt>Checks passed</dt><dd>{state?.passed ?? "—"} / 3</dd></div>
                <div><dt>Network reporting</dt><dd>Off</dd></div>
              </dl>
            </>}
          </div> : inspectorView === "changes" ? <div id="inspector-changes-panel" className="inspector-body changes-inspector-body" role="tabpanel" aria-labelledby="inspector-changes-tab">
            {surfaceProject && selectedTask && !removedWorktreeAt && !needsProjectAccess
              ? <ChangesPanel key={`${surfaceProject.path}:${selectedTask.path}`} project={surfaceProject} task={selectedTask} changes={taskChanges} loadError={changesError} selectedPath={selectedChangePath} disabled={runActive || setupActive || taskExternallyChanged} onSelect={setSelectedChangePath} onWorktreeRemoved={(next) => {
                setProjects(next);
                setSelectedTaskPath(undefined);
                setTaskDetails(undefined);
                setTaskChanges(undefined);
                requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-action="task.new"]')?.focus());
              }} />
              : <div className="changes-empty"><strong>Select a Task</strong><p>Choose an active Task to review its Git changes.</p></div>}
          </div> : <div id="inspector-history-panel" className="inspector-body history-inspector-body" role="tabpanel" aria-labelledby="inspector-history-tab">
            {surfaceProject && selectedTask && !needsProjectAccess
              ? <HistoryPanel key={`${surfaceProject.path}:${selectedTask.path}`} project={surfaceProject} task={selectedTask} history={taskHistory} loadError={historyError} disabled={runActive || setupActive || taskExternallyChanged} readOnly={Boolean(removedWorktreeAt)} onChange={setTaskHistory} onNavigate={(editorText) => {
                setTaskDetails(undefined);
                setHistoryDraft((current) => ({ taskPath: selectedTask.path, text: editorText ?? "", version: (current?.version ?? 0) + 1 }));
                refreshTaskProjection(selectedTask.path);
              }} onTaskCreated={async (result) => {
                setProjects(await window.pilot.getProjects());
                setTaskDetails(undefined);
                setSelectedTaskPath(result.task.path);
                setHistoryDraft((current) => ({ taskPath: result.task.path, text: result.draft ?? "", version: (current?.version ?? 0) + 1 }));
                setTaskRevision((value) => value + 1);
              }} />
              : <div className="history-empty"><strong>Select a Task</strong><p>Choose a Task to inspect its Pi history.</p></div>}
          </div>}
        </aside>
      </div>
      {selectedProject && (needsProjectAccess || showProjectAccess) && <ProjectAccessDialog project={selectedProject} dismissible={!needsProjectAccess} onChange={updateProjectAccess} onClose={closeProjectAccess} />}
      {selectedProject && taskCreation && <TaskCreationDialog project={selectedProject} state={taskCreation} onCreate={createTaskFromRequest} onClose={closeTaskCreation} />}
      <CommandPalette open={paletteOpen} availability={availability} onClose={() => setPaletteOpen(false)} onInvoke={invokeAction} />
      {actionError && <ActionError failure={actionError} onDismiss={() => setActionError(undefined)} onRetry={retryProjectState} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
