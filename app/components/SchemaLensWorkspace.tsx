"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  analyzeSourceProject,
  buildDemoSourceFiles,
  buildLLMContext,
  findRelevantGraphNodes,
  type AnalysisGraph,
  type Confidence,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type SourceFileInput,
} from "@/lib/analyzer";
import { analyzeSourceProjectInWorker } from "@/lib/analyzer-worker-client";
import type {
  AnswerCitation,
  AnswerResult,
  ConversationTurn,
  JsonValue,
  LlmErrorBody,
  LlmSuccess,
  MappingResult,
  SourceExcerpt,
} from "@/lib/llm/types";
import {
  sanitizeGraphForLlm,
  sanitizeSourceExcerptsForLlm,
} from "@/lib/llm/redaction";
import {
  buildSourceTree,
  collectExpandedFolders,
  normalizeSourcePath,
  type SourceDocumentDescriptor,
} from "@/lib/source-workspace";
import {
  GraphCanvas,
  type GraphViewMode,
  type SupplementalEdge,
} from "./GraphCanvas";
import {
  SourceCodeWorkbench,
  type SourceCodeDocument,
  type SourceCodeEvidence,
} from "./SourceCodeWorkbench";
import { SourceTree } from "./SourceTree";

type WorkspaceTab = GraphViewMode | "review" | "code";
type ExplorerMode = GraphViewMode;
type InspectorTab = "details" | "evidence" | "impact" | "ask";
type ScanState = "ready" | "reading" | "analyzing" | "error";

interface SourceDocumentRef extends SourceDocumentDescriptor {
  name: string;
  language: string;
  size: number;
  viewable: boolean;
  analysisIncluded: boolean;
  file?: File;
  inlineContent?: string;
}

interface RankedSourceDocument {
  document: SourceDocumentRef;
  priority: number;
}

interface SourceLocation {
  path: string;
  startLine: number;
  endLine: number;
  requestId: number;
  evidenceId?: string;
}

interface LlmStatus {
  configured: boolean;
  loading: boolean;
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  citations?: AnswerCitation[];
  referencedNodeIds?: string[];
  local?: boolean;
}

interface ReviewDecision {
  state: "confirmed" | "excluded";
  updatedAt: number;
}

const ANALYZABLE_EXTENSION = /\.(?:sql|ddl|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|kt|kts|go|rb|php|cs|scala|rs|xml|yml|yaml|prisma)$/i;
const VIEWABLE_TEXT_EXTENSION = /\.(?:sql|ddl|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|kt|kts|go|rb|php|cs|scala|rs|xml|html|htm|css|scss|sass|less|json|jsonc|md|mdx|txt|csv|tsv|graphql|gql|proto|prisma|yml|yaml|toml|ini|conf|config|properties|gradle|sh|bash|zsh|fish|ps1|bat|cmd|dockerfile|gitignore|gitattributes)$/i;
const VIEWABLE_TEXT_BASENAME = /^(?:dockerfile|containerfile|makefile|rakefile|gemfile|procfile|jenkinsfile|justfile|license|readme|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc|\.env(?:\..*)?)$/i;
const UNSAFE_PATH_CHARACTER = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const EXCLUDED_PATH_PARTS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vinext",
  ".wrangler",
  "dist",
  "build",
  "coverage",
  "vendor",
]);
const SENSITIVE_SOURCE_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const MAX_BROWSER_FILES = 800;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_TREE_FILES = 5_000;
const MAX_SOURCE_VIEW_BYTES = 4 * 1024 * 1024;
const MAX_ANALYSIS_BYTES = 32 * 1024 * 1024;
const ANALYSIS_READ_CONCURRENCY = 6;
const MAX_SOURCE_CACHE_CHARS = 12 * 1024 * 1024;
const MAX_OPEN_SOURCE_TABS = 12;
const WORKSPACE_TABS: readonly WorkspaceTab[] = ["database", "source", "code", "review"];
const INSPECTOR_TABS: readonly InspectorTab[] = ["details", "evidence", "impact", "ask"];

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  const getServerSnapshot = useCallback(() => false, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function sourceName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function normalizedBrowserPath(path: string): string | null {
  if (UNSAFE_PATH_CHARACTER.test(path) || path.split(/[\\/]/).some((part) => part.length > 255) || path.length > 2_048) {
    return null;
  }
  try {
    return normalizeSourcePath(path);
  } catch {
    return null;
  }
}

function excludedSourcePath(path: string): boolean {
  return SENSITIVE_SOURCE_NAME.test(sourceName(path)) || path
    .split("/")
    .some((part) => EXCLUDED_PATH_PARTS.has(part.toLocaleLowerCase()));
}

function viewableTextFile(file: File, path: string): boolean {
  if (file.size > MAX_SOURCE_VIEW_BYTES) return false;
  if (file.type.startsWith("text/")) return true;
  if (/^(?:application\/(?:json|javascript|xml|sql|graphql)|image\/svg\+xml)$/i.test(file.type)) return true;
  const name = sourceName(path);
  return VIEWABLE_TEXT_EXTENSION.test(name) || VIEWABLE_TEXT_BASENAME.test(name);
}

function compareRankedSource(left: RankedSourceDocument, right: RankedSourceDocument): number {
  return left.priority - right.priority || left.document.path.localeCompare(
    right.document.path,
    undefined,
    { numeric: true, sensitivity: "base" },
  ) || left.document.path.localeCompare(right.document.path);
}

/** Keep the best source candidates in a bounded max-heap without copying the FileList. */
function retainRankedSource(
  heap: RankedSourceDocument[],
  candidate: RankedSourceDocument,
  limit: number,
) {
  if (limit <= 0) return;
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareRankedSource(heap[parent], heap[index]) >= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (compareRankedSource(candidate, heap[0]) >= 0) return;

  heap[0] = candidate;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let worseChild = left;
    if (right < heap.length && compareRankedSource(heap[right], heap[left]) > 0) {
      worseChild = right;
    }
    if (compareRankedSource(heap[index], heap[worseChild]) >= 0) break;
    [heap[index], heap[worseChild]] = [heap[worseChild], heap[index]];
    index = worseChild;
  }
}

