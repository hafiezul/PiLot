export type CredentialSource = "stored" | "environment" | "runtime" | "models_json";

export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock", "ant-ling", "anthropic", "azure-openai-responses", "cerebras",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks", "google",
  "google-vertex", "groq", "huggingface", "kimi-coding", "minimax", "minimax-cn",
  "mistral", "moonshotai", "moonshotai-cn", "nvidia", "openai", "openai-codex",
  "opencode", "opencode-go", "openrouter", "together", "vercel-ai-gateway", "xai",
  "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
  "zai", "zai-coding-cn",
]);

export type ProviderSummary = {
  id: string;
  name: string;
  configured: boolean;
  credentialType?: "api_key" | "oauth";
  source?: CredentialSource;
  sourceLabel?: string;
  supportsOAuth: boolean;
};

export type ModelSummary = {
  id: string;
  name: string;
  provider: string;
};

export type ProviderLoginFlow = {
  id: string;
  providerId: string;
  providerName: string;
};

export type ProviderState = {
  models: ModelSummary[];
  providers: ProviderSummary[];
  activeLogin?: ProviderLoginFlow;
};

type OAuthFlowEvent = {
  flowId: string;
  providerId: string;
  providerName: string;
};

export type OAuthEvent = OAuthFlowEvent & (
  | { type: "started" }
  | { type: "auth"; instructions?: string; manualInput: false }
  | { type: "auth"; instructions?: string; manualInput: true; requestId: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "prompt"; requestId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { type: "select"; requestId: string; message: string; options: Array<{ id: string; label: string }> }
  | { type: "progress"; message: string }
  | { type: "success" }
  | { type: "failure"; message: string }
  | { type: "cancelled" }
);

export type PiLotApi = {
  getProviderState(): Promise<ProviderState>;
  setApiKey(provider: string, key: string): Promise<ProviderState>;
  removeApiKey(provider: string): Promise<ProviderState>;
  login(provider: string): Promise<ProviderState>;
  cancelLogin(flowId: string): Promise<ProviderState>;
  logout(provider: string): Promise<ProviderState>;
  respondToOAuth(flowId: string, requestId: string, value?: string): Promise<boolean>;
  onOAuthEvent(listener: (event: OAuthEvent) => void): () => void;
};
