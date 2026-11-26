import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  BeetlewatchClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  OMITTED_TOOLS,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Kubiaka endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/kubiaka-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const STATUS = "get_municipality_status";
const DETECTIONS = "list_new_detections";
const REWARDS = "list_rewards_and_subsidies";
const ALL_TOOLS = [STATUS, DETECTIONS, REWARDS];
const OMITTED = ["get_changes_since", "get_municipality_dossier"];

const SAMPLE_RESULT = {
  content: [
    { type: "text", text: "{\"municipality\":\"Kuwana\",\"damaged\":true}" },
  ],
  structuredContent: { municipality: "Kuwana", damaged: true },
};

const SAMPLE_ARGS = { municipality: "Kuwana" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "kubiaka", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new BeetlewatchClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/** True when any sent header name looks like an auth or payment header. */
function hasForbiddenHeader(calls: Captured[]): boolean {
  return calls.some((call) =>
    Object.keys(call.headers).some((h) =>
      /authorization|api-key|x402|payment/i.test(h),
    ),
  );
}

/* CLI helpers. */

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

/* MCP client over an in-memory transport, for tools/list and
 * tools/call assertions at the MCP layer itself. */
async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "beetlewatch-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (labelled subset: 3 of 5 captured tools)", () => {
  it("serves exactly the fixture's 3 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 3);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 3 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's Japanese titles verbatim, never translated", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      fixture.tools.map((t) => t.title),
    );
    assert.equal(defOf(STATUS).title, "市町村のクビアカの状態");
    assert.equal(defOf(DETECTIONS).title, "新たに被害が見つかった地域");
    assert.equal(defOf(REWARDS).title, "奨励金・報奨金と伐採の補助");
  });

  it("carries the fixture's Japanese descriptions verbatim, never translated", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(STATUS).description, /クビアカツヤカミキリ/);
    assert.match(defOf(DETECTIONS).description, /2026年9月11日/);
    assert.match(defOf(REWARDS).description, /成虫を捕まえた人/);
  });

  it("carries the required key exactly as captured on each tool", () => {
    assert.deepEqual(schemaOf(defOf(STATUS)).required, ["municipality"]);
    assert.equal("required" in schemaOf(defOf(DETECTIONS)), false);
    assert.equal("required" in schemaOf(defOf(REWARDS)), false);
  });

  it("carries the object type on every inputSchema, with no invented keys", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal("$schema" in schemaOf(tool), false);
      assert.equal("additionalProperties" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(defOf(STATUS)).properties), [
      "municipality",
      "prefecture",
    ]);
    assert.deepEqual(Object.keys(schemaOf(defOf(DETECTIONS)).properties), [
      "prefecture",
    ]);
    assert.deepEqual(Object.keys(schemaOf(defOf(REWARDS)).properties), [
      "prefecture",
      "only_open",
    ]);
  });

  it("get_municipality_status's municipality is a string with its captured Japanese description", () => {
    const prop = schemaOf(defOf(STATUS)).properties.municipality;
    assert.equal(prop.type, "string");
    assert.equal(
      prop.description,
      "市町村名。日本語かローマ字。市・町・村は付けても付けなくてもよい",
    );
  });

  it("every prefecture property is a string with its captured Japanese description", () => {
    assert.equal(schemaOf(defOf(STATUS)).properties.prefecture.type, "string");
    assert.equal(
      schemaOf(defOf(STATUS)).properties.prefecture.description,
      "都道府県名（同じ名前の市町村を絞るとき。任意）",
    );
    for (const name of [DETECTIONS, REWARDS]) {
      const prop = schemaOf(defOf(name)).properties.prefecture;
      assert.equal(prop.type, "string");
      assert.equal(prop.description, "都道府県名で絞る（任意）");
    }
  });

  it("list_rewards_and_subsidies's only_open is a boolean with its captured Japanese description", () => {
    const prop = schemaOf(defOf(REWARDS)).properties.only_open;
    assert.equal(prop.type, "boolean");
    assert.equal(prop.description, "受付中だけにする（既定 true）");
  });

  it("isKnownTool recognises the kept tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("beetle"), false);
    assert.equal(isKnownTool("status"), false);
    assert.equal(isKnownTool(""), false);
  });

  it("the MCP tools/list response carries exactly the fixture's 3 tools", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      ALL_TOOLS,
    );
    assert.deepEqual(listed, fixture.tools);
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("omitted x402 tools are absent at every level", () => {
  it("names exactly the two omitted tools in OMITTED_TOOLS", () => {
    assert.deepEqual([...OMITTED_TOOLS], OMITTED);
  });

  it("registry level: neither omitted tool is in TOOL_DEFS or TOOL_NAMES", () => {
    for (const name of OMITTED) {
      assert.equal(TOOL_NAMES.includes(name), false);
      assert.equal(TOOL_DEFS.some((t) => t.name === name), false);
      assert.equal(isKnownTool(name), false);
    }
  });

  it("MCP-layer level: neither omitted tool appears in tools/list", async () => {
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.equal(listed.length, 3);
    for (const name of OMITTED) {
      assert.equal(listed.some((t) => t.name === name), false);
    }
    assert.equal(upstream.calls.length, 0);
  });

  it("MCP-layer level: handleCallTool rejects each omitted tool with MethodNotFound, no network hop", async () => {
    for (const name of OMITTED) {
      const upstream = makeUpstream();
      const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
      await assert.rejects(
        () => handleCallTool(c, name, {}),
        (err: unknown) =>
          err instanceof McpError && err.code === ErrorCode.MethodNotFound,
      );
      assert.equal(upstream.calls.length, 0);
    }
  });

  it("MCP-layer level: an MCP tools/call for an omitted tool is rejected and never reaches the upstream", async () => {
    for (const name of OMITTED) {
      const upstream = makeUpstream();
      await withMcpClient(upstream, async (client) => {
        await assert.rejects(() =>
          client.callTool({ name, arguments: {} }),
        );
      });
      assert.equal(upstream.calls.length, 0);
    }
  });

  it("CLI level: each omitted tool name prints usage and exits 2", () => {
    for (const name of OMITTED) {
      const res = runCli([name, "{}"]);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /Usage:/);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://kubiaka-now.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name beetlewatch and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(STATUS, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "beetlewatch", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(STATUS, SAMPLE_ARGS);
    await c.callTool(DETECTIONS, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the KUBIAKA_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new BeetlewatchClient({
      fetchFn: upstream.fetchFn,
      env: { KUBIAKA_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { KUBIAKA_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new BeetlewatchClient({
      fetchFn: upstream.fetchFn,
      env: { KUBIAKA_MCP_URL: "   " },
    });
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header and no x402/payment header is ever sent", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a KUBIAKA_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new BeetlewatchClient({
      fetchFn: upstream.fetchFn,
      env: { KUBIAKA_API_KEY: "some-key-42" },
    });
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new BeetlewatchClient({
      fetchFn: upstream.fetchFn,
      env: {
        AUTHORIZATION: "Bearer x",
        API_KEY: "y",
        KUBIAKA_TOKEN: "z",
      },
    });
    await c.callTool(DETECTIONS, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new BeetlewatchClient({
      fetchFn: upstream.fetchFn,
      env: { KUBIAKA_API_KEY: "some-key-42" },
    });
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("never constructs or sends any x402/payment header, even with payment-style env vars present", async () => {
    const upstream = makeUpstream();
    const c = new BeetlewatchClient({
      fetchFn: upstream.fetchFn,
      env: {
        X402_PAYMENT: "should-never-be-sent",
        PAYMENT_SIGNATURE: "should-never-be-sent",
        WALLET_PRIVATE_KEY: "should-never-be-sent",
      },
    });
    await c.callTool(STATUS, SAMPLE_ARGS);
    await c.callTool(REWARDS, { only_open: true });
    assert.equal(hasForbiddenHeader(upstream.calls), false);
    for (const call of upstream.calls) {
      for (const name of Object.keys(call.headers)) {
        assert.doesNotMatch(name, /x402/i);
        assert.doesNotMatch(name, /payment/i);
      }
    }
  });

  it("sends no payment header across a full session for every kept tool", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(STATUS, SAMPLE_ARGS);
    await c.callTool(DETECTIONS, {});
    await c.callTool(REWARDS, {});
    assert.equal(calls.length, 5);
    assert.equal(hasForbiddenHeader(calls), false);
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(STATUS, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a get_municipality_status call verbatim with municipality and prefecture", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(STATUS, { municipality: "Kuwana", prefecture: "三重県" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, STATUS);
    assert.deepEqual(params.arguments, {
      municipality: "Kuwana",
      prefecture: "三重県",
    });
  });

  it("forwards a list_new_detections call under its own name with empty arguments", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(DETECTIONS, {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, DETECTIONS);
    assert.deepEqual(params.arguments, {});
  });

  it("forwards a list_new_detections call with its prefecture filter", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(DETECTIONS, { prefecture: "埼玉県" });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, DETECTIONS);
    assert.deepEqual(params.arguments, { prefecture: "埼玉県" });
  });

  it("forwards a list_rewards_and_subsidies call under its own name with prefecture and only_open", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(REWARDS, { prefecture: "三重県", only_open: false });
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, REWARDS);
    assert.deepEqual(params.arguments, { prefecture: "三重県", only_open: false });
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "municipality not found upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(STATUS, { municipality: "no-such-place" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      REWARDS,
      { only_open: true },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, REWARDS);
    assert.deepEqual(params.arguments, { only_open: true });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as beetlewatch error text", () => {
  it("maps a JSON-RPC error to `beetlewatch error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "lookup failed upstream" },
    });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "beetlewatch error: lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to beetlewatch error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "beetlewatch error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "beetlewatch error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "beetlewatch error: malformed response");
  });

  it("maps a non-2xx upstream status to beetlewatch error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "beetlewatch error: HTTP 500");
  });

  it("maps a throwing fetch to beetlewatch error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^beetlewatch error: /);
  });

  it("maps a throwing initialize fetch to beetlewatch error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "beetlewatch error: socket hang up");
  });

  it("maps a timed-out call to beetlewatch error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(STATUS, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^beetlewatch error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, STATUS, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, STATUS, "municipality=Kuwana"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid get_municipality_status call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, STATUS, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards a valid list_new_detections call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, DETECTIONS, {});
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, DETECTIONS);
    assert.deepEqual(params.arguments, {});
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, DETECTIONS, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });

  it("an MCP tools/call for an unknown tool is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({ name: "beetle_delete", arguments: {} }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(
      res.stderr,
      /get_municipality_status, list_new_detections, list_rewards_and_subsidies/,
    );
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([STATUS, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([STATUS, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([STATUS, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
