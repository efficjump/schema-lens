import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: path === "/" ? "text/html" : "application/json" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Schema Lens workspace and social metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Schema Lens[^<]*<\/title>/i);
  assert.match(html, /DB ERD/);
  assert.match(html, /소스 관계도/);
  assert.match(html, /소스 코드/);
  assert.match(html, /LLM 정밀 매핑/);
  assert.match(html, /property="og:image"[^>]+\/og\.png/);
  assert.doesNotMatch(html, /preview-placeholder|Your site is taking shape|react-loading-skeleton/i);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /worker-src 'self' blob:/);
  const scriptDirective = csp.split(";").find((directive) => directive.trim().startsWith("script-src ")) ?? "";
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'/);
  const nonce = scriptDirective.match(/'nonce-([a-f0-9]+)'/)?.[1];
  assert.ok(nonce);
  const scriptTags = [...html.matchAll(/<script\b[^>]*>/giu)].map((match) => match[0]);
  assert.ok(scriptTags.length > 0);
  scriptTags.forEach((tag) => assert.match(tag, new RegExp(`\\bnonce="${nonce}"`)));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
});

test("keeps the finished product free of starter preview code", async () => {
  const [page, layout, packageJson, workspace, codeWorkbench, sourceTree, worker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SchemaLensWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SourceCodeWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SourceTree.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /SchemaLensWorkspace/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /\/og\.png/);
  assert.match(workspace, /analyzeSourceProject/);
  assert.match(workspace, /\/api\/llm\/ask/);
  assert.match(workspace, /SourceCodeWorkbench/);
  assert.match(workspace, /SourceTree/);
  assert.match(workspace, /analyzeSourceProjectInWorker/);
  assert.match(workspace, /safeDownloadName\(projectName\)/);
  assert.match(workspace, /sanitizeGraphForLlm\(\{/);
  assert.doesNotMatch(codeWorkbench, /dangerouslySetInnerHTML|srcDoc|eval\s*\(|new Function/);
  assert.doesNotMatch(codeWorkbench, /content\.split\(/);
  assert.doesNotMatch(sourceTree, /dangerouslySetInnerHTML|srcDoc/);
  assert.match(sourceTree, /MAX_VISIBLE_TREE_ROWS/);
  assert.match(worker, /requestWithCspNonce/);
  assert.doesNotMatch(worker, /response\.text\(\)|html\.replace\(/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", templateRoot)));
  await access(new URL("public/og.png", templateRoot));
});

test("reports a local fallback when the server LLM key is absent", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("fallback-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/llm/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "어떤 테이블이 있나요?",
        graph: { nodes: [], edges: [] },
        evidence: [],
      }),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "LLM_NOT_CONFIGURED");
  assert.deepEqual(body.fallback, { available: true, mode: "local" });
});