async function readSourceFiles(
  documents: SourceDocumentRef[],
  signal: AbortSignal,
  concurrency = ANALYSIS_READ_CONCURRENCY,
): Promise<SourceFileInput[]> {
  const results = new Array<SourceFileInput>(documents.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, documents.length)) },
    async () => {
      while (cursor < documents.length) {
        if (signal.aborted) throw new DOMException("프로젝트 분석이 취소되었습니다.", "AbortError");
        const index = cursor;
        cursor += 1;
        const document = documents[index];
        results[index] = {
          path: document.path,
          content:
            document.inlineContent ??
            (document.file ? await readBrowserFileText(document.file, signal) : ""),
          language: document.language || undefined,
        };
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function readBrowserFileText(file: File, signal: AbortSignal): Promise<string> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      if (signal.aborted) throw new DOMException("파일 읽기가 취소되었습니다.", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function rememberSourceContent(cache: Map<string, string>, path: string, content: string) {
  cache.delete(path);
  cache.set(path, content);
  let totalChars = Array.from(cache.values()).reduce((sum, value) => sum + value.length, 0);
  for (const [cachedPath, cachedContent] of cache) {
    if (totalChars <= MAX_SOURCE_CACHE_CHARS) break;
    if (cachedPath === path) continue;
    cache.delete(cachedPath);
    totalChars -= cachedContent.length;
  }
}

function confidencePercent(confidence: Confidence | number): number {
  if (typeof confidence === "number") return Math.round(confidence * 100);
  if (confidence === "high") return 96;
  if (confidence === "medium") return 76;
  return 52;
}

function nodeLabel(node: GraphNode | undefined): string {
  if (!node) return "알 수 없는 노드";
  if (node.nodeType === "table") return node.qualifiedName;
  if (node.nodeType === "file") return node.path;
  return node.routePath ? `${node.httpMethod ?? "ROUTE"} ${node.routePath}` : node.name;
}

function nodeShortLabel(node: GraphNode | undefined): string {
  if (!node) return "알 수 없음";
  if (node.nodeType === "table") return node.name;
  if (node.nodeType === "file") return node.name;
  return node.name;
}

function edgeLabel(edge: GraphEdge): string {
  const labels: Record<GraphEdge["kind"], string> = {
    "foreign-key": "FK",
    "query-relation": "JOIN",
    read: "READ",
    write: "WRITE",
    import: "IMPORT",
    contains: "CONTAINS",
  };
  return labels[edge.kind];
}

function graphExcerpts(graph: AnalysisGraph, evidenceIds?: Set<string>): SourceExcerpt[] {
  const excerpts = graph.evidence
    .filter((item) => !evidenceIds || evidenceIds.has(item.id))
    .slice(0, 128)
    .map((item) => ({
      id: item.id,
      path: item.filePath,
      language: "",
      startLine: item.line,
      endLine: item.endLine,
      content: item.excerpt,
    }));
  return sanitizeSourceExcerptsForLlm(excerpts);
}

function compactGraphContext(graph: AnalysisGraph, focus = "") {
  try {
    const context = JSON.parse(buildLLMContext(graph, focus, 42)) as Record<string, unknown>;
    return sanitizeGraphForLlm(context as Record<string, JsonValue>);
  } catch {
    return sanitizeGraphForLlm({
      version: graph.version,
      stats: graph.stats,
      nodes: graph.nodes.slice(0, 42),
      edges: graph.edges.slice(0, 120),
      evidence: graph.evidence.slice(0, 120),
    } as unknown as Record<string, JsonValue>);
  }
}

function contextEvidenceIds(context: Record<string, JsonValue>): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(context.evidence)) return ids;
  context.evidence.forEach((item) => {
    if (item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string") {
      ids.add(item.id);
    }
  });
  return ids;
}

function relevantEvidence(graph: AnalysisGraph, nodeId: string | null): Evidence[] {
  if (!nodeId) return [];
  const ids = new Set<string>();
  const node = graph.nodes.find((item) => item.id === nodeId);
  node?.evidenceIds.forEach((id) => ids.add(id));
  graph.edges.forEach((edge) => {
    if (edge.source === nodeId || edge.target === nodeId) {
      edge.evidenceIds.forEach((id) => ids.add(id));
    }
  });
  return graph.evidence.filter((item) => ids.has(item.id));
}

function impactNodes(graph: AnalysisGraph, nodeId: string | null, depth = 2) {
  if (!nodeId) return [] as Array<{ node: GraphNode; depth: number; via: string }>;
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  const results: Array<{ node: GraphNode; depth: number; via: string }> = [];

  for (let currentDepth = 1; currentDepth <= depth; currentDepth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edges) {
        if (edge.source !== id && edge.target !== id) continue;
        const neighborId = edge.source === id ? edge.target : edge.source;
        if (seen.has(neighborId)) continue;
        const node = graph.nodes.find((item) => item.id === neighborId);
        if (!node) continue;
        seen.add(neighborId);
        next.push(neighborId);
        results.push({ node, depth: currentDepth, via: edgeLabel(edge) });
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  return results;
}

function localGraphAnswer(graph: AnalysisGraph, question: string): AnswerResult {
  let hits = findRelevantGraphNodes(graph, question, 8);
  const normalizedQuestion = question.toLocaleLowerCase();

  if (!hits.length) {
    const explicitlyNamed = graph.nodes.filter((node) =>
      normalizedQuestion.includes(nodeShortLabel(node).toLocaleLowerCase()),
    );
    hits = explicitlyNamed.map((node) => ({ node, score: 1, matchedTerms: [] }));
  }

  const primary = hits[0]?.node;
  const citations: AnswerCitation[] = [];
  const referencedNodeIds: string[] = [];
  const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
  const addEvidence = (ids: string[]) => {
    ids.slice(0, 3).forEach((id) => {
      const item = evidenceById.get(id);
      if (!item || citations.some((citation) => citation.sourceId === id)) return;
      citations.push({
        id: `local-citation-${id}`,
        kind: "excerpt",
        sourceId: id,
        quote: item.excerpt,
        explanation: `${item.filePath}:${item.line}에서 확인한 정적 분석 근거`,
      });
    });
  };

  if (!primary) {
    const rankedTables = [...graph.tables]
      .map((table) => ({
        table,
        count: graph.edges.filter((edge) => edge.source === table.id || edge.target === table.id).length,
      }))
      .sort((a, b) => b.count - a.count);
    const top = rankedTables[0];
    if (top) {
      referencedNodeIds.push(top.table.id);
      addEvidence(top.table.evidenceIds);
      const answer = `질문과 직접 일치하는 식별자는 찾지 못했습니다. 현재 관계가 가장 많은 테이블은 ${top.table.qualifiedName}이며 직접 연결은 ${top.count}개입니다. 테이블명이나 파일명을 포함해 질문하면 더 좁은 근거로 답할 수 있습니다.`;
      return {
        status: "answered",
        answer,
        claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
        citations,
        referencedNodeIds,
        limitations: ["LLM이 연결되지 않아 이름·관계 기반의 로컬 탐색으로 답했습니다."],
        suggestedQuestions: [`${top.table.name} 테이블을 읽고 쓰는 파일은?`],
      };
    }
    return {
      status: "insufficient_evidence",
      answer: "분석 그래프에서 질문에 답할 수 있는 테이블이나 소스 노드를 찾지 못했습니다.",
      claims: [],
      citations: [],
      referencedNodeIds: [],
      limitations: ["분석 대상에 SQL 또는 지원되는 소스 파일이 포함되었는지 확인해 주세요."],
      suggestedQuestions: [],
    };
  }

  referencedNodeIds.push(primary.id);
  addEvidence(primary.evidenceIds);
  const relatedEdges = graph.edges.filter(
    (edge) => edge.source === primary.id || edge.target === primary.id,
  );
  relatedEdges.forEach((edge) => {
    addEvidence(edge.evidenceIds);
    const otherId = edge.source === primary.id ? edge.target : edge.source;
    if (!referencedNodeIds.includes(otherId)) referencedNodeIds.push(otherId);
  });

  if (primary.nodeType === "table") {
    const readers = relatedEdges
      .filter((edge) => edge.kind === "read" && edge.target === primary.id)
      .map((edge) => graph.nodes.find((node) => node.id === edge.source))
      .filter((node): node is GraphNode => Boolean(node));
    const writers = relatedEdges
      .filter((edge) => edge.kind === "write" && edge.target === primary.id)
      .map((edge) => graph.nodes.find((node) => node.id === edge.source))
      .filter((node): node is GraphNode => Boolean(node));
    const relations = relatedEdges
      .filter((edge) => edge.kind === "foreign-key" || edge.kind === "query-relation")
      .map((edge) => graph.nodes.find((node) => node.id === (edge.source === primary.id ? edge.target : edge.source)))
      .filter((node): node is GraphNode => Boolean(node));
    const lines = [
      `${primary.qualifiedName}은(는) ${primary.columns.length}개 컬럼과 ${primary.primaryKey.length || 0}개 기본키 컬럼이 확인됩니다.`,
      readers.length ? `읽는 소스: ${readers.map(nodeLabel).join(", ")}` : "확인된 읽기 소스는 없습니다.",
      writers.length ? `쓰는 소스: ${writers.map(nodeLabel).join(", ")}` : "확인된 쓰기 소스는 없습니다.",
      relations.length ? `직접 연결된 테이블: ${relations.map(nodeShortLabel).join(", ")}` : "직접 연결된 테이블 관계는 없습니다.",
    ];
    const answer = lines.join("\n");
    return {
      status: "answered",
      answer,
      claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
      citations,
      referencedNodeIds,
      limitations: ["의미 추론 없이 DDL·쿼리에서 확인한 관계만 사용했습니다."],
      suggestedQuestions: [`${primary.name} 변경 영향은?`, `${primary.name}을 쓰는 소스는?`],
    };
  }

  if (primary.nodeType === "file") {
    const operations = relatedEdges
      .filter((edge) => edge.kind === "read" || edge.kind === "write")
      .map((edge) => {
        const other = graph.nodes.find((node) => node.id === (edge.source === primary.id ? edge.target : edge.source));
        return `${edgeLabel(edge)} ${nodeShortLabel(other)}`;
      });
    const answer = `${primary.path}에서 확인된 데이터 접근은 ${operations.length ? operations.join(", ") : "없습니다"}. 이 파일에는 ${primary.symbolIds.length}개의 함수·라우트 심볼이 탐지되었습니다.`;
    return {
      status: "answered",
      answer,
      claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
      citations,
      referencedNodeIds,
      limitations: ["동적 쿼리 문자열과 런타임 의존성은 정적 분석만으로 누락될 수 있습니다."],
      suggestedQuestions: [`${primary.name}이 참조하는 테이블은?`],
    };
  }

  const owner = graph.files.find((file) => file.id === primary.fileId);
  const answer = `${primary.name} 심볼은 ${owner?.path ?? primary.filePath}:${primary.line}에서 확인되었습니다.${primary.routePath ? ` 라우트는 ${primary.httpMethod ?? "HTTP"} ${primary.routePath}입니다.` : ""}`;
  return {
    status: "answered",
    answer,
    claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
    citations,
    referencedNodeIds,
    limitations: ["호출 그래프는 명시적 import와 쿼리 사용 근거에 한정됩니다."],
    suggestedQuestions: owner ? [`${owner.name}의 데이터 접근은?`] : [],
  };
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeDownloadName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || "schema-lens";
}

function starterMessage(graph: AnalysisGraph): ChatMessage {
  return {
    id: "assistant-intro",
    role: "assistant",
    content: `현재 그래프에서 테이블 ${graph.stats.tableCount}개, 소스 파일 ${graph.stats.fileCount}개, 관계 ${graph.stats.relationshipCount}개를 확인했습니다. 테이블 변경 영향, 쿼리 근거, 읽기·쓰기 흐름을 질문해 보세요.`,
    local: true,
  };
}

export function SchemaLensWorkspace() {
  const initialSources = useMemo(() => buildDemoSourceFiles(), []);
  const initialGraph = useMemo(() => analyzeSourceProject(initialSources), [initialSources]);
  const initialDocuments = useMemo<SourceDocumentRef[]>(
    () =>
      initialSources.map((source) => {
        const fileNode = initialGraph.files.find((file) => file.path === source.path);
        return {
          path: source.path,
          name: sourceName(source.path),
          language: fileNode?.language || source.language || "text",
          size: source.content.length,
          viewable: true,
          analysisIncluded: true,
          inlineContent: source.content,
        };
      }),
    [initialGraph.files, initialSources],
  );
  const [graph, setGraph] = useState<AnalysisGraph>(initialGraph);
  const [sourceDocuments, setSourceDocuments] = useState<SourceDocumentRef[]>(initialDocuments);
  const [projectName, setProjectName] = useState("workspace-api");
  const [projectPath, setProjectPath] = useState("내장 샘플 · browser local");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("database");
  const [explorerMode, setExplorerMode] = useState<ExplorerMode>("database");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [selectedId, setSelectedId] = useState<string | null>(initialGraph.tables[0]?.id ?? null);
  const [explorerSearch, setExplorerSearch] = useState("");
  const [graphSearch, setGraphSearch] = useState("");
  const [zoom, setZoom] = useState(0.9);
  const [scanState, setScanState] = useState<ScanState>("ready");
  const [scanMessage, setScanMessage] = useState("샘플 분석 완료");
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({
    configured: false,
    loading: true,
  });
  const [mapping, setMapping] = useState<MappingResult | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, ReviewDecision>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([starterMessage(initialGraph)]);
  const [question, setQuestion] = useState("");
  const [answerBusy, setAnswerBusy] = useState(false);
  const [openSourcePaths, setOpenSourcePaths] = useState<string[]>(
    initialDocuments[0] ? [initialDocuments[0].path] : [],
  );
  const [sourceLocation, setSourceLocation] = useState<SourceLocation | null>(
    initialDocuments[0]
      ? { path: initialDocuments[0].path, startLine: 1, endLine: 1, requestId: 1 }
      : null,
  );
  const [sourceContent, setSourceContent] = useState("");
  const [sourceContentPath, setSourceContentPath] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() =>
    collectExpandedFolders(buildSourceTree(initialDocuments), 2),
  );
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const explorerOverlay = useMediaQuery("(max-width: 760px)");
  const inspectorOverlay = useMediaQuery("(max-width: 1040px)");
  const explorerModal = explorerOverlay && explorerOpen;
  const inspectorModal = inspectorOverlay && inspectorOpen;
  const responsiveModalOpen = explorerModal || inspectorModal;
  const folderInput = useRef<HTMLInputElement>(null);
  const explorerToggle = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const explorerClose = useRef<HTMLButtonElement>(null);
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const workspaceTabRefs = useRef(new Map<WorkspaceTab, HTMLButtonElement>());
  const inspectorTabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const sourceLoadRequest = useRef(0);
  const sourceRevealRequest = useRef(2);
  const sourceContentCache = useRef(new Map<string, string>());
  const workspaceGeneration = useRef(0);
  const scanBusyRef = useRef(false);
  const scanAbort = useRef<AbortController | null>(null);
  const mappingRequest = useRef(0);
  const mappingAbort = useRef<AbortController | null>(null);
  const answerRequest = useRef(0);
  const answerAbort = useRef<AbortController | null>(null);

  const selectedNode = graph.nodes.find((node) => node.id === selectedId);
  const selectedEdges = graph.edges.filter(
    (edge) => edge.source === selectedId || edge.target === selectedId,
  );
  const selectedEvidence = useMemo(
    () => relevantEvidence(graph, selectedId),
    [graph, selectedId],
  );
  const impacts = useMemo(() => impactNodes(graph, selectedId), [graph, selectedId]);

  const activeSourceDocument = sourceLocation
    ? sourceDocuments.find((document) => document.path === sourceLocation.path)
    : undefined;
  const openSourceDocuments = openSourcePaths
    .map((path) => sourceDocuments.find((document) => document.path === path))
    .filter((document): document is SourceDocumentRef => Boolean(document));

  function beginWorkspaceTransition(): number {
    const generation = ++workspaceGeneration.current;
    scanAbort.current?.abort();
    mappingAbort.current?.abort();
    answerAbort.current?.abort();
    mappingRequest.current += 1;
    answerRequest.current += 1;
    setMappingBusy(false);
    setAnswerBusy(false);
    setMapping(null);
    setMappingError(null);
    setReviewDecisions({});
    setMessages([]);
    setQuestion("");
    return generation;
  }

  function revealSource(
    path: string,
    startLine = 1,
    endLine = startLine,
    options: { evidenceId?: string; selectFileNode?: boolean } = {},
  ) {
    const normalizedPath = normalizedBrowserPath(path);
    if (!normalizedPath || !sourceDocuments.some((document) => document.path === normalizedPath)) {
      setScanMessage(`원문을 열 수 없음 · ${path}`);
      return;
    }
    setOpenSourcePaths((current) => {
      if (current.includes(normalizedPath)) return current;
      const next = [...current, normalizedPath];
      return next.length > MAX_OPEN_SOURCE_TABS ? next.slice(-MAX_OPEN_SOURCE_TABS) : next;
    });
    setSourceLocation({
      path: normalizedPath,
      startLine: Math.max(1, Math.trunc(startLine) || 1),
      endLine: Math.max(Math.max(1, Math.trunc(startLine) || 1), Math.trunc(endLine) || startLine),
      requestId: sourceRevealRequest.current++,
      evidenceId: options.evidenceId,
    });
    setActiveTab("code");
    setExplorerMode("source");
    setExplorerOpen(false);
    if (options.selectFileNode) {
      const fileNode = graph.files.find((file) => file.path === normalizedPath);
      if (fileNode) {
        setSelectedId(fileNode.id);
        setInspectorTab("details");
      }
    }
  }

  function closeSource(path: string) {
    const closedIndex = openSourcePaths.indexOf(path);
    const next = openSourcePaths.filter((item) => item !== path);
    setOpenSourcePaths(next);
    if (sourceLocation?.path === path) {
      const nextPath = next[Math.min(Math.max(0, closedIndex), Math.max(0, next.length - 1))];
      setSourceLocation(
        nextPath
          ? { path: nextPath, startLine: 1, endLine: 1, requestId: sourceRevealRequest.current++ }
          : null,
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    const requestId = ++sourceLoadRequest.current;
    const controller = new AbortController();

    async function loadActiveSource() {
      await Promise.resolve();
      if (cancelled || requestId !== sourceLoadRequest.current) return;
      if (!activeSourceDocument) {
        setSourceContent("");
        setSourceContentPath(null);
        setSourceError(null);
        setSourceLoading(false);
        return;
      }

      const cached = sourceContentCache.current.get(activeSourceDocument.path);
      if (cached !== undefined) {
        rememberSourceContent(sourceContentCache.current, activeSourceDocument.path, cached);
        setSourceContent(cached);
        setSourceContentPath(activeSourceDocument.path);
        setSourceError(null);
        setSourceLoading(false);
        return;
      }

      if (!activeSourceDocument.viewable) {
        setSourceContent("");
        setSourceContentPath(null);
        setSourceError("이 파일 형식 또는 크기는 안전한 텍스트 미리보기 범위를 벗어납니다.");
        setSourceLoading(false);
        return;
      }

      setSourceLoading(true);
      setSourceContentPath(null);
      setSourceError(null);
      const load = activeSourceDocument.inlineContent !== undefined
        ? Promise.resolve(activeSourceDocument.inlineContent)
        : activeSourceDocument.file
          ? readBrowserFileText(activeSourceDocument.file, controller.signal)
          : undefined;
      if (!load) {
        setSourceLoading(false);
        setSourceError("선택한 폴더를 다시 열어야 원문을 읽을 수 있습니다.");
        return;
      }

      try {
        const content = await load;
        if (cancelled || requestId !== sourceLoadRequest.current) return;
        if (content.includes("\u0000")) {
          throw new Error("바이너리 데이터가 포함되어 텍스트로 표시하지 않았습니다.");
        }
        rememberSourceContent(sourceContentCache.current, activeSourceDocument.path, content);
        setSourceContent(content);
        setSourceContentPath(activeSourceDocument.path);
        setSourceLoading(false);
      } catch (error) {
        if (cancelled || requestId !== sourceLoadRequest.current) return;
        setSourceContent("");
        setSourceContentPath(null);
        setSourceError(error instanceof Error ? error.message : "파일 원문을 읽지 못했습니다.");
        setSourceLoading(false);
      }
    }

    void loadActiveSource();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeSourceDocument, sourceLocation?.requestId]);

  function closeResponsivePanels(restoreFocus = true) {
    const focusTarget = inspectorOpen
      ? inspectorToggle.current
      : explorerOpen
        ? explorerToggle.current
        : null;
    setExplorerOpen(false);
    setInspectorOpen(false);
    if (restoreFocus && focusTarget) {
      requestAnimationFrame(() => focusTarget.focus());
    }
  }

  function trapDrawerFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const shouldTrap = event.currentTarget.id === "project-explorer"
      ? explorerModal
      : inspectorModal;
    if (!shouldTrap) return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function nextTab<T extends string>(items: readonly T[], current: T, key: string): T | null {
    const index = items.indexOf(current);
    if (key === "ArrowRight") return items[(index + 1) % items.length];
    if (key === "ArrowLeft") return items[(index - 1 + items.length) % items.length];
    if (key === "Home") return items[0];
    if (key === "End") return items[items.length - 1];
    return null;
  }

  function activateWorkspaceTab(tab: WorkspaceTab) {
    setActiveTab(tab);
    if (tab === "database" || tab === "source") setExplorerMode(tab);
    if (tab === "code") setExplorerMode("source");
  }

  function handleWorkspaceTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: WorkspaceTab) {
    const target = nextTab(WORKSPACE_TABS, tab, event.key);
    if (!target) return;
    event.preventDefault();
    activateWorkspaceTab(target);
    requestAnimationFrame(() => workspaceTabRefs.current.get(target)?.focus());
  }

  function handleInspectorTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: InspectorTab) {
    const target = nextTab(INSPECTOR_TABS, tab, event.key);
    if (!target) return;
    event.preventDefault();
    setInspectorTab(target);
    requestAnimationFrame(() => inspectorTabRefs.current.get(target)?.focus());
  }

  useEffect(() => {
    const closeDrawers = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && (explorerOpen || inspectorOpen)) {
        const focusTarget = inspectorOpen
          ? inspectorToggle.current
          : explorerToggle.current;
        setExplorerOpen(false);
        setInspectorOpen(false);
        requestAnimationFrame(() => focusTarget?.focus());
      }
    };
    window.addEventListener("keydown", closeDrawers);
    return () => window.removeEventListener("keydown", closeDrawers);
  }, [explorerOpen, inspectorOpen]);

  useEffect(() => {
    if (explorerOpen) {
      requestAnimationFrame(() => explorerClose.current?.focus());
    } else if (inspectorOpen) {
      requestAnimationFrame(() => inspectorClose.current?.focus());
    }
  }, [explorerOpen, inspectorOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/llm/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload?.ok) return;
        setLlmStatus({
          configured: Boolean(payload.data?.configured),
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setLlmStatus((current) => ({ ...current, loading: false }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      scanAbort.current?.abort();
      mappingAbort.current?.abort();
      answerAbort.current?.abort();
      sourceLoadRequest.current += 1;
    },
    [],
  );

  const explorerItems = useMemo(() => {
    const items: GraphNode[] = explorerMode === "source" ? graph.files : graph.tables;
    if (!explorerSearch.trim()) return items;
    const term = explorerSearch.toLocaleLowerCase();
    return items.filter((node) => nodeLabel(node).toLocaleLowerCase().includes(term));
  }, [explorerMode, explorerSearch, graph.files, graph.tables]);

  const connectionCountByNode = useMemo(() => {
    const counts = new Map<string, number>();
    graph.edges.forEach((edge) => {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    });
    return counts;
  }, [graph.edges]);

  const analysisSourcePaths = useMemo(
    () => new Set(sourceDocuments.filter((document) => document.analysisIncluded).map((document) => document.path)),
    [sourceDocuments],
  );
  const sourceTreeDocuments = useMemo<SourceDocumentDescriptor[]>(
    () => {
      const fileIdByPath = new Map(graph.files.map((file) => [file.path, file.id]));
      return sourceDocuments.map((document) => ({
        path: document.path,
        name: document.name,
        language: document.language,
        size: document.size,
        fileId: fileIdByPath.get(document.path),
      }));
    },
    [graph.files, sourceDocuments],
  );
  const unavailableSourcePaths = useMemo(
    () => new Set(sourceDocuments.filter((document) => !document.viewable).map((document) => document.path)),
    [sourceDocuments],
  );
  const connectionCountByPath = useMemo(() => {
    const counts = new Map<string, number>();
    graph.files.forEach((file) => counts.set(file.path, connectionCountByNode.get(file.id) ?? 0));
    return counts;
  }, [connectionCountByNode, graph.files]);
  const selectedSourcePath = selectedNode?.nodeType === "file"
    ? selectedNode.path
    : selectedNode?.nodeType === "symbol"
      ? selectedNode.filePath
      : null;
  const codeDocuments = useMemo<SourceCodeDocument[]>(
    () =>
      openSourceDocuments.map((document) => {
        const isActive = document.path === sourceLocation?.path;
        const hasActiveContent = isActive && sourceContentPath === document.path;
        return {
          path: document.path,
          language: document.language,
          byteSize: document.size,
          content: hasActiveContent ? sourceContent : undefined,
          status: isActive
            ? sourceError
              ? "error"
              : sourceLoading || !hasActiveContent
                ? "loading"
                : "ready"
            : "ready",
          error: isActive ? sourceError ?? undefined : undefined,
        };
      }),
    [openSourceDocuments, sourceContent, sourceContentPath, sourceError, sourceLoading, sourceLocation?.path],
  );
  const codeEvidence = useMemo<SourceCodeEvidence[]>(
    () =>
      graph.evidence.map((item) => ({
        id: item.id,
        path: item.filePath,
        startLine: item.line,
        endLine: item.endLine,
        label: item.description || `${item.kind} 근거`,
        kind: item.kind,
      })),
    [graph.evidence],
  );

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const suggestedQuestions = useMemo(() => {
    const mostConnectedTable = [...graph.tables]
      .map((table) => ({
        table,
        degree: graph.edges.filter((edge) => edge.source === table.id || edge.target === table.id).length,
      }))
      .sort((a, b) => b.degree - a.degree)[0]?.table;
    const writerEdge = graph.edges.find((edge) => edge.kind === "write");
    const writer = writerEdge ? graph.nodes.find((node) => node.id === writerEdge.source) : undefined;
    const writtenTable = writerEdge ? graph.nodes.find((node) => node.id === writerEdge.target) : undefined;
    return [
      mostConnectedTable ? `${mostConnectedTable.name} 테이블 변경 영향은?` : "가장 많이 연결된 테이블은?",
      writer && writtenTable ? `${nodeShortLabel(writer)}가 ${nodeShortLabel(writtenTable)}에 쓰는 흐름은?` : "쓰기 쿼리가 있는 파일은?",
      "선언된 FK와 쿼리에서 추론한 JOIN을 구분해 줘",
    ];
  }, [graph]);

  const supplementalEdges: SupplementalEdge[] = useMemo(
    () =>
      mapping?.additions.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        kind: "llm",
        confidence: edge.confidence,
      })) ?? [],
    [mapping],
  );

  async function handleFolderChange(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.currentTarget.files;
    if (!fileList?.length) return;
    const chosenCount = fileList.length;
    const generation = beginWorkspaceTransition();
    const controller = new AbortController();
    scanAbort.current = controller;
    scanBusyRef.current = true;
    setScanState("reading");
    setScanMessage(`${chosenCount}개 파일을 분류하는 중`);

    try {
      const rankedDocuments: RankedSourceDocument[] = [];
      let candidateCount = 0;
      for (const file of fileList) {
        const path = normalizedBrowserPath(file.webkitRelativePath || file.name);
        if (!path || excludedSourcePath(path)) continue;
        candidateCount += 1;
        const viewable = viewableTextFile(file, path);
        const document: SourceDocumentRef = {
          path,
          name: sourceName(path),
          language: "text",
          size: file.size,
          viewable,
          analysisIncluded: false,
          file,
        };
        retainRankedSource(
          rankedDocuments,
          {
            document,
            priority:
              viewable && file.size <= MAX_FILE_BYTES && ANALYZABLE_EXTENSION.test(path)
                ? 0
                : viewable
                  ? 1
                  : 2,
          },
          MAX_SOURCE_TREE_FILES,
        );
      }
      event.currentTarget.value = "";
      rankedDocuments.sort(compareRankedSource);
      const seenPaths = new Set<string>();
      const documents = rankedDocuments.flatMap(({ document }) => {
        if (seenPaths.has(document.path)) return [];
        seenPaths.add(document.path);
        return [document];
      });
      const omittedTreeCount = Math.max(0, candidateCount - documents.length);
      if (!documents.length) {
        throw new Error("표시하거나 분석할 수 있는 파일을 찾지 못했습니다.");
      }

      const eligible = documents.filter(
        (document) =>
          document.file &&
          document.viewable &&
          document.size <= MAX_FILE_BYTES &&
          ANALYZABLE_EXTENSION.test(document.path),
      );
      const analysisDocuments: SourceDocumentRef[] = [];
      let analysisBytes = 0;
      for (const document of eligible) {
        if (analysisDocuments.length >= MAX_BROWSER_FILES) break;
        if (analysisBytes + document.size > MAX_ANALYSIS_BYTES) continue;
        analysisDocuments.push(document);
        analysisBytes += document.size;
      }

      const analyzedPaths = new Set(analysisDocuments.map((document) => document.path));
      documents.forEach((document) => {
        document.analysisIncluded = analyzedPaths.has(document.path);
      });
      const inputs = await readSourceFiles(analysisDocuments, controller.signal);
      if (generation !== workspaceGeneration.current || controller.signal.aborted) return;
      setScanState("analyzing");
      setScanMessage(
        `${inputs.length}개 소스 · ${(analysisBytes / 1024 / 1024).toFixed(1)}MB에서 관계를 찾는 중`,
      );
      const nextGraph = await analyzeSourceProjectInWorker(inputs, {
        signal: controller.signal,
      });
      if (generation !== workspaceGeneration.current || controller.signal.aborted) return;
      const languageByPath = new Map(nextGraph.files.map((file) => [file.path, file.language]));
      const nextDocuments = documents.map((document) => ({
        ...document,
        language: languageByPath.get(document.path) || document.name.split(".").pop()?.toLocaleLowerCase() || "text",
      }));
      setGraph(nextGraph);
      setSourceDocuments(nextDocuments);
      sourceContentCache.current.clear();
      const rootName = nextDocuments[0]?.path.split("/")[0];
      setProjectName(rootName || "local-project");
      const omittedAnalysisCount = Math.max(0, eligible.length - analysisDocuments.length);
      setProjectPath(
        `${nextDocuments.length}개 파일 · 분석 ${inputs.length}${omittedAnalysisCount ? ` · 예산 제외 ${omittedAnalysisCount}` : ""}${omittedTreeCount ? ` · 색인 제외 ${omittedTreeCount}` : ""} · 원본 변경 없음`,
      );
      setSelectedId(nextGraph.tables[0]?.id ?? nextGraph.files[0]?.id ?? null);
      const firstSourcePath = nextGraph.files[0]?.path ?? nextDocuments.find((document) => document.viewable)?.path;
      setOpenSourcePaths(firstSourcePath ? [firstSourcePath] : []);
      setSourceLocation(
        firstSourcePath
          ? { path: firstSourcePath, startLine: 1, endLine: 1, requestId: sourceRevealRequest.current++ }
          : null,
      );
      setSourceContent("");
      setSourceContentPath(null);
      setSourceError(null);
      setExpandedFolders(collectExpandedFolders(buildSourceTree(nextDocuments), 2));
      setExplorerSearch("");
      setGraphSearch("");
      setMessages([starterMessage(nextGraph)]);
      setScanState("ready");
      setScanMessage(
        `분석 완료 · 파일 ${inputs.length}/${nextDocuments.length}${omittedTreeCount ? ` · 색인 제외 ${omittedTreeCount}` : ""} · 테이블 ${nextGraph.stats.tableCount} · 관계 ${nextGraph.stats.relationshipCount}`,
      );
    } catch (error) {
      if (generation !== workspaceGeneration.current || controller.signal.aborted) return;
      setScanState("error");
      setScanMessage(
        error instanceof Error
          ? `분석을 마치지 못했습니다 · ${error.message}`
          : "분석을 마치지 못했습니다 · 폴더를 다시 선택해 주세요",
      );
    } finally {
      if (generation === workspaceGeneration.current) {
        scanBusyRef.current = false;
        if (scanAbort.current === controller) scanAbort.current = null;
      }
    }
  }

  function loadDemo() {
    beginWorkspaceTransition();
    scanBusyRef.current = false;
    const sources = buildDemoSourceFiles();
    const nextGraph = analyzeSourceProject(sources);
    const documents: SourceDocumentRef[] = sources.map((source) => ({
      path: source.path,
      name: sourceName(source.path),
      language: nextGraph.files.find((file) => file.path === source.path)?.language || source.language || "text",
      size: source.content.length,
      viewable: true,
      analysisIncluded: true,
      inlineContent: source.content,
    }));
    setGraph(nextGraph);
    setSourceDocuments(documents);
    sourceContentCache.current.clear();
    setProjectName("workspace-api");
    setProjectPath("내장 샘플 · browser local");
    setSelectedId(nextGraph.tables[0]?.id ?? null);
    setExplorerMode("database");
    setActiveTab("database");
    setExplorerSearch("");
    setGraphSearch("");
    setOpenSourcePaths(documents[0] ? [documents[0].path] : []);
    setSourceLocation(
      documents[0]
        ? { path: documents[0].path, startLine: 1, endLine: 1, requestId: sourceRevealRequest.current++ }
        : null,
    );
    setSourceContent("");
    setSourceContentPath(null);
    setSourceError(null);
    setExpandedFolders(collectExpandedFolders(buildSourceTree(documents), 2));
    setMapping(null);
    setMessages([starterMessage(nextGraph)]);
    setScanState("ready");
    setScanMessage("샘플 분석 완료");
  }

  async function runSemanticMapping() {
    if (mappingBusy || scanBusyRef.current || scanState !== "ready") return;
    const generation = workspaceGeneration.current;
    const requestId = ++mappingRequest.current;
    mappingAbort.current?.abort();
    const controller = new AbortController();
    mappingAbort.current = controller;
    setMappingBusy(true);
    setMappingError(null);
    const focus = selectedNode ? nodeLabel(selectedNode) : "";
    const context = compactGraphContext(graph, focus);
    const evidenceIds = contextEvidenceIds(context);

    try {
      const response = await fetch("/api/llm/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          graph: context,
          excerpts: graphExcerpts(graph, evidenceIds.size ? evidenceIds : undefined),
          focus,
        }),
      });
      const payload = (await response.json()) as LlmSuccess<MappingResult> | LlmErrorBody;
      if (generation !== workspaceGeneration.current || requestId !== mappingRequest.current) return;
      if (!payload.ok) throw new Error(payload.error.message);
      setMapping(payload.data);
      setLlmStatus({ configured: true, loading: false });
      setActiveTab("review");
      setScanMessage(
        `LLM 매핑 완료 · 검토 ${payload.data.additions.edges.length + payload.data.additions.nodes.length + payload.data.diagnostics.length}`,
      );
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== workspaceGeneration.current ||
        requestId !== mappingRequest.current
      ) return;
      setMappingError(
        error instanceof Error
          ? error.message
          : "LLM 매핑을 실행하지 못했습니다. 정적 분석 결과는 그대로 유지됩니다.",
      );
      setInspectorTab("ask");
    } finally {
      if (generation === workspaceGeneration.current && requestId === mappingRequest.current) {
        setMappingBusy(false);
        if (mappingAbort.current === controller) mappingAbort.current = null;
      }
    }
  }

  async function submitQuestion(rawQuestion?: string) {
    const nextQuestion = (rawQuestion ?? question).trim();
    if (!nextQuestion || answerBusy || scanBusyRef.current || scanState !== "ready") return;
    const graphSnapshot = graph;
    const generation = workspaceGeneration.current;
    const requestId = ++answerRequest.current;
    answerAbort.current?.abort();
    const controller = new AbortController();
    answerAbort.current = controller;
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: nextQuestion,
    };
    const priorMessages = messages;
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setAnswerBusy(true);
    setInspectorTab("ask");

    const context = compactGraphContext(graphSnapshot, nextQuestion);
    const evidenceIds = contextEvidenceIds(context);
    const conversation: ConversationTurn[] = priorMessages
      .slice(-8)
      .map((message) => ({ role: message.role, content: message.content }));

    try {
      const response = await fetch("/api/llm/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          question: nextQuestion,
          graph: context,
          evidence: graphExcerpts(graphSnapshot, evidenceIds.size ? evidenceIds : undefined),
          conversation,
        }),
      });
      const payload = (await response.json()) as LlmSuccess<AnswerResult> | LlmErrorBody;
      if (generation !== workspaceGeneration.current || requestId !== answerRequest.current) return;
      if (!payload.ok) {
        const fallback = localGraphAnswer(graphSnapshot, nextQuestion);
        setMessages((current) => [
          ...current,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: `${fallback.answer}\n\n${fallback.limitations.join(" ")}`,
            citations: fallback.citations,
            referencedNodeIds: fallback.referencedNodeIds,
            local: true,
          },
        ]);
        return;
      }

      setLlmStatus({ configured: true, loading: false });
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: [payload.data.answer, ...payload.data.limitations.map((item) => `제한: ${item}`)].join("\n\n"),
          citations: payload.data.citations,
          referencedNodeIds: payload.data.referencedNodeIds,
        },
      ]);
    } catch {
      if (
        controller.signal.aborted ||
        generation !== workspaceGeneration.current ||
        requestId !== answerRequest.current
      ) return;
      const fallback = localGraphAnswer(graphSnapshot, nextQuestion);
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: `${fallback.answer}\n\n${fallback.limitations.join(" ")}`,
          citations: fallback.citations,
          referencedNodeIds: fallback.referencedNodeIds,
          local: true,
        },
      ]);
    } finally {
      if (generation === workspaceGeneration.current && requestId === answerRequest.current) {
        setAnswerBusy(false);
        if (answerAbort.current === controller) answerAbort.current = null;
      }
    }
  }

  function handleQuestionSubmit(event: FormEvent) {
    event.preventDefault();
    void submitQuestion();
  }

  function handleQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitQuestion();
    }
  }

  function citationTarget(citation: AnswerCitation) {
    if (citation.kind === "graph") return graph.nodes.find((node) => node.id === citation.sourceId);
    const evidence = graph.evidence.find((item) => item.id === citation.sourceId);
    return evidence ? graph.files.find((file) => file.path === evidence.filePath) : undefined;
  }

  const confidence = selectedNode ? confidencePercent(selectedNode.confidence) : 0;
  const reviewCount = mapping
    ? mapping.additions.edges.length + mapping.additions.nodes.length + mapping.additions.aliases.length + mapping.diagnostics.length
    : 0;

  return (
    <main className="workspace">
      <header className="app-header" inert={responsiveModalOpen || undefined}>
        <div className="brand-lockup" aria-label="Schema Lens">
          <span className="brand-mark" aria-hidden="true" />
          <span>
            <span className="brand-title">Schema Lens</span>
            <span className="brand-subtitle">source grounded ERD</span>
          </span>
        </div>

        <button type="button" className="project-switcher" onClick={() => folderInput.current?.click()}>
          <span className="project-glyph">{"//"}</span>
          <span className="project-labels">
            <span className="project-name">{projectName}</span>
            <span className="project-path">{projectPath}</span>
          </span>
        </button>
        <input
          ref={folderInput}
          className="hidden-input"
          type="file"
          multiple
          aria-label="분석할 로컬 소스 폴더 선택"
          onChange={handleFolderChange}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />

        <button
          ref={explorerToggle}
          type="button"
          className="button button-small responsive-toggle explorer-toggle"
          aria-expanded={explorerOpen}
          aria-controls="project-explorer"
          onClick={() => {
            setExplorerOpen((current) => !current);
            setInspectorOpen(false);
          }}
        >
          탐색기
        </button>
        <button
          ref={inspectorToggle}
          type="button"
          className="button button-small responsive-toggle inspector-toggle"
          aria-expanded={inspectorOpen}
          aria-controls="project-inspector"
          onClick={() => {
            setInspectorOpen((current) => !current);
            setExplorerOpen(false);
          }}
        >
          상세
        </button>
        <div className="header-spacer" />
        <div className="header-summary">
          <span className="analysis-state">
            <span className={`status-dot${scanState === "reading" || scanState === "analyzing" ? " is-busy" : scanState === "error" ? " is-offline" : ""}`} />
            {scanState === "ready" ? "분석 최신" : scanState === "error" ? "부분 결과 유지" : "분석 중"}
          </span>
          <span className="header-metrics">
            TABLE {graph.stats.tableCount} · QUERY {graph.stats.readCount + graph.stats.writeCount} · EDGE {graph.stats.relationshipCount}
          </span>
        </div>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => void runSemanticMapping()}
          disabled={mappingBusy || scanState !== "ready"}
          title={llmStatus.configured ? "설정된 LLM으로 의미 매핑" : "LLM API 설정 시 활성화됩니다"}
        >
          {mappingBusy ? "매핑 중…" : "LLM 정밀 매핑"}
        </button>
        <button type="button" className="button button-primary" onClick={() => folderInput.current?.click()}>
          폴더 열기
        </button>
      </header>

      <section className="app-shell">
        <button
          type="button"
          className={`drawer-scrim${explorerOpen ? " has-explorer" : ""}${inspectorOpen ? " has-inspector" : ""}`}
          aria-label="열린 패널 닫기"
          onClick={() => closeResponsivePanels()}
        />
        <aside
          id="project-explorer"
          className={`explorer${explorerOpen ? " is-open" : ""}`}
          role={explorerModal ? "dialog" : undefined}
          aria-modal={explorerModal || undefined}
          aria-label="프로젝트 탐색기"
          inert={inspectorModal || undefined}
          onKeyDown={trapDrawerFocus}
        >
          <div className="panel-heading">
            <h2 className="panel-title">Explorer</h2>
            <span className="panel-count">
              {explorerMode === "source" ? sourceDocuments.length : explorerItems.length}
            </span>
            <button
              ref={explorerClose}
              type="button"
              className="panel-close"
              aria-label="탐색기 닫기"
              onClick={() => closeResponsivePanels()}
            >
              ×
            </button>
          </div>
          <input
            className="explorer-search"
            value={explorerSearch}
            onChange={(event) => setExplorerSearch(event.target.value)}
            placeholder={explorerMode === "source" ? "파일과 폴더 검색" : "테이블과 컬럼 검색"}
            aria-label="프로젝트 객체 검색"
          />
          <div className="segment-control" aria-label="탐색기 뷰">
            <button
              type="button"
              className="segment-button"
              aria-pressed={explorerMode === "database"}
              onClick={() => setExplorerMode("database")}
            >
              데이터
            </button>
            <button
              type="button"
              className="segment-button"
              aria-pressed={explorerMode === "source"}
              onClick={() => setExplorerMode("source")}
            >
              소스
            </button>
          </div>

          <div className="explorer-content">
            {explorerMode === "source" ? (
              <SourceTree
                documents={sourceTreeDocuments}
                query={explorerSearch}
                expandedFolders={expandedFolders}
                activePath={sourceLocation?.path ?? null}
                selectedPath={selectedSourcePath}
                analysisPaths={analysisSourcePaths}
                unavailablePaths={unavailableSourcePaths}
                connectionCountByPath={connectionCountByPath}
                onToggleFolder={toggleFolder}
                onOpenFile={(path) => revealSource(path, 1, 1, { selectFileNode: true })}
              />
            ) : (
              <>
                <div className="tree-group">
                  <div className="tree-group-header">데이터베이스 객체</div>
                  <div className="tree-list">
                    {explorerItems.map((node) => (
                      <button
                        type="button"
                        className={`tree-item${selectedId === node.id ? " is-selected" : ""}`}
                        key={node.id}
                        onClick={() => {
                          setSelectedId(node.id);
                          setActiveTab("database");
                          setInspectorTab("details");
                          setExplorerOpen(false);
                        }}
                      >
                        <span className="tree-item-glyph">DB</span>
                        <span className="tree-item-name">{nodeShortLabel(node)}</span>
                        <span className="tree-item-meta">{connectionCountByNode.get(node.id) ?? 0}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {graph.symbols.some((symbol) => symbol.kind === "route") ? (
                  <div className="tree-group">
                    <div className="tree-group-header">감지한 엔드포인트</div>
                    <div className="tree-list">
                      {graph.symbols
                        .filter((symbol) => symbol.kind === "route")
                        .slice(0, 10)
                        .map((symbol) => (
                          <button
                            type="button"
                            className={`tree-item${selectedId === symbol.id ? " is-selected" : ""}`}
                            key={symbol.id}
                            onClick={() => {
                              setSelectedId(symbol.id);
                              setInspectorTab("details");
                              setExplorerOpen(false);
                            }}
                          >
                            <span className="tree-item-glyph">{symbol.httpMethod?.slice(0, 2) ?? "R"}</span>
                            <span className="tree-item-name">{symbol.routePath ?? symbol.name}</span>
                            <span className="tree-item-meta">:{symbol.line}</span>
                          </button>
                        ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="privacy-note">
            <strong>Local first.</strong> 원문은 선택한 파일만 브라우저에서 읽습니다. JSON과 LLM에는 비밀값을 마스킹한 관계·근거만 전달됩니다.
          </div>
        </aside>

        <section
          className={`workbench${activeTab === "code" ? " is-code-view" : ""}`}
          aria-label="ERD 및 소스 작업 영역"
          inert={responsiveModalOpen || undefined}
        >
          <div className="work-tabs" role="tablist" aria-label="관계도 종류">
            <button
              ref={(element) => {
                if (element) workspaceTabRefs.current.set("database", element);
                else workspaceTabRefs.current.delete("database");
              }}
              type="button"
              id="workspace-tab-database"
              className="work-tab"
              role="tab"
              aria-controls="workspace-tabpanel"
              aria-selected={activeTab === "database"}
              tabIndex={activeTab === "database" ? 0 : -1}
              onClick={() => activateWorkspaceTab("database")}
              onKeyDown={(event) => handleWorkspaceTabKeyDown(event, "database")}
            >
              DB ERD <span className="tab-count">{graph.tables.length}</span>
            </button>
            <button
              ref={(element) => {
                if (element) workspaceTabRefs.current.set("source", element);
                else workspaceTabRefs.current.delete("source");
              }}
              type="button"
              id="workspace-tab-source"
              className="work-tab"
              role="tab"
              aria-controls="workspace-tabpanel"
              aria-selected={activeTab === "source"}
              tabIndex={activeTab === "source" ? 0 : -1}
              onClick={() => activateWorkspaceTab("source")}
              onKeyDown={(event) => handleWorkspaceTabKeyDown(event, "source")}
            >
              소스 관계도 <span className="tab-count">{graph.files.length}</span>
            </button>
            <button
              ref={(element) => {
                if (element) workspaceTabRefs.current.set("code", element);
                else workspaceTabRefs.current.delete("code");
              }}
              type="button"
              id="workspace-tab-code"
              className="work-tab"
              role="tab"
              aria-controls="workspace-tabpanel"
              aria-selected={activeTab === "code"}
              tabIndex={activeTab === "code" ? 0 : -1}
              onClick={() => activateWorkspaceTab("code")}
              onKeyDown={(event) => handleWorkspaceTabKeyDown(event, "code")}
            >
              소스 코드 <span className="tab-count">{openSourcePaths.length}</span>
            </button>
            <button
              ref={(element) => {
                if (element) workspaceTabRefs.current.set("review", element);
                else workspaceTabRefs.current.delete("review");
              }}
              type="button"
              id="workspace-tab-review"
              className="work-tab"
              role="tab"
              aria-controls="workspace-tabpanel"
              aria-selected={activeTab === "review"}
              tabIndex={activeTab === "review" ? 0 : -1}
              onClick={() => activateWorkspaceTab("review")}
              onKeyDown={(event) => handleWorkspaceTabKeyDown(event, "review")}
            >
              매핑 검토 <span className="tab-count">{reviewCount}</span>
            </button>
          </div>

          <div
            id="workspace-tabpanel"
            className={`workspace-tabpanel${activeTab === "code" ? " is-code" : ""}`}
            role="tabpanel"
            aria-labelledby={`workspace-tab-${activeTab}`}
          >
          {activeTab !== "code" ? (
            <div className="graph-toolbar">
              {activeTab !== "review" ? (
                <>
                  <div className="toolbar-search-wrap">
                    <input
                      className="toolbar-search"
                      value={graphSearch}
                      onChange={(event) => setGraphSearch(event.target.value)}
                      placeholder="현재 그래프 검색"
                      aria-label="현재 그래프 검색"
                    />
                  </div>
                  <button type="button" className="button button-small" onClick={() => setGraphSearch("")}>필터 초기화</button>
                  <div className="toolbar-divider" />
                  <button
                    type="button"
                    className="button button-small button-square"
                    aria-label="축소"
                    onClick={() => setZoom((current) => Math.max(0.55, Number((current - 0.1).toFixed(2))))}
                  >
                    −
                  </button>
                  <span className="zoom-value">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    className="button button-small button-square"
                    aria-label="확대"
                    onClick={() => setZoom((current) => Math.min(1.3, Number((current + 0.1).toFixed(2))))}
                  >
                    +
                  </button>
                  <button type="button" className="button button-small" onClick={() => setZoom(0.9)}>화면 맞춤</button>
                  <div className="toolbar-divider" />
                </>
              ) : (
                <span className="toolbar-context">LLM 제안을 근거와 함께 검토합니다.</span>
              )}
              <span className="toolbar-spacer" />
              <button
                type="button"
                className="button button-small"
                onClick={() =>
                  downloadJson(
                    `${safeDownloadName(projectName)}-schema-lens.json`,
                    sanitizeGraphForLlm({
                      projectName,
                      analyzedAt: new Date().toISOString(),
                      graph,
                      semanticMapping: mapping,
                    } as unknown as Record<string, JsonValue>),
                  )
                }
              >
                JSON 내보내기
              </button>
              <button type="button" className="button button-small" onClick={loadDemo}>샘플 복원</button>
            </div>
          ) : null}

          {activeTab === "code" ? (
            <SourceCodeWorkbench
              documents={codeDocuments}
              activePath={sourceLocation?.path ?? null}
              location={sourceLocation}
              evidence={codeEvidence}
              onActivateDocument={(path) =>
                revealSource(
                  path,
                  sourceLocation?.path === path ? sourceLocation.startLine : 1,
                  sourceLocation?.path === path ? sourceLocation.endLine : 1,
                  { selectFileNode: true },
                )
              }
              onCloseDocument={closeSource}
              onRetryDocument={(path) => {
                sourceContentCache.current.delete(path);
                revealSource(path, sourceLocation?.startLine ?? 1, sourceLocation?.endLine ?? 1, {
                  selectFileNode: true,
                });
              }}
              onSelectEvidence={(item) => {
                const evidence = graph.evidence.find((candidate) => candidate.id === item.id);
                const fileNode = graph.files.find((file) => file.path === item.path);
                if (fileNode) setSelectedId(fileNode.id);
                if (evidence) {
                  revealSource(item.path, item.startLine, item.endLine, { evidenceId: item.id });
                  setInspectorTab("evidence");
                  if (inspectorOverlay) setInspectorOpen(true);
                }
              }}
              onSelectLocation={(location) =>
                revealSource(location.path, location.startLine, location.endLine, {
                  selectFileNode: true,
                })
              }
            />
          ) : activeTab === "review" ? (
            <MappingReview
              mapping={mapping}
              error={mappingError}
              busy={mappingBusy || scanState !== "ready"}
              decisions={reviewDecisions}
              onRun={() => void runSemanticMapping()}
              onDecision={(id, state) =>
                setReviewDecisions((current) => ({
                  ...current,
                  [id]: { state, updatedAt: Date.now() },
                }))
              }
            />
          ) : (
            <GraphCanvas
              graph={graph}
              mode={activeTab}
              selectedId={selectedId}
              search={graphSearch}
              zoom={zoom}
              supplementalEdges={supplementalEdges}
              onSelect={(id) => {
                setSelectedId(id);
                setInspectorTab("details");
              }}
            />
          )}
          </div>
        </section>

        <aside
          id="project-inspector"
          className={`inspector${inspectorOpen ? " is-open" : ""}`}
          role={inspectorModal ? "dialog" : undefined}
          aria-modal={inspectorModal || undefined}
          aria-label="상세 및 질문 패널"
          inert={explorerModal || undefined}
          onKeyDown={trapDrawerFocus}
        >
          <div className="inspector-mobile-heading">
            <span>Inspector</span>
            <button
              ref={inspectorClose}
              type="button"
              className="panel-close"
              aria-label="상세 패널 닫기"
              onClick={() => closeResponsivePanels()}
            >
              ×
            </button>
          </div>
          <div className="side-tabs" role="tablist" aria-label="노드 정보">
            {([
              ["details", "상세"],
              ["evidence", "근거"],
              ["impact", "영향"],
              ["ask", "질문"],
            ] as Array<[InspectorTab, string]>).map(([id, label]) => (
              <button
                ref={(element) => {
                  if (element) inspectorTabRefs.current.set(id, element);
                  else inspectorTabRefs.current.delete(id);
                }}
                type="button"
                id={`inspector-tab-${id}`}
                className="side-tab"
                role="tab"
                aria-controls="inspector-tabpanel"
                aria-selected={inspectorTab === id}
                tabIndex={inspectorTab === id ? 0 : -1}
                key={id}
                onClick={() => setInspectorTab(id)}
                onKeyDown={(event) => handleInspectorTabKeyDown(event, id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            id="inspector-tabpanel"
            className="inspector-body"
            role="tabpanel"
            aria-labelledby={`inspector-tab-${inspectorTab}`}
          >
            {inspectorTab === "ask" ? (
              <ChatPanel
                llmStatus={llmStatus}
                selectedNode={selectedNode}
                messages={messages}
                question={question}
                busy={answerBusy}
                disabled={scanState !== "ready"}
                suggestions={suggestedQuestions}
                onQuestionChange={setQuestion}
                onSubmit={handleQuestionSubmit}
                onKeyDown={handleQuestionKeyDown}
                onSuggestion={(value) => void submitQuestion(value)}
                onCitation={(citation) => {
                  if (citation.kind === "excerpt") {
                    const evidence = graph.evidence.find((item) => item.id === citation.sourceId);
                    if (evidence) {
                      revealSource(evidence.filePath, evidence.line, evidence.endLine, {
                        evidenceId: evidence.id,
                      });
                      setInspectorTab("evidence");
                      return;
                    }
                  }
                  const target = citationTarget(citation);
                  if (target) {
                    setSelectedId(target.id);
                    setInspectorTab("evidence");
                  }
                }}
              />
            ) : !selectedNode ? (
              <div className="inspector-empty">
                <div>
                  <strong>노드를 선택해 주세요</strong>
                  그래프 또는 탐색기에서 항목을 선택하면 관계 근거와 영향 범위를 볼 수 있습니다.
                </div>
              </div>
            ) : inspectorTab === "details" ? (
              <NodeDetails
                graph={graph}
                node={selectedNode}
                edges={selectedEdges}
                confidence={confidence}
                onSelect={setSelectedId}
                onOpenSource={(path, line) => revealSource(path, line, line)}
              />
            ) : inspectorTab === "evidence" ? (
              <EvidencePanel
                evidence={selectedEvidence}
                onOpen={(item) => revealSource(item.filePath, item.line, item.endLine, { evidenceId: item.id })}
              />
            ) : (
              <ImpactPanel impacts={impacts} onSelect={(id) => {
                setSelectedId(id);
                setInspectorTab("details");
              }} />
            )}
          </div>
        </aside>
      </section>

      <footer className="activity-bar" inert={responsiveModalOpen || undefined}>
        <span className="activity-item"><span className={`status-dot${scanState === "reading" || scanState === "analyzing" ? " is-busy" : scanState === "error" ? " is-offline" : ""}`} /><strong>{scanMessage}</strong></span>
        <span className="activity-item">경고 {graph.warnings.length}</span>
        <span className="activity-item">라우트 {graph.stats.routeCount} · 함수 {graph.stats.functionCount}</span>
        <span className="activity-spacer" />
        <span className="activity-item">LLM {llmStatus.loading ? "확인 중" : llmStatus.configured ? "연결됨" : "로컬 폴백"}</span>
      </footer>
    </main>
  );
}

function NodeDetails({
  graph,
  node,
  edges,
  confidence,
  onSelect,
  onOpenSource,
}: {
  graph: AnalysisGraph;
  node: GraphNode;
  edges: GraphEdge[];
  confidence: number;
  onSelect: (id: string) => void;
  onOpenSource: (path: string, line: number) => void;
}) {
  const kind = node.nodeType === "table" ? "Database table" : node.nodeType === "file" ? "Source file" : node.kind;
  const subtitle = node.nodeType === "file" ? node.path : node.nodeType === "symbol" ? `${node.filePath}:${node.line}` : node.schema ?? "default schema";
  return (
    <>
      <section className="detail-section">
        <p className="detail-kicker">{kind}</p>
        <h2 className="detail-title">{nodeShortLabel(node)}</h2>
        <p className="detail-subtitle">{subtitle}</p>
        {node.nodeType === "file" || node.nodeType === "symbol" ? (
          <div className="detail-actions">
            <button
              type="button"
              className="button button-small"
              onClick={() => onOpenSource(
                node.nodeType === "file" ? node.path : node.filePath,
                node.nodeType === "symbol" ? node.line : 1,
              )}
            >
              소스 코드 열기
            </button>
          </div>
        ) : null}
        <div className="confidence-row">
          <div className="confidence-track"><div className="confidence-fill" style={{ width: `${confidence}%` }} /></div>
          <span className="confidence-label">{confidence}%</span>
        </div>
        <dl className="detail-grid">
          <dt>직접 연결</dt><dd>{edges.length}</dd>
          <dt>근거</dt><dd>{node.evidenceIds.length}</dd>
          {node.nodeType === "table" ? <><dt>컬럼</dt><dd>{node.columns.length}</dd><dt>기본키</dt><dd>{node.primaryKey.join(", ") || "없음"}</dd></> : null}
          {node.nodeType === "file" ? <><dt>언어</dt><dd>{node.language}</dd><dt>심볼</dt><dd>{node.symbolIds.length}</dd></> : null}
          {node.nodeType === "symbol" && node.routePath ? <><dt>HTTP</dt><dd>{node.httpMethod ?? "-"}</dd><dt>경로</dt><dd>{node.routePath}</dd></> : null}
        </dl>
      </section>
      <section className="detail-section">
        <p className="detail-kicker">Direct connections</p>
        <div className="connection-list">
          {edges.length ? edges.slice(0, 16).map((edge) => {
            const otherId = edge.source === node.id ? edge.target : edge.source;
            const other = graph.nodes.find((item) => item.id === otherId);
            return (
              <button type="button" className="connection-row" key={edge.id} onClick={() => onSelect(otherId)}>
                <span className="connection-kind">{edgeLabel(edge)}</span>
                <span className="connection-name">{nodeLabel(other)}</span>
                <span className="connection-confidence">{confidencePercent(edge.confidence)}%</span>
              </button>
            );
          }) : <div className="inspector-empty"><div>직접 연결된 관계가 없습니다.</div></div>}
        </div>
      </section>
    </>
  );
}

function EvidencePanel({ evidence, onOpen }: { evidence: Evidence[]; onOpen: (item: Evidence) => void }) {
  return (
    <section className="detail-section">
      <p className="detail-kicker">Source evidence · {evidence.length}</p>
      {evidence.length ? (
        <div className="evidence-list">
          {evidence.map((item) => (
            <article className="evidence-card" key={item.id}>
              <div className="evidence-source">
                <span>{item.filePath}</span>
                <span className="evidence-location">{item.line === item.endLine ? `:${item.line}` : `:${item.line}–${item.endLine}`}</span>
              </div>
              <pre className="evidence-code"><code>{item.excerpt}</code></pre>
              <button type="button" className="button button-small evidence-open" onClick={() => onOpen(item)}>
                코드에서 열기
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="inspector-empty"><div><strong>직접 근거가 없습니다</strong>이 항목은 다른 관계에서 간접 추론되었을 수 있습니다.</div></div>
      )}
    </section>
  );
}

function ImpactPanel({ impacts, onSelect }: { impacts: ReturnType<typeof impactNodes>; onSelect: (id: string) => void }) {
  return (
    <section className="detail-section">
      <p className="detail-kicker">Change impact · 2 hops</p>
      {impacts.length ? (
        <div className="impact-list">
          {impacts.map((item) => (
            <button type="button" className="impact-row" key={item.node.id} onClick={() => onSelect(item.node.id)}>
              <span className="connection-kind">{item.via}</span>
              <span className="connection-name">{nodeLabel(item.node)}</span>
              <span className="connection-confidence">{item.depth}단계</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="inspector-empty"><div><strong>영향 경로가 없습니다</strong>현재 분석 근거에서 연결된 항목을 찾지 못했습니다.</div></div>
      )}
    </section>
  );
}

function ChatPanel({
  llmStatus,
  selectedNode,
  messages,
  question,
  busy,
  disabled,
  suggestions,
  onQuestionChange,
  onSubmit,
  onKeyDown,
  onSuggestion,
  onCitation,
}: {
  llmStatus: LlmStatus;
  selectedNode: GraphNode | undefined;
  messages: ChatMessage[];
  question: string;
  busy: boolean;
  disabled: boolean;
  suggestions: string[];
  onQuestionChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSuggestion: (value: string) => void;
  onCitation: (citation: AnswerCitation) => void;
}) {
  return (
    <div className="chat-panel">
      <div className="chat-context">
        <div className="chat-context-row">
          <span>{selectedNode ? `현재 선택 · ${nodeShortLabel(selectedNode)}` : "전체 프로젝트 범위"}</span>
          <span className="llm-state">
            <span className={`llm-state-dot${llmStatus.configured ? "" : " is-local"}`} />
            {llmStatus.loading ? "연결 확인 중" : llmStatus.configured ? "외부 LLM 연결됨" : "로컬 탐색"}
          </span>
        </div>
      </div>

      <div className="chat-messages" aria-live="polite">
        {messages.map((message) => (
          <article className={`message${message.role === "user" ? " is-user" : ""}`} key={message.id}>
            <span className="message-role">{message.role === "user" ? "You" : message.local ? "Schema Lens · local" : "Schema Lens · LLM"}</span>
            <div className="message-bubble">{message.content}</div>
            {message.citations?.length ? (
              <div className="citation-list">
                {message.citations.map((citation) => (
                  <button
                    type="button"
                    className="citation-chip"
                    key={`${message.id}-${citation.id}`}
                    onClick={() => onCitation(citation)}
                    title={citation.explanation}
                  >
                    {citation.kind === "excerpt" ? "근거" : "노드"} · {citation.sourceId.slice(0, 12)}
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {messages.length === 1 ? (
          <div className="suggestion-list">
            {suggestions.map((suggestion) => (
              <button
                type="button"
                className="suggestion-button"
                key={suggestion}
                disabled={disabled}
                onClick={() => onSuggestion(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
        {busy ? <article className="message"><span className="message-role">Schema Lens</span><div className="message-bubble">근거를 따라 답을 구성하는 중…</div></article> : null}
      </div>

      <form className="chat-composer" onSubmit={onSubmit}>
        <textarea
          className="question-box"
          value={question}
          disabled={disabled}
          onChange={(event) => onQuestionChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="이 프로젝트의 데이터 흐름에 질문하기…"
          aria-label="프로젝트에 질문"
        />
        <div className="composer-footer">
          <span className="composer-hint">⌘/Ctrl + Enter로 전송</span>
          <button type="submit" className="button button-primary" disabled={!question.trim() || busy || disabled}>질문 보내기</button>
        </div>
      </form>
    </div>
  );
}

function MappingReview({
  mapping,
  error,
  busy,
  decisions,
  onRun,
  onDecision,
}: {
  mapping: MappingResult | null;
  error: string | null;
  busy: boolean;
  decisions: Record<string, ReviewDecision>;
  onRun: () => void;
  onDecision: (id: string, state: ReviewDecision["state"]) => void;
}) {
  const items = mapping
    ? [
        ...mapping.additions.edges.map((item) => ({
          id: item.id,
          title: `${item.source} → ${item.target}`,
          description: item.description,
          confidence: item.confidence,
          meta: `${item.label} · 근거 ${item.evidenceIds.length}`,
        })),
        ...mapping.additions.nodes.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          confidence: item.confidence,
          meta: `${item.layer} · 연결 후보 ${item.mappedNodeIds.length}`,
        })),
        ...mapping.additions.aliases.map((item) => ({
          id: `alias-${item.term}-${item.nodeId}`,
          title: `${item.term} ≈ ${item.nodeId}`,
          description: item.description,
          confidence: item.confidence,
          meta: `동적 용어 매핑 · 근거 ${item.evidenceIds.length}`,
        })),
      ]
    : [];

  return (
    <div className="graph-stage">
      <div className="review-view">
        <div className="review-hero">
          <div>
            <h2>동적 매핑 검토</h2>
            <p>
              정적 분석이 놓치기 쉬운 도메인 별칭과 교차 계층 관계를 LLM이 제안합니다. 근거 없는 관계는 그래프에 자동 확정하지 않습니다.
            </p>
          </div>
          <button type="button" className="button button-primary" onClick={onRun} disabled={busy}>
            {busy ? "분석 중…" : mapping ? "다시 추론" : "LLM 매핑 실행"}
          </button>
        </div>

        {error ? (
          <div className="evidence-card">
            <div className="evidence-source"><span>LLM 연결 안내</span><span>정적 결과 유지</span></div>
            <p className="review-description">{error}</p>
            <p className="review-meta">LLM API를 서버 환경에 설정하면 같은 화면에서 정밀 매핑을 다시 실행할 수 있습니다.</p>
          </div>
        ) : null}

        {mapping ? (
          <>
            <div className="evidence-card" style={{ marginBottom: 12 }}>
              <div className="evidence-source"><span>매핑 요약</span><span>{items.length}개 제안</span></div>
              <p className="review-description">{mapping.summary}</p>
            </div>
            <div className="review-list">
              {items.map((item) => {
                const decision = decisions[item.id]?.state;
                return (
                  <article className="review-card" key={item.id}>
                    <span className={`review-status${decision === "confirmed" ? " badge-confirmed" : decision === "excluded" ? " badge-warning" : ""}`}>
                      {decision === "confirmed" ? "확정" : decision === "excluded" ? "제외" : "검토 필요"}
                    </span>
                    <div>
                      <div className="review-title">{item.title}</div>
                      <div className="review-description">{item.description}</div>
                      <div className="review-meta">{item.meta}</div>
                    </div>
                    <div>
                      <div className="review-confidence">{Math.round(item.confidence * 100)}%</div>
                      <div style={{ display: "flex", gap: 5, marginTop: 8 }}>
                        <button type="button" className="button button-small" onClick={() => onDecision(item.id, "confirmed")}>확정</button>
                        <button type="button" className="button button-small button-quiet" onClick={() => onDecision(item.id, "excluded")}>제외</button>
                      </div>
                    </div>
                  </article>
                );
              })}
              {mapping.diagnostics.map((diagnostic, index) => (
                <article className="review-card" key={`${diagnostic.code}-${index}`}>
                  <span className="review-status badge-warning">{diagnostic.severity}</span>
                  <div>
                    <div className="review-title">{diagnostic.code}</div>
                    <div className="review-description">{diagnostic.message}</div>
                    <div className="review-meta">{diagnostic.suggestion}</div>
                  </div>
                  <div className="review-confidence">근거 {diagnostic.evidenceIds.length}</div>
                </article>
              ))}
            </div>
          </>
        ) : !error ? (
          <div className="graph-empty">
            <div className="empty-copy">
              <h2>검토할 LLM 매핑이 없습니다</h2>
              <p>정적 분석 결과는 이미 사용할 수 있습니다. LLM 정밀 매핑을 실행하면 별칭, 도메인 객체, 불명확한 관계를 근거와 함께 제안합니다.</p>
              <button type="button" className="button button-primary" onClick={onRun}>정밀 매핑 시작</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
