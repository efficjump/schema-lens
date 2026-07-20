/**
 * Pure helpers for presenting browser-selected source files as an IDE-like
 * workspace. Full source content deliberately stays outside these structures.
 */

export interface SourceDocumentDescriptor {
  path: string;
  name?: string;
  language?: string;
  size?: number;
  fileId?: string;
}

export interface SourceTreeFolderNode {
  kind: "folder";
  id: string;
  name: string;
  path: string;
  children: SourceTreeNode[];
}

export interface SourceTreeFileNode {
  kind: "file";
  id: string;
  name: string;
  path: string;
  document: SourceDocumentDescriptor;
}

export type SourceTreeNode = SourceTreeFolderNode | SourceTreeFileNode;

interface MutableFolder {
  path: string;
  name: string;
  folders: Map<string, MutableFolder>;
  files: Map<string, SourceTreeFileNode>;
}

const DEFAULT_LINE_WINDOW_SIZE = 240;

function compareTreeNames(a: string, b: string): number {
  return (
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) ||
    a.localeCompare(b)
  );
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

/**
 * Convert a user-selected path to one canonical, safe, relative path.
 *
 * The helper accepts either path separator, removes redundant separators and
 * dot segments, and resolves parent segments that remain inside the selected
 * root. It rejects absolute, drive-qualified, control-character, empty, and
 * root-escaping paths instead of silently turning them into a different file.
 */
export function normalizeSourcePath(path: string): string {
  if (typeof path !== "string") {
    throw new TypeError("Source path must be a string.");
  }
  if (!path.length) {
    throw new Error("Source path must not be empty.");
  }
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error("Source path must not contain control characters.");
  }

  const slashPath = path.replace(/\\/g, "/").normalize("NFC");
  if (slashPath.startsWith("/") || /^[A-Za-z]:/u.test(slashPath)) {
    throw new Error("Source path must be relative to the selected project.");
  }

  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) {
        throw new Error("Source path must not escape the selected project.");
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  if (!parts.length) {
    throw new Error("Source path must identify a file inside the project.");
  }
  return parts.join("/");
}

function createMutableFolder(path: string, name: string): MutableFolder {
  return {
    path,
    name,
    folders: new Map(),
    files: new Map(),
  };
}

function materializeFolder(folder: MutableFolder): SourceTreeNode[] {
  const folders: SourceTreeFolderNode[] = Array.from(folder.folders.values())
    .sort((a, b) => compareTreeNames(a.name, b.name))
    .map((child) => ({
      kind: "folder",
      id: `folder:${child.path}`,
      name: child.name,
      path: child.path,
      children: materializeFolder(child),
    }));
  const files = Array.from(folder.files.values()).sort((a, b) =>
    compareTreeNames(a.name, b.name),
  );
  return [...folders, ...files];
}

/** Build a deterministic hierarchy with folders before files at every level. */
export function buildSourceTree(
  documents: readonly SourceDocumentDescriptor[],
): SourceTreeNode[] {
  const root = createMutableFolder("", "");
  const canonicalPaths = new Set<string>();

  for (const descriptor of documents) {
    const path = normalizeSourcePath(descriptor.path);
    if (canonicalPaths.has(path)) {
      throw new Error(`Duplicate source path after normalization: ${path}`);
    }
    canonicalPaths.add(path);

    const parts = path.split("/");
    const fileName = parts.pop();
    if (!fileName) continue;

    let parent = root;
    let parentPath = "";
    for (const folderName of parts) {
      parentPath = parentPath ? `${parentPath}/${folderName}` : folderName;
      let folder = parent.folders.get(folderName);
      if (!folder) {
        folder = createMutableFolder(parentPath, folderName);
        parent.folders.set(folderName, folder);
      }
      parent = folder;
    }

    const document: SourceDocumentDescriptor = {
      ...descriptor,
      path,
      name: fileName,
    };
    parent.files.set(fileName, {
      kind: "file",
      id: descriptor.fileId || `file:${path}`,
      name: fileName,
      path,
      document,
    });
  }

  return materializeFolder(root);
}

function cloneTree(nodes: readonly SourceTreeNode[]): SourceTreeNode[] {
  return nodes.map((node) =>
    node.kind === "folder"
      ? { ...node, children: cloneTree(node.children) }
      : { ...node, document: { ...node.document } },
  );
}

/**
 * Filter file/folder names and paths while retaining every ancestor required
 * to locate a match. Matching a folder keeps its complete subtree visible.
 */
export function filterSourceTree(
  nodes: readonly SourceTreeNode[],
  query: string,
): SourceTreeNode[] {
  const term = normalizedSearchText(query.trim());
  if (!term) return cloneTree(nodes);

  const visit = (node: SourceTreeNode): SourceTreeNode | undefined => {
    const nodeText = normalizedSearchText(
      node.kind === "file"
        ? `${node.name}\n${node.path}\n${node.document.language ?? ""}`
        : `${node.name}\n${node.path}`,
    );
    if (nodeText.includes(term)) {
      return node.kind === "folder"
        ? { ...node, children: cloneTree(node.children) }
        : { ...node, document: { ...node.document } };
    }
    if (node.kind === "file") return undefined;

    const children = node.children
      .map(visit)
      .filter((child): child is SourceTreeNode => Boolean(child));
    return children.length ? { ...node, children } : undefined;
  };

  return nodes.map(visit).filter((node): node is SourceTreeNode => Boolean(node));
}

