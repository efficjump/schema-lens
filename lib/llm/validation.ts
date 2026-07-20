import { LlmServiceError } from "@/lib/llm/provider";
import type {
  AnswerCitation,
  AnswerClaim,
  AnswerResult,
  AskRequest,
  ConversationTurn,
  JsonValue,
  MappingAliasAddition,
  MappingDiagnostic,
  MappingEdgeAddition,
  MappingNodeAddition,
  MappingRequest,
  MappingResult,
  SourceExcerpt,
} from "@/lib/llm/types";

const MAX_REQUEST_CHARS = 240_000;
const MAX_GRAPH_CHARS = 160_000;
const MAX_EXCERPTS = 128;
const MAX_EXCERPT_CHARS = 24_000;
const MAX_QUESTION_CHARS = 4_000;
const MAX_FOCUS_CHARS = 2_000;
const MAX_CONVERSATION_TURNS = 12;
const MAX_CONVERSATION_TURN_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestError(message: string, details?: string[]): never {
  throw new LlmServiceError({
    code: "INVALID_REQUEST",
    message,
    httpStatus: 400,
    details,
  });
}

function outputError(message: string): never {
  throw new LlmServiceError({
    code: "LLM_INVALID_OUTPUT",
    message,
    httpStatus: 502,
    retryable: true,
  });
}

function tooLarge(message: string): never {
  throw new LlmServiceError({
    code: "REQUEST_TOO_LARGE",
    message,
    httpStatus: 413,
  });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_CHARS) {
    tooLarge("요청 본문이 허용 크기를 초과했습니다.");
  }

  const body = await request.text();
  if (body.length > MAX_REQUEST_CHARS) {
    tooLarge("요청 본문이 허용 크기를 초과했습니다.");
  }

  if (!body.trim()) requestError("JSON 요청 본문이 필요합니다.");

  try {
    return JSON.parse(body) as unknown;
  } catch {
    requestError("유효한 JSON 요청 본문이 필요합니다.");
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    requestError(`${field}에는 비어 있지 않은 문자열이 필요합니다.`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    tooLarge(`${field}의 길이가 허용 범위를 초과했습니다.`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
  fallback: string,
): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") requestError(`${field}에는 문자열이 필요합니다.`);
  if (value.length > maxLength) tooLarge(`${field}의 길이가 허용 범위를 초과했습니다.`);
  return value;
}

function nullableLine(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    requestError(`${field}에는 양의 정수 또는 null이 필요합니다.`);
  }
  return value as number;
}

function parseExcerpts(value: unknown, field: string): SourceExcerpt[] {
  if (!Array.isArray(value)) requestError(`${field}에는 배열이 필요합니다.`);
  if (value.length > MAX_EXCERPTS) tooLarge(`${field} 항목 수가 허용 범위를 초과했습니다.`);

  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) requestError(`${field}[${index}]에는 객체가 필요합니다.`);

    const id = requiredString(item.id, `${field}[${index}].id`, 200);
    if (ids.has(id)) requestError(`${field}의 id는 고유해야 합니다.`, [id]);
    ids.add(id);

    const content = requiredString(
      item.content,
      `${field}[${index}].content`,
      MAX_EXCERPT_CHARS,
    );
    const startLine = nullableLine(item.startLine, `${field}[${index}].startLine`);
    const endLine = nullableLine(item.endLine, `${field}[${index}].endLine`);
    if (startLine !== null && endLine !== null && endLine < startLine) {
      requestError(`${field}[${index}]의 endLine은 startLine보다 작을 수 없습니다.`);
    }

    return {
      id,
      path: optionalString(item.path, `${field}[${index}].path`, 1_000, ""),
      language: optionalString(
        item.language,
        `${field}[${index}].language`,
        100,
        "",
      ),
      startLine,
      endLine,
      content,
    };
  });
}

function parseGraph(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value)) requestError("graph에는 JSON 객체가 필요합니다.");

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    requestError("graph는 JSON으로 직렬화할 수 있어야 합니다.");
  }

  if (serialized.length > MAX_GRAPH_CHARS) {
    tooLarge("graph가 허용 크기를 초과했습니다. compact graph로 줄여 주세요.");
  }
  return value as Record<string, JsonValue>;
}

