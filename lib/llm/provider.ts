import { getLlmConfig, type LlmApiStyle } from "@/lib/llm/config";
import { redactSensitiveText } from "@/lib/llm/redaction";
import type { LlmErrorBody, LlmErrorCode, LlmUsage } from "@/lib/llm/types";

const REQUEST_TIMEOUT_MS = 45_000;

type ReasoningEffort = "none" | "low";

interface ProviderContentPart {
  type?: string;
  text?: string;
  refusal?: string;
}

interface ProviderOutputItem {
  type?: string;
  content?: ProviderContentPart[];
}

interface ProviderResponsePayload {
  id?: string;
  model?: string;
  status?: string;
  output_text?: string;
  output?: ProviderOutputItem[];
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | ProviderContentPart[] | null;
      refusal?: string | null;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
  } | null;
  incomplete_details?: {
    reason?: string;
  } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

export interface StructuredResponse<T> {
  data: T;
  usage: LlmUsage;
}

export class LlmServiceError extends Error {
  readonly code: LlmErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details?: string[];
  readonly fallback: boolean;
  readonly retryAfterSeconds?: number;

  constructor(options: {
    code: LlmErrorCode;
    message: string;
    httpStatus: number;
    retryable?: boolean;
    details?: string[];
    fallback?: boolean;
    retryAfterSeconds?: number;
  }) {
    super(options.message);
    this.name = "LlmServiceError";
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.fallback = options.fallback ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function redactProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const scrubbed = redactSensitiveText(value).trim();
  return scrubbed ? scrubbed.slice(0, 500) : undefined;
}

function textFromParts(parts: ProviderContentPart[] | undefined): string | null {
  const text = (parts ?? [])
    .filter((part) => part.type === "text" || part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return text || null;
}

function extractResponseText(
  payload: ProviderResponsePayload,
  apiStyle: LlmApiStyle,
): { text: string | null; refusal: string | null } {
  if (apiStyle === "chat-completions") {
    const message = payload.choices?.[0]?.message;
    const content = message?.content;
    const text =
      typeof content === "string" ? content.trim() || null : textFromParts(content ?? undefined);
    const refusal =
      (typeof message?.refusal === "string" && message.refusal.trim()) ||
      (Array.isArray(content)
        ? content.find((part) => part.type === "refusal")?.refusal?.trim()
        : null) ||
      null;
    return { text, refusal };
  }

  let refusal: string | null = null;
  const outputText: string[] = [];
  for (const item of payload.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "refusal" && typeof part.refusal === "string") {
        refusal ??= part.refusal;
      }
      if (part.type === "output_text" && typeof part.text === "string") {
        outputText.push(part.text);
      }
    }
  }

  const topLevelText =
    typeof payload.output_text === "string" && payload.output_text.trim()
      ? payload.output_text.trim()
      : null;
  return {
    text: topLevelText ?? (outputText.join("").trim() || null),
    refusal,
  };
}

function parseStructuredJson<T>(text: string): T {
  const candidates = [text.trim()];
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next conservative extraction strategy.
    }
  }

  throw new LlmServiceError({
    code: "LLM_INVALID_OUTPUT",
    message: "The model response could not be parsed as structured JSON.",
    httpStatus: 502,
    retryable: true,
  });
}

function usageFrom(payload: ProviderResponsePayload): LlmUsage {
  return {
    inputTokens: payload.usage?.input_tokens ?? payload.usage?.prompt_tokens ?? null,
    outputTokens:
      payload.usage?.output_tokens ?? payload.usage?.completion_tokens ?? null,
    totalTokens: payload.usage?.total_tokens ?? null,
  };
}

async function readProviderPayload(response: Response): Promise<ProviderResponsePayload> {
  const responseText = await response.text();
  if (!responseText) return {};
  try {
    return JSON.parse(responseText) as ProviderResponsePayload;
  } catch {
    return { error: { message: redactProviderMessage(responseText) } };
  }
}

function providerHttpError(status: number): LlmServiceError {
  if (status === 429) {
    return new LlmServiceError({
      code: "LLM_RATE_LIMITED",
      message: "The LLM API request limit was reached. Try again shortly.",
      httpStatus: 429,
      retryable: true,
    });
  }
  if (status === 401 || status === 403) {
    return new LlmServiceError({
      code: "LLM_PROVIDER_ERROR",
      message: "Check the LLM API credentials and model access permissions.",
      httpStatus: 502,
    });
  }
  return new LlmServiceError({
    code: "LLM_PROVIDER_ERROR",
    message: "The LLM API could not complete the request.",
    httpStatus: 502,
    retryable: status >= 500,
  });
}

