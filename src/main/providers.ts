import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { shell, type WebContents } from "electron";
import path from "node:path";
import type { OAuthEvent, ProviderState } from "../shared/providers.js";

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

export function getProviderState(): ProviderState {
  const { auth, models } = services();
  const oauthIds = new Set(auth.getOAuthProviders().map(({ id }) => id));
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
  return { providers, models: available };
}

export function setApiKey(provider: string, key: string) {
  if (!provider || !key.trim()) throw new Error("Enter an API key.");
  services().auth.set(provider, { type: "api_key", key: key.trim() });
  return getProviderState();
}

export function removeApiKey(provider: string) {
  const { auth } = services();
  if (auth.get(provider)?.type === "api_key") auth.remove(provider);
  return getProviderState();
}

export function logout(provider: string) {
  services().auth.logout(provider);
  return getProviderState();
}

type PendingReply = { resolve(value?: string): void; reject(error: Error): void };
let pendingReply: PendingReply | undefined;

export function respondToOAuth(value?: string) {
  pendingReply?.resolve(value);
  pendingReply = undefined;
}

function waitForReply() {
  return new Promise<string | undefined>((resolve, reject) => { pendingReply = { resolve, reject }; });
}

export async function login(providerId: string, sender: WebContents) {
  const { auth } = services();
  const provider = auth.getOAuthProviders().find(({ id }) => id === providerId);
  if (!provider) throw new Error("This provider does not support subscription login.");
  const send = (event: OAuthEvent) => sender.send("providers:oauth-event", event);
  let manualInput: Promise<string | undefined> | undefined;
  try {
    await auth.login(providerId, {
      onAuth: ({ url, instructions }) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Provider returned an unsafe login URL.");
        void shell.openExternal(url);
        if (provider.usesCallbackServer) manualInput = waitForReply();
        send({ type: "auth", providerName: provider.name, instructions, manualInput: Boolean(provider.usesCallbackServer) });
      },
      onDeviceCode: (info) => {
        void shell.openExternal(info.verificationUri);
        send({ type: "device_code", providerName: provider.name, ...info });
      },
      onPrompt: (prompt) => {
        send({ type: "prompt", providerName: provider.name, ...prompt });
        return waitForReply().then((value) => value ?? "");
      },
      onProgress: (message) => send({ type: "progress", providerName: provider.name, message }),
      onSelect: (prompt) => {
        send({ type: "select", providerName: provider.name, ...prompt });
        return waitForReply();
      },
      onManualCodeInput: () => (manualInput ?? waitForReply()).then((value) => value ?? ""),
    });
    return getProviderState();
  } finally {
    pendingReply?.reject(new Error("Login finished."));
    pendingReply = undefined;
  }
}