export function parseMappingRequest(value: unknown): MappingRequest {
  if (!isRecord(value)) requestError("요청 본문에는 JSON 객체가 필요합니다.");

  const focus =
    value.focus === undefined || value.focus === null || value.focus === ""
      ? null
      : requiredString(value.focus, "focus", MAX_FOCUS_CHARS);

  return {
    graph: parseGraph(value.graph),
    excerpts: parseExcerpts(value.excerpts, "excerpts"),
    focus,
  };
}

function parseConversation(value: unknown): ConversationTurn[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) requestError("conversation에는 배열이 필요합니다.");
  if (value.length > MAX_CONVERSATION_TURNS) {
    tooLarge("conversation 항목 수가 허용 범위를 초과했습니다.");
  }

  return value.map((item, index) => {
    if (!isRecord(item)) requestError(`conversation[${index}]에는 객체가 필요합니다.`);
    if (item.role !== "user" && item.role !== "assistant") {
      requestError(`conversation[${index}].role은 user 또는 assistant여야 합니다.`);
    }
    return {
      role: item.role,
      content: requiredString(
        item.content,
        `conversation[${index}].content`,
        MAX_CONVERSATION_TURN_CHARS,
      ),
    };
  });
}

export function parseAskRequest(value: unknown): AskRequest {
  if (!isRecord(value)) requestError("요청 본문에는 JSON 객체가 필요합니다.");

  return {
    question: requiredString(value.question, "question", MAX_QUESTION_CHARS),
    graph: parseGraph(value.graph),
    evidence: parseExcerpts(value.evidence, "evidence"),
    conversation: parseConversation(value.conversation),
  };
}

function modelRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) outputError(`모델 응답의 ${field} 형식이 올바르지 않습니다.`);
  return value;
}

function modelString(value: unknown, field: string): string {
  if (typeof value !== "string") outputError(`모델 응답의 ${field} 형식이 올바르지 않습니다.`);
  return value;
}

function modelStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    outputError(`모델 응답의 ${field} 형식이 올바르지 않습니다.`);
  }
  return value as string[];
}

function modelArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) outputError(`모델 응답의 ${field} 형식이 올바르지 않습니다.`);
  return value;
}

function modelConfidence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    outputError(`모델 응답의 ${field} 형식이 올바르지 않습니다.`);
  }
  return value;
}

function parseMappingNode(value: unknown, index: number): MappingNodeAddition {
  const item = modelRecord(value, `additions.nodes[${index}]`);
  const layer = modelString(item.layer, `additions.nodes[${index}].layer`);
  if (!["database", "source", "domain", "cross_layer"].includes(layer)) {
    outputError(`모델 응답의 additions.nodes[${index}].layer 값이 올바르지 않습니다.`);
  }
  return {
    id: modelString(item.id, `additions.nodes[${index}].id`),
    title: modelString(item.title, `additions.nodes[${index}].title`),
    kind: modelString(item.kind, `additions.nodes[${index}].kind`),
    layer: layer as MappingNodeAddition["layer"],
    description: modelString(
      item.description,
      `additions.nodes[${index}].description`,
    ),
    mappedNodeIds: modelStringArray(
      item.mappedNodeIds,
      `additions.nodes[${index}].mappedNodeIds`,
    ),
    evidenceIds: modelStringArray(
      item.evidenceIds,
      `additions.nodes[${index}].evidenceIds`,
    ),
    confidence: modelConfidence(
      item.confidence,
      `additions.nodes[${index}].confidence`,
    ),
  };
}

function parseMappingEdge(value: unknown, index: number): MappingEdgeAddition {
  const item = modelRecord(value, `additions.edges[${index}]`);
  return {
    id: modelString(item.id, `additions.edges[${index}].id`),
    source: modelString(item.source, `additions.edges[${index}].source`),
    target: modelString(item.target, `additions.edges[${index}].target`),
    kind: modelString(item.kind, `additions.edges[${index}].kind`),
    label: modelString(item.label, `additions.edges[${index}].label`),
    description: modelString(
      item.description,
      `additions.edges[${index}].description`,
    ),
    evidenceIds: modelStringArray(
      item.evidenceIds,
      `additions.edges[${index}].evidenceIds`,
    ),
    confidence: modelConfidence(
      item.confidence,
      `additions.edges[${index}].confidence`,
    ),
  };
}

