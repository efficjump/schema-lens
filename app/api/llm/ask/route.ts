import { createStructuredResponse, errorResponse } from "@/lib/llm/provider";
import { ANSWER_INSTRUCTIONS, buildAnswerInput } from "@/lib/llm/prompts";
import { enforceLlmRateLimit } from "@/lib/llm/rate-limit";
import {
  redactSensitiveValue,
  sanitizeAskRequestForLlm,
  sanitizeIncomingLlmPayload,
} from "@/lib/llm/redaction";
import { answerOutputSchema } from "@/lib/llm/schemas";
import type { AnswerResult, LlmSuccess } from "@/lib/llm/types";
import {
  parseAskRequest,
  readJsonBody,
  reconcileAnswerResult,
} from "@/lib/llm/validation";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    enforceLlmRateLimit(request);
    const askRequest = sanitizeAskRequestForLlm(
      parseAskRequest(
        sanitizeIncomingLlmPayload(await readJsonBody(request)),
      ),
    );
    const response = await createStructuredResponse<unknown>({
      instructions: ANSWER_INSTRUCTIONS,
      input: buildAnswerInput(askRequest),
      schemaName: "erd_grounded_answer",
      schema: answerOutputSchema,
      reasoningEffort: "none",
      maxOutputTokens: 3_500,
      signal: request.signal,
    });
    const data = redactSensitiveValue(
      reconcileAnswerResult(response.data, askRequest),
    );

    const body: LlmSuccess<AnswerResult> = {
      ok: true,
      data,
      meta: {
        provider: "custom",
        usage: response.usage,
      },
    };

    return Response.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
