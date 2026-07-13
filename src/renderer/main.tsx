import { StrictMode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Appearance } from "../shared/preferences";
import type { OAuthEvent, ProviderState } from "../shared/providers";
import type { CommandEvidence, LiveInputMode, ProjectAccess, ProjectsState, RunEvidence, TaskModelState, TaskRunState, TaskSummary, ToolEvidence } from "../shared/projects";
import type { StartupState } from "../shared/readiness";
import { ProviderIcon } from "./provider-icons";
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

function ProjectActions({ project, onOpenAccess, onChange }: { project: ProjectAccess; onOpenAccess(): void; onChange(state: ProjectsState): void }) {
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
      <button role="menuitem" onClick={() => { close(); void window.pilot.removeProject(project.path).then(onChange); }}>Remove Project</button>
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
  const status = item.status[0].toUpperCase() + item.status.slice(1);
  return <section className={`command-block ${item.status}`} role="region" aria-label={`Command: ${item.command}`}>
    <header><code>$ {item.command}</code><span>{status}</span></header>
    <p className="context-semantics">{item.includeInContext ? "Included in next Pi context" : "Local only — not sent to Pi"}</p>
    {item.output && <pre tabIndex={0} aria-label="Command output">{item.output}</pre>}
    {item.outputTruncated && <p className="output-bound">Output is bounded in the timeline.</p>}
    <CompleteOutput path={item.fullOutputPath} />
  </section>;
}

function ToolBlock({ item }: { item: ToolEvidence }) {
  const status = item.status === "succeeded" ? "Succeeded" : item.status === "failed" ? "Failed" : "Running";
  return <details key={`${item.id}-${item.status}`} className={`tool-evidence ${item.status}`} aria-label={`${item.name} tool, ${item.status}`} open={item.status !== "succeeded" || undefined}>
    <summary><span>{item.summary}</span><span>{status}</span></summary>
    <div className="evidence-detail">
      <h4>Input</h4><pre tabIndex={0}>{item.input}</pre>
      <h4>Output</h4>{item.output ? <pre tabIndex={0}>{item.output}</pre> : <p className="muted">No output yet.</p>}
      {item.details && <><h4>Details</h4><pre tabIndex={0}>{item.details}</pre></>}
      {item.outputTruncated && <p className="output-bound">Output is bounded in the timeline.</p>}
      <CompleteOutput path={item.fullOutputPath} />
    </div>
  </details>;
}

function RunBlock({ run, index, expandThinking }: { run: RunEvidence; index: number; expandThinking: boolean }) {
  const status = run.status[0].toUpperCase() + run.status.slice(1);
  return <article className={`run-evidence ${run.status}`} aria-labelledby={`run-${run.id}`}>
    <header className="run-heading">
      <div><span className="run-number">Run {index + 1}</span><h3 id={`run-${run.id}`}>{run.input.kind === "command" ? "Inline command" : "Agent run"}</h3></div>
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
        if (item.kind === "tool") return <ToolBlock key={item.id} item={item} />;
        if (item.kind === "command") return <CommandBlock key={item.id} item={item} />;
        return <details key={item.id} className={`run-notice ${item.tone}`} open>
          <summary>{item.title}</summary>{item.detail && <p>{item.detail}</p>}
        </details>;
      })}
    </div>
  </article>;
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