/** Collect folder paths that should start expanded up to the requested depth. */
export function collectExpandedFolders(
  nodes: readonly SourceTreeNode[],
  maxDepth = 1,
): Set<string> {
  const expanded = new Set<string>();
  const depthLimit = Number.isFinite(maxDepth)
    ? Math.max(0, Math.floor(maxDepth))
    : 1;

  const visit = (items: readonly SourceTreeNode[], depth: number) => {
    for (const node of items) {
      if (node.kind !== "folder") continue;
      if (depth < depthLimit) expanded.add(node.path);
      if (depth + 1 < depthLimit) visit(node.children, depth + 1);
    }
  };
  visit(nodes, 0);
  return expanded;
}

/** Return a centered, inclusive, 1-based line window clamped to the document. */
export function calculateLineWindow(
  totalLines: number,
  focusLine: number,
  windowSize = DEFAULT_LINE_WINDOW_SIZE,
): { startLine: number; endLine: number } {
  const lineCount = Number.isFinite(totalLines)
    ? Math.max(1, Math.floor(totalLines))
    : 1;
  const focus = Number.isFinite(focusLine)
    ? Math.min(lineCount, Math.max(1, Math.floor(focusLine)))
    : 1;
  const requestedSize = Number.isFinite(windowSize)
    ? Math.max(1, Math.floor(windowSize))
    : lineCount;
  const size = Math.min(lineCount, requestedSize);
  const linesBeforeFocus = Math.floor((size - 1) / 2);
  let startLine = focus - linesBeforeFocus;
  let endLine = startLine + size - 1;

  if (startLine < 1) {
    endLine += 1 - startLine;
    startLine = 1;
  }
  if (endLine > lineCount) {
    startLine = Math.max(1, lineCount - size + 1);
    endLine = lineCount;
  }
  return { startLine, endLine };
}

/**
 * Build a compact, random-access line index for a source string.
 *
 * Every entry except the last is the UTF-16 offset of a line start. The final
 * entry is an end sentinel equal to `content.length`. CRLF is treated as one
 * line break, while lone CR and LF are also supported. A trailing line break
 * therefore produces a final empty line whose start equals the sentinel.
 */
export function buildLineStartOffsets(content: string): Uint32Array {
  if (content.length > 0xffffffff) {
    throw new RangeError("Source content is too large for a Uint32 line index.");
  }

  let lineCount = 1;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 13) {
      lineCount += 1;
      if (content.charCodeAt(index + 1) === 10) index += 1;
    } else if (code === 10) {
      lineCount += 1;
    }
  }

  const offsets = new Uint32Array(lineCount + 1);
  let nextLine = 1;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 13) {
      if (content.charCodeAt(index + 1) === 10) index += 1;
      offsets[nextLine] = index + 1;
      nextLine += 1;
    } else if (code === 10) {
      offsets[nextLine] = index + 1;
      nextLine += 1;
    }
  }
  offsets[offsets.length - 1] = content.length;
  return offsets;
}

/**
 * Slice one 1-based line from an indexed source string without its CR/LF.
 * Invalid line numbers or an incompatible offset index safely return "".
 */
export function sliceSourceLine(
  content: string,
  lineStarts: Uint32Array,
  lineNumber: number,
): string {
  if (
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    lineStarts.length < 2 ||
    lineNumber >= lineStarts.length
  ) {
    return "";
  }

  const start = lineStarts[lineNumber - 1];
  let end = lineStarts[lineNumber];
  if (start > end || end > content.length) return "";

  if (end > start && content.charCodeAt(end - 1) === 10) end -= 1;
  if (end > start && content.charCodeAt(end - 1) === 13) end -= 1;
  return content.slice(start, end);
}

/**
 * Search source text with one whole-document normalization pass and return the
 * unique 1-based lines on which matches begin. This avoids allocating and
 * normalizing a string for every source line.
 */
export function findMatchingSourceLines(
  content: string,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): number[] {
  const term = normalizedSearchText(query.trim());
  if (!term) return [];

  const matchLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : Number.POSITIVE_INFINITY;
  if (!matchLimit) return [];

  const normalizedContent = normalizedSearchText(content);
  const matches: number[] = [];
  let searchFrom = 0;
  let trackedUntil = 0;
  let currentLine = 1;
  let lastMatchedLine = 0;

  while (searchFrom <= normalizedContent.length - term.length) {
    const matchIndex = normalizedContent.indexOf(term, searchFrom);
    if (matchIndex < 0) break;

    while (trackedUntil < matchIndex) {
      const code = normalizedContent.charCodeAt(trackedUntil);
      if (code === 13) {
        currentLine += 1;
        if (
          trackedUntil + 1 < matchIndex &&
          normalizedContent.charCodeAt(trackedUntil + 1) === 10
        ) {
          trackedUntil += 1;
        }
      } else if (code === 10) {
        currentLine += 1;
      }
      trackedUntil += 1;
    }

    if (currentLine !== lastMatchedLine) {
      matches.push(currentLine);
      lastMatchedLine = currentLine;
      if (matches.length >= matchLimit) break;
    }
    searchFrom = matchIndex + Math.max(1, term.length);
  }

  return matches;
}

/** Find plain-text matches and return their 1-based line numbers. */
export function findMatchingLines(
  lines: readonly string[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
): number[] {
  const term = normalizedSearchText(query.trim());
  if (!term) return [];
  const matchLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : Number.POSITIVE_INFINITY;
  if (!matchLimit) return [];

  const matches: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizedSearchText(String(lines[index])).includes(term)) {
      matches.push(index + 1);
      if (matches.length >= matchLimit) break;
    }
  }
  return matches;
}
