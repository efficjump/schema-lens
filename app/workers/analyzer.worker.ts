import {
  analyzeSourceProject,
  type SourceFileInput,
} from "../../lib/analyzer";
import type {
  AnalyzerWorkerErrorResponse,
  AnalyzerWorkerRequest,
  AnalyzerWorkerResponse,
  AnalyzerWorkerSuccessResponse,
} from "../../lib/analyzer-worker-client";

interface AnalyzerWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: AnalyzerWorkerResponse): void;
}

const workerScope = globalThis as unknown as AnalyzerWorkerScope;
const PROTOCOL_VERSION = 1 as const;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceFileInput(value: unknown): value is SourceFileInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.content === "string" &&
    (value.language === undefined || typeof value.language === "string")
  );
}

function isAnalyzerWorkerRequest(
  value: unknown,
): value is AnalyzerWorkerRequest {
  return (
    isRecord(value) &&
    value.type === "analyze-source-project" &&
    value.version === PROTOCOL_VERSION &&
    typeof value.requestId === "string" &&
    SAFE_REQUEST_ID_PATTERN.test(value.requestId) &&
    Array.isArray(value.inputs) &&
    value.inputs.every(isSourceFileInput)
  );
}

function safeRequestId(value: unknown): string {
  if (!isRecord(value) || typeof value.requestId !== "string") {
    return "invalid-request";
  }
  return SAFE_REQUEST_ID_PATTERN.test(value.requestId)
    ? value.requestId
    : "invalid-request";
}

function postInvalidRequest(value: unknown): void {
  const response: AnalyzerWorkerErrorResponse = {
    type: "analysis-result",
    version: PROTOCOL_VERSION,
    requestId: safeRequestId(value),
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "The source-analysis Web Worker request format is invalid.",
    },
  };
  workerScope.postMessage(response);
}

workerScope.addEventListener("message", (event) => {
  if (!isAnalyzerWorkerRequest(event.data)) {
    postInvalidRequest(event.data);
    return;
  }

  try {
    const graph = analyzeSourceProject(event.data.inputs);
    const response: AnalyzerWorkerSuccessResponse = {
      type: "analysis-result",
      version: PROTOCOL_VERSION,
      requestId: event.data.requestId,
      ok: true,
      graph,
    };
    workerScope.postMessage(response);
  } catch {
    const response: AnalyzerWorkerErrorResponse = {
      type: "analysis-result",
      version: PROTOCOL_VERSION,
      requestId: event.data.requestId,
      ok: false,
      error: {
        code: "ANALYSIS_FAILED",
        message: "The source-analysis Web Worker could not complete the analysis.",
      },
    };
    workerScope.postMessage(response);
  }
});
