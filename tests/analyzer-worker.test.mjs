import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadWorkerClient() {
  const sourceUrl = new URL("../lib/analyzer-worker-client.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "analyzer-worker-client.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const workerClient = await loadWorkerClient();

function emptyGraph() {
  return {
    version: 1,
    tables: [],
    files: [],
    symbols: [],
    nodes: [],
    edges: [],
    evidence: [],
    warnings: [],
    stats: {},
  };
}

class MockWorker {
  static instances = [];
  static mode = "success";

  listeners = new Map();
  posted = [];
  terminateCount = 0;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    MockWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  postMessage(message) {
    this.posted.push(message);
    if (MockWorker.mode === "pending") return;
    queueMicrotask(() => {
      if (MockWorker.mode === "success") {
        this.emit("message", {
          data: {
            type: "analysis-result",
            version: 1,
            requestId: message.requestId,
            ok: true,
            graph: emptyGraph(),
          },
        });
      } else if (MockWorker.mode === "error-response") {
        this.emit("message", {
          data: {
            type: "analysis-result",
            version: 1,
            requestId: message.requestId,
            ok: false,
            error: {
              code: "ANALYSIS_FAILED",
              message: "safe failure\u0000 detail",
            },
          },
        });
      }
    });
  }

  terminate() {
    this.terminateCount += 1;
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

async function withMockBrowser(callback) {
  const OriginalWorker = globalThis.Worker;
  const OriginalUrl = globalThis.URL;
  globalThis.Worker = MockWorker;
  globalThis.URL = class MockUrl {
    constructor(path, base) {
      this.href = `${String(base)}#${String(path)}`;
    }
  };
  try {
    await callback();
  } finally {
    globalThis.Worker = OriginalWorker;
    globalThis.URL = OriginalUrl;
    MockWorker.instances.length = 0;
    MockWorker.mode = "success";
  }
}

test("worker response validation accepts only the typed protocol", () => {
  assert.equal(workerClient.isAnalyzerWorkerResponse({}), false);
  assert.equal(
    workerClient.isAnalyzerWorkerResponse({
      type: "analysis-result",
      version: 1,
      requestId: "request-1",
      ok: true,
      graph: emptyGraph(),
    }),
    true,
  );
  assert.equal(
    workerClient.isAnalyzerWorkerResponse({
      type: "analysis-result",
      version: 2,
      requestId: "request-1",
      ok: true,
      graph: emptyGraph(),
    }),
    false,
  );
});

test("client terminates its module worker and removes listeners after success", async () => {
  await withMockBrowser(async () => {
    const graph = await workerClient.analyzeSourceProjectInWorker([
      { path: "schema.sql", content: "CREATE TABLE users (id INT);" },
    ]);
    assert.equal(graph.version, 1);
    const worker = MockWorker.instances[0];
    assert.equal(worker.options.type, "module");
    assert.equal(worker.terminateCount, 1);
    assert.equal(worker.listenerCount(), 0);
    assert.equal(worker.posted[0].type, "analyze-source-project");
  });
});

test("client sanitizes worker errors and cleans up the failed worker", async () => {
  await withMockBrowser(async () => {
    MockWorker.mode = "error-response";
    await assert.rejects(
      workerClient.analyzeSourceProjectInWorker([]),
      (error) => {
        assert.equal(error.message, "safe failure detail");
        return true;
      },
    );
    const worker = MockWorker.instances[0];
    assert.equal(worker.terminateCount, 1);
    assert.equal(worker.listenerCount(), 0);
  });
});

test("AbortSignal rejects with AbortError and cleans up the pending worker", async () => {
  await withMockBrowser(async () => {
    MockWorker.mode = "pending";
    const controller = new AbortController();
    const analysis = workerClient.analyzeSourceProjectInWorker([], {
      signal: controller.signal,
    });
    controller.abort("untrusted abort reason");
    await assert.rejects(analysis, (error) => error.name === "AbortError");
    const worker = MockWorker.instances[0];
    assert.equal(worker.terminateCount, 1);
    assert.equal(worker.listenerCount(), 0);
  });
});

test("worker entry statically imports the analyzer and never forwards stacks", async () => {
  const workerSource = await readFile(
    new URL("../app/workers/analyzer.worker.ts", import.meta.url),
    "utf8",
  );
  assert.match(workerSource, /from "\.\.\/\.\.\/lib\/analyzer"/);
  assert.match(workerSource, /analyzeSourceProject\(event\.data\.inputs\)/);
  assert.doesNotMatch(workerSource, /\.stack\b|eval\s*\(|new Function/);
});
