import type { CSSProperties } from "react";
import type { SimpleIcon } from "simple-icons";
import {
  siAnthropic,
  siCloudflare,
  siDeepseek,
  siGooglecloud,
  siGooglegemini,
  siHuggingface,
  siKimi,
  siMinimax,
  siMistralai,
  siMoonshotai,
  siNvidia,
  siOpencode,
  siOpenrouter,
  siVercel,
  siXiaomi,
} from "simple-icons";

const providerIcons: Record<string, SimpleIcon> = {
  anthropic: siAnthropic,
  "cloudflare-ai-gateway": siCloudflare,
  "cloudflare-workers-ai": siCloudflare,
  deepseek: siDeepseek,
  google: siGooglegemini,
  "google-vertex": siGooglecloud,
  huggingface: siHuggingface,
  "kimi-coding": siKimi,
  minimax: siMinimax,
  "minimax-cn": siMinimax,
  mistral: siMistralai,
  moonshotai: siMoonshotai,
  "moonshotai-cn": siMoonshotai,
  nvidia: siNvidia,
  opencode: siOpencode,
  "opencode-go": siOpencode,
  openrouter: siOpenrouter,
  "vercel-ai-gateway": siVercel,
  xiaomi: siXiaomi,
  "xiaomi-token-plan-ams": siXiaomi,
  "xiaomi-token-plan-cn": siXiaomi,
  "xiaomi-token-plan-sgp": siXiaomi,
};

const adaptiveDarkIcons = new Set([siAnthropic, siKimi, siMoonshotai, siOpencode, siVercel]);

export function ProviderIcon({ id, builtIn }: { id: string; builtIn: boolean }) {
  const icon = builtIn ? providerIcons[id] : undefined;
  if (!icon) return <svg className="provider-icon generic" data-provider-icon="generic" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="6" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" />
    <path d="m10.7 8.2-3.4 6.6m6-6.6 3.4 6.6M8.5 17h7" />
  </svg>;

  const color = `#${icon.hex}`;
  const style = {
    "--provider-color": color,
    "--provider-color-dark": adaptiveDarkIcons.has(icon) ? "#f2f2ef" : color,
  } as CSSProperties;
  return <svg className="provider-icon branded" data-provider-icon={icon.slug} viewBox="0 0 24 24" style={style} aria-hidden="true">
    <path d={icon.path} />
  </svg>;
}
