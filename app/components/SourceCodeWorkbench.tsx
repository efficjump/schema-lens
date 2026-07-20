"use client";

import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildLineStartOffsets,
  calculateLineWindow,
  findMatchingSourceLines,
  sliceSourceLine,
} from "@/lib/source-workspace";

export type SourceDocumentStatus = "loading" | "ready" | "error";

/** A source document is always rendered as inert text and is never executed. */
export interface SourceCodeDocument {
  path: string;
  content?: string;
  language?: string;
  byteSize?: number;
  status?: SourceDocumentStatus;
  error?: string;
}

/** A one-based, inclusive source range to reveal in the active document. */
export interface SourceCodeLocation {
  path: string;
  startLine: number;
  endLine?: number;
  /** Changes when the same source range should be revealed again. */
  requestId?: number;
}

/** Evidence rendered in the code gutter. Line numbers are one-based and inclusive. */
export interface SourceCodeEvidence {
  id: string;
  path: string;
  startLine: number;
  endLine?: number;
  label?: string;
  kind?: string;
}

export interface SourceCodeWorkbenchProps {
  documents: readonly SourceCodeDocument[];
  activePath: string | null;
  location?: SourceCodeLocation | null;
  evidence?: readonly SourceCodeEvidence[];
  /** Maximum number of source lines mounted at once. */
  windowSize?: number;
  onActivateDocument: (path: string) => void;
  onCloseDocument: (path: string) => void;
  onRetryDocument?: (path: string) => void;
  onSelectEvidence?: (evidence: SourceCodeEvidence) => void;
  onSelectLocation?: (location: SourceCodeLocation) => void;
}

const DEFAULT_WINDOW_SIZE = 220;
const MIN_WINDOW_SIZE = 60;
const MAX_WINDOW_SIZE = 400;
const SEARCH_RESULT_LIMIT = 2_000;
const SEARCH_DEBOUNCE_MS = 180;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedLine(value: number | undefined, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value ?? fallback));
}

