import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { shell, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OAuthEvent, ProviderLoginFlow, ProviderState } from "../shared/providers.js";
import { providerAuthTestFixture, TEST_OAUTH_PROVIDER_ID } from "./provider-test-fixture.js";

function services() {
  const agentDir = getAgentDir();
  const auth = AuthStorage.create(path.join(agentDir, "auth.json"));
  const models = ModelRegistry.create(auth, path.join(agentDir, "models.json"));
  return { auth, models };
}

function source(status: ReturnType<ModelRegistry["getProviderAuthStatus"]>) {
  switch (status.source) {
    case "stored": return { source: "stored" as const, sourceLabel: "Stored API key" };
    case "environment": return { source: "environment" as const, sourceLabel: status.label ? `Environment · ${status.label}` : "Environment" };
    case "runtime": return { source: "runtime" as const, sourceLabel: "Runtime API key" };
    case "fallback":
    case "models_json_key":
    case "models_json_command": return { source: "models_json" as const, sourceLabel: "models.json" };
    default: return {};
  }
}

type PendingReply = {
  id: string;
  promise: Promise<string | undefined>;
  resolve(value?: string): void;
  reject(error: Error): void;
};

type ActiveLogin = ProviderLoginFlow & {
  sender: WebContents;
  controller: AbortController;
  pending?: PendingReply;
  onDestroyed(): void;
};

class ProviderLoginCancelledError extends Error {
  constructor() {
    super("Authentication cancelled.");
    this.name = "ProviderLoginCancelledError";
  }
}

let activeLogin: ActiveLogin | undefined;

function oauthProviders(auth: AuthStorage) {
  const fixture = providerAuthTestFixture();
  return fixture ? [...auth.getOAuthProviders(), fixture] : auth.getOAuthProviders();
}

function publicLogin(flow: ActiveLogin): ProviderLoginFlow {
  return { id: flow.id, providerId: flow.providerId, providerName: flow.providerName };
}

function eventBase(flow: ActiveLogin) {
  return { flowId: flow.id, providerId: flow.providerId, providerName: flow.providerName };
}

function send(flow: ActiveLogin, event: OAuthEvent) {
  if (!flow.sender.isDestroyed()) flow.sender.send("providers:oauth-event", event);
}

function sendActive(flow: ActiveLogin, event: OAuthEvent) {
  if (activeLogin === flow) send(flow, event);
}

function activeLoginError() {
  return new Error(`Authentication is already in progress for ${activeLogin!.providerName}. Cancel it before starting another provider login.`);
}

function assertNoActiveLogin() {
  if (activeLogin) throw activeLoginError();
}

function assertActiveFlow(flow: ActiveLogin) {
  if (activeLogin !== flow) throw new ProviderLoginCancelledError();
}

function waitForReply(flow: ActiveLogin) {
  assertActiveFlow(flow);
  if (flow.pending) throw new Error("The provider requested another authentication response before the previous response finished.");
  let resolve!: (value?: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | undefined>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  // A callback-server flow can finish without consuming its manual fallback.
  void promise.catch(() => undefined);
  const pending = { id: randomUUID(), promise, resolve, reject };
  flow.pending = pending;
  return pending;
}

function finishLogin(flow: ActiveLogin, event: OAuthEvent | undefined, pendingError: Error) {
  if (activeLogin !== flow) return false;
  activeLogin = undefined;
  flow.sender.removeListener("destroyed", flow.onDestroyed);
  const pending = flow.pending;
  flow.pending = undefined;
  pending?.reject(pendingError);
  flow.controller.abort();
  if (event) send(flow, event);
  return true;
}

function cancelActiveLogin(flow: ActiveLogin, notify: boolean) {
  const error = new ProviderLoginCancelledError();
  return finishLogin(flow, notify ? { ...eventBase(flow), type: "cancelled" } : undefined, error);
}

function openLoginUrl(url: string, openExternal = true) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Provider returned an unsafe login URL.");
  if (openExternal) void shell.openExternal(url);
}

