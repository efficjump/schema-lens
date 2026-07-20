/**
 * Dependency-free, browser-safe source and SQL analyzer.
 *
 * The parser is intentionally heuristic: every inferred item carries confidence
 * and source evidence so consumers can distinguish schema facts from query
 * observations. It never relies on project-specific table mappings.
 */

export type Confidence = "high" | "medium" | "low";

export type EvidenceKind =
  | "ddl"
  | "query"
  | "import"
  | "function"
  | "route"
  | "inference";

export interface SourceFileInput {
  path: string;
  content: string;
  language?: string;
}

export interface AnalyzerOptions {
  /** Skip files larger than this number of characters. Defaults to 2 MiB. */
  maxFileSize?: number;
  /** Infer columns mentioned by queries when no DDL exists. Defaults to true. */
  inferColumns?: boolean;
  /** Resolve source imports to the supplied file list. Defaults to true. */
  resolveImports?: boolean;
  /** Optional extension allow-list. Paths outside it still become file nodes. */
  analyzeExtensions?: string[];
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  filePath: string;
  line: number;
  endLine: number;
  excerpt: string;
  /** Compatibility aliases used by provider-agnostic LLM grounding APIs. */
  content: string;
  path: string;
  language?: string;
  startLine: number;
  description?: string;
}

export interface ColumnReference {
  table: string;
  column: string;
  tableId: string;
  columnId: string;
}

export interface DatabaseColumn {
  id: string;
  name: string;
  dataType?: string;
  nullable?: boolean;
  primaryKey: boolean;
  unique: boolean;
  defaultValue?: string;
  references: ColumnReference[];
  confidence: Confidence;
  evidenceIds: string[];
}

export interface DatabaseTable {
  id: string;
  nodeType: "table";
  schema?: string;
  name: string;
  qualifiedName: string;
  columns: DatabaseColumn[];
  primaryKey: string[];
  confidence: Confidence;
  evidenceIds: string[];
}

export type SourceLanguage =
  | "sql"
  | "typescript"
  | "javascript"
  | "python"
  | "java"
  | "kotlin"
  | "go"
  | "ruby"
  | "php"
  | "csharp"
  | "scala"
  | "rust"
  | "markup"
  | "unknown";

export interface SourceFileNode {
  id: string;
  nodeType: "file";
  path: string;
  name: string;
  extension: string;
  language: SourceLanguage | string;
  size: number;
  symbolIds: string[];
  confidence: Confidence;
  evidenceIds: string[];
}

export type SourceSymbolKind = "function" | "method" | "route";

export interface SourceSymbolNode {
  id: string;
  nodeType: "symbol";
  kind: SourceSymbolKind;
  name: string;
  fileId: string;
  filePath: string;
  line: number;
  signature?: string;
  httpMethod?: string;
  routePath?: string;
  handlerSymbolId?: string;
  confidence: Confidence;
  evidenceIds: string[];
}

export type GraphNode = DatabaseTable | SourceFileNode | SourceSymbolNode;

export type GraphEdgeKind =
  | "foreign-key"
  | "query-relation"
  | "read"
  | "write"
  | "import"
  | "contains";

export interface GraphEdge {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  label: string;
  confidence: Confidence;
  evidenceIds: string[];
  sourceColumn?: string;
  targetColumn?: string;
  operation?: "READ" | "WRITE" | "IMPORT" | "CONTAINS" | "RELATION";
  queryType?: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface AnalysisWarning {
  filePath: string;
  line?: number;
  code: "file-too-large" | "dynamic-identifier" | "partial-parse";
  message: string;
}

export interface AnalysisStats {
  fileCount: number;
  analyzedFileCount: number;
  tableCount: number;
  columnCount: number;
  relationshipCount: number;
  readCount: number;
  writeCount: number;
  importCount: number;
  functionCount: number;
  routeCount: number;
}

export interface AnalysisGraph {
  version: 1;
  tables: DatabaseTable[];
  files: SourceFileNode[];
  symbols: SourceSymbolNode[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: Evidence[];
  warnings: AnalysisWarning[];
  stats: AnalysisStats;
}

export interface GraphSearchHit {
  node: GraphNode;
  score: number;
  matchedTerms: string[];
}

interface MutableTable extends DatabaseTable {
  _key: string;
}

interface SqlSlice {
  sql: string;
  start: number;
  end: number;
  type: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
}

interface IdentifierParts {
  schema?: string;
  name: string;
  qualifiedName: string;
  key: string;
}

interface TableMention {
  identifier: IdentifierParts;
  alias?: string;
  clause: "FROM" | "JOIN" | "USING" | "INTO" | "UPDATE";
  index: number;
}

const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024;
const IDENTIFIER_PART = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_$][\w$-]*)`;
const QUALIFIED_IDENTIFIER = `${IDENTIFIER_PART}(?:\\s*\\.\\s*${IDENTIFIER_PART}){0,2}`;
const SQL_START = new RegExp(
  `\\b(WITH(?=\\s+(?:RECURSIVE\\s+)?${IDENTIFIER_PART}(?:\\s*\\([^)]*\\))?\\s+AS\\s*\\()|SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\b`,
  "gi",
);

const SQL_KEYWORDS = new Set(
  (
    "as on where join left right full inner outer cross natural group order having limit offset " +
    "union except intersect returning set values into from using when then else end and or not " +
    "select insert update delete create alter table primary foreign references constraint default " +
    "null unique cascade restrict true false asc desc fetch for with recursive lateral"
  ).split(/\s+/),
);

const LANGUAGE_BY_EXTENSION: Record<string, SourceLanguage> = {
  sql: "sql",
  ddl: "sql",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  go: "go",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  scala: "scala",
  rs: "rust",
  xml: "markup",
  yml: "markup",
  yaml: "markup",
};

const ANALYZABLE_EXTENSIONS = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

function normalizePath(path: string): string {
  const slashPath = path.replace(/\\/g, "/");
  const prefix = slashPath.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!prefix) parts.push(part);
    } else {
      parts.push(part);
    }
  }
  return prefix + parts.join("/");
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? (normalized.startsWith("/") ? "/" : "") : normalized.slice(0, index);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const file = basename(path);
  const index = file.lastIndexOf(".");
  return index < 0 ? "" : file.slice(index + 1).toLowerCase();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cleanIdentifierPart(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`");
  }
  return trimmed;
}