function requestBody(
  apiStyle: LlmApiStyle,
  model: string,
  options: {
    instructions: string;
    input: string;
    schemaName: string;
    schema: Record<string, unknown>;
    reasoningEffort: ReasoningEffort;
    maxOutputTokens: number;
  },
): Record<string, unknown> {
  if (apiStyle === "chat-completions") {
    return {
      model,
      messages: [
        { role: "system", content: options.instructions },
        { role: "user", content: options.input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: options.schemaName,
          strict: true,
          schema: options.schema,
        },
      },
      max_completion_tokens: options.maxOutputTokens,
    };
  }

  return {
    model,
    instructions: options.instructions,
    input: options.input,
    reasoning: { effort: options.reasoningEffort },
    text: {
      format: {
        type: "json_schema",
        name: options.schemaName,
        strict: true,
        schema: options.schema,
      },
    },
    max_output_tokens: options.maxOutputTokens,
    store: false,
  };
}

function completionIsIncomplete(
  payload: ProviderResponsePayload,
  apiStyle: LlmApiStyle,
): string | null {
  if (apiStyle === "chat-completions") {
    const reason = payload.choices?.[0]?.finish_reason;
    return reason && reason !== "stop" ? reason : null;
  }
  return payload.status && payload.status !== "completed" ? payload.status : null;
}

export async function createStructuredResponse<T>(options: {
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: number;
  signal?: AbortSignal;
}): Promise<StructuredResponse<T>> {
  const config = getLlmConfig();
  if (!config.configured || !config.apiUrl || !config.model) {
    throw new LlmServiceError({
      code: "LLM_NOT_CONFIGURED",
      message: config.invalidApiUrl
        ? "LLM_API_URL must use HTTPS or a local development address."
        : "Server-side LLM features require both LLM_API_URL and LLM_MODEL.",
      httpStatus: 503,
      fallback: true,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  let response: Response;
  let payload: ProviderResponsePayload;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    response = await fetch(config.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody(config.apiStyle, config.model, options)),
      signal: controller.signal,
    });
    payload = await readProviderPayload(response);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new LlmServiceError({
        code: "LLM_TIMEOUT",
        message: "The LLM API response timed out.",
        httpStatus: 504,
        retryable: true,
      });
    }
    throw new LlmServiceError({
      code: "LLM_PROVIDER_ERROR",
      message: "The LLM API could not be reached.",
      httpStatus: 502,
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!response.ok) throw providerHttpError(response.status);
  if (payload.error) {
    throw new LlmServiceError({
      code: "LLM_PROVIDER_ERROR",
      message: "The LLM API response contained an error.",
      httpStatus: 502,
      retryable: true,
    });
  }

  const extracted = extractResponseText(payload, config.apiStyle);
  if (extracted.refusal) {
    throw new LlmServiceError({
      code: "LLM_REFUSAL",
      message: "The model declined this request.",
      httpStatus: 422,
    });
  }

  const incompleteReason = completionIsIncomplete(payload, config.apiStyle);
  if (incompleteReason || !extracted.text) {
    throw new LlmServiceError({
      code: "LLM_INCOMPLETE",
      message: "The model response was incomplete.",
      httpStatus: 502,
      retryable: true,
    });
  }

  return {
    data: parseStructuredJson<T>(extracted.text),
    usage: usageFrom(payload),
  };
}

export function errorResponse(error: unknown): Response {
  const serviceError =
    error instanceof LlmServiceError
      ? error
      : new LlmServiceError({
          code: "LLM_PROVIDER_ERROR",
          message: "An unexpected error occurred while processing the LLM request.",
          httpStatus: 500,
        });

  const body: LlmErrorBody = {
    ok: false,
    error: {
      code: serviceError.code,
      message: serviceError.message,
      ...(serviceError.details ? { details: serviceError.details } : {}),
      retryable: serviceError.retryable,
      ...(serviceError.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: serviceError.retryAfterSeconds }
        : {}),
    },
    ...(serviceError.fallback
      ? { fallback: { available: true as const, mode: "local" as const } }
      : {}),
  };

  return Response.json(body, {
    status: serviceError.httpStatus,
    headers: {
      "Cache-Control": "no-store",
      ...(serviceError.retryAfterSeconds !== undefined
        ? { "Retry-After": String(serviceError.retryAfterSeconds) }
        : {}),
    },
  });
}
