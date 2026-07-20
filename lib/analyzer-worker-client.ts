import type {
  AnalysisGraph,
  SourceFileInput,
} from "./analyzer";

export const ANALYZER_WORKER_PROTOCOL_VERSION = 1 as const;

export interface AnalyzerWorkerRequest {
  type: "analyze-source-project";
  version: typeof ANALYZER_WORKER_PROTOCOL_VERSION;
  requestId: string;
  inputs: SourceFileInput[];
}

export type AnalyzerWorkerErrorCode =
  | "INVALID_REQUEST"
  | "ANALYSIS_FAILED";

export interface AnalyzerWorkerSuccessResponse {
  type: "analysis-result";
  version: typeof ANALYZER_WORKER_PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  graph: AnalysisGraph;
}

export interface AnalyzerWorkerErrorResponse {
  type: "analysis-result";
  version: typeof ANALYZER_WORKER_PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: {
    code: AnalyzerWorkerErrorCode;
    message: string;
  };
}

export type AnalyzerWorkerResponse =
  | AnalyzerWorkerSuccessResponse
  | AnalyzerWorkerErrorResponse;

export interface AnalyzeSourceProjectWorkerOptions {
  signal?: AbortSignal;
}

const SAFE_ERROR_LENGTH = 240;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/gu;
let requestSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasGraphShape(value: unknown): value is AnalysisGraph {
  if (!isRecord(value) || value.version !== 1) return false;
  return (
    Array.isArray(value.tables) &&
    Array.isArray(value.files) &&
    Array.isArray(value.symbols) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    Array.isArray(value.evidence) &&
    Array.isArray(value.warnings) &&
    isRecord(value.stats)
  );
}

/** Runtime validation keeps malformed worker messages out of application state. */
export function isAnalyzerWorkerResponse(
  value: unknown,
): value is AnalyzerWorkerResponse {
  if (
    !isRecord(value) ||
    value.type !== "analysis-result" ||
    value.version !== ANALYZER_WORKER_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }

  if (value.ok) return hasGraphShape(value.graph);
  if (!isRecord(value.error)) return false;
  return (
    (value.error.code === "INVALID_REQUEST" ||
      value.error.code === "ANALYSIS_FAILED") &&
    typeof value.error.message === "string"
  );
}

function safeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const safe = value
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, SAFE_ERROR_LENGTH);
  return safe || fallback;
}

function createAbortError(): Error {
  const message = "소스 분석이 취소되었습니다.";
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function nextRequestId(): string {
  requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `analysis-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

/**
 * Run one source analysis in an isolated module worker.
 *
 * Every invocation owns its worker. It therefore has one cleanup path that
 * removes all listeners and terminates the worker on success, failure, message
 * corruption, postMessage failure, or AbortSignal cancellation.
 */
export function analyzeSourceProjectInWorker(
  inputs: SourceFileInput[],
  options: AnalyzeSourceProjectWorkerOptions = {},
): Promise<AnalysisGraph> {
  if (options.signal?.aborted) return Promise.reject(createAbortError());
  if (typeof Worker !== "function") {
    return Promise.reject(
      new Error("이 브라우저에서는 소스 분석 Web Worker를 사용할 수 없습니다."),
    );
  }

  return new Promise<AnalysisGraph>((resolve, reject) => {
    const requestId = nextRequestId();
    let settled = false;
    let worker: Worker;

    try {
      worker = new Worker(
        new URL("../app/workers/analyzer.worker.ts", import.meta.url),
        { type: "module", name: "schema-lens-analyzer" },
      );
    } catch {
      reject(new Error("소스 분석 Web Worker를 시작하지 못했습니다."));
      return;
    }

    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.removeEventListener("messageerror", handleMessageError);
      options.signal?.removeEventListener("abort", handleAbort);
      try {
        worker.terminate();
      } catch {
        // A worker that already stopped still satisfies the cleanup contract.
      }
    };

    const finish = (
      callback: () => void,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    function handleMessage(event: MessageEvent<unknown>) {
      const response = event.data;
      if (
        !isAnalyzerWorkerResponse(response) ||
        response.requestId !== requestId
      ) {
        finish(() =>
          reject(new Error("소스 분석 Web Worker가 올바르지 않은 응답을 반환했습니다.")),
        );
        return;
      }

      if ("error" in response) {
        finish(() =>
          reject(
            new Error(
              safeErrorMessage(
                response.error.message,
                "소스 분석 Web Worker에서 분석을 완료하지 못했습니다.",
              ),
            ),
          ),
        );
        return;
      }
      finish(() => resolve(response.graph));
    }

    function handleError(event: ErrorEvent) {
      event.preventDefault();
      finish(() =>
        reject(new Error("소스 분석 Web Worker 실행 중 오류가 발생했습니다.")),
      );
    }

    function handleMessageError() {
      finish(() =>
        reject(new Error("소스 분석 Web Worker 응답을 읽지 못했습니다.")),
      );
    }

    function handleAbort() {
      finish(() => reject(createAbortError()));
    }

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.addEventListener("messageerror", handleMessageError);
    options.signal?.addEventListener("abort", handleAbort, { once: true });

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }

    const request: AnalyzerWorkerRequest = {
      type: "analyze-source-project",
      version: ANALYZER_WORKER_PROTOCOL_VERSION,
      requestId,
      inputs,
    };
    try {
      worker.postMessage(request);
    } catch {
      finish(() =>
        reject(new Error("소스 분석 요청을 Web Worker에 전달하지 못했습니다.")),
      );
    }
  });
}
