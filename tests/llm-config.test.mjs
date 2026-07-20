import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadConfig() {
  const sourceUrl = new URL("../lib/llm/config.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "config.ts",
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
}

const config = await loadConfig();
const environmentKeys = [
  "LLM_API_KEY",
  "LLM_API_STYLE",
  "LLM_API_URL",
  "LLM_MODEL",
  "LLM_RATE_LIMIT_PER_MINUTE",
];

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("LLM integration stays disabled until URL and model are configured", () => {
  withEnvironment({}, () => {
    const value = config.getLlmConfig();
    assert.equal(value.configured, false);
    assert.equal(value.apiStyle, "responses");
    assert.equal(value.apiUrl, null);
  });
});

test("accepts HTTPS and localhost endpoints without exposing a default model", () => {
  withEnvironment(
    {
      LLM_API_URL: "https://llm.example.com/v1/responses",
      LLM_MODEL: "configured-model",
    },
    () => {
      const value = config.getLlmConfig();
      assert.equal(value.configured, true);
      assert.equal(value.model, "configured-model");
      assert.equal(value.apiUrl, "https://llm.example.com/v1/responses");
    },
  );

  withEnvironment(
    {
      LLM_API_URL: "http://localhost:9090/v1/chat/completions",
      LLM_MODEL: "local-model",
    },
    () => assert.equal(config.getLlmConfig().configured, true),
  );
});

test("rejects insecure remote endpoints and normalizes configurable guards", () => {
  withEnvironment(
    {
      LLM_API_URL: "http://llm.example.com/v1/responses",
      LLM_MODEL: "configured-model",
      LLM_API_STYLE: "chat-completions",
      LLM_RATE_LIMIT_PER_MINUTE: "1001",
    },
    () => {
      const value = config.getLlmConfig();
      assert.equal(value.configured, false);
      assert.equal(value.invalidApiUrl, true);
      assert.equal(value.apiStyle, "chat-completions");
      assert.equal(config.getLlmRateLimitPerMinute(), 12);
    },
  );
});