export function getProviderState(): ProviderState {
  const { auth, models } = services();
  const oauthIds = new Set(oauthProviders(auth).map(({ id }) => id));
  const ids = new Set([...models.getAll().map(({ provider }) => provider), ...auth.list(), ...oauthIds]);
  const providers = [...ids].map((id) => {
    const credential = auth.get(id);
    const status = models.getProviderAuthStatus(id);
    return {
      id,
      name: models.getProviderDisplayName(id),
      configured: Boolean(status.source),
      credentialType: credential?.type,
      supportsOAuth: oauthIds.has(id),
      ...(credential?.type === "oauth" ? { source: "stored" as const, sourceLabel: "Subscription" } : source(status)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const available = models.getAvailable().map((model) => ({
    id: model.id,
    name: model.name || model.id,
    provider: model.provider,
  })).sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  return { providers, models: available, ...(activeLogin ? { activeLogin: publicLogin(activeLogin) } : {}) };
}

export function setApiKey(provider: string, key: string) {
  assertNoActiveLogin();
  if (!provider || !key.trim()) throw new Error("Enter an API key.");
  services().auth.set(provider, { type: "api_key", key: key.trim() });
  return getProviderState();
}

export function removeApiKey(provider: string) {
  assertNoActiveLogin();
  const { auth } = services();
  if (auth.get(provider)?.type === "api_key") auth.remove(provider);
  return getProviderState();
}

export function logout(provider: string) {
  assertNoActiveLogin();
  services().auth.logout(provider);
  return getProviderState();
}

export function respondToOAuth(flowId: unknown, requestId: unknown, value: unknown, sender: WebContents) {
  if (typeof flowId !== "string" || typeof requestId !== "string" || (value !== undefined && typeof value !== "string")) return false;
  const flow = activeLogin;
  if (!flow || flow.id !== flowId || flow.sender !== sender || flow.pending?.id !== requestId) return false;
  const pending = flow.pending;
  flow.pending = undefined;
  pending.resolve(value);
  return true;
}

export function cancelLogin(flowId: unknown, sender: WebContents) {
  const flow = activeLogin;
  if (typeof flowId === "string" && flow?.id === flowId && flow.sender === sender) cancelActiveLogin(flow, true);
  return getProviderState();
}

export function login(providerId: unknown, sender: WebContents) {
  if (activeLogin) throw activeLoginError();
  if (typeof providerId !== "string" || !providerId) throw new Error("Choose a provider to authenticate.");
  const { auth } = services();
  const provider = oauthProviders(auth).find(({ id }) => id === providerId);
  if (!provider) throw new Error("This provider does not support subscription login.");

  const flow: ActiveLogin = {
    id: randomUUID(),
    providerId,
    providerName: provider.name,
    sender,
    controller: new AbortController(),
    onDestroyed: () => undefined,
  };
  flow.onDestroyed = () => { cancelActiveLogin(flow, false); };
  activeLogin = flow;
  sender.once("destroyed", flow.onDestroyed);
  send(flow, { ...eventBase(flow), type: "started" });

  void (async () => {
    let manualInput: PendingReply | undefined;
    try {
      const credentials = await provider.login({
        onAuth: ({ url, instructions }) => {
          assertActiveFlow(flow);
          openLoginUrl(url, provider.id !== TEST_OAUTH_PROVIDER_ID);
          if (provider.usesCallbackServer) manualInput = waitForReply(flow);
          sendActive(flow, provider.usesCallbackServer
            ? { ...eventBase(flow), type: "auth", instructions, manualInput: true, requestId: manualInput!.id }
            : { ...eventBase(flow), type: "auth", instructions, manualInput: false });
        },
        onDeviceCode: (info) => {
          assertActiveFlow(flow);
          openLoginUrl(info.verificationUri, provider.id !== TEST_OAUTH_PROVIDER_ID);
          sendActive(flow, { ...eventBase(flow), type: "device_code", userCode: info.userCode, verificationUri: info.verificationUri });
        },
        onPrompt: (prompt) => {
          const pending = waitForReply(flow);
          sendActive(flow, { ...eventBase(flow), type: "prompt", requestId: pending.id, ...prompt });
          return pending.promise.then((value) => value ?? "");
        },
        onProgress: (message) => sendActive(flow, { ...eventBase(flow), type: "progress", message }),
        onSelect: (prompt) => {
          const pending = waitForReply(flow);
          sendActive(flow, { ...eventBase(flow), type: "select", requestId: pending.id, ...prompt });
          return pending.promise;
        },
        onManualCodeInput: () => {
          if (!manualInput) {
            manualInput = waitForReply(flow);
            sendActive(flow, { ...eventBase(flow), type: "auth", manualInput: true, requestId: manualInput.id });
          }
          return manualInput.promise.then((value) => value ?? "");
        },
        signal: flow.controller.signal,
      });
      if (activeLogin !== flow) return;
      auth.set(providerId, { type: "oauth", ...credentials });
      finishLogin(flow, { ...eventBase(flow), type: "success" }, new Error("Authentication finished."));
    } catch (reason) {
      if (activeLogin !== flow) return;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      finishLogin(flow, { ...eventBase(flow), type: "failure", message: error.message }, error);
    }
  })();

  return getProviderState();
}