function splitIdentifier(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      current += char;
      if ((quote === "[" && char === "]") || (quote !== "[" && char === quote)) quote = "";
    } else if (char === '"' || char === "`" || char === "[") {
      quote = char;
      current += char;
    } else if (char === ".") {
      if (current.trim()) parts.push(cleanIdentifierPart(current));
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(cleanIdentifierPart(current));
  return parts;
}

function parseIdentifier(raw: string): IdentifierParts | undefined {
  if (!raw || /\$\{|[:?]/.test(raw)) return undefined;
  const parts = splitIdentifier(raw).filter(Boolean);
  if (!parts.length) return undefined;
  const name = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts.slice(0, -1).join(".") : undefined;
  const qualifiedName = schema ? `${schema}.${name}` : name;
  return { schema, name, qualifiedName, key: qualifiedName.toLocaleLowerCase() };
}

function lineAt(content: string, index: number): number {
  let line = 1;
  const limit = Math.min(content.length, Math.max(0, index));
  for (let cursor = 0; cursor < limit; cursor += 1) {
    const code = content.charCodeAt(cursor);
    if (code === 13) {
      line += 1;
      if (content.charCodeAt(cursor + 1) === 10) cursor += 1;
    } else if (code === 10) {
      line += 1;
    }
  }
  return line;
}

function compactExcerpt(value: string, max = 360): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function confidenceRank(value: Confidence): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function strongerConfidence(a: Confidence, b: Confidence): Confidence {
  return confidenceRank(a) >= confidenceRank(b) ? a : b;
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item);
}

function splitTopLevel(value: string, delimiter = ","): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote && quote !== "`") index += 1;
        else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === delimiter && depth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

function findMatchingParen(content: string, openIndex: number): number {
  let depth = 0;
  let quote = "";
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote) {
        if (content[index + 1] === quote && quote !== "`") index += 1;
        else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findStatementEnd(content: string, start: number): number {
  let preceding = start - 1;
  while (preceding >= 0 && /\s/.test(content[preceding])) preceding -= 1;
  // Embedded SQL commonly starts immediately after a source-language string
  // delimiter. Seeding that delimiter prevents one query literal from
  // accidentally swallowing the next query in the same source file.
  let quote = preceding >= 0 && /['"`]/.test(content[preceding]) ? content[preceding] : "";
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === quote && content[index - 1] !== "\\") {
        if (content[index + 1] === quote && quote !== "`") index += 1;
        else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) return index + 1;
    if (index - start > 20_000) return index;
  }
  return content.length;
}

function removeSqlComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, " "))
    .replace(/--[^\r\n]*/g, (match) => " ".repeat(match.length));
}

function extractSqlSlices(content: string): SqlSlice[] {
  const slices: SqlSlice[] = [];
  const cleaned = removeSqlComments(content);
  SQL_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SQL_START.exec(cleaned))) {
    const start = match.index;
    const end = findStatementEnd(cleaned, start);
    const rawType = match[1].toUpperCase();
    const type = rawType.startsWith("INSERT")
      ? "INSERT"
      : rawType.startsWith("DELETE")
        ? "DELETE"
        : rawType.startsWith("WITH")
          ? "SELECT"
        : (rawType as SqlSlice["type"]);
    slices.push({ sql: cleaned.slice(start, end), start, end, type });
    SQL_START.lastIndex = Math.max(SQL_START.lastIndex, end);
  }
  return slices;
}

