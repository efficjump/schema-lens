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
    message: "모델 응답을 구조화된 JSON으로 해석하지 못했습니다.",
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
      message: "LLM API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
      httpStatus: 429,
      retryable: true,
    });
  }
  if (status === 401 || status === 403) {
    return new LlmServiceError({
      code: "LLM_PROVIDER_ERROR",
      message: "LLM API 인증 또는 모델 접근 권한을 확인해 주세요.",
      httpStatus: 502,
    });
  }
  return new LlmServiceError({
    code: "LLM_PROVIDER_ERROR",
    message: "LLM API가 요청을 처리하지 못했습니다.",
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
        ? "LLM_API_URL은 HTTPS 주소 또는 로컬 개발 주소여야 합니다."
        : "LLM_API_URL과 LLM_MODEL이 설정되지 않아 서버 LLM 기능을 사용할 수 없습니다.",
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
        message: "LLM API 응답 대기 시간이 초과되었습니다.",
        httpStatus: 504,
        retryable: true,
      });
    }
    throw new LlmServiceError({
      code: "LLM_PROVIDER_ERROR",
      message: "LLM API에 연결하지 못했습니다.",
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
      message: "LLM API 응답에 오류가 포함되어 있습니다.",
      httpStatus: 502,
      retryable: true,
    });
  }

  const extracted = extractResponseText(payload, config.apiStyle);
  if (extracted.refusal) {
    throw new LlmServiceError({
      code: "LLM_REFUSAL",
      message: "모델이 이 요청에 대한 응답을 거절했습니다.",
      httpStatus: 422,
    });
  }

  const incompleteReason = completionIsIncomplete(payload, config.apiStyle);
  if (incompleteReason || !extracted.text) {
    throw new LlmServiceError({
      code: "LLM_INCOMPLETE",
      message: "모델 응답이 완료되지 않았습니다.",
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
          message: "LLM 요청을 처리하는 중 예기치 않은 오류가 발생했습니다.",
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
