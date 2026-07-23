"use client";

import { useMemo } from "react";
import { useI18n } from "@/app/i18n";
import type {
  AnalysisGraph,
  DatabaseTable,
  GraphEdge,
  SourceFileNode,
} from "@/lib/analyzer";

export type GraphViewMode = "database" | "source";

export interface SupplementalEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  confidence: number;
}

interface GraphCanvasProps {
  graph: AnalysisGraph;
  mode: GraphViewMode;
  selectedId: string | null;
  search: string;
  zoom: number;
  supplementalEdges?: SupplementalEdge[];
  onSelect: (nodeId: string) => void;
}

interface CanvasNode {
  id: string;
  nodeType: "table" | "file";
  title: string;
  subtitle: string;
  x: number;
  y: number;
  width: number;
  height: number;
  table?: DatabaseTable;
  file?: SourceFileNode;
  readCount: number;
  writeCount: number;
  importCount: number;
}

interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  confidence: number;
}

const NODE_WIDTH = 242;
const COLUMN_GAP = 92;
const ROW_GAP = 54;
const MAX_VISIBLE_COLUMNS = 6;

function confidenceNumber(value: GraphEdge["confidence"]): number {
  if (value === "high") return 0.96;
  if (value === "medium") return 0.76;
  return 0.52;
}

function graphDegree(graph: AnalysisGraph, nodeId: string): number {
  return graph.edges.reduce(
    (count, edge) =>
      count + Number(edge.source === nodeId) + Number(edge.target === nodeId),
    0,
  );
}

function tableHeight(table: DatabaseTable): number {
  const visible = Math.min(MAX_VISIBLE_COLUMNS, table.columns.length);
  return 55 + visible * 25 + (table.columns.length > visible ? 27 : 11);
}

function classifySourceLayer(file: SourceFileNode): number {
  const path = file.path.toLocaleLowerCase();
  if (/(^|[/_.-])(route|routes|controller|controllers|api|endpoint)([/_.-]|$)/.test(path)) {
    return 0;
  }
  if (/(repository|repositories|dao|mapper|data|database|persistence)/.test(path)) {
    return 1;
  }
  return 0;
}

function edgeStats(graph: AnalysisGraph, nodeId: string) {
  return graph.edges.reduce(
    (stats, edge) => {
      if (edge.source !== nodeId && edge.target !== nodeId) return stats;
      if (edge.kind === "read") stats.readCount += 1;
      if (edge.kind === "write") stats.writeCount += 1;
      if (edge.kind === "import") stats.importCount += 1;
      return stats;
    },
    { readCount: 0, writeCount: 0, importCount: 0 },
  );
}

function buildDatabaseLayout(graph: AnalysisGraph) {
  const sorted = [...graph.tables].sort(
    (a, b) =>
      graphDegree(graph, b.id) - graphDegree(graph, a.id) ||
      a.qualifiedName.localeCompare(b.qualifiedName),
  );
  const columnCount = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(sorted.length))));
  const rows = Math.max(1, Math.ceil(sorted.length / columnCount));
  const rowHeights = Array.from({ length: rows }, () => 0);

  sorted.forEach((table, index) => {
    const row = Math.floor(index / columnCount);
    rowHeights[row] = Math.max(rowHeights[row], tableHeight(table));
  });

  const rowOffsets: number[] = [];
  let currentY = 46;
  rowHeights.forEach((height) => {
    rowOffsets.push(currentY);
    currentY += height + ROW_GAP;
  });

  const nodes: CanvasNode[] = sorted.map((table, index) => {
    const row = Math.floor(index / columnCount);
    const column = index % columnCount;
    const height = tableHeight(table);
    return {
      id: table.id,
      nodeType: "table",
      title: table.name,
      subtitle: table.schema ?? "default schema",
      x: 48 + column * (NODE_WIDTH + COLUMN_GAP),
      y: rowOffsets[row] + (rowHeights[row] - height) / 2,
      width: NODE_WIDTH,
      height,
      table,
      readCount: graph.edges.filter((edge) => edge.target === table.id && edge.kind === "read").length,
      writeCount: graph.edges.filter((edge) => edge.target === table.id && edge.kind === "write").length,
      importCount: 0,
    };
  });

  const edges: CanvasEdge[] = graph.edges
    .filter((edge) => edge.kind === "foreign-key" || edge.kind === "query-relation")
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.kind === "foreign-key" ? "FK" : "JOIN",
      kind: edge.kind,
      confidence: confidenceNumber(edge.confidence),
    }));

  return {
    nodes,
    edges,
    width: Math.max(720, 96 + columnCount * (NODE_WIDTH + COLUMN_GAP)),
    height: Math.max(520, currentY + 30),
  };
}