function placePicker(popover: HTMLElement, trigger: HTMLElement, preferredWidth: number) {
  const bounds = trigger.getBoundingClientRect();
  const width = Math.min(preferredWidth, window.innerWidth - 24);
  popover.style.width = `${width}px`;
  popover.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
  popover.style.top = `${bounds.top - 7}px`;
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
    requestAnimationFrame(() => popover.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  const move = (event: React.KeyboardEvent, direction: number) => {
    const options = [...(popover.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const index = options.indexOf(event.currentTarget as HTMLElement);
    options[(index + direction + options.length) % options.length]?.focus();
    event.preventDefault();
  };

  return <>
    <button ref={trigger} type="button" className="thinking-picker-trigger" aria-haspopup="dialog" aria-expanded={open} aria-label={`Thinking level: ${thinkingLevelLabel(state.thinkingLevel)}`} disabled={disabled} onClick={show}>
      <span>Thinking · {thinkingLevelLabel(state.thinkingLevel)}</span><span aria-hidden="true">⌄</span>
    </button>
    <div ref={popover} popover="auto" className="model-picker-popover thinking-picker-popover" role="dialog" aria-label="Choose thinking level" onToggle={(event) => setOpen(event.currentTarget.matches(":popover-open"))} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    }}>
      <div className="model-results" role="listbox" aria-label="Thinking levels">
        {state.thinkingLevels.map((level) => {
          const selected = level === state.thinkingLevel;
          return <button key={level} type="button" role="option" aria-selected={selected} onClick={() => {
            void onSelect(level).then((changed) => { if (changed) close(); });
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

function TaskModelControls({ project, task, state, disabled, onChange, onOpenSettings }: {
  project: ProjectAccess;
  task: TaskSummary;
  state?: TaskModelState;
  disabled: boolean;
  onChange(next: TaskModelState): void;
  onOpenSettings(): void;
}) {
  const picker = useRef<HTMLDivElement>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const modelListId = useId();
  const [providerId, setProviderId] = useState("");
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
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
    setError("");
    try { onChange(await action()); return true; } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
  };
  const closePicker = (restoreFocus = true) => {
    if (picker.current?.matches(":popover-open")) picker.current.hidePopover();
    if (restoreFocus) pickerTrigger.current?.focus();
  };
  const openPicker = () => {
    if (!picker.current || !pickerTrigger.current || disabled) return;
    setError("");
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
        <button ref={pickerTrigger} type="button" className="model-picker-trigger" aria-haspopup="dialog" aria-expanded={pickerOpen} aria-label={`Provider and model: ${selectedProvider.name} · ${state.selected.name} · ${state.selected.id}`} disabled={disabled} onClick={openPicker}>
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
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        </div>
      </div>
      {error && !pickerOpen && <p className="error" role="alert">{error}</p>}
    </>}
  </div>;
}

function TaskPage({ project, task, onCreate, onDetails, onOpenSettings }: {
  project: ProjectAccess;
  task: TaskSummary;
  onCreate(): void;
  onDetails(next: TaskModelState): void;
  onOpenSettings(): void;
}) {
  const [timeline, setTimeline] = useState<TaskRunState>();
  const [modelState, setModelState] = useState<TaskModelState>();
  const [expandThinking, setExpandThinking] = useState(false);
  const [draft, setDraft] = useState("");
  const [liveMode, setLiveMode] = useState<LiveInputMode>("steer");
  const [error, setError] = useState("");
  const updateModelState = (next: TaskModelState) => { setModelState(next); onDetails(next); };
  const refreshDetails = () => window.pilot.getTaskModel(project.path, task.path).then(updateModelState);

  useEffect(() => {
    let cancelled = false;
    let receivedRunEvent = false;
    setTimeline(undefined);
    setError("");
    const unsubscribe = window.pilot.onTaskRunEvent((next) => {
      if (next.taskPath !== task.path) return;
      receivedRunEvent = true;
      if (next.recoveredInput) setDraft((current) => [next.recoveredInput, current].filter((value) => value?.trim()).join("\n\n"));
      setTimeline(next);
    });
    void Promise.all([
      window.pilot.getTaskRun(project.path, task.path),
      window.pilot.getPreferences(),
      window.pilot.getTaskModel(project.path, task.path),
    ]).then(([next, preferences, model]) => {
      if (cancelled) return;
      if (!receivedRunEvent) setTimeline(next);
      setExpandThinking(preferences.expandThinking);
      updateModelState(model);
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; unsubscribe(); };
  }, [project.path, task.path]);

  useEffect(() => setLiveMode("steer"), [timeline?.activeRunId]);

  const activeRun = timeline?.runs.find(({ id }) => id === timeline.activeRunId);
  const active = Boolean(activeRun);
  const live = activeRun?.input.kind === "prompt";
  const liveReady = live && activeRun.status === "running";
  const submit = (mode?: LiveInputMode) => {
    const input = draft.trim();
    if (!input || (active && (!liveReady || !mode))) return;
    setError("");
    setDraft("");
    const hiddenCommand = !active && input.startsWith("!!");
    const command = hiddenCommand ? input.slice(2) : !active && input.startsWith("!") ? input.slice(1) : undefined;
    const operation = active
      ? window.pilot.queuePrompt(task.path, input, mode!)
      : command !== undefined
        ? window.pilot.executeCommand(project.path, task.path, command, !hiddenCommand)
        : window.pilot.submitPrompt(project.path, task.path, input);
    void operation.then(() => refreshDetails()).catch((reason) => {
      setDraft((current) => [input, current].filter((value) => value.trim()).join("\n\n"));
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  const queues = timeline?.queues ?? { steering: [], followUp: [] };

  return <div className="task-page">
    <header className="topbar task-topbar">
      <div><p className="eyebrow">Active Task</p><h1>{task.title}</h1><span className="execution-location">Local execution location</span></div>
      <button className="new-task-button" onClick={onCreate}>New Task</button>
    </header>
    <section className="run-timeline" aria-label="Run timeline">
      <div className="timeline-heading"><h2>Run timeline</h2><span aria-live="polite">{active ? "Run active" : `${timeline?.runs.length ?? 0} Runs`}</span></div>
      {timeline?.runs.length ? timeline.runs.map((run, index) => <RunBlock key={run.id} run={run} index={index} expandThinking={expandThinking} />) : <p className="muted">Submit a prompt or inline command to start this Task.</p>}
      {active && <button className="abort-button" onClick={() => void window.pilot.abortTask(task.path)}>Abort</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
    <form className="task-composer" aria-label="Task composer" onSubmit={(event) => { event.preventDefault(); submit(active ? liveMode : undefined); }}>
      <label htmlFor="task-prompt">{live ? "Guide the active Run" : "Prompt or inline command"}</label>
      {live && <fieldset className="live-input-mode" role="radiogroup" aria-label="Live input mode">
        <legend>Delivery</legend>
        <label><input type="radio" name="live-input-mode" checked={liveMode === "steer"} onChange={() => setLiveMode("steer")} />Steer <small>after the current tool batch</small></label>
        <label><input type="radio" name="live-input-mode" checked={liveMode === "followUp"} onChange={() => setLiveMode("followUp")} />Follow-up <small>after this Run settles</small></label>
      </fieldset>}
      <textarea id="task-prompt" aria-label="Prompt" value={draft} disabled={active && !live} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (!liveReady || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        const mode = event.altKey ? "followUp" : liveMode;
        if (event.altKey) setLiveMode(mode);
        submit(mode);
      }} placeholder={live ? "Steer Pi now, or queue work for later…" : "Ask Pi to work, or run !command…"} rows={3} />
      {live && <div className="pending-queues" aria-label="Pending live input">
        <ul className="pending-queue" aria-label="Pending steering">{queues.steering.length ? queues.steering.map((text, index) => <li key={`${text}-${index}`}><strong>Steer</strong><span>{text}</span></li>) : <li className="queue-empty"><strong>Steer</strong><span>None pending</span></li>}</ul>
        <ul className="pending-queue" aria-label="Pending follow-ups">{queues.followUp.length ? queues.followUp.map((text, index) => <li key={`${text}-${index}`}><strong>Follow-up</strong><span>{text}</span></li>) : <li className="queue-empty"><strong>Follow-up</strong><span>None pending</span></li>}</ul>
      </div>}
      <div className="composer-controls">
        <TaskModelControls project={project} task={task} state={modelState} disabled={active} onChange={updateModelState} onOpenSettings={onOpenSettings} />
        <button type="submit" className="run-button" disabled={!draft.trim() || (active && !liveReady)}>{live ? "Queue input" : "Run"}</button>
      </div>
    </form>
  </div>;
}

function ProjectPage({ project, needsAccess, selectedTaskPath, onSelectTask, onCreateTask, onOpenAccess, onChange, onDetails, onOpenSettings }: {
  project: ProjectAccess;
  needsAccess: boolean;
  selectedTaskPath?: string;
  onSelectTask(path: string): void;
  onCreateTask(): void;
  onOpenAccess(): void;
  onChange(state: ProjectsState): void;
  onDetails(state: TaskModelState): void;
  onOpenSettings(): void;
}) {
  const active = project.tasks.filter(({ lifecycle }) => lifecycle === "active");
  const archived = project.tasks.filter(({ lifecycle }) => lifecycle === "archived");
  const selectedTask = active.find(({ path }) => path === selectedTaskPath);
  if (selectedTask && !needsAccess) return <TaskPage project={project} task={selectedTask} onCreate={onCreateTask} onDetails={onDetails} onOpenSettings={onOpenSettings} />;
  return <>
    <header className="topbar project-topbar">
      <div><p className="eyebrow">Project</p><h1>{project.name}</h1><code>{project.path}</code></div>
      <div className="project-top-actions"><span className="privacy"><i /> Local only</span><ProjectActions project={project} onOpenAccess={onOpenAccess} onChange={onChange} /></div>
    </header>
    {needsAccess ? <section className="project-empty" aria-live="polite">
      <h2>Access required</h2>
      <p>Complete the access decision to admit this Project.</p>
    </section> : <div className="task-overview">
      {project.diagnostics.length > 0 && <section className="task-diagnostics" aria-label="Task diagnostics">
        {project.diagnostics.map((diagnostic) => <div key={diagnostic.title}><strong>{diagnostic.title}</strong><p>{diagnostic.detail}</p></div>)}
      </section>}
      <section className="task-section" aria-label="Active tasks">
        <div className="task-section-heading"><h2>Active Tasks</h2><div><span>{active.length}</span><button className="new-task-button" onClick={onCreateTask}>New Task</button></div></div>
        {active.length ? <ul>{active.map((task) => <li key={task.path}><button className="task-title-button" onClick={() => onSelectTask(task.path)}>{task.title}</button><span>Active</span><button onClick={() => void window.pilot.setTaskArchived(project.path, task.path, true).then(onChange)}>Archive</button></li>)}</ul> : <p className="muted">No active Tasks</p>}
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
  const [expandThinking, setExpandThinking] = useState(false);
  useEffect(() => { void window.pilot.getPreferences().then((value) => {
    setAppearance(value.appearance);
    setExpandThinking(value.expandThinking);
    applyAppearance(value.appearance);
  }); }, []);

  return <section className="general-settings" aria-labelledby="general-title">
    <p className="eyebrow">Application</p>
    <h2 id="general-title">General</h2>
    <p className="muted">Choose how PiLot looks and presents Run evidence on this device.</p>
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

function SettingsPage({ initialDestination, onChange, onClose }: { initialDestination: "general" | "providers"; onChange(): void; onClose(): void }) {
  const [destination, setDestination] = useState<"general" | "providers">(initialDestination);
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
  const [selectedTaskPath, setSelectedTaskPath] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDestination, setSettingsDestination] = useState<"general" | "providers">("general");
  const [showProjectAccess, setShowProjectAccess] = useState(false);
  const [taskDetails, setTaskDetails] = useState<TaskModelState>();
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
  const createSelectedTask = useCallback(async () => {
    const project = projects?.selected;
    if (!project) return;
    const task = await window.pilot.createTask(project.path);
    setProjects(await window.pilot.getProjects());
    setTaskDetails(undefined);
    setSelectedTaskPath(task.path);
  }, [projects?.selected?.path]);
  const openProviderSettings = useCallback(() => {
    setSettingsDestination("providers");
    setShowSettings(true);
  }, []);

  useEffect(() => {
    refresh();
    void window.pilot.getPreferences().then((value) => applyAppearance(value.appearance));
  }, []);

  const selectedProject = projects?.selected;
  const selectedTask = selectedProject?.tasks.find(({ path }) => path === selectedTaskPath);
  const needsProjectAccess = Boolean(selectedProject && (!selectedProject.executionConsent || (selectedProject.resourceTrust.required && selectedProject.resourceTrust.decision === null)));

  if (showSettings) return <><div className="window-bar" aria-hidden="true" /><SettingsPage initialDestination={settingsDestination} onChange={refresh} onClose={closeSettings} /></>;

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
                  <button aria-current={projects.selected?.path === project.path ? "page" : undefined} onClick={() => {
                    setSelectedTaskPath(undefined);
                    setTaskDetails(undefined);
                    void window.pilot.selectProject(project.path).then(setProjects);
                  }}>
                    <span className="project-icon" aria-hidden="true">◇</span>
                    <span>{project.name}</span>
                    <small>{project.taskCount}</small>
                  </button>
                  {projects.selected?.path === project.path && <ul className="task-nav-list" aria-label={`Active Tasks in ${project.name}`}>
                    {project.tasks.filter(({ lifecycle }) => lifecycle === "active").map((task) => <li key={task.path}><button aria-current={selectedTaskPath === task.path ? "page" : undefined} onClick={() => { setTaskDetails(undefined); setSelectedTaskPath(task.path); }}>{task.title}</button></li>)}
                  </ul>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted nav-empty">Projects with Pi tasks will appear here.</p>
          )}
          <div className="nav-footer">
            <span className="command-center"><span aria-hidden="true">⌘</span> Command center</span>
            <button ref={settingsButton} className="settings-button" aria-label="Settings" title="Settings" onClick={() => { setSettingsDestination("general"); setShowSettings(true); }}><span aria-hidden="true">⚙</span></button>
          </div>
        </nav>

        <main id="content" className="workspace-main">
          {selectedProject ? <ProjectPage
            project={selectedProject}
            needsAccess={needsProjectAccess}
            selectedTaskPath={selectedTaskPath}
            onSelectTask={(path) => { setTaskDetails(undefined); setSelectedTaskPath(path); }}
            onCreateTask={() => void createSelectedTask()}
            onOpenAccess={() => setShowProjectAccess(true)}
            onChange={setProjects}
            onDetails={setTaskDetails}
            onOpenSettings={openProviderSettings}
          /> : <>
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
            </> : selectedTask && taskDetails ? <section className="task-details" aria-label="Task details">
              <p className="eyebrow">Task details</p>
              <h2>{selectedTask.title}</h2>
              <dl>
                <div><dt>Model</dt><dd>{taskDetails.selected ? `${taskDetails.selected.provider}/${taskDetails.selected.id}` : "Unavailable"}</dd></div>
                <div><dt>Thinking</dt><dd>{taskDetails.thinkingLevel}</dd></div>
                <div><dt>Context</dt><dd>{taskDetails.usage.contextWindow ? `${taskDetails.usage.contextTokens === null ? "Calculating" : taskDetails.usage.contextTokens.toLocaleString()} / ${taskDetails.usage.contextWindow.toLocaleString()}` : "Unavailable"}</dd></div>
                <div><dt>Total tokens</dt><dd>{taskDetails.usage.totalTokens.toLocaleString()}</dd></div>
                <div><dt>Cost</dt><dd>${taskDetails.usage.cost.toFixed(5)}</dd></div>
              </dl>
            </section> : <section className="project-details" aria-label="Project details">
              <p className="eyebrow">Project</p>
              <h2>{selectedProject.name}</h2>
              <p className="muted inspector-note">{selectedProject.path}</p>
              <dl>
                <div><dt>Active Tasks</dt><dd>{selectedProject.tasks.filter(({ lifecycle }) => lifecycle === "active").length}</dd></div>
                <div><dt>Archived Tasks</dt><dd>{selectedProject.tasks.filter(({ lifecycle }) => lifecycle === "archived").length}</dd></div>
                <div><dt>Execution location</dt><dd>Local</dd></div>
              </dl>
            </section> : <>
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
