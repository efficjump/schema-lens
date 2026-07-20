"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildSourceTree,
  filterSourceTree,
  type SourceDocumentDescriptor,
  type SourceTreeNode,
} from "@/lib/source-workspace";

interface VisibleTreeRow {
  node: SourceTreeNode;
  level: number;
  parentPath: string | null;
}

const MAX_VISIBLE_TREE_ROWS = 800;

export interface SourceTreeProps {
  documents: readonly SourceDocumentDescriptor[];
  query: string;
  expandedFolders: ReadonlySet<string>;
  activePath: string | null;
  selectedPath?: string | null;
  analysisPaths?: ReadonlySet<string>;
  unavailablePaths?: ReadonlySet<string>;
  connectionCountByPath?: ReadonlyMap<string, number>;
  onToggleFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function flattenTree(
  nodes: readonly SourceTreeNode[],
  expandedFolders: ReadonlySet<string>,
  revealAll: boolean,
  level = 1,
  parentPath: string | null = null,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];
  nodes.forEach((node) => {
    rows.push({ node, level, parentPath });
    if (node.kind === "folder" && (revealAll || expandedFolders.has(node.path))) {
      rows.push(
        ...flattenTree(node.children, expandedFolders, revealAll, level + 1, node.path),
      );
    }
  });
  return rows;
}

function fileGlyph(document: SourceDocumentDescriptor): string {
  const extension = document.name?.includes(".")
    ? document.name.split(".").pop()
    : document.language;
  return (extension || "TXT").slice(0, 3).toLocaleUpperCase();
}

export function SourceTree({
  documents,
  query,
  expandedFolders,
  activePath,
  selectedPath = null,
  analysisPaths = new Set<string>(),
  unavailablePaths = new Set<string>(),
  connectionCountByPath = new Map<string, number>(),
  onToggleFolder,
  onOpenFile,
}: SourceTreeProps) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedPath, setFocusedPath] = useState<string | null>(activePath);
  const fullTree = useMemo(() => buildSourceTree(documents), [documents]);
  const filteredTree = useMemo(() => filterSourceTree(fullTree, query), [fullTree, query]);
  const allRows = useMemo(
    () => flattenTree(filteredTree, expandedFolders, Boolean(query.trim())),
    [expandedFolders, filteredTree, query],
  );
  const rows = useMemo(
    () => allRows.slice(0, MAX_VISIBLE_TREE_ROWS),
    [allRows],
  );
  const hiddenRowCount = Math.max(0, allRows.length - rows.length);
  const rovingPath = focusedPath && rows.some((row) => row.node.path === focusedPath)
    ? focusedPath
    : activePath && rows.some((row) => row.node.path === activePath)
      ? activePath
      : rows[0]?.node.path ?? null;

  function focusRow(path: string) {
    setFocusedPath(path);
    requestAnimationFrame(() => buttonRefs.current.get(path)?.focus());
  }

  function handleTreeKeyDown(event: KeyboardEvent<HTMLButtonElement>, rowIndex: number) {
    const row = rows[rowIndex];
    if (!row) return;
    let targetPath: string | null = null;

    if (event.key === "ArrowDown") targetPath = rows[Math.min(rows.length - 1, rowIndex + 1)]?.node.path ?? null;
    if (event.key === "ArrowUp") targetPath = rows[Math.max(0, rowIndex - 1)]?.node.path ?? null;
    if (event.key === "Home") targetPath = rows[0]?.node.path ?? null;
    if (event.key === "End") targetPath = rows.at(-1)?.node.path ?? null;

    if (event.key === "ArrowRight" && row.node.kind === "folder") {
      if (!expandedFolders.has(row.node.path) && !query.trim()) {
        onToggleFolder(row.node.path);
      } else {
        targetPath = rows[rowIndex + 1]?.level === row.level + 1
          ? rows[rowIndex + 1].node.path
          : null;
      }
    }

    if (event.key === "ArrowLeft") {
      if (
        row.node.kind === "folder" &&
        expandedFolders.has(row.node.path) &&
        !query.trim()
      ) {
        onToggleFolder(row.node.path);
      } else {
        targetPath = row.parentPath;
      }
    }

    if (targetPath) {
      event.preventDefault();
      focusRow(targetPath);
    } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
    }
  }

  if (!rows.length) {
    return (
      <div className="source-tree-empty" role="status">
        {query.trim() ? "일치하는 파일이 없습니다." : "표시할 소스 파일이 없습니다."}
      </div>
    );
  }

  return (
    <div className="source-tree" role="tree" aria-label="프로젝트 소스 트리">
      {rows.map((row, index) => {
        const node = row.node;
        const isFolder = node.kind === "folder";
        const isExpanded = isFolder && (Boolean(query.trim()) || expandedFolders.has(node.path));
        const isActive = !isFolder && node.path === activePath;
        const isSelected = !isFolder && node.path === selectedPath;
        const unavailable = !isFolder && unavailablePaths.has(node.path);
        const analysisIncluded = !isFolder && analysisPaths.has(node.path);
        const connectionCount = !isFolder ? connectionCountByPath.get(node.path) ?? 0 : 0;
        const label = isFolder ? node.name : node.document.name || node.name;

        return (
          <button
            ref={(element) => {
              if (element) buttonRefs.current.set(node.path, element);
              else buttonRefs.current.delete(node.path);
            }}
            type="button"
            role="treeitem"
            aria-level={row.level}
            aria-expanded={isFolder ? isExpanded : undefined}
            aria-selected={!isFolder ? isActive : undefined}
            aria-label={unavailable ? `${label}, 텍스트 미리보기 불가` : label}
            className={`source-tree-row${isActive ? " is-active" : ""}${isSelected ? " is-related" : ""}${unavailable ? " is-unavailable" : ""}`}
            style={{ "--tree-depth": row.level - 1 } as CSSProperties}
            tabIndex={rovingPath === node.path ? 0 : -1}
            key={node.id}
            title={node.path}
            onFocus={() => setFocusedPath(node.path)}
            onKeyDown={(event) => handleTreeKeyDown(event, index)}
            onClick={() => {
              if (isFolder) onToggleFolder(node.path);
              else onOpenFile(node.path);
            }}
          >
            <span className="source-tree-chevron" aria-hidden="true">
              {isFolder ? (isExpanded ? "⌄" : "›") : ""}
            </span>
            <span className={`source-tree-glyph${isFolder ? " is-folder" : ""}`} aria-hidden="true">
              {isFolder ? "DIR" : fileGlyph(node.document)}
            </span>
            <span className="source-tree-name">{label}</span>
            {!isFolder ? (
              <span className="source-tree-meta" aria-label={`${connectionCount}개 관계`}>
                {analysisIncluded ? "A" : ""}{connectionCount ? ` · ${connectionCount}` : ""}
              </span>
            ) : null}
          </button>
        );
      })}
      {hiddenRowCount ? (
        <div className="source-tree-limit" role="status">
          성능을 위해 {rows.length.toLocaleString()}개 항목만 표시했습니다. 나머지 {hiddenRowCount.toLocaleString()}개는 검색어로 좁혀 보세요.
        </div>
      ) : null}
    </div>
  );
}