function buildSourceLayout(graph: AnalysisGraph) {
  const relevantFileIds = new Set<string>();
  for (const edge of graph.edges) {
    if (["read", "write", "import"].includes(edge.kind)) {
      relevantFileIds.add(edge.source);
      relevantFileIds.add(edge.target);
    }
  }

  const files = graph.files
    .filter((file) => relevantFileIds.has(file.id) || file.symbolIds.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  const lanes: Array<Array<SourceFileNode | DatabaseTable>> = [[], [], []];
  files.forEach((file) => lanes[classifySourceLayer(file)].push(file));
  [...graph.tables]
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
    .forEach((table) => lanes[2].push(table));

  const nodes: CanvasNode[] = [];
  const laneStep = NODE_WIDTH + COLUMN_GAP;
  const laneCounts = lanes.map((lane) => lane.length);
  const maxLaneCount = Math.max(1, ...laneCounts);

  lanes.forEach((lane, laneIndex) => {
    lane.forEach((item, index) => {
      const isTable = item.nodeType === "table";
      const stats = edgeStats(graph, item.id);
      const height = isTable ? Math.min(tableHeight(item), 206) : 124;
      nodes.push({
        id: item.id,
        nodeType: isTable ? "table" : "file",
        title: isTable ? item.name : item.name,
        subtitle: isTable ? item.schema ?? "database" : item.language,
        x: 48 + laneIndex * laneStep,
        y: 54 + index * (206 + ROW_GAP),
        width: NODE_WIDTH,
        height,
        table: isTable ? item : undefined,
        file: isTable ? undefined : item,
        ...stats,
      });
    });
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: CanvasEdge[] = graph.edges
    .filter(
      (edge) =>
        ["read", "write", "import"].includes(edge.kind) &&
        nodeIds.has(edge.source) &&
        nodeIds.has(edge.target),
    )
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.kind.toLocaleUpperCase(),
      kind: edge.kind,
      confidence: confidenceNumber(edge.confidence),
    }));

  return {
    nodes,
    edges,
    width: Math.max(900, 96 + lanes.length * laneStep),
    height: Math.max(580, 90 + maxLaneCount * (206 + ROW_GAP)),
  };
}

function pathBetween(source: CanvasNode, target: CanvasNode) {
  const goesRight = target.x >= source.x;
  const sourceX = goesRight ? source.x + source.width : source.x;
  const targetX = goesRight ? target.x : target.x + target.width;
  const sourceY = source.y + Math.min(70, source.height / 2);
  const targetY = target.y + Math.min(70, target.height / 2);
  const controlDistance = Math.max(56, Math.abs(targetX - sourceX) * 0.48);
  const control1 = goesRight ? sourceX + controlDistance : sourceX - controlDistance;
  const control2 = goesRight ? targetX - controlDistance : targetX + controlDistance;
  return {
    d: `M ${sourceX} ${sourceY} C ${control1} ${sourceY}, ${control2} ${targetY}, ${targetX} ${targetY}`,
    labelX: (sourceX + targetX) / 2,
    labelY: (sourceY + targetY) / 2,
  };
}

function nodeMatches(node: CanvasNode, search: string): boolean {
  if (!search.trim()) return true;
  const term = search.trim().toLocaleLowerCase();
  const columnNames = node.table?.columns.map((column) => column.name).join(" ") ?? "";
  return `${node.title} ${node.subtitle} ${node.file?.path ?? ""} ${columnNames}`
    .toLocaleLowerCase()
    .includes(term);
}

function confidenceLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function GraphCanvas({
  graph,
  mode,
  selectedId,
  search,
  zoom,
  supplementalEdges = [],
  onSelect,
}: GraphCanvasProps) {
  const { t } = useI18n();
  const layout = useMemo(
    () => (mode === "database" ? buildDatabaseLayout(graph) : buildSourceLayout(graph)),
    [graph, mode],
  );
  const nodesById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );
  const extraEdges = supplementalEdges.filter(
    (edge) => nodesById.has(edge.source) && nodesById.has(edge.target),
  );
  const edges = [...layout.edges, ...extraEdges];
  const searchActive = search.trim().length > 0;

  if (!layout.nodes.length) {
    return (
      <div className="graph-stage">
        <div className="graph-empty">
          <div className="empty-copy">
            <h2>{t("graph.emptyTitle")}</h2>
            <p>{t("graph.emptyDescription")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="graph-stage"
      aria-label={t("graph.canvas", {
        mode: mode === "database" ? "DB ERD" : t("workspace.sourceGraph"),
      })}
    >
      <div
        className="graph-world"
        style={{
          width: layout.width * zoom,
          height: layout.height * zoom,
        }}
      >
        <div
          style={{
            position: "relative",
            width: layout.width,
            height: layout.height,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
          }}
        >
          <svg
            className="graph-edge-layer"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={t("graph.edgeCount", { count: edges.length })}
          >
            <defs>
              <marker
                id="arrow-default"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#71859a" />
              </marker>
              <marker
                id="arrow-write"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#ff9c7a" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const source = nodesById.get(edge.source);
              const target = nodesById.get(edge.target);
              if (!source || !target || source.id === target.id) return null;
              const path = pathBetween(source, target);
              const inferred = edge.kind === "query-relation" || edge.kind === "llm";
              const label = edge.kind === "llm" ? `LLM · ${confidenceLabel(edge.confidence)}` : edge.label;
              const labelWidth = Math.max(27, label.length * 6 + 10);
              return (
                <g key={edge.id}>
                  <path
                    d={path.d}
                    className={`edge-path is-${edge.kind}${inferred ? " is-inferred" : ""}`}
                    markerEnd={`url(#${edge.kind === "write" ? "arrow-write" : "arrow-default"})`}
                  />
                  <g className="edge-label" transform={`translate(${path.labelX}, ${path.labelY})`}>
                    <rect x={-labelWidth / 2} y={-9} width={labelWidth} height={18} rx={4} />
                    <text textAnchor="middle" dominantBaseline="central">
                      {label}
                    </text>
                  </g>
                </g>
              );
            })}
          </svg>

          {layout.nodes.map((node) => {
            const matches = nodeMatches(node, search);
            const selected = selectedId === node.id;
            const connectionCount = graphDegree(graph, node.id);
            return (
              <button
                type="button"
                key={node.id}
                className={`graph-node${selected ? " is-selected" : ""}${searchActive && !matches ? " is-muted" : ""}${searchActive && matches ? " is-highlighted" : ""}`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  minHeight: node.height,
                }}
                aria-label={t("graph.nodeLabel", {
                  type:
                    node.nodeType === "table"
                      ? t("graph.table")
                      : t("graph.sourceFile"),
                  title: node.title,
                  count: connectionCount,
                })}
                aria-pressed={selected}
                onClick={() => onSelect(node.id)}
              >
                <span className="node-header">
                  <span className="node-glyph">{node.nodeType === "table" ? "DB" : "<>"}</span>
                  <span className="node-title-wrap">
                    <span className="node-title">{node.title}</span>
                    <span className="node-subtitle">{node.subtitle}</span>
                  </span>
                  <span className="node-type">{node.nodeType === "table" ? "table" : "source"}</span>
                </span>

                {node.table ? (
                  <>
                    <span className="column-list">
                      {node.table.columns.slice(0, MAX_VISIBLE_COLUMNS).map((column) => (
                        <span className="column-row" key={column.id}>
                          <span className="column-key">
                            {column.primaryKey ? "PK" : column.references.length ? "FK" : column.unique ? "UQ" : ""}
                          </span>
                          <span className="column-name">{column.name}</span>
                          <span className="column-type">{column.dataType ?? "unknown"}</span>
                        </span>
                      ))}
                    </span>
                    {node.table.columns.length > MAX_VISIBLE_COLUMNS ? (
                      <span className="node-more">
                        {t("graph.moreColumns", {
                          count: node.table.columns.length - MAX_VISIBLE_COLUMNS,
                        })}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="source-node-body">
                    <span className="source-node-path">{node.file?.path}</span>
                    <span className="source-node-stats">
                      <span>{t("graph.read")} <strong>{node.readCount}</strong></span>
                      <span>{t("graph.write")} <strong>{node.writeCount}</strong></span>
                      <span>{t("graph.reference")} <strong>{node.importCount}</strong></span>
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="graph-legend" aria-label={t("graph.legend")}>
        <span className="legend-item"><span className="legend-line is-fk" /> FK</span>
        <span className="legend-item"><span className="legend-line is-read" /> READ</span>
        <span className="legend-item"><span className="legend-line is-write" /> WRITE</span>
        <span className="legend-item"><span className="legend-line is-inferred" /> {t("graph.inferred")}</span>
      </div>
      <span className="sr-only" aria-live="polite">
        {t("graph.updated", {
          nodes: layout.nodes.length,
          edges: edges.length,
        })}
      </span>
    </div>
  );
}
