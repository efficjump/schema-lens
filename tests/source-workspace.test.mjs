import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadSourceWorkspace() {
  const sourceUrl = new URL("../lib/source-workspace.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "source-workspace.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const sourceWorkspace = await loadSourceWorkspace();

test("source paths normalize separators and dot segments without permitting traversal", () => {
  assert.equal(
    sourceWorkspace.normalizeSourcePath("./src\\data//repositories/../project.ts"),
    "src/data/project.ts",
  );
  assert.equal(
    sourceWorkspace.normalizeSourcePath("src/cafe\u0301/query.sql"),
    "src/caf\u00e9/query.sql",
  );

  for (const unsafePath of [
    "",
    "/etc/passwd",
    "C:\\workspace\\secret.ts",
    "\\\\server\\share\\query.sql",
    "../outside.ts",
    "src/../../outside.ts",
    "src/secret\u0000.ts",
  ]) {
    assert.throws(() => sourceWorkspace.normalizeSourcePath(unsafePath));
  }
});

test("source tree is hierarchical, deterministic, folder-first, and rejects aliases", () => {
  const tree = sourceWorkspace.buildSourceTree([
    { path: "README.md", language: "markdown" },
    { path: "src/zeta.ts", language: "typescript" },
    { path: "src/data/query10.sql", language: "sql", fileId: "graph-file-10" },
    { path: "src/data/query2.sql", language: "sql" },
    { path: "database/schema.sql", language: "sql" },
  ]);

  assert.deepEqual(tree.map((node) => [node.kind, node.name]), [
    ["folder", "database"],
    ["folder", "src"],
    ["file", "README.md"],
  ]);
  const src = tree.find((node) => node.path === "src");
  assert.ok(src && src.kind === "folder");
  assert.deepEqual(src.children.map((node) => [node.kind, node.name]), [
    ["folder", "data"],
    ["file", "zeta.ts"],
  ]);
  const data = src.children[0];
  assert.ok(data.kind === "folder");
  assert.deepEqual(data.children.map((node) => node.name), ["query2.sql", "query10.sql"]);
  assert.equal(data.children[1].id, "graph-file-10");
  assert.equal(data.children[1].document.path, "src/data/query10.sql");

  assert.throws(() =>
    sourceWorkspace.buildSourceTree([
      { path: "src/data/../query.sql" },
      { path: "src/query.sql" },
    ]),
  );
});

test("tree filtering preserves ancestors and folder matches retain descendants", () => {
  const tree = sourceWorkspace.buildSourceTree([
    { path: "src/data/projectRepository.ts", language: "typescript" },
    { path: "src/data/taskRepository.ts", language: "typescript" },
    { path: "src/routes/projects.ts", language: "typescript" },
    { path: "database/schema.sql", language: "sql" },
  ]);

  const fileMatch = sourceWorkspace.filterSourceTree(tree, "taskrepository");
  assert.deepEqual(fileMatch.map((node) => node.path), ["src"]);
  assert.deepEqual(fileMatch[0].children.map((node) => node.path), ["src/data"]);
  assert.deepEqual(fileMatch[0].children[0].children.map((node) => node.path), [
    "src/data/taskRepository.ts",
  ]);

  const folderMatch = sourceWorkspace.filterSourceTree(tree, "data");
  const filteredSrc = folderMatch.find((node) => node.path === "src");
  assert.ok(filteredSrc && filteredSrc.kind === "folder");
  const data = filteredSrc.children.find((node) => node.path === "src/data");
  assert.ok(data && data.kind === "folder");
  assert.equal(data.children.length, 2);

  const languageMatch = sourceWorkspace.filterSourceTree(tree, "SQL");
  assert.deepEqual(languageMatch.map((node) => node.path), ["database"]);
  assert.deepEqual(tree[1].children.map((node) => node.path), ["src/data", "src/routes"]);
});

test("initial expansion collection observes the requested folder depth", () => {
  const tree = sourceWorkspace.buildSourceTree([
    { path: "src/app/api/tasks/route.ts" },
    { path: "database/migrations/001.sql" },
  ]);
  assert.deepEqual([...sourceWorkspace.collectExpandedFolders(tree)], ["database", "src"]);
  assert.deepEqual([...sourceWorkspace.collectExpandedFolders(tree, 2)], [
    "database",
    "database/migrations",
    "src",
    "src/app",
  ]);
  assert.deepEqual([...sourceWorkspace.collectExpandedFolders(tree, 0)], []);
});

test("line windows stay centered where possible and clamp at document edges", () => {
  assert.deepEqual(sourceWorkspace.calculateLineWindow(100, 50, 11), {
    startLine: 45,
    endLine: 55,
  });
  assert.deepEqual(sourceWorkspace.calculateLineWindow(100, 1, 10), {
    startLine: 1,
    endLine: 10,
  });
  assert.deepEqual(sourceWorkspace.calculateLineWindow(100, 1000, 10), {
    startLine: 91,
    endLine: 100,
  });
  assert.deepEqual(sourceWorkspace.calculateLineWindow(3, 2, 50), {
    startLine: 1,
    endLine: 3,
  });
  assert.deepEqual(sourceWorkspace.calculateLineWindow(0, Number.NaN, 0), {
    startLine: 1,
    endLine: 1,
  });
});

test("line offsets include an end sentinel and preserve a trailing empty line", () => {
  assert.deepEqual([...sourceWorkspace.buildLineStartOffsets("")], [0, 0]);
  assert.deepEqual([...sourceWorkspace.buildLineStartOffsets("single")], [0, 6]);

  const mixed = "alpha\r\nbeta\rgamma\n";
  const offsets = sourceWorkspace.buildLineStartOffsets(mixed);
  assert.deepEqual([...offsets], [0, 7, 12, 18, 18]);
  assert.equal(offsets.length - 1, 4);
});

test("indexed line slicing is 1-based, strips CR/LF, and handles boundaries safely", () => {
  const content = "alpha\r\nbeta\rgamma\n";
  const offsets = sourceWorkspace.buildLineStartOffsets(content);

  assert.equal(sourceWorkspace.sliceSourceLine(content, offsets, 1), "alpha");
  assert.equal(sourceWorkspace.sliceSourceLine(content, offsets, 2), "beta");
  assert.equal(sourceWorkspace.sliceSourceLine(content, offsets, 3), "gamma");
  assert.equal(sourceWorkspace.sliceSourceLine(content, offsets, 4), "");
  assert.equal(sourceWorkspace.sliceSourceLine(content, offsets, 0), "");
  assert.equal(sourceWorkspace.sliceSourceLine(content, offsets, 5), "");
  assert.equal(sourceWorkspace.sliceSourceLine(content, offsets, Number.NaN), "");
  assert.equal(
    sourceWorkspace.sliceSourceLine("short", new Uint32Array([0, 99]), 1),
    "",
  );
});

test("whole-source matching normalizes once, tracks line breaks, deduplicates lines, and honors limits", () => {
  const content = [
    "SELECT select FROM users",
    "Cafe\u0301 relation",
    "CAF\u00c9 RELATION relation",
    "\ufb03 compatibility prefix",
    "Target target",
  ].join("\r\n");

  assert.deepEqual(sourceWorkspace.findMatchingSourceLines(content, "select"), [1]);
  assert.deepEqual(sourceWorkspace.findMatchingSourceLines(content, "caf\u00e9"), [2, 3]);
  assert.deepEqual(sourceWorkspace.findMatchingSourceLines(content, "relation", 1), [2]);
  assert.deepEqual(sourceWorkspace.findMatchingSourceLines(content, "TARGET"), [5]);
  assert.deepEqual(sourceWorkspace.findMatchingSourceLines(content, "  "), []);
  assert.deepEqual(sourceWorkspace.findMatchingSourceLines(content, "relation", 0), []);

  assert.deepEqual(
    sourceWorkspace.findMatchingSourceLines("match\rnone\rMATCH\nmatch\n", "match"),
    [1, 3, 4],
  );
});

test("matching line collection is normalized, case-insensitive, bounded, and 1-based", () => {
  const lines = [
    "SELECT * FROM users",
    "no match",
    "select id from projects",
    "Cafe\u0301 relation",
    "CAF\u00c9 relation",
  ];
  assert.deepEqual(sourceWorkspace.findMatchingLines(lines, "select"), [1, 3]);
  assert.deepEqual(sourceWorkspace.findMatchingLines(lines, "caf\u00e9", 1), [4]);
  assert.deepEqual(sourceWorkspace.findMatchingLines(lines, "  "), []);
  assert.deepEqual(sourceWorkspace.findMatchingLines(lines, "relation", 0), []);
});
