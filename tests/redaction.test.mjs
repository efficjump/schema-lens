import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadRedaction() {
  const sourceUrl = new URL("../lib/llm/redaction.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "redaction.ts",
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
}

const redaction = await loadRedaction();

const joinFragments = (...parts) => parts.join("");

const secrets = {
  providerKey: joinFragments("sk", "-test-", "abcdefghijklmnopqrstuvwx1234567890"),
  github: joinFragments("github", "_pat_", "11AA22BB33CC44DD55EE66FF77GG88HH99II"),
  awsAccessKey: joinFragments("AK", "IA", "IOSFODNN7EXAMPLE"),
  jwt: joinFragments(
    "ey", "JhbGciOiJIUzI1NiJ9.",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
    "SyntheticSignatureForRedaction12_",
  ),
  databaseUrl: joinFragments(
    "postgresql", "://", "sample-user", ":", "sample-password", "@db.invalid:5432/sample",
  ),
  password: "correct-horse-battery-staple",
};

test("redacts provider keys, JWTs, database URLs, named secrets and private keys", () => {
  const privateKey = [
    joinFragments("-----BEGIN ", "PRIVATE KEY-----"),
    "base64privatekeymaterial",
    joinFragments("-----END ", "PRIVATE KEY-----"),
  ].join("\n");
  const input = [
    secrets.providerKey,
    secrets.github,
    secrets.awsAccessKey,
    secrets.jwt,
    secrets.databaseUrl,
    `password=${secrets.password}`,
    joinFragments("Authorization: Bearer ", "synthetic-token-that-must-not-escape"),
    privateKey,
    "provider echoed a masked key: sk-...abcd",
    joinFragments("-----BEGIN OPEN", "SSH PRIVATE KEY-----\ntruncated-private-material"),
  ].join("\n");

  const output = redaction.redactSensitiveText(input);
  for (const secret of [...Object.values(secrets), privateKey]) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /\[REDACTED_PROVIDER_KEY\]/);
  assert.match(output, /\[REDACTED_JWT\]/);
  assert.match(output, /\[REDACTED_DATABASE_URL\]/);
  assert.match(output, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(output, /\[REDACTED_SECRET\]/);
  assert.equal(output.includes("truncated-private-material"), false);
});

test("recursively redacts values and credential-shaped object keys without mutating input", () => {
  const input = {
    safe: "visible",
    nested: [
      { token: secrets.providerKey },
      { [secrets.github]: { connection: secrets.databaseUrl } },
    ],
  };

  const output = redaction.redactSensitiveValue(input);
  const serialized = JSON.stringify(output);
  assert.equal(input.nested[0].token, secrets.providerKey);
  assert.equal(serialized.includes(secrets.providerKey), false);
  assert.equal(serialized.includes(secrets.github), false);
  assert.equal(serialized.includes(secrets.databaseUrl), false);
  assert.equal(output.safe, "visible");
});

test("graph sanitizer allow-lists Evidence and drops the unredacted content alias", () => {
  const graph = {
    nodes: [
      {
        id: "file:repository.ts",
        nodeType: "file",
        metadata: { authorization: `Bearer ${secrets.providerKey}` },
      },
    ],
    edges: [],
    evidence: [
      {
        id: "evidence:one",
        kind: "query",
        filePath: "src/repository.ts",
        line: 8,
        endLine: 9,
        excerpt: `password = '${secrets.password}'`,
        content: `password = '${secrets.password}'`,
        path: "src/repository.ts",
        startLine: 8,
        description: `uses ${secrets.databaseUrl}`,
        internalOnly: secrets.providerKey,
      },
    ],
  };

  const output = redaction.sanitizeGraphForLlm(graph);
  const evidence = output.evidence[0];
  assert.deepEqual(Object.keys(evidence).sort(), [
    "description",
    "endLine",
    "excerpt",
    "filePath",
    "id",
    "kind",
    "line",
  ]);
  assert.equal("content" in evidence, false);
  assert.equal("path" in evidence, false);
  assert.equal("startLine" in evidence, false);
  assert.equal("internalOnly" in evidence, false);

  const serialized = JSON.stringify(output);
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("incoming and typed request sanitizers cover graph, excerpts, questions and conversation", () => {
  const raw = {
    question: `Does ${secrets.databaseUrl} write users?`,
    graph: {
      nodes: [],
      edges: [],
      evidence: [
        {
          id: "evidence:one",
          kind: "query",
          filePath: "query.sql",
          line: 1,
          endLine: 1,
          excerpt: `token=${secrets.providerKey}`,
          content: secrets.providerKey,
        },
      ],
    },
    evidence: [
      {
        id: "evidence:one",
        path: "query.sql",
        language: "sql",
        startLine: 1,
        endLine: 1,
        content: `token=${secrets.providerKey}`,
      },
    ],
    conversation: [{ role: "user", content: secrets.jwt }],
  };

  const incoming = redaction.sanitizeIncomingLlmPayload(raw);
  const output = redaction.sanitizeAskRequestForLlm(incoming);
  const serialized = JSON.stringify(output);
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal("content" in output.graph.evidence[0], false);
  assert.equal(output.evidence[0].id, "evidence:one");
});

test("ask and map routes sanitize before provider input and redact returned model data", async () => {
  const [askRoute, mapRoute] = await Promise.all([
    readFile(new URL("../app/api/llm/ask/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/llm/map/route.ts", import.meta.url), "utf8"),
  ]);

  for (const route of [askRoute, mapRoute]) {
    assert.match(route, /sanitizeIncomingLlmPayload\(await readJsonBody\(request\)\)/);
    assert.match(route, /redactSensitiveValue\(/);
  }
  assert.match(askRoute, /sanitizeAskRequestForLlm/);
  assert.match(mapRoute, /sanitizeMappingRequestForLlm/);
});