function parseMappingAlias(value: unknown, index: number): MappingAliasAddition {
  const item = modelRecord(value, `additions.aliases[${index}]`);
  return {
    term: modelString(item.term, `additions.aliases[${index}].term`),
    nodeId: modelString(item.nodeId, `additions.aliases[${index}].nodeId`),
    description: modelString(
      item.description,
      `additions.aliases[${index}].description`,
    ),
    evidenceIds: modelStringArray(
      item.evidenceIds,
      `additions.aliases[${index}].evidenceIds`,
    ),
    confidence: modelConfidence(
      item.confidence,
      `additions.aliases[${index}].confidence`,
    ),
  };
}

function parseDiagnostic(value: unknown, index: number): MappingDiagnostic {
  const item = modelRecord(value, `diagnostics[${index}]`);
  const severity = modelString(item.severity, `diagnostics[${index}].severity`);
  if (!["info", "warning", "error"].includes(severity)) {
    outputError(`모델 응답의 diagnostics[${index}].severity 값이 올바르지 않습니다.`);
  }
  return {
    severity: severity as MappingDiagnostic["severity"],
    code: modelString(item.code, `diagnostics[${index}].code`),
    message: modelString(item.message, `diagnostics[${index}].message`),
    relatedNodeIds: modelStringArray(
      item.relatedNodeIds,
      `diagnostics[${index}].relatedNodeIds`,
    ),
    evidenceIds: modelStringArray(
      item.evidenceIds,
      `diagnostics[${index}].evidenceIds`,
    ),
    suggestion: modelString(item.suggestion, `diagnostics[${index}].suggestion`),
  };
}

function parseMappingResult(value: unknown): MappingResult {
  const result = modelRecord(value, "root");
  const additions = modelRecord(result.additions, "additions");
  return {
    summary: modelString(result.summary, "summary"),
    additions: {
      nodes: modelArray(additions.nodes, "additions.nodes").map(parseMappingNode),
      edges: modelArray(additions.edges, "additions.edges").map(parseMappingEdge),
      aliases: modelArray(additions.aliases, "additions.aliases").map(
        parseMappingAlias,
      ),
    },
    diagnostics: modelArray(result.diagnostics, "diagnostics").map(parseDiagnostic),
    unansweredQuestions: modelStringArray(
      result.unansweredQuestions,
      "unansweredQuestions",
    ),
  };
}

interface GraphReference {
  serialized: string;
}

export function collectGraphReferences(
  graph: Record<string, JsonValue>,
): Map<string, GraphReference> {
  const references = new Map<string, GraphReference>();
  const pending: unknown[] = [graph];
  let inspected = 0;

  while (pending.length > 0 && inspected < 100_000) {
    const current = pending.pop();
    inspected += 1;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;

    if (typeof current.id === "string" && current.id.trim()) {
      references.set(current.id, { serialized: JSON.stringify(current) });
    }
    pending.push(...Object.values(current));
  }

  return references;
}

function uniqueKnown(values: string[], known: Set<string>): string[] {
  return [...new Set(values.filter((value) => known.has(value)))];
}

function reconciliationDiagnostic(message: string, relatedNodeIds: string[] = []): MappingDiagnostic {
  return {
    severity: "warning",
    code: "INVALID_REFERENCE_DROPPED",
    message,
    relatedNodeIds,
    evidenceIds: [],
    suggestion: "입력 그래프와 근거 ID를 확인한 뒤 다시 매핑하세요.",
  };
}

