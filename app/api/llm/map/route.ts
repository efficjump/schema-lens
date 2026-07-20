import { createStructuredResponse, errorResponse } from "@/lib/llm/provider";
import { buildMappingInput, MAPPING_INSTRUCTIONS } from "@/lib/llm/prompts";
import { enforceLlmRateLimit } from "@/lib/llm/rate-limit";
import {
  redactSensitiveValue,
  sanitizeIncomingLlmPayload,
  sanitizeMappingRequestForLlm,
} from "@/lib/llm/redaction";
import { mappingOutputSchema } from "@/lib/llm/schemas";
import type { LlmSuccess, MappingResult } from "@/lib/llm/types";
import {
  parseMappingRequest,
  readJsonBody,
  reconcileMappingResult,
} from "@/lib/llm/validation";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    enforceLlmRateLimit(request);
    const mappingRequest = sanitizeMappingRequestForLlm(
      parseMappingRequest(
        sanitizeIncomingLlmPayload(await readJsonBody(request)),
      ),
    );
    const response = await createStructuredResponse<unknown>({
      instructions: MAPPING_INSTRUCTIONS,
      input: buildMappingInput(mappingRequest),
      schemaName: "erd_semantic_mapping",
      schema: mappingOutputSchema,
      reasoningEffort: "low",
      maxOutputTokens: 6_000,
      signal: request.signal,
    });
    const data = redactSensitiveValue(
      reconcileMappingResult(response.data, mappingRequest),
    );

    const body: LlmSuccess<MappingResult> = {
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
