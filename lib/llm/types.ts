export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SourceExcerpt {
  id: string;
  path: string;
  language: string;
  startLine: number | null;
  endLine: number | null;
  content: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface MappingRequest {
  graph: Record<string, JsonValue>;
  excerpts: SourceExcerpt[];
  focus: string | null;
}

export interface MappingNodeAddition {
  id: string;
  title: string;
  kind: string;
  layer: "database" | "source" | "domain" | "cross_layer";
  description: string;
  mappedNodeIds: string[];
  evidenceIds: string[];
  confidence: number;
}

export interface MappingEdgeAddition {
  id: string;
  source: string;
  target: string;
  kind: string;
  label: string;
  description: string;
  evidenceIds: string[];
  confidence: number;
}

export interface MappingAliasAddition {
  term: string;
  nodeId: string;
  description: string;
  evidenceIds: string[];
  confidence: number;
}

export interface MappingDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  relatedNodeIds: string[];
  evidenceIds: string[];
  suggestion: string;
}

export interface MappingResult {
  summary: string;
  additions: {
    nodes: MappingNodeAddition[];
    edges: MappingEdgeAddition[];
    aliases: MappingAliasAddition[];
  };
  diagnostics: MappingDiagnostic[];
  unansweredQuestions: string[];
}

export interface AskRequest {
  question: string;
  graph: Record<string, JsonValue>;
  evidence: SourceExcerpt[];
  conversation: ConversationTurn[];
}

export interface AnswerCitation {
  id: string;
  kind: "graph" | "excerpt";
  sourceId: string;
  quote: string;
  explanation: string;
}

export interface AnswerClaim {
  text: string;
  citationIds: string[];
}

export interface AnswerResult {
  status: "answered" | "insufficient_evidence";
  answer: string;
  claims: AnswerClaim[];
  citations: AnswerCitation[];
  referencedNodeIds: string[];
  limitations: string[];
  suggestedQuestions: string[];
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface LlmSuccess<T> {
  ok: true;
  data: T;
  meta: {
    provider: "custom";
    usage: LlmUsage;
  };
}

export type LlmErrorCode =
  | "INVALID_REQUEST"
  | "REQUEST_TOO_LARGE"
  | "LLM_NOT_CONFIGURED"
  | "LLM_REFUSAL"
  | "LLM_INCOMPLETE"
  | "LLM_INVALID_OUTPUT"
  | "LLM_RATE_LIMITED"
  | "LLM_TIMEOUT"
  | "LLM_PROVIDER_ERROR";

export interface LlmErrorBody {
  ok: false;
  error: {
    code: LlmErrorCode;
    message: string;
    details?: string[];
    retryable: boolean;
    retryAfterSeconds?: number;
  };
  fallback?: {
    available: true;
    mode: "local";
  };
}
