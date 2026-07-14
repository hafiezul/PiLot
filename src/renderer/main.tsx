import { StrictMode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { desktopActions, type DesktopActionId } from "../shared/actions";
import type { Appearance } from "../shared/preferences";
import type { OAuthEvent, ProviderState } from "../shared/providers";
import { detectSupportedImageMimeType, IMAGE_MIME_LABELS, MAXIMUM_IMAGE_BYTES, MAXIMUM_IMAGES, type ChangedFile, type CommandEvidence, type CompactionEvidence, type DiffLine, type ImageAttachment, type LiveInputMode, type ProjectAccess, type ProjectsState, type RetryEvidence, type RunEvidence, type TaskChanges, type TaskFileDiff, type TaskModelState, type TaskResourceState, type TaskRunState, type TaskSummary, type ToolEvidence } from "../shared/projects";
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
  const status = item.status[0].toUpperCase() + item.status.slice(1);
  return <section className={`command-block ${item.status}`} role="region" aria-label={`Command: ${item.command}`}>
    <header><code>$ {item.command}</code><span>{status}</span></header>
    <p className="context-semantics">{item.includeInContext ? "Included in next Pi context" : "Local only — not sent to Pi"}</p>
    {item.output && <pre tabIndex={0} aria-label="Command output">{item.output}</pre>}
    {item.outputTruncated && <p className="output-bound">Output is bounded in the timeline.</p>}
    <CompleteOutput path={item.fullOutputPath} />
  </section>;
}