function detectLanguage(path: string, explicit?: string): SourceLanguage | string {
  if (explicit?.trim()) return explicit.trim().toLowerCase();
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? "unknown";
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

/** Analyze SQL and application sources as one evidence-backed graph. */
export function analyzeSourceProject(
  inputFiles: SourceFileInput[],
  options: AnalyzerOptions = {},
): AnalysisGraph {
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const inferColumns = options.inferColumns !== false;
  const resolveImports = options.resolveImports !== false;
  const extensionAllowList = options.analyzeExtensions
    ? new Set(options.analyzeExtensions.map((value) => value.replace(/^\./, "").toLowerCase()))
    : ANALYZABLE_EXTENSIONS;

  const normalizedInputs = inputFiles.map((file) => ({
    ...file,
    path: normalizePath(file.path),
    content: file.content ?? "",
  }));
  const evidence: Evidence[] = [];
  const evidenceByKey = new Map<string, string>();
  const warnings: AnalysisWarning[] = [];
  const tables = new Map<string, MutableTable>();
  const edges = new Map<string, GraphEdge>();
  const symbols: SourceSymbolNode[] = [];
  const symbolIds = new Set<string>();
  let analyzedFileCount = 0;

  const files: SourceFileNode[] = normalizedInputs.map((input) => ({
    id: `file:${input.path}`,
    nodeType: "file",
    path: input.path,
    name: basename(input.path),
    extension: extensionOf(input.path),
    language: detectLanguage(input.path, input.language),
    size: input.content.length,
    symbolIds: [],
    confidence: "high",
    evidenceIds: [],
  }));
  const fileByPath = new Map(files.map((file) => [file.path, file]));

  function addEvidence(
    kind: EvidenceKind,
    filePath: string,
    content: string,
    start: number,
    end: number,
    description?: string,
  ): string {
    const excerpt = compactExcerpt(content.slice(Math.max(0, start), Math.max(start + 1, end)));
    const line = lineAt(content, start);
    const endLine = lineAt(content, end);
    const key = `${kind}|${filePath}|${line}|${endLine}|${excerpt}|${description ?? ""}`;
    const existing = evidenceByKey.get(key);
    if (existing) return existing;
    const id = `evidence:${stableHash(key)}`;
    evidenceByKey.set(key, id);
    evidence.push({
      id,
      kind,
      filePath,
      line,
      endLine,
      excerpt,
      content: excerpt,
      path: filePath,
      language: detectLanguage(filePath),
      startLine: line,
      description,
    });
    return id;
  }

  function ensureTable(identifier: IdentifierParts, confidence: Confidence, evidenceId: string): MutableTable {
    const existing = tables.get(identifier.key);
    if (existing) {
      existing.confidence = strongerConfidence(existing.confidence, confidence);
      pushUnique(existing.evidenceIds, evidenceId);
      return existing;
    }
    const table: MutableTable = {
      id: `table:${identifier.key}`,
      nodeType: "table",
      schema: identifier.schema,
      name: identifier.name,
      qualifiedName: identifier.qualifiedName,
      columns: [],
      primaryKey: [],
      confidence,
      evidenceIds: [evidenceId],
      _key: identifier.key,
    };
    tables.set(identifier.key, table);
    return table;
  }

  function ensureColumn(
    table: MutableTable,
    name: string,
    confidence: Confidence,
    evidenceId: string,
    patch: Partial<DatabaseColumn> = {},
  ): DatabaseColumn {
    const cleanName = cleanIdentifierPart(name);
    const existing = table.columns.find((column) => column.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
    if (existing) {
      existing.confidence = strongerConfidence(existing.confidence, confidence);
      pushUnique(existing.evidenceIds, evidenceId);
      if (patch.dataType && !existing.dataType) existing.dataType = patch.dataType;
      if (patch.nullable !== undefined) existing.nullable = patch.nullable;
      if (patch.primaryKey) existing.primaryKey = true;
      if (patch.unique) existing.unique = true;
      if (patch.defaultValue !== undefined) existing.defaultValue = patch.defaultValue;
      for (const reference of patch.references ?? []) {
        if (!existing.references.some((item) => item.columnId === reference.columnId)) existing.references.push(reference);
      }
      if (existing.primaryKey) pushUnique(table.primaryKey, existing.name);
      return existing;
    }
    const column: DatabaseColumn = {
      id: `column:${table._key}.${cleanName.toLocaleLowerCase()}`,
      name: cleanName,
      dataType: patch.dataType,
      nullable: patch.nullable,
      primaryKey: patch.primaryKey ?? false,
      unique: patch.unique ?? false,
      defaultValue: patch.defaultValue,
      references: patch.references ? [...patch.references] : [],
      confidence,
      evidenceIds: [evidenceId],
    };
    table.columns.push(column);
    if (column.primaryKey) pushUnique(table.primaryKey, column.name);
    return column;
  }

  function addEdge(edge: Omit<GraphEdge, "id">, identityParts: string[] = []): GraphEdge {
    const identity = [edge.kind, edge.source, edge.target, edge.sourceColumn ?? "", edge.targetColumn ?? "", ...identityParts].join("|");
    const id = `edge:${edge.kind}:${stableHash(identity)}`;
    const existing = edges.get(id);
    if (existing) {
      existing.confidence = strongerConfidence(existing.confidence, edge.confidence);
      for (const evidenceId of edge.evidenceIds) pushUnique(existing.evidenceIds, evidenceId);
      return existing;
    }
    const created: GraphEdge = { id, ...edge };
    edges.set(id, created);
    return created;
  }

  function addForeignKey(
    sourceTable: MutableTable,
    sourceColumnName: string,
    targetIdentifier: IdentifierParts,
    targetColumnName: string,
    evidenceId: string,
    confidence: Confidence,
    origin: "ddl" | "query",
  ): void {
    const targetTable = ensureTable(targetIdentifier, confidence, evidenceId);
    const sourceColumn = ensureColumn(sourceTable, sourceColumnName, confidence, evidenceId);
    const targetColumn = ensureColumn(targetTable, targetColumnName, confidence, evidenceId);
    const reference: ColumnReference = {
      table: targetTable.qualifiedName,
      column: targetColumn.name,
      tableId: targetTable.id,
      columnId: targetColumn.id,
    };
    if (origin === "ddl" && !sourceColumn.references.some((item) => item.columnId === reference.columnId)) {
      sourceColumn.references.push(reference);
    }
    addEdge(
      {
        kind: origin === "ddl" ? "foreign-key" : "query-relation",
        source: sourceTable.id,
        target: targetTable.id,
        label: `${sourceColumn.name} → ${targetColumn.name}`,
        confidence,
        evidenceIds: [evidenceId],
        sourceColumn: sourceColumn.id,
        targetColumn: targetColumn.id,
        operation: "RELATION",
        metadata: { origin },
      },
      [origin],
    );
  }

  function parseColumnList(value: string): string[] {
    return splitTopLevel(value).map((item) => cleanIdentifierPart(item.trim())).filter(Boolean);
  }

  function applyTableConstraint(table: MutableTable, definition: string, evidenceId: string): boolean {
    const normalized = definition.replace(/^\s*CONSTRAINT\s+[^\s]+\s+/i, "").trim();
    const primary = normalized.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (primary) {
      for (const name of parseColumnList(primary[1])) ensureColumn(table, name, "high", evidenceId, { primaryKey: true, nullable: false });
      return true;
    }
    const unique = normalized.match(/^UNIQUE(?:\s+KEY)?(?:\s+[^\s(]+)?\s*\(([^)]+)\)/i);
    if (unique) {
      for (const name of parseColumnList(unique[1])) ensureColumn(table, name, "high", evidenceId, { unique: true });
      return true;
    }
    const foreign = normalized.match(
      new RegExp(`^FOREIGN\\s+KEY\\s*\\(([^)]+)\\)\\s+REFERENCES\\s+(${QUALIFIED_IDENTIFIER})\\s*\\(([^)]+)\\)`, "i"),
    );
    if (foreign) {
      const target = parseIdentifier(foreign[2]);
      if (!target) return true;
      const sourceColumns = parseColumnList(foreign[1]);
      const targetColumns = parseColumnList(foreign[3]);
      sourceColumns.forEach((sourceColumn, index) => {
        const targetColumn = targetColumns[index] ?? targetColumns[0];
        if (targetColumn) addForeignKey(table, sourceColumn, target, targetColumn, evidenceId, "high", "ddl");
      });
      return true;
    }
    return /^(?:CHECK|EXCLUDE|KEY|INDEX)\b/i.test(normalized);
  }

  function parseColumnDefinition(table: MutableTable, definition: string, evidenceId: string): void {
    const match = definition.match(new RegExp(`^\\s*(${IDENTIFIER_PART})\\s+([\\s\\S]+)$`, "i"));
    if (!match) return;
    const name = cleanIdentifierPart(match[1]);
    const rest = match[2].trim();
    const constraintIndex = rest.search(/\s+(?:CONSTRAINT|PRIMARY\s+KEY|NOT\s+NULL|NULL\b|UNIQUE\b|DEFAULT\b|REFERENCES\b|CHECK\b|COLLATE\b|GENERATED\b|AUTO_INCREMENT\b|IDENTITY\b)/i);
    const dataType = (constraintIndex < 0 ? rest : rest.slice(0, constraintIndex)).trim().replace(/\s+/g, " ");
    const defaultMatch = rest.match(/\bDEFAULT\s+(.+?)(?=\s+(?:CONSTRAINT|PRIMARY|NOT\s+NULL|NULL\b|UNIQUE|REFERENCES|CHECK|COLLATE|GENERATED)|$)/i);
    const column = ensureColumn(table, name, "high", evidenceId, {
      dataType: dataType || undefined,
      nullable: /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest) ? false : /\bNULL\b/i.test(rest) ? true : undefined,
      primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
      unique: /\bUNIQUE\b/i.test(rest),
      defaultValue: defaultMatch?.[1]?.trim(),
    });
    const reference = rest.match(new RegExp(`\\bREFERENCES\\s+(${QUALIFIED_IDENTIFIER})\\s*\\(([^)]+)\\)`, "i"));
    if (reference) {
      const target = parseIdentifier(reference[1]);
      const targetColumn = parseColumnList(reference[2])[0];
      if (target && targetColumn) addForeignKey(table, column.name, target, targetColumn, evidenceId, "high", "ddl");
    }
  }

  function parseCreateTables(input: SourceFileInput): void {
    const cleaned = removeSqlComments(input.content);
    const pattern = new RegExp(
      `\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${QUALIFIED_IDENTIFIER})\\s*\\(`,
      "gi",
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleaned))) {
      const openIndex = pattern.lastIndex - 1;
      const closeIndex = findMatchingParen(cleaned, openIndex);
      if (closeIndex < 0) {
        warnings.push({
          filePath: input.path,
          line: lineAt(input.content, match.index),
          code: "partial-parse",
          message: `CREATE TABLE ${match[1]} has no matching closing parenthesis.`,
        });
        continue;
      }
      const identifier = parseIdentifier(match[1]);
      if (!identifier) {
        warnings.push({ filePath: input.path, line: lineAt(input.content, match.index), code: "dynamic-identifier", message: "Dynamic CREATE TABLE identifier was skipped." });
        continue;
      }
      const evidenceId = addEvidence("ddl", input.path, input.content, match.index, closeIndex + 1, `CREATE TABLE ${identifier.qualifiedName}`);
      const table = ensureTable(identifier, "high", evidenceId);
      const definitions = splitTopLevel(cleaned.slice(openIndex + 1, closeIndex));
      for (const definition of definitions) {
        if (!applyTableConstraint(table, definition, evidenceId)) parseColumnDefinition(table, definition, evidenceId);
      }
      pattern.lastIndex = closeIndex + 1;
    }
  }

  function parseAlterTables(input: SourceFileInput): void {
    const cleaned = removeSqlComments(input.content);
    const pattern = new RegExp(`\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${QUALIFIED_IDENTIFIER})\\s+`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleaned))) {
      const end = findStatementEnd(cleaned, match.index);
      const statement = cleaned.slice(match.index, end);
      const identifier = parseIdentifier(match[1]);
      if (!identifier) continue;
      const evidenceId = addEvidence("ddl", input.path, input.content, match.index, end, `ALTER TABLE ${identifier.qualifiedName}`);
      const table = ensureTable(identifier, "high", evidenceId);
      const actionStart = match[0].length;
      const actions = splitTopLevel(statement.slice(actionStart).replace(/;\s*$/, ""));
      for (let action of actions) {
        action = action.replace(/^\s*ADD\s+/i, "").replace(/^COLUMN\s+/i, "");
        if (!applyTableConstraint(table, action, evidenceId)) parseColumnDefinition(table, action, evidenceId);
      }
      pattern.lastIndex = Math.max(pattern.lastIndex, end);
    }
  }

  function collectCteNames(sql: string): Set<string> {
    const names = new Set<string>();
    const pattern = new RegExp(`(?:\\bWITH|,)\\s*(${IDENTIFIER_PART})(?:\\s*\\([^)]*\\))?\\s+AS\\s*\\(`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql))) names.add(cleanIdentifierPart(match[1]).toLocaleLowerCase());
    return names;
  }

  function collectTableMentions(sql: string, queryType: SqlSlice["type"]): TableMention[] {
    const mentions: TableMention[] = [];
    const cteNames = collectCteNames(sql);
    const pattern = new RegExp(`\\b(FROM|JOIN|USING)\\s+(${QUALIFIED_IDENTIFIER})(?:\\s+(?:AS\\s+)?(${IDENTIFIER_PART}))?`, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sql))) {
      const identifier = parseIdentifier(match[2]);
      if (!identifier || cteNames.has(identifier.name.toLocaleLowerCase())) continue;
      const rawAlias = match[3] ? cleanIdentifierPart(match[3]) : undefined;
      const alias = rawAlias && !SQL_KEYWORDS.has(rawAlias.toLocaleLowerCase()) ? rawAlias : undefined;
      mentions.push({ identifier, alias, clause: match[1].toUpperCase() as TableMention["clause"], index: match.index });
    }
    if (queryType === "INSERT") {
      const target = sql.match(new RegExp(`\\bINSERT\\s+INTO\\s+(${QUALIFIED_IDENTIFIER})`, "i"));
      const identifier = target ? parseIdentifier(target[1]) : undefined;
      if (identifier) mentions.unshift({ identifier, clause: "INTO", index: target?.index ?? 0 });
    } else if (queryType === "UPDATE") {
      const target = sql.match(new RegExp(`\\bUPDATE\\s+(${QUALIFIED_IDENTIFIER})(?:\\s+(?:AS\\s+)?(${IDENTIFIER_PART}))?`, "i"));
      const identifier = target ? parseIdentifier(target[1]) : undefined;
      const rawAlias = target?.[2] ? cleanIdentifierPart(target[2]) : undefined;
      const alias = rawAlias && !SQL_KEYWORDS.has(rawAlias.toLocaleLowerCase()) ? rawAlias : undefined;
      if (identifier) mentions.unshift({ identifier, alias, clause: "UPDATE", index: target?.index ?? 0 });
    }
    return mentions;
  }

  function aliasMapFor(mentions: TableMention[]): Map<string, IdentifierParts> {
    const aliases = new Map<string, IdentifierParts>();
    for (const mention of mentions) {
      aliases.set(mention.identifier.name.toLocaleLowerCase(), mention.identifier);
      aliases.set(mention.identifier.qualifiedName.toLocaleLowerCase(), mention.identifier);
      if (mention.alias) aliases.set(mention.alias.toLocaleLowerCase(), mention.identifier);
    }
    return aliases;
  }

  function addFileTableEdge(
    file: SourceFileNode,
    table: MutableTable,
    operation: "READ" | "WRITE",
    queryType: SqlSlice["type"],
    evidenceId: string,
  ): void {
    addEdge(
      {
        kind: operation === "READ" ? "read" : "write",
        source: file.id,
        target: table.id,
        label: operation,
        confidence: "high",
        evidenceIds: [evidenceId],
        operation,
        queryType,
      },
      [operation],
    );
  }

  function inferMentionedColumns(
    sql: string,
    aliases: Map<string, IdentifierParts>,
    evidenceId: string,
  ): void {
    if (!inferColumns) return;
    const qualifiedColumn = new RegExp(`(${IDENTIFIER_PART})\\s*\\.\\s*(${IDENTIFIER_PART})`, "g");
    let match: RegExpExecArray | null;
    while ((match = qualifiedColumn.exec(sql))) {
      const qualifier = cleanIdentifierPart(match[1]).toLocaleLowerCase();
      const columnName = cleanIdentifierPart(match[2]);
      const identifier = aliases.get(qualifier);
      if (!identifier || columnName === "*") continue;
      ensureColumn(ensureTable(identifier, "medium", evidenceId), columnName, "medium", evidenceId);
    }
  }

  function parseQueryRelations(
    sql: string,
    aliases: Map<string, IdentifierParts>,
    evidenceId: string,
  ): void {
    const onPattern = /\bON\s+([\s\S]+?)(?=\b(?:LEFT|RIGHT|FULL|INNER|OUTER|CROSS|NATURAL)?\s*JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|\bRETURNING\b|;|$)/gi;
    let onMatch: RegExpExecArray | null;
    const reference = new RegExp(`(${QUALIFIED_IDENTIFIER})\\s*\\.\\s*(${IDENTIFIER_PART})`, "i");
    while ((onMatch = onPattern.exec(sql))) {
      const equalities = onMatch[1].split(/\bAND\b/i);
      for (const equality of equalities) {
        const equalsIndex = equality.indexOf("=");
        if (equalsIndex < 0) continue;
        const left = equality.slice(0, equalsIndex).match(reference);
        const right = equality.slice(equalsIndex + 1).match(reference);
        if (!left || !right) continue;
        const leftQualifier = cleanIdentifierPart(splitIdentifier(left[1]).slice(-1)[0]).toLocaleLowerCase();
        const rightQualifier = cleanIdentifierPart(splitIdentifier(right[1]).slice(-1)[0]).toLocaleLowerCase();
        const leftTableIdentifier = aliases.get(leftQualifier);
        const rightTableIdentifier = aliases.get(rightQualifier);
        if (!leftTableIdentifier || !rightTableIdentifier || leftTableIdentifier.key === rightTableIdentifier.key) continue;
        const sourceTable = ensureTable(leftTableIdentifier, "medium", evidenceId);
        addForeignKey(sourceTable, cleanIdentifierPart(left[2]), rightTableIdentifier, cleanIdentifierPart(right[2]), evidenceId, "medium", "query");
      }
    }
  }

  function inferMutationColumns(
    slice: SqlSlice,
    target: MutableTable | undefined,
    evidenceId: string,
  ): void {
    if (!inferColumns || !target) return;
    if (slice.type === "INSERT") {
      const match = slice.sql.match(new RegExp(`\\bINSERT\\s+INTO\\s+${QUALIFIED_IDENTIFIER}\\s*\\(([^)]+)\\)`, "i"));
      for (const column of match ? parseColumnList(match[1]) : []) ensureColumn(target, column, "medium", evidenceId);
    } else if (slice.type === "UPDATE") {
      const match = slice.sql.match(/\bSET\s+([\s\S]+?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|;|$)/i);
      for (const assignment of match ? splitTopLevel(match[1]) : []) {
        const column = assignment.match(new RegExp(`^\\s*(?:${IDENTIFIER_PART}\\s*\\.\\s*)?(${IDENTIFIER_PART})\\s*=`));
        if (column) ensureColumn(target, cleanIdentifierPart(column[1]), "medium", evidenceId);
      }
    }
  }

  function parseQueries(input: SourceFileInput, file: SourceFileNode): void {
    for (const slice of extractSqlSlices(input.content)) {
      const evidenceId = addEvidence("query", input.path, input.content, slice.start, slice.end, `${slice.type} query`);
      const mentions = collectTableMentions(slice.sql, slice.type);
      const aliases = aliasMapFor(mentions);
      let writeTarget: MutableTable | undefined;
      for (const mention of mentions) {
        const table = ensureTable(mention.identifier, "medium", evidenceId);
        const isWriteTarget =
          (slice.type === "INSERT" && mention.clause === "INTO") ||
          (slice.type === "UPDATE" && mention.clause === "UPDATE") ||
          (slice.type === "DELETE" && mention.clause === "FROM" && !writeTarget);
        if (isWriteTarget) {
          writeTarget = table;
          addFileTableEdge(file, table, "WRITE", slice.type, evidenceId);
        } else {
          addFileTableEdge(file, table, "READ", slice.type, evidenceId);
        }
      }
      inferMutationColumns(slice, writeTarget, evidenceId);
      inferMentionedColumns(slice.sql, aliases, evidenceId);
      parseQueryRelations(slice.sql, aliases, evidenceId);
    }
  }

  function addSymbol(
    file: SourceFileNode,
    symbol: Omit<SourceSymbolNode, "id" | "nodeType" | "fileId" | "filePath">,
  ): SourceSymbolNode {
    const identity = `${file.path}|${symbol.kind}|${symbol.name}|${symbol.line}|${symbol.httpMethod ?? ""}|${symbol.routePath ?? ""}`;
    const id = `symbol:${stableHash(identity)}`;
    const existing = symbols.find((item) => item.id === id);
    if (existing) return existing;
    const created: SourceSymbolNode = { id, nodeType: "symbol", fileId: file.id, filePath: file.path, ...symbol };
    symbols.push(created);
    symbolIds.add(id);
    pushUnique(file.symbolIds, id);
    for (const evidenceId of created.evidenceIds) pushUnique(file.evidenceIds, evidenceId);
    addEdge({
      kind: "contains",
      source: file.id,
      target: id,
      label: created.kind,
      confidence: created.confidence,
      evidenceIds: created.evidenceIds,
      operation: "CONTAINS",
    });
    return created;
  }

  function functionPatterns(language: string): Array<{ pattern: RegExp; nameGroup: number; kind?: SourceSymbolKind }> {
    if (language === "python") return [{ pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\([^\n]*\)/gm, nameGroup: 1 }];
    if (language === "go") return [{ pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\([^\n]*\)/gm, nameGroup: 1 }];
    if (language === "ruby") return [{ pattern: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\b[^\n]*/gm, nameGroup: 1 }];
    if (language === "php") return [{ pattern: /\bfunction\s+([A-Za-z_]\w*)\s*\([^\n]*\)/gm, nameGroup: 1 }];
    if (["java", "kotlin", "csharp", "scala"].includes(language)) {
      return [
        { pattern: /^\s*(?:public|private|protected|internal|static|final|open|override|suspend|abstract|virtual|async|inline|external|\s)+[\w<>,.?\[\]\s:]+\s+([A-Za-z_]\w*)\s*\([^;\n]*\)\s*(?:\{|=)/gm, nameGroup: 1, kind: "method" },
        { pattern: /^\s*(?:public|private|protected|internal|static|final|open|override|suspend|abstract|virtual|async|inline|external|\s)*fun\s+([A-Za-z_]\w*)\s*\([^\n]*\)/gm, nameGroup: 1, kind: "method" },
      ];
    }
    if (["typescript", "javascript"].includes(language)) {
      return [
        { pattern: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^\n]*\)/gm, nameGroup: 1 },
        { pattern: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^\n]*?\)|[A-Za-z_$][\w$]*)\s*=>/gm, nameGroup: 1 },
      ];
    }
    if (language === "rust") return [{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\([^\n]*\)/gm, nameGroup: 1 }];
    return [];
  }

  function parseFunctions(input: SourceFileInput, file: SourceFileNode): void {
    for (const descriptor of functionPatterns(file.language)) {
      descriptor.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = descriptor.pattern.exec(input.content))) {
        const evidenceId = addEvidence("function", input.path, input.content, match.index, match.index + match[0].length, `Function ${match[descriptor.nameGroup]}`);
        addSymbol(file, {
          kind: descriptor.kind ?? "function",
          name: match[descriptor.nameGroup],
          line: lineAt(input.content, match.index),
          signature: compactExcerpt(match[0], 180),
          confidence: "high",
          evidenceIds: [evidenceId],
        });
      }
    }
  }

  function routePathFromFile(path: string): string | undefined {
    const normalized = normalizePath(path);
    const appMatch = normalized.match(/(?:^|\/)app\/api\/(.+)\/route\.[^/]+$/i);
    const pagesMatch = normalized.match(/(?:^|\/)pages\/api\/(.+)\.[^/]+$/i);
    const raw = appMatch?.[1] ?? pagesMatch?.[1];
    if (!raw) return undefined;
    const segments = raw
      .split("/")
      .filter((segment) => segment && !/^\(.+\)$/.test(segment) && !segment.startsWith("@"))
      .map((segment) => {
        const catchAll = segment.match(/^\[\.\.\.(.+)]$/);
        const optionalCatchAll = segment.match(/^\[\[\.\.\.(.+)]]$/);
        const dynamic = segment.match(/^\[(.+)]$/);
        if (optionalCatchAll) return `*${optionalCatchAll[1]}?`;
        if (catchAll) return `*${catchAll[1]}`;
        if (dynamic) return `:${dynamic[1]}`;
        return segment;
      });
    return `/api/${segments.join("/")}`.replace(/\/$/, "");
  }

  function parseRoutes(input: SourceFileInput, file: SourceFileNode): void {
    const routePatterns: Array<{ pattern: RegExp; method: number; path: number; handler?: number }> = [
      { pattern: /\b[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*["'`](\/[^"'`]*)["'`](?:\s*,\s*([A-Za-z_$][\w$]*))?/gi, method: 1, path: 2, handler: 3 },
      { pattern: /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi, method: 0, path: 1 },
      { pattern: /@(?:app|router|blueprint)\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/gi, method: 1, path: 2 },
      { pattern: /\b(?:get|post|put|patch|delete)\s+["']([^"']+)["']/gi, method: 0, path: 1 },
    ];
    for (const descriptor of routePatterns) {
      descriptor.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = descriptor.pattern.exec(input.content))) {
        const annotation = match[0].match(/@(Get|Post|Put|Patch|Delete|Request)Mapping/i)?.[1];
        const method = descriptor.method ? match[descriptor.method].toUpperCase() : annotation?.toUpperCase() ?? "ANY";
        const path = match[descriptor.path];
        const handlerName = descriptor.handler ? match[descriptor.handler] : undefined;
        const handler = handlerName
          ? symbols.find((symbol) => symbol.fileId === file.id && symbol.name === handlerName && symbol.kind !== "route")
          : undefined;
        const evidenceId = addEvidence("route", input.path, input.content, match.index, match.index + match[0].length, `${method} ${path}`);
        addSymbol(file, {
          kind: "route",
          name: `${method} ${path}`,
          line: lineAt(input.content, match.index),
          httpMethod: method,
          routePath: path,
          handlerSymbolId: handler?.id,
          signature: compactExcerpt(match[0], 180),
          confidence: "high",
          evidenceIds: [evidenceId],
        });
      }
    }

    const conventionalPath = routePathFromFile(file.path);
    if (conventionalPath) {
      const methodFunctions = symbols.filter(
        (symbol) => symbol.fileId === file.id && symbol.kind !== "route" && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/i.test(symbol.name),
      );
      for (const handler of methodFunctions) {
        const evidenceId = handler.evidenceIds[0];
        addSymbol(file, {
          kind: "route",
          name: `${handler.name.toUpperCase()} ${conventionalPath}`,
          line: handler.line,
          httpMethod: handler.name.toUpperCase(),
          routePath: conventionalPath,
          handlerSymbolId: handler.id,
          confidence: "high",
          evidenceIds: [evidenceId],
        });
      }
    }
  }

  function collectImportSpecifiers(content: string, language: string): Array<{ specifier: string; index: number }> {
    const found: Array<{ specifier: string; index: number }> = [];
    const patterns: RegExp[] = [];
    if (["typescript", "javascript"].includes(language)) {
      patterns.push(/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g);
    } else if (language === "python") {
      patterns.push(/^\s*from\s+([.\w]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm);
    } else if (["java", "kotlin", "scala"].includes(language)) {
      patterns.push(/^\s*import\s+([\w.]+)(?:\.\*)?\s*;?/gm);
    } else if (language === "go") {
      patterns.push(/^\s*import\s+(?:\w+\s+)?["`]([^"`]+)["`]/gm);
      const block = /\bimport\s*\(([^)]+)\)/gm;
      let blockMatch: RegExpExecArray | null;
      while ((blockMatch = block.exec(content))) {
        const item = /(?:^|\n)\s*(?:\w+\s+)?["`]([^"`]+)["`]/g;
        let itemMatch: RegExpExecArray | null;
        while ((itemMatch = item.exec(blockMatch[1]))) found.push({ specifier: itemMatch[1], index: blockMatch.index + itemMatch.index });
      }
    } else if (language === "php") {
      patterns.push(/\b(?:require|require_once|include|include_once)\s*(?:\(\s*)?["']([^"']+)["']/g, /^\s*use\s+([\w\\]+)/gm);
    } else if (language === "csharp") {
      patterns.push(/^\s*using\s+([\w.]+)\s*;/gm);
    } else if (language === "rust") {
      patterns.push(/^\s*use\s+([\w:]+)/gm, /^\s*mod\s+([A-Za-z_]\w*)\s*;/gm);
    }
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content))) found.push({ specifier: match[1], index: match.index });
    }
    return found.sort((a, b) => a.index - b.index);
  }

  function resolveImportPath(fromPath: string, specifier: string): string | undefined {
    const knownPaths = new Set(fileByPath.keys());
    const fromExtension = extensionOf(fromPath);
    const sourceExtensions = dedupeSorted([fromExtension, "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "kt", "go", "rb", "php", "cs", "rs"]);
    const candidates: string[] = [];
    const relative = specifier.startsWith(".");
    if (fromExtension === "py" && relative) {
      const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 1;
      let packageDirectory = dirname(fromPath);
      for (let level = 1; level < leadingDots; level += 1) packageDirectory = dirname(packageDirectory);
      const modulePath = specifier.slice(leadingDots).replace(/\./g, "/");
      const base = normalizePath(`${packageDirectory}/${modulePath}`);
      candidates.push(base);
      for (const extension of sourceExtensions) candidates.push(`${base}.${extension}`);
      for (const extension of sourceExtensions) candidates.push(`${base}/__init__.${extension}`);
    } else if (relative || specifier.startsWith("/")) {
      const base = specifier.startsWith("/") ? normalizePath(specifier) : normalizePath(`${dirname(fromPath)}/${specifier}`);
      candidates.push(base);
      for (const extension of sourceExtensions) candidates.push(`${base}.${extension}`);
      for (const extension of sourceExtensions) candidates.push(`${base}/index.${extension}`);
    } else {
      const modulePath = specifier.replace(/::/g, "/").replace(/[.\\]/g, "/");
      candidates.push(modulePath);
      for (const extension of sourceExtensions) candidates.push(`${modulePath}.${extension}`);
      for (const path of knownPaths) {
        const withoutExtension = path.replace(/\.[^/.]+$/, "");
        if (withoutExtension === modulePath || withoutExtension.endsWith(`/${modulePath}`)) candidates.push(path);
      }
    }
    return candidates.map(normalizePath).find((candidate) => knownPaths.has(candidate));
  }

  function parseImports(input: SourceFileInput, file: SourceFileNode): void {
    if (!resolveImports) return;
    for (const item of collectImportSpecifiers(input.content, file.language)) {
      const targetPath = resolveImportPath(file.path, item.specifier);
      if (!targetPath || targetPath === file.path) continue;
      const target = fileByPath.get(targetPath);
      if (!target) continue;
      const evidenceId = addEvidence("import", input.path, input.content, item.index, item.index + item.specifier.length, `Import ${item.specifier}`);
      addEdge(
        {
          kind: "import",
          source: file.id,
          target: target.id,
          label: item.specifier,
          confidence: "high",
          evidenceIds: [evidenceId],
          operation: "IMPORT",
          metadata: { specifier: item.specifier, resolvedPath: targetPath },
        },
        [item.specifier],
      );
    }
  }

  for (let index = 0; index < normalizedInputs.length; index += 1) {
    const input = normalizedInputs[index];
    const file = files[index];
    if (input.content.length > maxFileSize) {
      warnings.push({ filePath: input.path, code: "file-too-large", message: `Skipped analysis because the file exceeds ${maxFileSize} characters.` });
      continue;
    }
    if (!extensionAllowList.has(file.extension) && file.language === "unknown") continue;
    analyzedFileCount += 1;
    parseCreateTables(input);
    parseAlterTables(input);
    parseQueries(input, file);
    parseFunctions(input, file);
    parseRoutes(input, file);
    parseImports(input, file);
  }

  const publicTables: DatabaseTable[] = Array.from(tables.values())
    .map((table) => ({
      id: table.id,
      nodeType: table.nodeType,
      schema: table.schema,
      name: table.name,
      qualifiedName: table.qualifiedName,
      confidence: table.confidence,
      primaryKey: dedupeSorted(table.primaryKey),
      evidenceIds: dedupeSorted(table.evidenceIds),
      columns: table.columns
        .map((column) => ({ ...column, evidenceIds: dedupeSorted(column.evidenceIds), references: [...column.references] }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  files.forEach((file) => {
    file.symbolIds = dedupeSorted(file.symbolIds);
    file.evidenceIds = dedupeSorted(file.evidenceIds);
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  symbols.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.name.localeCompare(b.name));
  const publicEdges = Array.from(edges.values()).sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  evidence.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.kind.localeCompare(b.kind));

  const stats: AnalysisStats = {
    fileCount: files.length,
    analyzedFileCount,
    tableCount: publicTables.length,
    columnCount: publicTables.reduce((sum, table) => sum + table.columns.length, 0),
    relationshipCount: publicEdges.filter((edge) => edge.kind === "foreign-key" || edge.kind === "query-relation").length,
    readCount: publicEdges.filter((edge) => edge.kind === "read").length,
    writeCount: publicEdges.filter((edge) => edge.kind === "write").length,
    importCount: publicEdges.filter((edge) => edge.kind === "import").length,
    functionCount: symbols.filter((symbol) => symbol.kind !== "route").length,
    routeCount: symbols.filter((symbol) => symbol.kind === "route").length,
  };

  return {
    version: 1,
    tables: publicTables,
    files,
    symbols,
    nodes: [...publicTables, ...files, ...symbols],
    edges: publicEdges,
    evidence,
    warnings,
    stats,
  };
}

/** Short aliases kept for consumers that prefer project/source terminology. */
export const analyzeProject = analyzeSourceProject;
export const analyzeSources = analyzeSourceProject;

function searchableNodeText(node: GraphNode, evidenceById: Map<string, Evidence>): string {
  const evidenceText = node.evidenceIds.map((id) => evidenceById.get(id)?.excerpt ?? "").join(" ");
  if (node.nodeType === "table") {
    return `${node.schema ?? ""} ${node.name} ${node.qualifiedName} ${node.columns.map((column) => `${column.name} ${column.dataType ?? ""}`).join(" ")} ${evidenceText}`;
  }
  if (node.nodeType === "file") return `${node.path} ${node.name} ${node.language} ${evidenceText}`;
  return `${node.name} ${node.kind} ${node.filePath} ${node.httpMethod ?? ""} ${node.routePath ?? ""} ${evidenceText}`;
}

function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLocaleLowerCase()
        .normalize("NFKC")
        .split(/[^\p{L}\p{N}_.$/-]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 1),
    ),
  );
}

/**
 * Lightweight relevance ranking for selecting graph context before an LLM call.
 * It is vocabulary-driven by the supplied project and question, not fixed maps.
 */
export function findRelevantGraphNodes(graph: AnalysisGraph, query: string, limit = 20): GraphSearchHit[] {
  const terms = queryTerms(query);
  const evidenceById = new Map(graph.evidence.map((item) => [item.id, item]));
  if (!terms.length) return graph.nodes.slice(0, limit).map((node) => ({ node, score: 0, matchedTerms: [] }));
  return graph.nodes
    .map((node) => {
      const text = searchableNodeText(node, evidenceById).toLocaleLowerCase().normalize("NFKC");
      const name = (node.nodeType === "table" ? node.qualifiedName : node.nodeType === "file" ? node.path : node.name).toLocaleLowerCase();
      const matchedTerms = terms.filter((term) => text.includes(term));
      const score = matchedTerms.reduce((total, term) => total + (name === term ? 8 : name.includes(term) ? 4 : 1), 0);
      return { node, score, matchedTerms };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, Math.max(0, limit));
}

/**
 * Produce compact, structured evidence for a provider-agnostic LLM request.
 * Callers retain control of the model, transport, system prompt and credentials.
 */
export function buildLLMContext(graph: AnalysisGraph, question = "", maxNodes = 30): string {
  const relevant = question.trim() ? findRelevantGraphNodes(graph, question, maxNodes).map((hit) => hit.node) : [];
  // A question may use a different natural language than the schema. In that
  // case lexical retrieval is not evidence that nothing is relevant, so fall
  // back to bounded project context and let the configured LLM map concepts.
  const selected = relevant.length ? relevant : graph.nodes.slice(0, maxNodes);
  const selectedIds = new Set(selected.map((node) => node.id));
  const selectedEdges = graph.edges.filter((edge) => selectedIds.has(edge.source) || selectedIds.has(edge.target));
  for (const edge of selectedEdges) {
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    if (source) selectedIds.add(source.id);
    if (target) selectedIds.add(target.id);
  }
  const contextNodes = graph.nodes.filter((node) => selectedIds.has(node.id));
  const evidenceIds = new Set<string>();
  contextNodes.forEach((node) => node.evidenceIds.forEach((id) => evidenceIds.add(id)));
  selectedEdges.forEach((edge) => edge.evidenceIds.forEach((id) => evidenceIds.add(id)));
  return JSON.stringify(
    {
      question,
      instruction: "Answer only from the supplied graph and evidence. Separate explicit DDL facts from query-derived inferences and cite file paths and lines.",
      nodes: contextNodes,
      edges: selectedEdges,
      evidence: graph.evidence.filter((item) => evidenceIds.has(item.id)),
    },
    null,
    2,
  );
}

/** Realistic, framework-mixed input for demos and smoke tests. */
export function buildDemoSourceFiles(): SourceFileInput[] {
  return [
    {
      path: "database/migrations/001_workspace.sql",
      content: `
CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(120),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  owner_id UUID NOT NULL,
  name VARCHAR(180) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT projects_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL,
  assignee_id UUID,
  title VARCHAR(240) NOT NULL,
  state VARCHAR(24) NOT NULL DEFAULT 'open',
  due_at TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

ALTER TABLE projects ADD CONSTRAINT projects_owner_fk FOREIGN KEY (owner_id) REFERENCES users(id);
ALTER TABLE tasks ADD CONSTRAINT tasks_assignee_fk FOREIGN KEY (assignee_id) REFERENCES users(id);
`,
    },
    {
      path: "src/data/projectRepository.ts",
      content: `
import { database } from "./connection";

export async function listProjectsForUser(userId: string) {
  return database.query(\`
    SELECT p.id, p.name, p.status, o.name AS organization_name,
           COUNT(t.id) AS open_tasks
    FROM projects p
    JOIN organizations o ON o.id = p.organization_id
    LEFT JOIN tasks t ON t.project_id = p.id AND t.state = 'open'
    WHERE p.owner_id = $1
    GROUP BY p.id, p.name, p.status, o.name
  \`, [userId]);
}

export async function createProject(input: { organizationId: string; ownerId: string; name: string }) {
  return database.query(
    \`INSERT INTO projects (organization_id, owner_id, name) VALUES ($1, $2, $3) RETURNING id\`,
    [input.organizationId, input.ownerId, input.name],
  );
}
`,
    },
    {
      path: "src/data/taskRepository.ts",
      content: `
import { database } from "./connection";

export const completeTask = async (taskId: string) => {
  return database.query(\`UPDATE tasks SET state = 'done' WHERE id = $1 RETURNING id\`, [taskId]);
};

export async function tasksDueForUser(userId: string) {
  return database.query(\`
    SELECT t.id, t.title, t.due_at, p.name AS project_name, u.display_name
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.assignee_id = $1 AND t.state <> 'done'
  \`, [userId]);
}
`,
    },
    {
      path: "src/routes/projects.ts",
      content: `
import { Router } from "express";
import { createProject, listProjectsForUser } from "../data/projectRepository";

export const projectRouter = Router();

projectRouter.get("/projects", listProjectsForUser);
projectRouter.post("/projects", createProject);
`,
    },
    {
      path: "src/app/api/tasks/[id]/route.ts",
      content: `
import { completeTask } from "../../../../data/taskRepository";

export async function PATCH(request: Request) {
  const payload = await request.json();
  return Response.json(await completeTask(payload.id));
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  await database.query(\`DELETE FROM tasks WHERE id = $1\`, [id]);
  return new Response(null, { status: 204 });
}
`,
    },
    { path: "src/data/connection.ts", content: `export const database = { query: async (sql: string, params: unknown[]) => ({ sql, params }) };` },
  ];
}

export function buildDemoGraph(): AnalysisGraph {
  return analyzeSourceProject(buildDemoSourceFiles());
}
