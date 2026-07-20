import { getLlmConfig } from "@/lib/llm/config";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = getLlmConfig();

  return Response.json(
    {
      ok: true,
      data: {
        provider: "custom",
        configured: config.configured,
        capabilities: {
          semanticMapping: true,
          groundedQuestionAnswering: true,
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