function ToolBlock({ item, changePaths, onOpenChange }: { item: ToolEvidence; changePaths: string[]; onOpenChange(path: string): void }) {
  const status = item.status === "succeeded" ? "Succeeded" : item.status === "failed" ? "Failed" : "Running";
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

function RunBlock({ run, index, expandThinking, changePaths, onOpenChange }: { run: RunEvidence; index: number; expandThinking: boolean; changePaths: string[]; onOpenChange(path: string): void }) {
  const status = run.status[0].toUpperCase() + run.status.slice(1);
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
}

type InspectorView = "details" | "changes";
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

function InspectorTabs({ selected, changeCount, onSelect }: { selected: InspectorView; changeCount: number; onSelect(view: InspectorView): void }) {
  const tabs: Array<{ id: InspectorView; label: string }> = [{ id: "details", label: "Details" }, { id: "changes", label: "Changes" }];
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, direction: number) => {
    const index = tabs.findIndex(({ id }) => id === selected);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    onSelect(next.id);
    requestAnimationFrame(() => document.getElementById(`inspector-${next.id}-tab`)?.focus());
    event.preventDefault();
  };
  return <div className="tabs" role="tablist" aria-label="Inspector views">
    {tabs.map(({ id, label }) => <button key={id} id={`inspector-${id}-tab`} role="tab" data-action={id === "details" ? "view.details" : undefined} aria-controls={`inspector-${id}-panel`} aria-selected={selected === id} aria-label={id === "changes" ? `Changes, ${changeCount} changed file${changeCount === 1 ? "" : "s"}` : label} tabIndex={selected === id ? 0 : -1} onClick={() => onSelect(id)} onKeyDown={(event) => {
      if (event.key === "ArrowLeft") move(event, -1);
      else if (event.key === "ArrowRight") move(event, 1);
      else if (event.key === "Home") move(event, -tabs.findIndex(({ id: value }) => value === selected));
      else if (event.key === "End") move(event, tabs.length - 1 - tabs.findIndex(({ id: value }) => value === selected));
    }}><span>{label}</span>{id === "changes" && changeCount > 0 && <span className="tab-badge" aria-hidden="true">{changeCount}</span>}</button>)}
    <button role="tab" aria-selected="false" tabIndex={-1} disabled>History</button>
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

function ChangesPanel({ project, task, changes, loadError, selectedPath, onSelect }: {
  project: ProjectAccess;
  task: TaskSummary;
  changes?: TaskChanges;
  loadError: string;
  selectedPath?: string;
  onSelect(path: string): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const [diff, setDiff] = useState<TaskFileDiff>();
  const [diffError, setDiffError] = useState("");
  const [openError, setOpenError] = useState("");
  const selected = changes?.files.find(({ path }) => path === selectedPath);

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

  const open = (filePath?: string) => {
    setOpenError("");
    void window.pilot.openTaskPathInEditor(project.path, task.path, filePath).catch((reason) => setOpenError(reason instanceof Error ? reason.message : String(reason)));
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
    <div className="execution-editor-row"><code title={changes.executionPath}>{changes.executionPath}</code><button type="button" onClick={() => open()}>Open execution location in editor</button></div>
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
            <header><div><span>{changeStatusLabels[selected.status]}</span><h3 id="selected-change-title">{selected.path}</h3></div><button type="button" disabled={selected.status === "deleted"} onClick={() => open(selected.path)}>Open {selected.path} in editor</button></header>
            {!diff && !diffError ? <p className="muted" role="status">Loading unified diff…</p>
              : diff?.binary ? <p className="muted">Binary file content is not shown.</p>
                : diff?.truncated ? <p className="muted">This diff is too large to display. Open the file in your editor to review it.</p>
                  : diff ? <>
                    {diff.metadata.length > 0 && <ul className="diff-metadata" aria-label="Git change metadata">{diff.metadata.map((line) => <li key={line}><code>{line}</code></li>)}</ul>}
                    {diff.hunks.length ? <VirtualDiff key={diff.path} diff={diff} /> : <p className="muted">No text hunks to display.</p>}
                  </> : null}
          </section>}
        </>}
    {(diffError || openError) && <p className="error changes-error" role="alert">{diffError || openError}</p>}
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

function TaskPage({ project, task, reloadToken, changePaths, onCreate, onDetails, onOpenSettings, onOpenChange, onRunChange, onActionStart, onError }: {
  project: ProjectAccess;
  task: TaskSummary;
  reloadToken: number;
  changePaths: string[];
  onCreate(): void;
  onDetails(next: TaskModelState): void;
  onOpenSettings(): void;
  onOpenChange(path: string): void;
  onRunChange(active: boolean): void;
  onActionStart(): void;
  onError(reason: unknown, recovery: string): void;
}) {
  const [timeline, setTimeline] = useState<TaskRunState>();
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
  const taskPage = useRef<HTMLDivElement>(null);
  const followingLatest = useRef(true);
  const positionedTask = useRef("");
  const lastScrollTop = useRef(0);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const imageDragDepth = useRef(0);
  const currentTaskPath = useRef(task.path);
  currentTaskPath.current = task.path;
  const completionListId = useId();
  const imageHelpId = useId();
  const updateModelState = (next: TaskModelState) => { setModelState(next); onDetails(next); };
  const refreshDetails = () => window.pilot.getTaskModel(project.path, task.path).then(updateModelState);

  useEffect(() => {
    let cancelled = false;
    let receivedRunEvent = false;
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
    void window.pilot.getTaskResources(project.path, task.path).then((taskResources) => {
      if (!cancelled) {
        setResources(taskResources);
        if (reloadToken) setActionNotice("Pi resources reloaded");
      }
    }).catch((reason) => {
      if (!cancelled && reloadToken) onError(reason, "Fix the reported Pi resource, then reload resources again.");
      if (!cancelled) setResources({
        taskPath: task.path,
        commands: [],
        files: [],
        diagnostics: [{ severity: "error", message: reason instanceof Error ? reason.message : String(reason) }],
      });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [project.path, task.path, reloadToken, onError]);

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
  const latestEvidenceKey = latestRunEvidence ? JSON.stringify(latestRunEvidence) : "";

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
  }, [task.path, latestEvidenceKey]);

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
  useEffect(() => {
    onRunChange(active);
    return () => onRunChange(false);
  }, [active, onRunChange]);
  const live = activeRun?.input.kind === "prompt";
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
    if (!input || (active && (!liveReady || !mode))) return;
    setError("");
    setDraft("");
    const hiddenCommand = !active && input.startsWith("!!");
    const command = hiddenCommand ? input.slice(2) : !active && input.startsWith("!") ? input.slice(1) : undefined;
    const operation = active
      ? window.pilot.queuePrompt(task.path, input, mode!)
      : command !== undefined
        ? window.pilot.executeCommand(project.path, task.path, command, !hiddenCommand)
        : window.pilot.submitPrompt(project.path, task.path, input, images);
    void operation.then(() => {
      if (!active) setImages([]);
      return refreshDetails();
    }).catch((reason) => {
      setDraft((current) => [input, current].filter((value) => value.trim()).join("\n\n"));
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  const queues = timeline?.queues ?? { steering: [], followUp: [] };

  return <div ref={taskPage} className="task-page">
    <header className="topbar task-topbar">
      <div><p className="eyebrow">Active Task</p><h1>{task.title}</h1><span className="execution-location">Local execution location</span></div>
      <button className="new-task-button" data-action="task.new" onClick={onCreate}>New Task</button>
    </header>
    <section className="run-timeline" aria-label="Run timeline">
      <div className="timeline-heading"><h2>Run timeline</h2><div><span aria-live="polite">{active ? "Run active" : `${timeline?.runs.length ?? 0} Runs`}</span><button type="button" disabled={active} onClick={() => {
        setError("");
        onActionStart();
        void window.pilot.compactTask(project.path, task.path).then(refreshDetails).catch((reason) => onError(reason, "Add more Task history or check provider access, then try compacting again."));
      }} data-action="run.compact">Compact context</button></div></div>
      {timeline?.runs.length ? timeline.runs.map((run, index) => <RunBlock key={run.id} run={run} index={index} expandThinking={expandThinking} changePaths={changePaths} onOpenChange={onOpenChange} />) : <p className="muted">Submit a prompt or inline command to start this Task.</p>}
      {actionNotice && <p className="success action-notice" role="status">{actionNotice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
    <div className="composer-dock">
      {showJumpLatest && <button type="button" className="jump-latest" aria-label="Jump to latest Run evidence" title="Jump to latest" onClick={jumpToLatest}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.75 6.25 3.25 3.25 3.25-3.25" /></svg>
      </button>}
      <form className="task-composer" aria-label="Task composer" onDragEnter={(event) => {
      if (active || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      imageDragDepth.current += 1;
      setImageDragActive(true);
    }} onDragOver={(event) => {
      if (event.dataTransfer.types.includes("Files") && !active) event.preventDefault();
    }} onDragLeave={(event) => {
      if (!imageDragActive) return;
      event.preventDefault();
      imageDragDepth.current = Math.max(0, imageDragDepth.current - 1);
      if (!imageDragDepth.current) setImageDragActive(false);
    }} onDrop={(event) => {
      imageDragDepth.current = 0;
      setImageDragActive(false);
      if (active || !event.dataTransfer.files.length) return;
      event.preventDefault();
      void attachFiles([...event.dataTransfer.files]);
    }} onSubmit={(event) => { event.preventDefault(); submit(active ? liveMode : undefined); }}>
      {imageDragActive && <div className="image-drop-feedback" aria-hidden="true"><span>＋</span> Drop images to attach</div>}
      <label htmlFor="task-prompt">{live ? "Guide the active Run" : "Prompt or inline command"}</label>
      {resources?.diagnostics.length ? <section className="resource-diagnostics" aria-label="Pi resource diagnostics">
        {resources.diagnostics.map((diagnostic, index) => <p key={`${diagnostic.path ?? "resource"}-${index}`} className={diagnostic.severity}><strong>Pi resource {diagnostic.severity}:</strong> {diagnostic.message}{diagnostic.path && <code>{diagnostic.path}</code>}</p>)}
      </section> : null}
      {live && <fieldset className="live-input-mode" role="radiogroup" aria-label="Live input mode">
        <legend>Delivery</legend>
        <label><input type="radio" name="live-input-mode" checked={liveMode === "steer"} onChange={() => setLiveMode("steer")} />Steer <small>after the current tool batch</small></label>
        <label><input type="radio" name="live-input-mode" checked={liveMode === "followUp"} onChange={() => setLiveMode("followUp")} />Follow-up <small>after this Run settles</small></label>
      </fieldset>}
      <div className="composer-editor">
        <textarea ref={promptInput} id="task-prompt" data-action="view.focusPrompt" role="combobox" aria-label="Prompt" aria-autocomplete="list" aria-expanded={showCompletions} aria-controls={completionListId} aria-activedescendant={showCompletions ? `${completionListId}-${completionIndex}` : undefined} value={draft} disabled={active && !live} onChange={(event) => {
          setDraft(event.target.value);
          setCursor(event.target.selectionStart);
          setDismissedCompletion("");
        }} onSelect={(event) => setCursor(event.currentTarget.selectionStart)} onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!active && files.length) {
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
          <TaskModelControls project={project} task={task} state={modelState} disabled={active} onChange={updateModelState} onOpenSettings={onOpenSettings} onActionStart={onActionStart} onError={onError} />
        </div>
        <div className="composer-submit-controls">
          {!active && <>
            <input ref={imagePicker} className="visually-hidden" type="file" aria-label="Choose images" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => {
              void attachFiles([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = "";
            }} />
            <button type="button" className="attachment-trigger" aria-label={attachingImages ? "Preparing images" : "Attach images"} aria-describedby={imageHelpId} aria-busy={attachingImages} title="Attach images — PNG, JPEG, GIF, or WebP, up to 20 MB" disabled={attachingImages} onClick={() => imagePicker.current?.click()}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.3 8.8 9.7 4.4a2.1 2.1 0 0 1 3 3l-5.5 5.5a3.5 3.5 0 0 1-5-5l5.6-5.5" /></svg>
            </button>
            <span id={imageHelpId} className="visually-hidden">Paste, drop, or select PNG, JPEG, GIF, or WebP images up to 20 MB each</span>
          </>}
          {active && !draft.trim()
            ? <button type="button" data-action="run.stop" className="composer-action stop-action" aria-label="Stop Run" title="Stop Run" onClick={() => { onActionStart(); void window.pilot.abortTask(task.path).catch((reason) => onError(reason, "The Run may already be settled. Reload the Task if its status looks stale.")); }}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" rx="1" /></svg>
            </button>
            : <button type="submit" className="composer-action send-action" aria-label="Send" title="Send" disabled={!draft.trim() || (active && !liveReady)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12V4M4.75 7.25 8 4l3.25 3.25" /></svg>
            </button>}

        </div>
      </div>
      </form>
    </div>
  </div>;
}

function ProjectPage({ project, needsAccess, selectedTaskPath, reloadToken, changePaths, onSelectTask, onCreateTask, onOpenAccess, onChange, onDetails, onOpenSettings, onOpenChange, onRunChange, onActionStart, onError }: {
  project: ProjectAccess;
  needsAccess: boolean;
  selectedTaskPath?: string;
  reloadToken: number;
  changePaths: string[];
  onSelectTask(path: string): void;
  onCreateTask(): void;
  onOpenAccess(): void;
  onChange(state: ProjectsState): void;
  onDetails(state: TaskModelState): void;
  onOpenSettings(): void;
  onOpenChange(path: string): void;
  onRunChange(active: boolean): void;
  onActionStart(): void;
  onError(reason: unknown, recovery: string): void;
}) {
  const active = project.tasks.filter(({ lifecycle }) => lifecycle === "active");
  const archived = project.tasks.filter(({ lifecycle }) => lifecycle === "archived");
  const selectedTask = active.find(({ path }) => path === selectedTaskPath);
  if (selectedTask && !needsAccess) return <TaskPage project={project} task={selectedTask} reloadToken={reloadToken} changePaths={changePaths} onCreate={onCreateTask} onDetails={onDetails} onOpenSettings={onOpenSettings} onOpenChange={onOpenChange} onRunChange={onRunChange} onActionStart={onActionStart} onError={onError} />;
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
        {archived.length ? <ul>{archived.map((task) => <li key={task.path}><strong>{task.title}</strong><span>Archived</span><button onClick={() => { onActionStart(); void window.pilot.setTaskArchived(project.path, task.path, false).then(onChange).catch((reason) => onError(reason, "Reload the Project and try restoring the Task again.")); }}>Restore</button></li>)}</ul> : <p className="muted">No archived Tasks</p>}
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

type ActionFailure = { message: string; recovery: string };

function ActionError({ failure, onDismiss }: { failure: ActionFailure; onDismiss(): void }) {
  return <div className="action-error" role="alert"><span><strong>Action failed.</strong> {failure.message}<small>{failure.recovery}</small></span><button type="button" aria-label="Dismiss error" onClick={onDismiss}>×</button></div>;
}

function App() {
  const [state, setState] = useState<StartupState>();
  const [projects, setProjects] = useState<ProjectsState>();
  const [selectedTaskPath, setSelectedTaskPath] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDestination, setSettingsDestination] = useState<"general" | "providers">("general");
  const [showProjectAccess, setShowProjectAccess] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [runActive, setRunActive] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => matchMedia("(max-width: 1040px)").matches);
  const [actionError, setActionError] = useState<ActionFailure>();
  const [taskDetails, setTaskDetails] = useState<TaskModelState>();
  const [inspectorView, setInspectorView] = useState<InspectorView>("details");
  const [taskChanges, setTaskChanges] = useState<TaskChanges>();
  const [changesError, setChangesError] = useState("");
  const [selectedChangePath, setSelectedChangePath] = useState<string>();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const detailsReturnFocus = useRef<HTMLElement | null>(null);
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
    setActionError(undefined);
    try {
      const task = await window.pilot.createTask(project.path);
      setProjects(await window.pilot.getProjects());
      setTaskDetails(undefined);
      setSelectedTaskPath(task.path);
    } catch (reason) {
      setActionError({ message: reason instanceof Error ? reason.message : String(reason), recovery: "Check Project access and try creating the Task again." });
    }
  }, [projects?.selected?.path]);
  const openProviderSettings = useCallback(() => {
    setSettingsDestination("providers");
    setShowSettings(true);
  }, []);
  const closeDetails = useCallback(() => {
    setShowDetails(false);
    requestAnimationFrame(() => detailsReturnFocus.current?.focus());
  }, []);
  const openChange = useCallback((filePath: string) => {
    const target = taskChanges?.files.find((file) => file.path === filePath || file.previousPath === filePath)?.path;
    if (!target) return;
    detailsReturnFocus.current = document.activeElement as HTMLElement | null;
    setSelectedChangePath(target);
    setInspectorView("changes");
    setShowDetails(true);
    requestAnimationFrame(() => document.getElementById("inspector-changes-tab")?.focus());
  }, [taskChanges]);
  const clearActionError = useCallback(() => setActionError(undefined), []);
  const reportActionError = useCallback((reason: unknown, recovery: string) => {
    setActionError({ message: reason instanceof Error ? reason.message : String(reason), recovery });
  }, []);
  const handleRunChange = useCallback((active: boolean) => setRunActive(active), []);

  const selectedProject = projects?.selected;
  const selectedTask = selectedProject?.tasks.find(({ path }) => path === selectedTaskPath);
  const needsProjectAccess = Boolean(selectedProject && (!selectedProject.executionConsent || (selectedProject.resourceTrust.required && selectedProject.resourceTrust.decision === null)));
  const workspaceAvailable = !showSettings;
  const taskAvailable = Boolean(workspaceAvailable && selectedTask && !needsProjectAccess);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    setTaskChanges(undefined);
    setChangesError("");
    setSelectedChangePath(undefined);
    if (!selectedProject || !selectedTask || needsProjectAccess) return;
    const refreshChanges = async () => {
      try {
        const next = await window.pilot.getTaskChanges(selectedProject.path, selectedTask.path);
        if (cancelled) return;
        setTaskChanges(next);
        setChangesError("");
        setSelectedChangePath((current) => current && next.files.some(({ path }) => path === current) ? current : next.files[0]?.path);
      } catch (reason) {
        if (!cancelled) {
          setTaskChanges(undefined);
          setChangesError(reason instanceof Error ? reason.message : String(reason));
        }
      }
      if (!cancelled) timer = window.setTimeout(refreshChanges, 1_500);
    };
    void refreshChanges();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [selectedProject?.path, selectedTask?.path, needsProjectAccess]);
  const unavailable = (reason: string) => ({ enabled: false, reason });
  const availability: ActionAvailability = {
    "project.add": workspaceAvailable ? { enabled: true } : unavailable("Return to the command center to add a Project"),
    "task.new": taskAvailable || Boolean(workspaceAvailable && selectedProject && !needsProjectAccess) ? { enabled: true } : unavailable("Select a Project with access enabled"),
    "task.exportJsonl": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task"),
    "task.exportHtml": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task"),
    "task.archive": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task"),
    "task.chooseModel": taskAvailable && !runActive && Boolean(taskDetails?.selected) ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task with an available model"),
    "task.chooseThinking": taskAvailable && !runActive && (taskDetails?.thinkingLevels.length ?? 0) > 1 ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "No alternative thinking levels"),
    "resources.reload": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "Stop the active Run first" : "Select a Task"),
    "run.compact": taskAvailable && !runActive ? { enabled: true } : unavailable(runActive ? "A Run is active" : "Select a Task"),
    "run.stop": runActive ? { enabled: true } : unavailable("No Run is active"),
    "view.focusPrompt": taskAvailable ? { enabled: true } : unavailable("Select a Task"),
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
    if (id === "task.new") { void createSelectedTask(); return; }
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
    const media = matchMedia("(max-width: 1040px)");
    const updateLayout = () => setCompactLayout(media.matches);
    media.addEventListener("change", updateLayout);
    return () => media.removeEventListener("change", updateLayout);
  }, []);
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
  useEffect(() => {
    refresh();
    void window.pilot.getPreferences().then((value) => applyAppearance(value.appearance));
  }, []);
  useEffect(() => setActionError(undefined), [selectedProject?.path, selectedTask?.path, showSettings]);

  if (showSettings) return <>
    <div className="window-bar" aria-hidden="true" />
    <SettingsPage initialDestination={settingsDestination} onChange={refresh} onClose={closeSettings} />
    <CommandPalette open={paletteOpen} availability={availability} onClose={() => setPaletteOpen(false)} onInvoke={invokeAction} />
    {actionError && <ActionError failure={actionError} onDismiss={() => setActionError(undefined)} />}
  </>;

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
            <button data-action="project.add" aria-label="Add project" title="Add Project" onClick={() => invokeAction("project.add")}>+</button>
          </div>
          {projects?.projects.length ? (
            <ul className="project-list">
              {projects.projects.map((project) => (
                <li key={project.path}>
                  <button aria-current={projects.selected?.path === project.path ? "page" : undefined} onClick={() => {
                    setSelectedTaskPath(undefined);
                    setTaskDetails(undefined);
                    void window.pilot.selectProject(project.path).then(setProjects).catch((reason) => reportActionError(reason, "Reload the Project list and try selecting it again."));
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
            <button type="button" className="command-center" data-action="view.commandPalette" onClick={() => invokeAction("view.commandPalette")}><span>Command Palette</span><kbd>{shortcutLabel("CommandOrControl+Shift+P")}</kbd></button>
            <button ref={settingsButton} data-action="view.settings" className="settings-button" aria-label="Settings" title="Settings" onClick={() => { setSettingsDestination("general"); setShowSettings(true); }}><span aria-hidden="true">⚙</span></button>
          </div>
        </nav>

        <main id="content" className="workspace-main">
          {selectedProject ? <ProjectPage
            project={selectedProject}
            needsAccess={needsProjectAccess}
            selectedTaskPath={selectedTaskPath}
            reloadToken={reloadToken}
            changePaths={taskChanges?.files.flatMap(({ path, previousPath }) => previousPath ? [path, previousPath] : [path]) ?? []}
            onSelectTask={(path) => { setTaskDetails(undefined); setSelectedTaskPath(path); }}
            onCreateTask={() => void createSelectedTask()}
            onOpenAccess={() => setShowProjectAccess(true)}
            onChange={setProjects}
            onDetails={setTaskDetails}
            onOpenSettings={openProviderSettings}
            onOpenChange={openChange}
            onRunChange={handleRunChange}
            onActionStart={clearActionError}
            onError={reportActionError}
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

        <aside aria-label="Inspector" className={`inspector${showDetails ? " details-visible" : ""}`}>
          <InspectorTabs selected={inspectorView} changeCount={taskChanges?.files.length ?? 0} onSelect={setInspectorView} />
          <button type="button" className="inspector-close" aria-label="Close Inspector" onClick={closeDetails}>×</button>
          {inspectorView === "details" ? <div id="inspector-details-panel" className="inspector-body" role="tabpanel" aria-labelledby="inspector-details-tab">
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
          </div> : <div id="inspector-changes-panel" className="inspector-body changes-inspector-body" role="tabpanel" aria-labelledby="inspector-changes-tab">
            {selectedProject && selectedTask && !needsProjectAccess
              ? <ChangesPanel project={selectedProject} task={selectedTask} changes={taskChanges} loadError={changesError} selectedPath={selectedChangePath} onSelect={setSelectedChangePath} />
              : <div className="changes-empty"><strong>Select a Task</strong><p>Choose an active Task to review its Git changes.</p></div>}
          </div>}
        </aside>
      </div>
      {selectedProject && (needsProjectAccess || showProjectAccess) && <ProjectAccessDialog project={selectedProject} dismissible={!needsProjectAccess} onChange={updateProjectAccess} onClose={closeProjectAccess} />}
      <CommandPalette open={paletteOpen} availability={availability} onClose={() => setPaletteOpen(false)} onInvoke={invokeAction} />
      {actionError && <ActionError failure={actionError} onDismiss={() => setActionError(undefined)} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
