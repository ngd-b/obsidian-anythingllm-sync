const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { buildSync } = require("esbuild");

const code = buildSync({ entryPoints: ["src/services/anythingllm-client.ts"], bundle: true,
  platform: "node", format: "cjs", external: ["obsidian"], write: false }).outputFiles[0].text;

function setup(payload, status = 200) {
  const requests = [];
  const context = { module: { exports: {} }, require: () => ({ requestUrl: async (request) => {
    requests.push(request);
    return { status, json: payload, text: JSON.stringify(payload) };
  } }) };
  vm.runInNewContext(code, context);
  const client = new context.module.exports.AnythingLLMClient(() => ({ baseUrl: "http://localhost:3001/api/" }), () => "key");
  return { client, requests };
}

test("workspace verification uses authenticated GET and the document's full remote path", async () => {
  const s = setup({ workspace: [{ slug: "test/workspace", documents: [{ docpath: "custom/a.md-id.json" }] }] });
  const locations = await s.client.listWorkspaceDocuments("test/workspace");
  assert.deepEqual(Array.from(locations), ["custom/a.md-id.json"]);
  assert.equal(s.requests[0].url, "http://localhost:3001/api/v1/workspace/test%2Fworkspace");
  assert.equal(s.requests[0].method, "GET");
  assert.equal(s.requests[0].headers.Authorization, "Bearer key");
});

test("a valid empty workspace is distinct from an invalid API response", async () => {
  const valid = setup({ workspace: [{ slug: "wiki", documents: [] }] });
  assert.equal((await valid.client.listWorkspaceDocuments("wiki")).size, 0);
  for (const invalid of [null, {}, { workspace: [] }, { workspace: [{ slug: "wiki" }] },
    { workspace: [{ slug: "wiki", documents: [{ filename: "a.md" }] }] },
    { workspace: [{ slug: "wiki", documents: [null] }] }]) {
    await assert.rejects(setup(invalid).client.listWorkspaceDocuments("wiki"));
  }
});

test("authentication and server errors reject the verification request", async () => {
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(setup({ error: "request failed" }, status).client.listWorkspaceDocuments("wiki"), /HTTP/);
  }
});
