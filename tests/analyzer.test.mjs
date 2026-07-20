import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadAnalyzer() {
  const sourceUrl = new URL("../lib/analyzer.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "analyzer.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const analyzer = await loadAnalyzer();

test("demo graph joins DDL, query access, source imports, functions and routes", () => {
  const graph = analyzer.buildDemoGraph();

  assert.deepEqual(
    graph.tables.map((table) => table.qualifiedName),
    ["organizations", "projects", "tasks", "users"],
  );
  assert.equal(graph.stats.fileCount, 6);
  assert.equal(graph.stats.writeCount, 3);
  assert.ok(graph.stats.readCount >= 6);
  assert.ok(graph.stats.importCount >= 4);
  assert.ok(graph.stats.routeCount >= 4);

  const projects = graph.tables.find((table) => table.name === "projects");
  assert.ok(projects);
  assert.deepEqual(projects.primaryKey, ["id"]);
  assert.equal(projects.confidence, "high");
  assert.equal(projects.columns.find((column) => column.name === "owner_id")?.references[0]?.table, "users");

  const writeTypes = new Set(
    graph.edges.filter((edge) => edge.kind === "write").map((edge) => edge.queryType),
  );
  assert.deepEqual(writeTypes, new Set(["INSERT", "UPDATE", "DELETE"]));
  assert.ok(graph.edges.some((edge) => edge.kind === "query-relation"));
  assert.ok(graph.edges.some((edge) => edge.kind === "import" && edge.metadata?.resolvedPath === "src/data/projectRepository.ts"));
  assert.ok(graph.symbols.some((symbol) => symbol.kind === "route" && symbol.name === "GET /projects"));
  assert.ok(graph.symbols.some((symbol) => symbol.kind === "route" && symbol.name === "PATCH /api/tasks/:id"));
  assert.ok(graph.evidence.every((item) => item.filePath && item.line > 0 && item.excerpt));
});

test("quoted schemas, composite constraints and ALTER TABLE foreign keys retain exact evidence", () => {
  const graph = analyzer.analyzeSourceProject([
    {
      path: "migrations/schema.sql",
      content: `
CREATE TABLE "sales"."customers" (
  "region_id" INTEGER NOT NULL,
  "customer_id" BIGINT NOT NULL,
  email VARCHAR(255) UNIQUE,
  PRIMARY KEY ("region_id", "customer_id")
);

CREATE TABLE sales.orders (
  id BIGINT PRIMARY KEY,
  region_id INTEGER NOT NULL,
  customer_id BIGINT NOT NULL,
  amount DECIMAL(12, 2) DEFAULT 0
);

ALTER TABLE sales.orders ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (region_id, customer_id)
  REFERENCES sales.customers (region_id, customer_id);
`,
    },
  ]);

  const customers = graph.tables.find((table) => table.qualifiedName === "sales.customers");
  const orders = graph.tables.find((table) => table.qualifiedName === "sales.orders");
  assert.ok(customers && orders);
  assert.deepEqual(customers.primaryKey, ["customer_id", "region_id"]);
  assert.equal(orders.columns.find((column) => column.name === "amount")?.dataType, "DECIMAL(12, 2)");
  assert.equal(orders.columns.find((column) => column.name === "amount")?.defaultValue, "0");
  assert.equal(orders.columns.find((column) => column.name === "region_id")?.references[0]?.table, "sales.customers");
  assert.equal(orders.columns.find((column) => column.name === "customer_id")?.references[0]?.column, "customer_id");
  assert.equal(graph.edges.filter((edge) => edge.kind === "foreign-key").length, 2);
  assert.ok(graph.evidence.some((item) => item.description === "ALTER TABLE sales.orders" && item.line > 10));
});

test("query-only source infers table access, aliases, columns and JOIN relationships without inventing CTE tables", () => {
  const graph = analyzer.analyzeProject([
    {
      path: "src/reporting/customer_report.py",
      content: `
def customer_report(connection, region):
    return connection.execute("""
      WITH recent_orders AS (
        SELECT order_id, customer_id, region_id
        FROM sales.orders
        WHERE created_at > CURRENT_DATE - INTERVAL '30 days'
      )
      SELECT c.customer_id, c.email, r.order_id
      FROM sales.customers AS c
      JOIN recent_orders r
        ON r.customer_id = c.customer_id AND r.region_id = c.region_id
      WHERE c.region_id = :region
    """, {"region": region})
`,
    },
    {
      path: "src/reporting/cleanup.py",
      content: `
from .customer_report import customer_report

def purge(connection):
    connection.execute("DELETE FROM audit_events WHERE created_at < CURRENT_DATE")
`,
    },
  ]);

  const names = graph.tables.map((table) => table.qualifiedName);
  assert.ok(names.includes("sales.orders"));
  assert.ok(names.includes("sales.customers"));
  assert.ok(names.includes("audit_events"));
  assert.ok(!names.includes("recent_orders"));
  assert.ok(graph.tables.find((table) => table.qualifiedName === "sales.customers")?.columns.some((column) => column.name === "email"));
  assert.ok(graph.edges.some((edge) => edge.kind === "read" && edge.target === "table:sales.customers"));
  assert.ok(graph.edges.some((edge) => edge.kind === "write" && edge.target === "table:audit_events"));
  assert.ok(graph.edges.some((edge) => edge.kind === "import"));
  assert.ok(graph.symbols.some((symbol) => symbol.name === "customer_report"));
});

test("LLM context selection is project-vocabulary driven and includes connected evidence", () => {
  const graph = analyzer.buildDemoGraph();
  const hits = analyzer.findRelevantGraphNodes(graph, "tasks assignee route", 8);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].node.nodeType, "table");
  assert.equal(hits[0].node.name, "tasks");

  const context = JSON.parse(analyzer.buildLLMContext(graph, "Which source updates task state?", 8));
  assert.equal(context.question, "Which source updates task state?");
  assert.ok(context.nodes.some((node) => node.id === "table:tasks"));
  assert.ok(context.edges.some((edge) => edge.kind === "write" && edge.target === "table:tasks"));
  assert.ok(context.evidence.some((item) => item.filePath === "src/data/taskRepository.ts"));
});

test("evidence lines treat CR, LF, and CRLF as the same logical line breaks", () => {
  const graph = analyzer.analyzeSourceProject([
    {
      path: "migrations/legacy.sql",
      content: [
        "SELECT 1;",
        "CREATE TABLE legacy_users (id BIGINT PRIMARY KEY);",
        "SELECT id FROM legacy_users;",
      ].join("\r"),
    },
  ]);

  const ddl = graph.evidence.find((item) => item.kind === "ddl");
  const query = graph.evidence.find(
    (item) => item.kind === "query" && item.excerpt.includes("FROM legacy_users"),
  );
  assert.equal(ddl?.line, 2);
  assert.equal(query?.line, 3);
});