export function reconcileMappingResult(
  value: unknown,
  request: MappingRequest,
): MappingResult {
  const result = parseMappingResult(value);
  const graphReferences = collectGraphReferences(request.graph);
  const graphIds = new Set(graphReferences.keys());
  const evidenceIds = new Set(request.excerpts.map((item) => item.id));
  const generatedIds = new Set<string>();
  const serverDiagnostics: MappingDiagnostic[] = [];

  const nodes = result.additions.nodes.flatMap((node) => {
    if (!node.id || graphIds.has(node.id) || generatedIds.has(node.id)) {
      serverDiagnostics.push(
        reconciliationDiagnostic(`중복되거나 비어 있는 추가 노드 ID를 제외했습니다: ${node.id}`),
      );
      return [];
    }

    const mappedNodeIds = uniqueKnown(node.mappedNodeIds, graphIds);
    const knownEvidenceIds = uniqueKnown(node.evidenceIds, evidenceIds);
    if (mappedNodeIds.length === 0 && knownEvidenceIds.length === 0) {
      serverDiagnostics.push(
        reconciliationDiagnostic(
          `기존 그래프나 소스 근거로 추적할 수 없는 추가 노드를 제외했습니다: ${node.id}`,
        ),
      );
      return [];
    }

    generatedIds.add(node.id);
    return [{ ...node, mappedNodeIds, evidenceIds: knownEvidenceIds }];
  });

  const endpointIds = new Set([...graphIds, ...generatedIds]);
  const edgeIds = new Set<string>();
  const edges = result.additions.edges.flatMap((edge) => {
    const knownEvidenceIds = uniqueKnown(edge.evidenceIds, evidenceIds);
    if (
      !edge.id ||
      endpointIds.has(edge.id) ||
      edgeIds.has(edge.id) ||
      !endpointIds.has(edge.source) ||
      !endpointIds.has(edge.target) ||
      knownEvidenceIds.length === 0
    ) {
      serverDiagnostics.push(
        reconciliationDiagnostic(
          `중복 ID, 알 수 없는 끝점 또는 소스 근거가 없는 추가 관계를 제외했습니다: ${edge.id}`,
          [edge.source, edge.target].filter((id) => endpointIds.has(id)),
        ),
      );
      return [];
    }

    edgeIds.add(edge.id);
    return [{ ...edge, evidenceIds: knownEvidenceIds }];
  });

  const aliases = result.additions.aliases.flatMap((alias) => {
    const knownEvidenceIds = uniqueKnown(alias.evidenceIds, evidenceIds);
    if (!endpointIds.has(alias.nodeId) || knownEvidenceIds.length === 0) {
      serverDiagnostics.push(
        reconciliationDiagnostic(
          `알 수 없는 노드를 가리키거나 소스 근거가 없는 별칭을 제외했습니다: ${alias.term}`,
        ),
      );
      return [];
    }
    return [{ ...alias, evidenceIds: knownEvidenceIds }];
  });

  return {
    ...result,
    additions: { nodes, edges, aliases },
    diagnostics: [
      ...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        relatedNodeIds: uniqueKnown(diagnostic.relatedNodeIds, endpointIds),
        evidenceIds: uniqueKnown(diagnostic.evidenceIds, evidenceIds),
      })),
      ...serverDiagnostics,
    ],
  };
}

function parseCitation(value: unknown, index: number): AnswerCitation {
  const item = modelRecord(value, `citations[${index}]`);
  const kind = modelString(item.kind, `citations[${index}].kind`);
  if (kind !== "graph" && kind !== "excerpt") {
    outputError(`모델 응답의 citations[${index}].kind 값이 올바르지 않습니다.`);
  }
  return {
    id: modelString(item.id, `citations[${index}].id`),
    kind,
    sourceId: modelString(item.sourceId, `citations[${index}].sourceId`),
    quote: modelString(item.quote, `citations[${index}].quote`),
    explanation: modelString(item.explanation, `citations[${index}].explanation`),
  };
}

function parseClaim(value: unknown, index: number): AnswerClaim {
  const item = modelRecord(value, `claims[${index}]`);
  return {
    text: modelString(item.text, `claims[${index}].text`),
    citationIds: modelStringArray(
      item.citationIds,
      `claims[${index}].citationIds`,
    ),
  };
}

