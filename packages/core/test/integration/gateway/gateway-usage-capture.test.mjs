import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { ClaudeCodeRouterPlugin } from "@ccr/core/gateway/claude-code-router-plugin.ts";
import * as pipelineModule from "@ccr/core/gateway/request/pipeline.ts";

const { GatewayRequestPipeline } = pipelineModule;

test("session prompt token cache isolates interleaved sessions and falls back to request estimates", () => {
  const cache = new pipelineModule.SessionPromptTokenCache(2);

  cache.set("session-alpha", 40);
  assert.equal(cache.resolve("session-alpha", 9), 40);
  assert.equal(cache.resolve("session-beta", 9), 9);

  cache.set("session-beta", 70);
  assert.equal(cache.resolve("session-alpha", 9), 40);
  assert.equal(cache.resolve("session-beta", 9), 70);

  cache.set("session-gamma", 90);
  assert.equal(cache.resolve("session-alpha", 9), 9);
  assert.equal(cache.resolve(undefined, undefined), undefined);
});

test("gateway uses measured prompt tokens from the matching session for later failures", async () => {
  const config = createGatewayConfig();
  const plugin = new ClaudeCodeRouterPlugin(config);
  const captures = [];
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "core-token",
    getPlugin: () => plugin,
    getStatus: () => ({
      coreEndpoint: "http://127.0.0.1:65535",
      endpoint: "http://127.0.0.1:3456"
    }),
    recordUsageCapture: async (input) => {
      captures.push(input);
      return input.statusCode === 200 ? { measuredPromptTokenCount: 40 } : undefined;
    }
  });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(JSON.stringify({
        model: "k3",
        usage: { input_tokens: 30, cache_read_input_tokens: 10, output_tokens: 5, total_tokens: 45 }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }
    throw new Error("upstream failed");
  };

  try {
    await proxyPipelineRequest(pipeline, "session-alpha", "first request");
    await waitFor(() => captures.length === 1);
    await assert.rejects(proxyPipelineRequest(pipeline, "session-beta", "second request"));
    await assert.rejects(proxyPipelineRequest(pipeline, "session-alpha", "third request"));
    await waitFor(() => captures.length === 3);

    assert.notEqual(captures[1]?.estimatedPromptTokenCount, 40);
    assert.equal(captures[2]?.estimatedPromptTokenCount, 40);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway records one 499 usage capture after a client disconnect without request logging", async () => {
  const config = createGatewayConfig();
  const plugin = new ClaudeCodeRouterPlugin(config);
  const captures = [];
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "core-token",
    getPlugin: () => plugin,
    getStatus: () => ({
      coreEndpoint: "http://127.0.0.1:65535",
      endpoint: "http://127.0.0.1:3456"
    }),
    recordUsageCapture: async (input) => {
      captures.push(input);
      return undefined;
    }
  });
  const originalFetch = globalThis.fetch;
  let markFetchStarted;
  let upstreamRequestId;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    upstreamRequestId = new Headers(init.headers).get("x-client-request-id");
    markFetchStarted();
    init.signal.addEventListener("abort", () => {
      reject(new DOMException("The client disconnected", "AbortError"));
    }, { once: true });
  });

  const requestBody = JSON.stringify({
    max_tokens: 64,
    messages: [{ content: "hello", role: "user" }],
    model: "kimi-test/k3"
  });
  const request = Readable.from([requestBody]);
  request.headers = {
    "content-type": "application/json",
    "user-agent": "claude-code/1.0",
    "x-claude-code-session-id": "session-alpha"
  };
  request.method = "POST";
  request.url = "/v1/messages";
  const response = new CapturingResponse();

  try {
    const proxy = pipeline.proxyRequest(request, response, "/v1/messages");
    await fetchStarted;
    response.emit("close");
    response.emit("error", new Error("client closed"));
    await proxy;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.statusCode, 499);
    assert.equal(captures[0]?.requestBodySizeBytes, Buffer.byteLength(requestBody));
    assert.equal(typeof captures[0]?.requestId, "string");
    assert.equal(captures[0]?.requestId, upstreamRequestId);
    assert.equal(typeof captures[0]?.estimatedPromptTokenCount, "number");
    assert.ok((captures[0]?.estimatedPromptTokenCount ?? 0) > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function proxyPipelineRequest(pipeline, sessionId, message) {
  const request = Readable.from([JSON.stringify({
    max_tokens: 64,
    messages: [{ content: message, role: "user" }],
    model: "kimi-test/k3"
  })]);
  request.headers = {
    "content-type": "application/json",
    "user-agent": "claude-code/1.0",
    "x-claude-code-session-id": sessionId
  };
  request.method = "POST";
  request.url = "/v1/messages";
  const response = new CapturingResponse();
  await pipeline.proxyRequest(request, response, "/v1/messages");
  if (!response.writableEnded) {
    await new Promise((resolve, reject) => {
      response.once("finish", resolve);
      response.once("error", reject);
    });
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function createGatewayConfig() {
  return {
    CUSTOM_ROUTER_PATH: "",
    Providers: [
      {
        capabilities: [{ baseUrl: "http://kimi.example/v1/messages", type: "anthropic_messages" }],
        models: ["k3"],
        name: "kimi-test"
      }
    ],
    Router: {
      builtInRules: {
        "claude-code": { enabled: false },
        codex: { enabled: false }
      },
      fallback: { mode: "off", models: [], retryCount: 0 },
      rules: []
    },
    contextArchive: {
      enabled: false,
      mcpEnabled: false
    },
    observability: {
      agentAnalysis: false,
      requestLogs: false
    },
    preferredProvider: "kimi-test",
    profile: {
      enabled: false,
      profiles: []
    },
    toolHub: { enabled: false },
    virtualModelProfiles: []
  };
}

class CapturingResponse extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 0;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = Object.fromEntries(
      Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])
    );
    return this;
  }

  _write(_chunk, _encoding, callback) {
    callback();
  }
}
