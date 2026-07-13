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

export type ProviderState = {
  models: ModelSummary[];
  providers: ProviderSummary[];
};

export type OAuthEvent =
  | { type: "auth"; providerName: string; instructions?: string; manualInput: boolean }
  | { type: "device_code"; providerName: string; userCode: string; verificationUri: string }
  | { type: "prompt"; providerName: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { type: "select"; providerName: string; message: string; options: Array<{ id: string; label: string }> }
  | { type: "progress"; providerName: string; message: string };

export type PiLotApi = {
  getProviderState(): Promise<ProviderState>;
  setApiKey(provider: string, key: string): Promise<ProviderState>;
  removeApiKey(provider: string): Promise<ProviderState>;
  login(provider: string): Promise<ProviderState>;
  logout(provider: string): Promise<ProviderState>;
  respondToOAuth(value?: string): Promise<void>;
  onOAuthEvent(listener: (event: OAuthEvent) => void): () => void;
};