function parseAnswerResult(value: unknown): AnswerResult {
  const result = modelRecord(value, "root");
  const status = modelString(result.status, "status");
  if (status !== "answered" && status !== "insufficient_evidence") {
    outputError("모델 응답의 status 값이 올바르지 않습니다.");
  }
  return {
    status,
    answer: modelString(result.answer, "answer"),
    claims: modelArray(result.claims, "claims").map(parseClaim),
    citations: modelArray(result.citations, "citations").map(parseCitation),
    referencedNodeIds: modelStringArray(
      result.referencedNodeIds,
      "referencedNodeIds",
    ),
    limitations: modelStringArray(result.limitations, "limitations"),
    suggestedQuestions: modelStringArray(
      result.suggestedQuestions,
      "suggestedQuestions",
    ),
  };
}

function isExactQuote(quote: string, source: string): boolean {
  const trimmed = quote.trim();
  return trimmed.length >= 3 && /[\p{L}\p{N}_]/u.test(trimmed) && source.includes(trimmed);
}

export function reconcileAnswerResult(
  value: unknown,
  request: AskRequest,
): AnswerResult {
  const result = parseAnswerResult(value);
  const graphReferences = collectGraphReferences(request.graph);
  const evidenceById = new Map(request.evidence.map((item) => [item.id, item.content]));
  const seenCitationContent = new Set<string>();
  const seenCitationIds = new Set<string>();
  let invalidCitationCount = 0;

  const citations = result.citations.filter((citation) => {
    const source =
      citation.kind === "graph"
        ? graphReferences.get(citation.sourceId)?.serialized
        : evidenceById.get(citation.sourceId);
    const key = `${citation.kind}:${citation.sourceId}:${citation.quote}`;
    const valid = Boolean(source && isExactQuote(citation.quote, source));
    if (
      !citation.id.trim() ||
      !valid ||
      seenCitationIds.has(citation.id) ||
      seenCitationContent.has(key)
    ) {
      invalidCitationCount += 1;
      return false;
    }
    seenCitationIds.add(citation.id);
    seenCitationContent.add(key);
    return true;
  });

  const citationById = new Map(citations.map((citation) => [citation.id, citation]));
  let invalidClaimCount = 0;
  const claims = result.claims.flatMap((claim) => {
    const citationIds = [...new Set(claim.citationIds)];
    if (
      !claim.text.trim() ||
      citationIds.length === 0 ||
      citationIds.some((id) => !citationById.has(id))
    ) {
      invalidClaimCount += 1;
      return [];
    }
    return [{ ...claim, text: claim.text.trim(), citationIds }];
  });

  const referencedNodeIds = uniqueKnown(
    result.referencedNodeIds,
    new Set(graphReferences.keys()),
  );
  const limitations = [...result.limitations];
  if (invalidCitationCount > 0) {
    limitations.push(
      `검증할 수 없는 인용 ${invalidCitationCount}개를 응답에서 제외했습니다.`,
    );
  }

  if (invalidClaimCount > 0) {
    limitations.push(
      `검증 가능한 인용이 없는 주장 ${invalidClaimCount}개를 응답에서 제외했습니다.`,
    );
  }

  if (result.status === "answered" && (claims.length === 0 || invalidClaimCount > 0)) {
    return {
      ...result,
      status: "insufficient_evidence",
      answer:
        "제공된 그래프와 소스 근거에서 검증 가능한 인용을 찾지 못해 답변을 확정할 수 없습니다.",
      citations: [],
      claims: [],
      referencedNodeIds,
      limitations: [
        ...limitations,
        "검증 가능한 그래프 또는 소스 인용이 필요합니다.",
      ],
    };
  }

  if (result.status === "answered") {
    const usedCitationIds = new Set(claims.flatMap((claim) => claim.citationIds));
    return {
      ...result,
      answer: claims.map((claim) => claim.text).join(" "),
      claims,
      citations: citations.filter((citation) => usedCitationIds.has(citation.id)),
      referencedNodeIds,
      limitations,
    };
  }

  return { ...result, claims, citations, referencedNodeIds, limitations };
}
