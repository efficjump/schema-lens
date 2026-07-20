export const LLM_API_STYLES = ["responses", "chat-completions"] as const;

export type LlmApiStyle = (typeof LLM_API_STYLES)[number];

type LlmEnvironment = {
  LLM_API_KEY?: string;
  LLM_API_STYLE?: string;
  LLM_API_URL?: string;
  LLM_MODEL?: string;
  LLM_RATE_LIMIT_PER_MINUTE?: string;
};

const DEFAULT_RATE_LIMIT_PER_MINUTE = 12;

function readEnvironmentValue(name: keyof LlmEnvironment): string | undefined {
  if (typeof process !== "undefined") {
    const processValue = process.env[name];
    if (typeof processValue === "string" && processValue.trim()) {
      return processValue.trim();
    }
  }

  return undefined;
}

function normalizeApiStyle(value: string | undefined): LlmApiStyle {
  return LLM_API_STYLES.includes(value as LlmApiStyle)
    ? (value as LlmApiStyle)
    : "responses";
}

function normalizeApiUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) return null;
    if (url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function getLlmRateLimitPerMinute(): number {
  const configured = readEnvironmentValue("LLM_RATE_LIMIT_PER_MINUTE");
  if (configured === undefined) return DEFAULT_RATE_LIMIT_PER_MINUTE;

  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000) {
    return DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  return parsed;
}

export function getLlmConfig() {
  const rawApiUrl = readEnvironmentValue("LLM_API_URL");
  const apiUrl = normalizeApiUrl(rawApiUrl);
  const model = readEnvironmentValue("LLM_MODEL");

  return {
    apiKey: readEnvironmentValue("LLM_API_KEY"),
    apiStyle: normalizeApiStyle(readEnvironmentValue("LLM_API_STYLE")),
    apiUrl,
    model,
    configured: Boolean(apiUrl && model),
    invalidApiUrl: Boolean(rawApiUrl && !apiUrl),
  } as const;
}
