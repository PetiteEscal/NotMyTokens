// Integration test for the MCP Worker. Mocks fetch (GitHub raw + REST API) and
// drives the worker's default fetch handler with real JSON-RPC requests.
// Run: node test/mcp.test.mjs   (Node 22+, strips TS types automatically)
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const ENV = { GITHUB_OWNER: "acme", GITHUB_REPO: "reg", GITHUB_BRANCH: "main", GITHUB_TOKEN: "tok" };

const INDEX = {
  schemaVersion: 1,
  count: 1,
  artifacts: [
    {
      id: "react-pricing-card",
      name: "Pricing Card",
      type: "visualization",
      version: "1.0.0",
      description: "Responsive pricing card with Tailwind.",
      tags: ["react", "tailwind", "ui"],
      language: "tsx",
      entry: "PricingCard.tsx",
      files: ["PricingCard.tsx"],
      path: "artifacts/react-pricing-card",
    },
  ],
};

// ---- mock network -----------------------------------------------------------
const ghCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/main/index.json")) return jsonResp(INDEX);
  if (u.includes("/PricingCard.tsx")) return new Response("export function PricingCard() {}", { status: 200 });

  // GitHub REST API mocks
  if (u.includes("api.github.com")) {
    ghCalls.push(`${init.method ?? "GET"} ${u.split("/repos/acme/reg")[1]}`);
    if (u.includes("/git/ref/heads/main")) return jsonResp({ object: { sha: "basesha" } });
    if (u.includes("/git/commits/basesha")) return jsonResp({ tree: { sha: "basetree" } });
    if (u.endsWith("/git/blobs")) return jsonResp({ sha: "blob_" + ghCalls.length });
    if (u.endsWith("/git/trees")) return jsonResp({ sha: "newtree" });
    if (u.endsWith("/git/commits")) return jsonResp({ sha: "newcommit" });
    if (u.endsWith("/git/refs")) return jsonResp({ ref: "ok" });
    if (u.endsWith("/pulls")) return jsonResp({ html_url: "https://github.com/acme/reg/pull/42" });
  }
  throw new Error("unexpected fetch: " + u);
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

// ---- helpers ----------------------------------------------------------------
async function rpc(method, params, id = 1) {
  const req = new Request("https://w/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const res = await worker.fetch(req, ENV);
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

function toolData(body) {
  return JSON.parse(body.result.content[0].text);
}

// ---- tests ------------------------------------------------------------------
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  ✓ ${name}`);
  passed++;
}

await test("initialize advertises tools capability", async () => {
  const { body } = await rpc("initialize", {});
  assert.equal(body.result.serverInfo.name, "notmytoken");
  assert.ok(body.result.capabilities.tools);
});

await test("notifications/initialized → 202 no body", async () => {
  const req = new Request("https://w/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const res = await worker.fetch(req, ENV);
  assert.equal(res.status, 202);
});

await test("tools/list returns the 3 tools", async () => {
  const { body } = await rpc("tools/list", {});
  const names = body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get_artifact", "search_artifacts", "upload_artifact"]);
});

await test("search_artifacts matches by query and type", async () => {
  const { body } = await rpc("tools/call", { name: "search_artifacts", arguments: { query: "tailwind", type: "visualization" } });
  const data = toolData(body);
  assert.equal(data.count, 1);
  assert.equal(data.results[0].id, "react-pricing-card");
});

await test("search_artifacts filters out non-matches", async () => {
  const { body } = await rpc("tools/call", { name: "search_artifacts", arguments: { query: "kubernetes" } });
  assert.equal(toolData(body).count, 0);
});

await test("get_artifact returns metadata + file contents", async () => {
  const { body } = await rpc("tools/call", { name: "get_artifact", arguments: { id: "react-pricing-card" } });
  const data = toolData(body);
  assert.equal(data.id, "react-pricing-card");
  assert.match(data.contents["PricingCard.tsx"], /export function PricingCard/);
});

await test("get_artifact unknown id → isError result", async () => {
  const { body } = await rpc("tools/call", { name: "get_artifact", arguments: { id: "nope" } });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /not found/i);
});

await test("upload_artifact opens a PR through the Git Data API", async () => {
  const { body } = await rpc("tools/call", {
    name: "upload_artifact",
    arguments: {
      id: "new-thing",
      name: "New Thing",
      type: "tool",
      version: "1.0.0",
      description: "A new snippet.",
      tags: ["x"],
      entry: "main.txt",
      files: [{ path: "main.txt", content: "hello" }],
    },
  });
  const data = toolData(body);
  assert.equal(data.status, "pull_request_opened");
  assert.equal(data.pullRequest, "https://github.com/acme/reg/pull/42");
  // committed meta.json + main.txt = 2 blobs
  assert.equal(ghCalls.filter((c) => c.includes("POST /git/blobs")).length, 2);
  assert.ok(ghCalls.some((c) => c === "POST /pulls"));
});

await test("upload_artifact rejects duplicate id", async () => {
  const { body } = await rpc("tools/call", {
    name: "upload_artifact",
    arguments: {
      id: "react-pricing-card",
      name: "Dup",
      type: "tool",
      version: "1.0.0",
      description: "dup",
      tags: [],
      entry: "a.txt",
      files: [{ path: "a.txt", content: "x" }],
    },
  });
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /already exists/);
});

await test("unknown method → -32601", async () => {
  const { body } = await rpc("bogus/method", {});
  assert.equal(body.error.code, -32601);
});

console.log(`\n${passed} tests passed`);
