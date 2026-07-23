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
import {
  type Locale,
  type Translate,
  useI18n,
} from "@/app/i18n";

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
  t: Translate,
  concurrency = ANALYSIS_READ_CONCURRENCY,
): Promise<SourceFileInput[]> {
  const results = new Array<SourceFileInput>(documents.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, documents.length)) },
    async () => {
      while (cursor < documents.length) {
        if (signal.aborted) {
          throw new DOMException(t("scan.projectCancelled"), "AbortError");
        }
        const index = cursor;
        cursor += 1;
        const document = documents[index];
        results[index] = {
          path: document.path,
          content:
            document.inlineContent ??
            (document.file ? await readBrowserFileText(document.file, signal, t) : ""),
          language: document.language || undefined,
        };
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function readBrowserFileText(
  file: File,
  signal: AbortSignal,
  t: Translate,
): Promise<string> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException(t("scan.readCancelled"), "AbortError");
      }
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

function nodeLabel(node: GraphNode | undefined, t?: Translate): string {
  if (!node) return t ? t("common.unknownNode") : "Unknown node";
  if (node.nodeType === "table") return node.qualifiedName;
  if (node.nodeType === "file") return node.path;
  return node.routePath ? `${node.httpMethod ?? "ROUTE"} ${node.routePath}` : node.name;
}

function nodeShortLabel(node: GraphNode | undefined, t?: Translate): string {
  if (!node) return t ? t("common.unknown") : "Unknown";
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

function localGraphAnswer(
  graph: AnalysisGraph,
  question: string,
  t: Translate,
): AnswerResult {
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
        explanation: t("chat.localCitation", {
          path: item.filePath,
          line: item.line,
        }),
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
      const answer = t("chat.noIdentifier", {
        table: top.table.qualifiedName,
        count: top.count,
      });
      return {
        status: "answered",
        answer,
        claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
        citations,
        referencedNodeIds,
        limitations: [t("chat.localLimitation")],
        suggestedQuestions: [
          t("chat.quickReadersWriters", { name: top.table.name }),
        ],
      };
    }
    return {
      status: "insufficient_evidence",
      answer: t("chat.noGraphMatch"),
      claims: [],
      citations: [],
      referencedNodeIds: [],
      limitations: [t("chat.noGraphMatchHelp")],
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
      t("chat.tableSummary", {
        name: primary.qualifiedName,
        columns: primary.columns.length,
        primaryKeys: primary.primaryKey.length || 0,
      }),
      readers.length
        ? t("chat.readers", { items: readers.map((node) => nodeLabel(node, t)).join(", ") })
        : t("chat.noReaders"),
      writers.length
        ? t("chat.writers", { items: writers.map((node) => nodeLabel(node, t)).join(", ") })
        : t("chat.noWriters"),
      relations.length
        ? t("chat.relatedTables", {
            items: relations.map((node) => nodeShortLabel(node, t)).join(", "),
          })
        : t("chat.noRelatedTables"),
    ];
    const answer = lines.join("\n");
    return {
      status: "answered",
      answer,
      claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
      citations,
      referencedNodeIds,
      limitations: [t("chat.staticOnly")],
      suggestedQuestions: [
        t("chat.quickSourceImpact", { name: primary.name }),
        t("chat.quickSourceWrites", { name: primary.name }),
      ],
    };
  }

  if (primary.nodeType === "file") {
    const operations = relatedEdges
      .filter((edge) => edge.kind === "read" || edge.kind === "write")
      .map((edge) => {
        const other = graph.nodes.find((node) => node.id === (edge.source === primary.id ? edge.target : edge.source));
        return `${edgeLabel(edge)} ${nodeShortLabel(other, t)}`;
      });
    const answer = t("chat.fileSummary", {
      path: primary.path,
      operations: operations.length ? operations.join(", ") : t("chat.noOperations"),
      symbols: primary.symbolIds.length,
    });
    return {
      status: "answered",
      answer,
      claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
      citations,
      referencedNodeIds,
      limitations: [t("chat.dynamicLimitation")],
      suggestedQuestions: [
        t("chat.quickReferencedTables", { name: primary.name }),
      ],
    };
  }

  const owner = graph.files.find((file) => file.id === primary.fileId);
  const answer = t("chat.symbolSummary", {
    name: primary.name,
    path: owner?.path ?? primary.filePath,
    line: primary.line,
    route: primary.routePath
      ? t("chat.routeSummary", {
          method: primary.httpMethod ?? "HTTP",
          path: primary.routePath,
        })
      : "",
  });
  return {
    status: "answered",
    answer,
    claims: [{ text: answer, citationIds: citations.map((citation) => citation.id) }],
    citations,
    referencedNodeIds,
    limitations: [t("chat.callGraphLimitation")],
    suggestedQuestions: owner
      ? [t("chat.quickDataAccess", { name: owner.name })]
      : [],
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

function llmErrorMessage(
  code: LlmErrorBody["error"]["code"],
  t: Translate,
): string {
  const messageByCode: Record<LlmErrorBody["error"]["code"], Parameters<Translate>[0]> = {
    INVALID_REQUEST: "llm.invalidRequest",
    REQUEST_TOO_LARGE: "llm.requestTooLarge",
    LLM_NOT_CONFIGURED: "llm.notConfigured",
    LLM_REFUSAL: "llm.refusal",
    LLM_INCOMPLETE: "llm.incomplete",
    LLM_INVALID_OUTPUT: "llm.invalidOutput",
    LLM_RATE_LIMITED: "llm.rateLimited",
    LLM_TIMEOUT: "llm.timeout",
    LLM_PROVIDER_ERROR: "llm.providerError",
  };
  return t(messageByCode[code]);
}

function starterMessage(graph: AnalysisGraph, t: Translate): ChatMessage {
  return {
    id: "assistant-intro",
    role: "assistant",
    content: t("chat.starter", {
      tables: graph.stats.tableCount,
      files: graph.stats.fileCount,
      relationships: graph.stats.relationshipCount,
    }),
    local: true,
  };
}

export function SchemaLensWorkspace() {
  const { locale, setLocale, t } = useI18n();
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
  const [projectPath, setProjectPath] = useState(() => t("scan.demoPath"));
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("database");
  const [explorerMode, setExplorerMode] = useState<ExplorerMode>("database");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("details");
  const [selectedId, setSelectedId] = useState<string | null>(initialGraph.tables[0]?.id ?? null);
  const [explorerSearch, setExplorerSearch] = useState("");
  const [graphSearch, setGraphSearch] = useState("");
  const [zoom, setZoom] = useState(0.9);
  const [scanState, setScanState] = useState<ScanState>("ready");
  const [scanMessage, setScanMessage] = useState(() => t("scan.demoComplete"));
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({
    configured: false,
    loading: true,
  });
  const [mapping, setMapping] = useState<MappingResult | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, ReviewDecision>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([
    starterMessage(initialGraph, t),
  ]);
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
      setScanMessage(t("scan.sourceUnavailable", { path }));
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
        setSourceError(t("source.unsupported"));
        setSourceLoading(false);
        return;
      }

      setSourceLoading(true);
      setSourceContentPath(null);
      setSourceError(null);
      const load = activeSourceDocument.inlineContent !== undefined
        ? Promise.resolve(activeSourceDocument.inlineContent)
        : activeSourceDocument.file
          ? readBrowserFileText(activeSourceDocument.file, controller.signal, t)
          : undefined;
      if (!load) {
        setSourceLoading(false);
        setSourceError(t("source.reopenFolder"));
        return;
      }

      try {
        const content = await load;
        if (cancelled || requestId !== sourceLoadRequest.current) return;
        if (content.includes("\u0000")) {
          throw new Error(t("source.binary"));
        }
        rememberSourceContent(sourceContentCache.current, activeSourceDocument.path, content);
        setSourceContent(content);
        setSourceContentPath(activeSourceDocument.path);
        setSourceLoading(false);
      } catch (error) {
        if (cancelled || requestId !== sourceLoadRequest.current) return;
        setSourceContent("");
        setSourceContentPath(null);
        setSourceError(
          error instanceof Error ? error.message : t("source.readFailed"),
        );
        setSourceLoading(false);
      }
    }

    void loadActiveSource();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeSourceDocument, sourceLocation?.requestId, t]);

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

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const demoLoaded =
        projectName === "workspace-api" &&
        sourceDocuments.every((document) => document.inlineContent !== undefined);
      if (demoLoaded) {
        setProjectPath(t("scan.demoPath"));
        if (scanState === "ready") setScanMessage(t("scan.demoComplete"));
      }
      setMessages((current) =>
        current.length === 1 && current[0]?.id === "assistant-intro"
          ? [starterMessage(graph, t)]
          : current,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [graph, locale, projectName, scanState, sourceDocuments, t]);

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
    return items.filter((node) => nodeLabel(node, t).toLocaleLowerCase().includes(term));
  }, [explorerMode, explorerSearch, graph.files, graph.tables, t]);

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
        label:
          item.description ||
          `${item.kind} · ${t("common.evidence")}`,
        kind: item.kind,
      })),
    [graph.evidence, t],
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
      mostConnectedTable
        ? t("chat.quickTableImpact", { name: mostConnectedTable.name })
        : t("chat.quickMostConnected"),
      writer && writtenTable
        ? t("chat.quickWriterFlow", {
            writer: nodeShortLabel(writer, t),
            table: nodeShortLabel(writtenTable, t),
          })
        : t("chat.quickWriteQuery"),
      t("chat.quickFkJoin"),
    ];
  }, [graph, t]);

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
    setScanMessage(t("scan.classifying", { count: chosenCount }));

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
        throw new Error(t("scan.noFiles"));
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
      const inputs = await readSourceFiles(analysisDocuments, controller.signal, t);
      if (generation !== workspaceGeneration.current || controller.signal.aborted) return;
      setScanState("analyzing");
      setScanMessage(
        t("scan.analyzing", {
          count: inputs.length,
          size: (analysisBytes / 1024 / 1024).toFixed(1),
        }),
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
      const analysisOmitted = omittedAnalysisCount
        ? t("scan.analysisOmitted", { count: omittedAnalysisCount })
        : "";
      const indexOmitted = omittedTreeCount
        ? t("scan.indexOmitted", { count: omittedTreeCount })
        : "";
      setProjectPath(
        t("scan.inventory", {
          files: nextDocuments.length,
          analyzed: inputs.length,
          analysisOmitted,
          indexOmitted,
        }),
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
      setMessages([starterMessage(nextGraph, t)]);
      setScanState("ready");
      setScanMessage(
        t("scan.complete", {
          analyzed: inputs.length,
          files: nextDocuments.length,
          indexOmitted,
          tables: nextGraph.stats.tableCount,
          relationships: nextGraph.stats.relationshipCount,
        }),
      );
    } catch (error) {
      if (generation !== workspaceGeneration.current || controller.signal.aborted) return;
      setScanState("error");
      setScanMessage(
        error instanceof Error
          ? t("scan.failedDetail", { detail: error.message })
          : t("scan.failed"),
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
    setProjectPath(t("scan.demoPath"));
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
    setMessages([starterMessage(nextGraph, t)]);
    setScanState("ready");
    setScanMessage(t("scan.demoComplete"));
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
    const focus = selectedNode ? nodeLabel(selectedNode, t) : "";
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
      if (!payload.ok) {
        throw new Error(llmErrorMessage(payload.error.code, t));
      }
      setMapping(payload.data);
      setLlmStatus({ configured: true, loading: false });
      setActiveTab("review");
      setScanMessage(
        t("mapping.complete", {
          count:
            payload.data.additions.edges.length +
            payload.data.additions.nodes.length +
            payload.data.diagnostics.length,
        }),
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
          : t("mapping.failed"),
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
        const fallback = localGraphAnswer(graphSnapshot, nextQuestion, t);
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
          content: [
            payload.data.answer,
            ...payload.data.limitations.map((item) =>
              t("mapping.limitPrefix", { text: item }),
            ),
          ].join("\n\n"),
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
      const fallback = localGraphAnswer(graphSnapshot, nextQuestion, t);
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
          aria-label={t("workspace.chooseFolder")}
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
          {t("workspace.explorer")}
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
          {t("workspace.inspector")}
        </button>
        <div className="header-spacer" />
        <div className="header-summary">
          <span className="analysis-state">
            <span className={`status-dot${scanState === "reading" || scanState === "analyzing" ? " is-busy" : scanState === "error" ? " is-offline" : ""}`} />
            {scanState === "ready"
              ? t("workspace.analysisCurrent")
              : scanState === "error"
                ? t("workspace.partialResults")
                : t("workspace.analyzing")}
          </span>
          <span className="header-metrics">
            TABLE {graph.stats.tableCount} · QUERY {graph.stats.readCount + graph.stats.writeCount} · EDGE {graph.stats.relationshipCount}
          </span>
        </div>
        <label className="language-select">
          <span>{t("language.label")}</span>
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            <option value="en">{t("language.en")}</option>
            <option value="ko">{t("language.ko")}</option>
          </select>
        </label>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => void runSemanticMapping()}
          disabled={mappingBusy || scanState !== "ready"}
          title={
            llmStatus.configured
              ? t("workspace.llmMappingTitle")
              : t("workspace.llmMappingDisabled")
          }
        >
          {mappingBusy
            ? t("workspace.mappingBusy")
            : t("workspace.mappingAction")}
        </button>
        <button type="button" className="button button-primary" onClick={() => folderInput.current?.click()}>
          {t("workspace.openFolder")}
        </button>
      </header>

      <section className="app-shell">
        <button
          type="button"
          className={`drawer-scrim${explorerOpen ? " has-explorer" : ""}${inspectorOpen ? " has-inspector" : ""}`}
          aria-label={t("workspace.closePanel")}
          onClick={() => closeResponsivePanels()}
        />
        <aside
          id="project-explorer"
          className={`explorer${explorerOpen ? " is-open" : ""}`}
          role={explorerModal ? "dialog" : undefined}
          aria-modal={explorerModal || undefined}
          aria-label={t("workspace.explorerLabel")}
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
              aria-label={t("workspace.closeExplorer")}
              onClick={() => closeResponsivePanels()}
            >
              ×
            </button>
          </div>
          <input
            className="explorer-search"
            value={explorerSearch}
            onChange={(event) => setExplorerSearch(event.target.value)}
            placeholder={
              explorerMode === "source"
                ? t("workspace.searchFiles")
                : t("workspace.searchData")
            }
            aria-label={t("workspace.searchObjects")}
          />
          <div className="segment-control" aria-label={t("workspace.explorerView")}>
            <button
              type="button"
              className="segment-button"
              aria-pressed={explorerMode === "database"}
              onClick={() => setExplorerMode("database")}
            >
              {t("workspace.data")}
            </button>
            <button
              type="button"
              className="segment-button"
              aria-pressed={explorerMode === "source"}
              onClick={() => setExplorerMode("source")}
            >
              {t("workspace.source")}
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
                  <div className="tree-group-header">
                    {t("workspace.databaseObjects")}
                  </div>
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
                        <span className="tree-item-name">{nodeShortLabel(node, t)}</span>
                        <span className="tree-item-meta">{connectionCountByNode.get(node.id) ?? 0}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {graph.symbols.some((symbol) => symbol.kind === "route") ? (
                  <div className="tree-group">
                    <div className="tree-group-header">
                      {t("workspace.detectedEndpoints")}
                    </div>
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
            <strong>{t("workspace.localFirst")}</strong>{" "}
            {t("workspace.localFirstDetail")}
          </div>
        </aside>

        <section
          className={`workbench${activeTab === "code" ? " is-code-view" : ""}`}
          aria-label={t("workspace.mainArea")}
          inert={responsiveModalOpen || undefined}
        >
          <div className="work-tabs" role="tablist" aria-label={t("workspace.viewTabs")}>
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
              {t("workspace.databaseErd")}{" "}
              <span className="tab-count">{graph.tables.length}</span>
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
              {t("workspace.sourceGraph")}{" "}
              <span className="tab-count">{graph.files.length}</span>
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
              {t("workspace.sourceCode")}{" "}
              <span className="tab-count">{openSourcePaths.length}</span>
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
              {t("workspace.mappingReview")}{" "}
              <span className="tab-count">{reviewCount}</span>
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
                      placeholder={t("workspace.graphSearch")}
                      aria-label={t("workspace.graphSearch")}
                    />
                  </div>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setGraphSearch("")}
                  >
                    {t("workspace.clearFilter")}
                  </button>
                  <div className="toolbar-divider" />
                  <button
                    type="button"
                    className="button button-small button-square"
                    aria-label={t("workspace.zoomOut")}
                    onClick={() => setZoom((current) => Math.max(0.55, Number((current - 0.1).toFixed(2))))}
                  >
                    −
                  </button>
                  <span className="zoom-value">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    className="button button-small button-square"
                    aria-label={t("workspace.zoomIn")}
                    onClick={() => setZoom((current) => Math.min(1.3, Number((current + 0.1).toFixed(2))))}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => setZoom(0.9)}
                  >
                    {t("workspace.fit")}
                  </button>
                  <div className="toolbar-divider" />
                </>
              ) : (
                <span className="toolbar-context">
                  {t("workspace.reviewContext")}
                </span>
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
                {t("workspace.exportJson")}
              </button>
              <button
                type="button"
                className="button button-small"
                onClick={loadDemo}
              >
                {t("workspace.restoreSample")}
              </button>
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
          aria-label={t("workspace.inspectorLabel")}
          inert={explorerModal || undefined}
          onKeyDown={trapDrawerFocus}
        >
          <div className="inspector-mobile-heading">
            <span>Inspector</span>
            <button
              ref={inspectorClose}
              type="button"
              className="panel-close"
              aria-label={t("workspace.closeInspector")}
              onClick={() => closeResponsivePanels()}
            >
              ×
            </button>
          </div>
          <div className="side-tabs" role="tablist" aria-label={t("workspace.nodeInfo")}>
            {([
              ["details", t("workspace.details")],
              ["evidence", t("workspace.evidence")],
              ["impact", t("workspace.impact")],
              ["ask", t("workspace.ask")],
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
                  <strong>{t("workspace.selectNodeTitle")}</strong>
                  {t("workspace.selectNodeDescription")}
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
        <span className="activity-item">
          {t("workspace.warnings", { count: graph.warnings.length })}
        </span>
        <span className="activity-item">
          {t("workspace.routesAndFunctions", {
            routes: graph.stats.routeCount,
            functions: graph.stats.functionCount,
          })}
        </span>
        <span className="activity-spacer" />
        <span className="activity-item">
          LLM{" "}
          {llmStatus.loading
            ? t("workspace.llmChecking")
            : llmStatus.configured
              ? t("workspace.llmConnected")
              : t("workspace.localFallback")}
        </span>
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
  const { t } = useI18n();
  const kind =
    node.nodeType === "table"
      ? t("details.databaseTable")
      : node.nodeType === "file"
        ? t("details.sourceFile")
        : node.kind;
  const subtitle =
    node.nodeType === "file"
      ? node.path
      : node.nodeType === "symbol"
        ? `${node.filePath}:${node.line}`
        : node.schema ?? t("details.defaultSchema");
  return (
    <>
      <section className="detail-section">
        <p className="detail-kicker">{kind}</p>
        <h2 className="detail-title">{nodeShortLabel(node, t)}</h2>
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
              {t("details.openSource")}
            </button>
          </div>
        ) : null}
        <div className="confidence-row">
          <div className="confidence-track"><div className="confidence-fill" style={{ width: `${confidence}%` }} /></div>
          <span className="confidence-label">{confidence}%</span>
        </div>
        <dl className="detail-grid">
          <dt>{t("details.directLinks")}</dt><dd>{edges.length}</dd>
          <dt>{t("common.evidence")}</dt><dd>{node.evidenceIds.length}</dd>
          {node.nodeType === "table" ? <><dt>{t("details.columns")}</dt><dd>{node.columns.length}</dd><dt>{t("details.primaryKey")}</dt><dd>{node.primaryKey.join(", ") || t("common.none")}</dd></> : null}
          {node.nodeType === "file" ? <><dt>{t("details.language")}</dt><dd>{node.language}</dd><dt>{t("details.symbols")}</dt><dd>{node.symbolIds.length}</dd></> : null}
          {node.nodeType === "symbol" && node.routePath ? <><dt>HTTP</dt><dd>{node.httpMethod ?? "-"}</dd><dt>{t("details.path")}</dt><dd>{node.routePath}</dd></> : null}
        </dl>
      </section>
      <section className="detail-section">
        <p className="detail-kicker">{t("details.directConnections")}</p>
        <div className="connection-list">
          {edges.length ? edges.slice(0, 16).map((edge) => {
            const otherId = edge.source === node.id ? edge.target : edge.source;
            const other = graph.nodes.find((item) => item.id === otherId);
            return (
              <button type="button" className="connection-row" key={edge.id} onClick={() => onSelect(otherId)}>
                <span className="connection-kind">{edgeLabel(edge)}</span>
                <span className="connection-name">{nodeLabel(other, t)}</span>
                <span className="connection-confidence">{confidencePercent(edge.confidence)}%</span>
              </button>
            );
          }) : <div className="inspector-empty"><div>{t("details.noDirect")}</div></div>}
        </div>
      </section>
    </>
  );
}

function EvidencePanel({ evidence, onOpen }: { evidence: Evidence[]; onOpen: (item: Evidence) => void }) {
  const { t } = useI18n();
  return (
    <section className="detail-section">
      <p className="detail-kicker">{t("details.sourceEvidence")} · {evidence.length}</p>
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
                {t("details.openInCode")}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="inspector-empty"><div><strong>{t("evidence.noneTitle")}</strong>{t("evidence.noneDescription")}</div></div>
      )}
    </section>
  );
}

function ImpactPanel({ impacts, onSelect }: { impacts: ReturnType<typeof impactNodes>; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <section className="detail-section">
      <p className="detail-kicker">{t("details.changeImpact")}</p>
      {impacts.length ? (
        <div className="impact-list">
          {impacts.map((item) => (
            <button type="button" className="impact-row" key={item.node.id} onClick={() => onSelect(item.node.id)}>
              <span className="connection-kind">{item.via}</span>
              <span className="connection-name">{nodeLabel(item.node, t)}</span>
              <span className="connection-confidence">{t("impact.steps", { count: item.depth })}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="inspector-empty"><div><strong>{t("impact.noneTitle")}</strong>{t("impact.noneDescription")}</div></div>
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
  const { t } = useI18n();
  return (
    <div className="chat-panel">
      <div className="chat-context">
        <div className="chat-context-row">
          <span>
            {selectedNode
              ? t("chat.currentSelection", {
                  name: nodeShortLabel(selectedNode, t),
                })
              : t("chat.projectScope")}
          </span>
          <span className="llm-state">
            <span className={`llm-state-dot${llmStatus.configured ? "" : " is-local"}`} />
            {llmStatus.loading
              ? t("chat.connectionChecking")
              : llmStatus.configured
                ? t("chat.externalConnected")
                : t("chat.localSearch")}
          </span>
        </div>
      </div>

      <div className="chat-messages" aria-live="polite">
        {messages.map((message) => (
          <article className={`message${message.role === "user" ? " is-user" : ""}`} key={message.id}>
            <span className="message-role">
              {message.role === "user"
                ? t("chat.you")
                : message.local
                  ? t("chat.localRole")
                  : t("chat.llmRole")}
            </span>
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
                    {citation.kind === "excerpt"
                      ? t("chat.citationEvidence")
                      : t("chat.citationNode")}{" "}
                    · {citation.sourceId.slice(0, 12)}
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
        {busy ? (
          <article className="message">
            <span className="message-role">Schema Lens</span>
            <div className="message-bubble">{t("chat.answering")}</div>
          </article>
        ) : null}
      </div>

      <form className="chat-composer" onSubmit={onSubmit}>
        <textarea
          className="question-box"
          value={question}
          disabled={disabled}
          onChange={(event) => onQuestionChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("chat.placeholder")}
          aria-label={t("chat.label")}
        />
        <div className="composer-footer">
          <span className="composer-hint">{t("chat.submitHint")}</span>
          <button
            type="submit"
            className="button button-primary"
            disabled={!question.trim() || busy || disabled}
          >
            {t("chat.submit")}
          </button>
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
  const { t } = useI18n();
  const items = mapping
    ? [
        ...mapping.additions.edges.map((item) => ({
          id: item.id,
          title: `${item.source} → ${item.target}`,
          description: item.description,
          confidence: item.confidence,
          meta: t("review.nodeMeta", {
            label: item.label,
            count: item.evidenceIds.length,
          }),
        })),
        ...mapping.additions.nodes.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          confidence: item.confidence,
          meta: t("review.diagnosticMeta", {
            layer: item.layer,
            count: item.mappedNodeIds.length,
          }),
        })),
        ...mapping.additions.aliases.map((item) => ({
          id: `alias-${item.term}-${item.nodeId}`,
          title: `${item.term} ≈ ${item.nodeId}`,
          description: item.description,
          confidence: item.confidence,
          meta: t("review.aliasMeta", {
            count: item.evidenceIds.length,
          }),
        })),
      ]
    : [];

  return (
    <div className="graph-stage">
      <div className="review-view">
        <div className="review-hero">
          <div>
            <h2>{t("review.title")}</h2>
            <p>{t("review.description")}</p>
          </div>
          <button type="button" className="button button-primary" onClick={onRun} disabled={busy}>
            {busy
              ? t("review.analyzing")
              : mapping
                ? t("review.runAgain")
                : t("review.run")}
          </button>
        </div>

        {error ? (
          <div className="evidence-card">
            <div className="evidence-source">
              <span>{t("review.connectionGuide")}</span>
              <span>{t("review.staticKept")}</span>
            </div>
            <p className="review-description">{error}</p>
            <p className="review-meta">{t("review.connectionDescription")}</p>
          </div>
        ) : null}

        {mapping ? (
          <>
            <div className="evidence-card" style={{ marginBottom: 12 }}>
              <div className="evidence-source">
                <span>{t("review.summary")}</span>
                <span>{t("review.suggestionCount", { count: items.length })}</span>
              </div>
              <p className="review-description">{mapping.summary}</p>
            </div>
            <div className="review-list">
              {items.map((item) => {
                const decision = decisions[item.id]?.state;
                return (
                  <article className="review-card" key={item.id}>
                    <span className={`review-status${decision === "confirmed" ? " badge-confirmed" : decision === "excluded" ? " badge-warning" : ""}`}>
                      {decision === "confirmed"
                        ? t("review.confirmed")
                        : decision === "excluded"
                          ? t("review.excluded")
                          : t("review.needsReview")}
                    </span>
                    <div>
                      <div className="review-title">{item.title}</div>
                      <div className="review-description">{item.description}</div>
                      <div className="review-meta">{item.meta}</div>
                    </div>
                    <div>
                      <div className="review-confidence">{Math.round(item.confidence * 100)}%</div>
                      <div style={{ display: "flex", gap: 5, marginTop: 8 }}>
                        <button type="button" className="button button-small" onClick={() => onDecision(item.id, "confirmed")}>{t("review.confirm")}</button>
                        <button type="button" className="button button-small button-quiet" onClick={() => onDecision(item.id, "excluded")}>{t("review.exclude")}</button>
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
                  <div className="review-confidence">
                    {t("review.evidenceCount", {
                      count: diagnostic.evidenceIds.length,
                    })}
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : !error ? (
          <div className="graph-empty">
            <div className="empty-copy">
              <h2>{t("review.emptyTitle")}</h2>
              <p>{t("review.emptyDescription")}</p>
              <button type="button" className="button button-primary" onClick={onRun}>
                {t("review.start")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