function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "크기 미상";
  if (value < 1_024) return `${Math.round(value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function documentStatus(document: SourceCodeDocument): SourceDocumentStatus {
  if (document.status) return document.status;
  if (document.error) return "error";
  return typeof document.content === "string" ? "ready" : "loading";
}

function tabDomId(prefix: string, index: number): string {
  return `${prefix}-tab-${index}`;
}

export function SourceCodeWorkbench({
  documents,
  activePath,
  location = null,
  evidence = [],
  windowSize = DEFAULT_WINDOW_SIZE,
  onActivateDocument,
  onCloseDocument,
  onRetryDocument,
  onSelectEvidence,
  onSelectLocation,
}: SourceCodeWorkbenchProps) {
  const idPrefix = useId().replace(/:/g, "");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const codeLinesRef = useRef<HTMLDivElement>(null);
  const [searchState, setSearchState] = useState({
    contextKey: "",
    query: "",
    matchIndex: 0,
  });
  const [windowFocusState, setWindowFocusState] = useState({
    contextKey: "",
    line: 1,
  });
  const [settledSearchState, setSettledSearchState] = useState({
    contextKey: "",
    query: "",
  });

  const activeDocument = useMemo(
    () => documents.find((document) => document.path === activePath) ?? null,
    [activePath, documents],
  );
  const hasActiveTab = activeDocument !== null;
  const resolvedActivePath = activeDocument?.path ?? null;
  const activeStatus = activeDocument ? documentStatus(activeDocument) : null;
  const content = activeStatus === "ready" ? activeDocument?.content ?? "" : "";
  const lineStarts = useMemo(() => buildLineStartOffsets(content), [content]);
  const totalLines = Math.max(1, lineStarts.length - 1);
  const boundedWindowSize = clamp(
    Math.trunc(windowSize || DEFAULT_WINDOW_SIZE),
    MIN_WINDOW_SIZE,
    MAX_WINDOW_SIZE,
  );

  let revealedRange: { startLine: number; endLine: number } | null = null;
  if (resolvedActivePath && location?.path === resolvedActivePath) {
    const startLine = clamp(normalizedLine(location.startLine), 1, totalLines);
    const endLine = clamp(
      normalizedLine(location.endLine, startLine),
      startLine,
      totalLines,
    );
    revealedRange = { startLine, endLine };
  }

  const viewContextKey = `${resolvedActivePath ?? ""}\u0000${
    revealedRange ? `${revealedRange.startLine}:${revealedRange.endLine}` : ""
  }\u0000${location?.requestId ?? ""}`;
  const searchQuery = searchState.contextKey === viewContextKey ? searchState.query : "";
  const settledSearchQuery = settledSearchState.contextKey === viewContextKey
    ? settledSearchState.query
    : "";
  const searchPending = searchQuery !== settledSearchQuery;
  const activeMatchIndex = searchState.contextKey === viewContextKey
    ? searchState.matchIndex
    : 0;
  const windowFocusLine = windowFocusState.contextKey === viewContextKey
    ? windowFocusState.line
    : revealedRange?.startLine ?? 1;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSettledSearchState({ contextKey: viewContextKey, query: searchQuery });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [searchQuery, viewContextKey]);

  const rawMatchingLines = useMemo(
    () =>
      searchPending
        ? []
        : findMatchingSourceLines(content, settledSearchQuery, SEARCH_RESULT_LIMIT + 1),
    [content, searchPending, settledSearchQuery],
  );
  const searchTruncated = rawMatchingLines.length > SEARCH_RESULT_LIMIT;
  const matchingLines = searchTruncated
    ? rawMatchingLines.slice(0, SEARCH_RESULT_LIMIT)
    : rawMatchingLines;
  const currentMatchLine = matchingLines.length
    ? matchingLines[clamp(activeMatchIndex, 0, matchingLines.length - 1)]
    : null;
  const effectiveFocusLine = currentMatchLine ?? windowFocusLine;
  const lineWindow = calculateLineWindow(
    totalLines,
    clamp(normalizedLine(effectiveFocusLine), 1, totalLines),
    boundedWindowSize,
  );
  const visibleLines = useMemo(
    () =>
      Array.from(
        { length: lineWindow.endLine - lineWindow.startLine + 1 },
        (_, offset) => sliceSourceLine(content, lineStarts, lineWindow.startLine + offset),
      ),
    [content, lineStarts, lineWindow.endLine, lineWindow.startLine],
  );

  const evidenceByLine = useMemo(() => {
    const byLine = new Map<number, SourceCodeEvidence[]>();
    if (!resolvedActivePath) return byLine;
    for (const item of evidence) {
      if (item.path !== resolvedActivePath) continue;
      const line = clamp(normalizedLine(item.startLine), 1, totalLines);
      const current = byLine.get(line) ?? [];
      current.push(item);
      byLine.set(line, current);
    }
    return byLine;
  }, [evidence, resolvedActivePath, totalLines]);

  const matchSet = useMemo(() => new Set(matchingLines), [matchingLines]);

  useLayoutEffect(() => {
    if (activeStatus !== "ready") return;
    const frame = requestAnimationFrame(() => {
      const container = codeLinesRef.current;
      if (!container) return;
      const row = container.querySelector<HTMLElement>(
        `[data-line="${effectiveFocusLine}"]`,
      );
      if (!row) return;

      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const centeredTop =
        container.scrollTop +
        (rowRect.top - containerRect.top) -
        (container.clientHeight - rowRect.height) / 2;
      const maximumTop = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTop = clamp(centeredTop, 0, maximumTop);
    });

    return () => cancelAnimationFrame(frame);
  }, [
    activeStatus,
    effectiveFocusLine,
    lineWindow.endLine,
    lineWindow.startLine,
    viewContextKey,
  ]);

  function activateMatch(direction: 1 | -1) {
    if (!matchingLines.length) return;
    const next = (activeMatchIndex + direction + matchingLines.length) % matchingLines.length;
    setSearchState({ contextKey: viewContextKey, query: searchQuery, matchIndex: next });
    setWindowFocusState({ contextKey: viewContextKey, line: matchingLines[next] });
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      activateMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && searchQuery) {
      event.preventDefault();
      setSearchState({ contextKey: viewContextKey, query: "", matchIndex: 0 });
    }
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    document: SourceCodeDocument,
    index: number,
  ) {
    let targetIndex: number | null = null;
    if (event.key === "ArrowRight") targetIndex = (index + 1) % documents.length;
    if (event.key === "ArrowLeft") targetIndex = (index - 1 + documents.length) % documents.length;
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = documents.length - 1;

    if (targetIndex !== null) {
      event.preventDefault();
      const target = documents[targetIndex];
      onActivateDocument(target.path);
      requestAnimationFrame(() => tabRefs.current.get(target.path)?.focus());
      return;
    }

    if (event.key === "Delete") {
      event.preventDefault();
      closeAndFocusAdjacent(document, index);
    }
  }

  function closeAndFocusAdjacent(document: SourceCodeDocument, index: number) {
    const adjacentDocument = documents[index + 1] ?? documents[index - 1];
    onCloseDocument(document.path);
    if (adjacentDocument) {
      requestAnimationFrame(() => tabRefs.current.get(adjacentDocument.path)?.focus());
    }
  }

  function moveWindow(direction: 1 | -1) {
    const nextFocus = clamp(
      windowFocusLine + direction * boundedWindowSize,
      1,
      totalLines,
    );
    setSearchState({ contextKey: viewContextKey, query: "", matchIndex: 0 });
    setWindowFocusState({ contextKey: viewContextKey, line: nextFocus });
  }

  if (!documents.length) {
    return (
      <section className="code-workbench code-empty" aria-label="소스 코드 작업 영역">
        <div className="code-state">
          <strong>열린 소스 파일이 없습니다</strong>
          <p>소스 트리에서 파일을 선택하거나 근거의 파일 위치를 열어 주세요.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="code-workbench" aria-label="소스 코드 작업 영역">
      <div className="code-tabs" role="tablist" aria-label="열린 소스 파일">
        {documents.map((document, index) => {
          const selected = document.path === activePath;
          const keyboardCurrent = selected || (!hasActiveTab && index === 0);
          const name = basename(document.path);
          return (
            <div className={`code-tab${selected ? " is-active" : ""}`} role="presentation" key={document.path}>
              <button
                ref={(node) => {
                  if (node) tabRefs.current.set(document.path, node);
                  else tabRefs.current.delete(document.path);
                }}
                id={tabDomId(idPrefix, index)}
                className="code-tab-activate"
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${idPrefix}-panel`}
                aria-keyshortcuts="Delete"
                tabIndex={keyboardCurrent ? 0 : -1}
                title={document.path}
                onClick={() => onActivateDocument(document.path)}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  onCloseDocument(document.path);
                }}
                onKeyDown={(event) => handleTabKeyDown(event, document, index)}
              >
                <span className="code-tab-name">{name}</span>
                {documentStatus(document) === "error" ? (
                  <span className="code-tab-status" aria-label="불러오기 오류">!</span>
                ) : documentStatus(document) === "loading" ? (
                  <span className="code-tab-status" aria-label="불러오는 중">…</span>
                ) : null}
              </button>
              <button
                className="code-tab-close"
                type="button"
                tabIndex={-1}
                aria-label={`${name} 탭 닫기`}
                title="탭 닫기"
                onClick={() => closeAndFocusAdjacent(document, index)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {!activeDocument ? (
        <div className="code-state code-state-missing" role="status">
          <strong>활성 파일을 찾을 수 없습니다</strong>
          <p>열린 탭에서 파일을 다시 선택해 주세요.</p>
        </div>
      ) : (
        <div
          id={`${idPrefix}-panel`}
          className="code-panel"
          role="tabpanel"
          aria-labelledby={tabDomId(
            idPrefix,
            documents.findIndex((document) => document.path === activeDocument.path),
          )}
        >
          <header className="code-header">
            <div className="code-file-context">
              <nav className="code-breadcrumb" aria-label="소스 파일 경로">
                {activeDocument.path.split("/").filter(Boolean).map((segment, index, segments) => (
                  <span className="code-breadcrumb-part" key={`${segment}-${index}`}>
                    <span>{segment}</span>
                    {index < segments.length - 1 ? <span className="code-breadcrumb-separator" aria-hidden="true">/</span> : null}
                  </span>
                ))}
              </nav>
              <div className="code-meta">
                <span>{activeDocument.language || "plain text"}</span>
                <span>{totalLines.toLocaleString()}줄</span>
                <span>{formatBytes(activeDocument.byteSize ?? content.length)}</span>
                {revealedRange ? (
                  <span>선택 {revealedRange.startLine}–{revealedRange.endLine}행</span>
                ) : null}
              </div>
            </div>

            {activeStatus === "ready" ? (
              <div className="code-search" role="search">
                <label className="code-search-label">
                  <span className="code-sr-only">현재 파일에서 검색</span>
                  <input
                    className="code-search-input"
                    type="search"
                    value={searchQuery}
                    placeholder="파일 내 검색"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setSearchState({
                      contextKey: viewContextKey,
                      query: event.target.value,
                      matchIndex: 0,
                    })}
                    onKeyDown={handleSearchKeyDown}
                  />
                </label>
                <output
                  className="code-search-count"
                  aria-live="polite"
                  title={searchTruncated ? `검색 결과가 ${SEARCH_RESULT_LIMIT.toLocaleString()}개를 초과해 앞부분만 표시합니다.` : undefined}
                >
                  {searchQuery
                    ? searchPending
                      ? "검색 중…"
                      : matchingLines.length
                      ? `${clamp(activeMatchIndex, 0, matchingLines.length - 1) + 1}/${matchingLines.length}${searchTruncated ? "+" : ""}`
                      : "결과 없음"
                    : ""}
                </output>
                <button
                  className="code-search-action"
                  type="button"
                  aria-label="이전 검색 결과"
                  disabled={!matchingLines.length}
                  onClick={() => activateMatch(-1)}
                >
                  ↑
                </button>
                <button
                  className="code-search-action"
                  type="button"
                  aria-label="다음 검색 결과"
                  disabled={!matchingLines.length}
                  onClick={() => activateMatch(1)}
                >
                  ↓
                </button>
              </div>
            ) : null}
          </header>

          {activeStatus === "loading" ? (
            <div className="code-state code-state-loading" role="status" aria-live="polite">
              <strong>소스 파일을 불러오는 중입니다</strong>
              <p>{activeDocument.path}</p>
            </div>
          ) : activeStatus === "error" ? (
            <div className="code-state code-state-error" role="alert">
              <strong>소스 파일을 열지 못했습니다</strong>
              <p>{activeDocument.error || "브라우저가 이 파일을 읽지 못했습니다."}</p>
              {onRetryDocument ? (
                <button className="code-state-action" type="button" onClick={() => onRetryDocument(activeDocument.path)}>
                  다시 시도
                </button>
              ) : null}
            </div>
          ) : content.length === 0 ? (
            <div className="code-state code-state-empty" role="status">
              <strong>빈 파일입니다</strong>
              <p>표시할 소스 코드가 없습니다.</p>
            </div>
          ) : (
            <div className="code-viewer">
              <div className="code-window-toolbar">
                <button
                  className="code-window-action"
                  type="button"
                  disabled={lineWindow.startLine <= 1}
                  onClick={() => moveWindow(-1)}
                >
                  이전 구간
                </button>
                <span className="code-window-status" aria-live="polite">
                  {lineWindow.startLine.toLocaleString()}–{lineWindow.endLine.toLocaleString()} / {totalLines.toLocaleString()}줄
                </span>
                <button
                  className="code-window-action"
                  type="button"
                  disabled={lineWindow.endLine >= totalLines}
                  onClick={() => moveWindow(1)}
                >
                  다음 구간
                </button>
              </div>

              <div
                ref={codeLinesRef}
                className="code-lines"
                role="region"
                aria-label={`${activeDocument.path} 읽기 전용 소스 코드`}
                tabIndex={0}
              >
                <code className="code-content" dir="ltr" translate="no">
                  {visibleLines.map((line, offset) => {
                    const lineNumber = lineWindow.startLine + offset;
                    const lineEvidence = evidenceByLine.get(lineNumber) ?? [];
                    const inRevealedRange = Boolean(
                      revealedRange &&
                      lineNumber >= revealedRange.startLine &&
                      lineNumber <= revealedRange.endLine,
                    );
                    const isSearchMatch = matchSet.has(lineNumber);
                    const isCurrentMatch = currentMatchLine === lineNumber;
                    const rowClass = [
                      "code-line",
                      inRevealedRange ? "is-revealed" : "",
                      isSearchMatch ? "is-search-match" : "",
                      isCurrentMatch ? "is-current-match" : "",
                    ].filter(Boolean).join(" ");

                    return (
                      <span className={rowClass} key={lineNumber} data-line={lineNumber}>
                        <span className="code-evidence-gutter">
                          {lineEvidence.map((item) =>
                            onSelectEvidence ? (
                              <button
                                className="code-evidence-marker"
                                type="button"
                                key={item.id}
                                title={item.label || `${item.startLine}행 근거`}
                                aria-label={item.label || `${lineNumber}행의 ${item.kind || "분석"} 근거`}
                                onClick={() => onSelectEvidence(item)}
                              >
                                <span aria-hidden="true">●</span>
                              </button>
                            ) : (
                              <span
                                className="code-evidence-marker"
                                key={item.id}
                                title={item.label || `${item.startLine}행 근거`}
                                aria-hidden="true"
                              >
                                ●
                              </span>
                            ),
                          )}
                        </span>
                        {onSelectLocation ? (
                          <button
                            className="code-line-number"
                            type="button"
                            aria-label={`${lineNumber}행 선택`}
                            aria-pressed={inRevealedRange}
                            onClick={() => onSelectLocation({
                              path: activeDocument.path,
                              startLine: lineNumber,
                              endLine: lineNumber,
                            })}
                          >
                            {lineNumber}
                          </button>
                        ) : (
                          <span className="code-line-number" aria-hidden="true">{lineNumber}</span>
                        )}
                        <span className="code-line-text">{line}</span>
                      </span>
                    );
                  })}
                </code>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
