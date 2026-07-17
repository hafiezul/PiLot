import { useEffect, useState } from "react";
import type { AgentCompactionSettings, AgentRetrySettings, AgentSettingsState } from "../shared/agent-settings";
import { thinkingLevels, type ThinkingLevel } from "../shared/projects";

function modelKey(provider: string, modelId: string) {
  return `${provider}/${modelId}`;
}

function thinkingLevelLabel(level: ThinkingLevel) {
  return level[0].toUpperCase() + level.slice(1);
}

export function AgentSettings() {
  const [state, setState] = useState<AgentSettingsState>();
  const [scopeDraft, setScopeDraft] = useState("");
  const [retryDraft, setRetryDraft] = useState<AgentRetrySettings>();
  const [compactionDraft, setCompactionDraft] = useState<AgentCompactionSettings>();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const receive = (next: AgentSettingsState, synchronizeScope = false) => {
    setState(next);
    setRetryDraft(next.retry);
    setCompactionDraft(next.compaction);
    if (synchronizeScope) setScopeDraft(next.enabledModels.join("\n"));
    setError("");
  };

  const attempt = async (action: () => Promise<AgentSettingsState>, success: string, synchronizeScope = false) => {
    if (busy) return;
    setBusy(success);
    setNotice("");
    setError("");
    try {
      receive(await action(), synchronizeScope);
      setNotice(success);
    } catch (reason) {
      if (state) {
        setRetryDraft(state.retry);
        setCompactionDraft(state.compaction);
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  };

  const reload = () => attempt(() => window.pilot.getAgentSettings(), "Pi settings reloaded", true);
  useEffect(() => { void reload(); }, []);

  if (!state) return <section className="agent-settings" aria-label="Agent defaults" aria-busy={Boolean(busy)}>
    <div className="settings-page-heading"><h2>Agent defaults</h2><button type="button" disabled={Boolean(busy)} onClick={reload}>Retry</button></div>
    {error ? <p className="error settings-feedback" role="alert">{error}</p> : <p className="muted settings-feedback" role="status">Reading Pi settings…</p>}
  </section>;

  const selectedModel = state.defaultModel ? modelKey(state.defaultModel.provider, state.defaultModel.id) : "";
  const scopeSaved = state.enabledModels.join("\n");
  const retry = retryDraft ?? state.retry;
  const compaction = compactionDraft ?? state.compaction;
  const retryChanged = retry.enabled !== state.retry.enabled || retry.maxRetries !== state.retry.maxRetries || retry.baseDelayMs !== state.retry.baseDelayMs;
  const compactionChanged = compaction.enabled !== state.compaction.enabled || compaction.reserveTokens !== state.compaction.reserveTokens || compaction.keepRecentTokens !== state.compaction.keepRecentTokens;

  return <section className="agent-settings" aria-labelledby="agent-settings-title" aria-busy={Boolean(busy)}>
    <div className="settings-page-heading">
      <h2 id="agent-settings-title">Agent defaults</h2>
      <button type="button" disabled={Boolean(busy)} onClick={reload}>Reload Pi settings</button>
    </div>
    <p className="settings-introduction">These defaults are shared with compatible Pi interfaces. Existing Tasks keep their recorded model choices, and active Runs are not replaced underneath you.</p>
    <p className="settings-source">Canonical file <code>{state.settingsPath}</code></p>

    <section className="agent-settings-group" aria-labelledby="model-defaults-title">
      <header><h3 id="model-defaults-title">Model and thinking</h3><p>Used when a Task has not recorded its own choice.</p></header>
      <label className="agent-select-setting">Default model
        <select aria-label="Default model" value={selectedModel} disabled={Boolean(busy) || !state.models.length} onChange={(event) => {
          const model = state.models.find((candidate) => modelKey(candidate.provider, candidate.id) === event.target.value);
          if (model) void attempt(() => window.pilot.setDefaultAgentModel(model.provider, model.id), "Default model saved");
        }}>
          {!state.defaultModel && <option value="">Automatic · Pi default</option>}
          {state.defaultModel && !state.defaultModel.available && <option value={selectedModel}>{state.defaultModel.name} · {state.defaultModel.provider} (unavailable)</option>}
          {state.models.map((model) => <option key={modelKey(model.provider, model.id)} value={modelKey(model.provider, model.id)}>{model.name} · {model.provider}</option>)}
        </select>
        {!state.models.length && <small>Connect a provider before choosing a default model.</small>}
      </label>
      <label className="agent-select-setting">Default thinking level
        <select aria-label="Default thinking level" value={state.defaultThinkingLevel} disabled={Boolean(busy)} onChange={(event) => {
          void attempt(() => window.pilot.setDefaultAgentThinking(event.target.value as ThinkingLevel), "Default thinking saved");
        }}>
          {thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabel(level)}</option>)}
        </select>
        <small>Pi clamps the level when the selected model supports less reasoning.</small>
      </label>
    </section>

    <section className="agent-settings-group model-scope-setting" aria-labelledby="model-scope-title">
      <header><h3 id="model-scope-title">Model cycle scope</h3><p>One Pi model pattern per line, in cycle order. Leave blank to use all available models.</p></header>
      <textarea aria-label="Scoped model patterns" rows={4} spellCheck={false} disabled={Boolean(busy)} value={scopeDraft} onChange={(event) => setScopeDraft(event.target.value)} placeholder={"anthropic/claude-*\nopenai/gpt-*:high"} />
      {state.scopeDiagnostics.length > 0 && <ul className="scope-diagnostics" aria-label="Model scope notes">{state.scopeDiagnostics.map((message) => <li key={message}>{message}</li>)}</ul>}
      <div className="settings-save-row"><span>{scopeDraft === scopeSaved ? "Saved in Pi" : "Unsaved changes"}</span><button type="button" disabled={Boolean(busy) || scopeDraft === scopeSaved} onClick={() => {
        void attempt(() => window.pilot.setAgentModelScope(scopeDraft.split(/\r?\n/)), "Model scope saved", true);
      }}>Save model scope</button></div>
    </section>

    <section className="agent-settings-group runtime-defaults" aria-labelledby="runtime-defaults-title">
      <header><h3 id="runtime-defaults-title">Run recovery</h3><p>Shared retry and context-compaction behavior for compatible Pi interfaces.</p></header>
      <form aria-label="Retry defaults" onSubmit={(event) => {
        event.preventDefault();
        void attempt(() => window.pilot.setAgentRetry(retry), "Retry defaults saved");
      }}>
        <label className="runtime-toggle"><input type="checkbox" aria-label="Automatic retry" checked={retry.enabled} disabled={Boolean(busy)} onChange={(event) => setRetryDraft({ ...retry, enabled: event.target.checked })} /><span><strong>Automatic retry</strong><small>Retry transient model failures with exponential backoff.</small></span></label>
        <div className="runtime-number-settings">
          <label>Maximum retries<input type="number" aria-label="Maximum retries" min={0} step={1} required disabled={Boolean(busy)} value={retry.maxRetries} onChange={(event) => setRetryDraft({ ...retry, maxRetries: event.target.valueAsNumber || 0 })} /></label>
          <label>Base delay (milliseconds)<input type="number" aria-label="Base delay (milliseconds)" min={0} step={1} required disabled={Boolean(busy)} value={retry.baseDelayMs} onChange={(event) => setRetryDraft({ ...retry, baseDelayMs: event.target.valueAsNumber || 0 })} /></label>
        </div>
        <div className="settings-save-row"><span>{retryChanged ? "Unsaved changes" : "Saved in Pi"}</span><button type="submit" disabled={Boolean(busy) || !retryChanged}>Save retry defaults</button></div>
      </form>
      <form aria-label="Compaction defaults" onSubmit={(event) => {
        event.preventDefault();
        void attempt(() => window.pilot.setAgentCompaction(compaction), "Compaction defaults saved");
      }}>
        <label className="runtime-toggle"><input type="checkbox" aria-label="Automatic compaction" checked={compaction.enabled} disabled={Boolean(busy)} onChange={(event) => setCompactionDraft({ ...compaction, enabled: event.target.checked })} /><span><strong>Automatic compaction</strong><small>Summarize older context before the model window fills.</small></span></label>
        <div className="runtime-number-settings">
          <label>Recent tokens to keep<input type="number" aria-label="Recent tokens to keep" min={1} step={1} required disabled={Boolean(busy)} value={compaction.keepRecentTokens} onChange={(event) => setCompactionDraft({ ...compaction, keepRecentTokens: event.target.valueAsNumber || 1 })} /></label>
          <label>Reserved tokens<input type="number" aria-label="Reserved tokens" min={1} step={1} required disabled={Boolean(busy)} value={compaction.reserveTokens} onChange={(event) => setCompactionDraft({ ...compaction, reserveTokens: event.target.valueAsNumber || 1 })} /></label>
        </div>
        <div className="settings-save-row"><span>{compactionChanged ? "Unsaved changes" : "Saved in Pi"}</span><button type="submit" disabled={Boolean(busy) || !compactionChanged}>Save compaction defaults</button></div>
      </form>
    </section>
    {busy && <p className="muted settings-feedback" role="status">{busy === "Pi settings reloaded" ? "Reloading Pi settings…" : "Saving Pi settings…"}</p>}
    {notice && <p className="success settings-feedback" role="status">{notice}</p>}
    {error && <p className="error settings-feedback" role="alert">{error}</p>}
  </section>;
}
