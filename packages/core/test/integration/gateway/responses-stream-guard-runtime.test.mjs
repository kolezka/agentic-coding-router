import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createGzip } from "node:zlib";

const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));
const gatewayEntry = requireFromProject.resolve("@the-next-ai/ai-gateway");
const gatewayBootstrapEntry = path.join(process.cwd(), ".test-dist", "core", "runtime", "gateway-bootstrap.js");
const idleTimeoutMs = 1200;
/** Well below the pre-fix stall, so a hang cannot pass as a slow success. */
const stallBudgetMs = 8_000;

const toolArguments = JSON.stringify({ city: "Kraków" });
const completedResponse = {
  id: "resp_1",
  model: "gpt-stall",
  output: [
    { id: "rs_1", summary: [{ text: "checking the forecast", type: "summary_text" }], type: "reasoning" },
    {
      content: [{ annotations: [], text: "zażółć gęślą jaźń 🚀", type: "output_text" }],
      id: "msg_1",
      role: "assistant",
      status: "completed",
      type: "message"
    },
    {
      arguments: toolArguments,
      call_id: "call_1",
      id: "fc_1",
      name: "get_weather",
      status: "completed",
      type: "function_call"
    }
  ],
  status: "completed",
  usage: { input_tokens: 11, output_tokens: 7 }
};

test("a Responses upstream that never closes still delivers text, reasoning and a tool call", async () => {
  const { gateway, upstream } = await useUpstream(completeThenHeartbeat());

  const body = await postJson(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "what is the weather", role: "user" }],
    model: "StallUpstream/gpt-stall"
  }, stallBudgetMs);

  assert.equal(body.status, 200, JSON.stringify(body.json));
  const text = body.json.content.find((item) => item.type === "text");
  const toolUse = body.json.content.find((item) => item.type === "tool_use");
  assert.equal(text.text, "zażółć gęślą jaźń 🚀");
  assert.equal(toolUse.name, "get_weather");
  assert.deepEqual(toolUse.input, { city: "Kraków" });
  assert.equal(upstream.lastResponseEnded(), false, "the upstream must still be holding its body open");
});

test("a gzip Responses stream reaches the client decoded", async () => {
  const { gateway } = await useUpstream(completeThenHeartbeat({ gzip: true }));

  const body = await postJson(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "hello", role: "user" }],
    model: "StallUpstream/gpt-stall"
  }, stallBudgetMs);

  assert.equal(body.status, 200, JSON.stringify(body.json));
  assert.equal(body.json.content.find((item) => item.type === "text").text, "zażółć gęślą jaźń 🚀");
});

test("the guard also covers the plain global fetch path used without a dispatcher", async () => {
  const { gateway } = await useUpstream(completeThenHeartbeat(), { upstreamTimeoutMs: 0 });

  const body = await postJson(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "hello", role: "user" }],
    model: "StallUpstream/gpt-stall"
  }, stallBudgetMs);

  assert.equal(body.status, 200, JSON.stringify(body.json));
  assert.equal(body.json.content.find((item) => item.type === "text").text, "zażółć gęślą jaźń 🚀");
});

test("a provider without baseurl is guarded using OPENAI_BASE_URL", async () => {
  const { gateway } = await useUpstream(completeThenHeartbeat(), { useDefaultBaseUrl: true });
  const body = await postJson(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "hello", role: "user" }],
    model: "StallUpstream/gpt-stall"
  }, stallBudgetMs);
  assert.equal(body.status, 200, JSON.stringify(body.json));
  assert.equal(body.json.content.find((item) => item.type === "text").text, "zażółć gęślą jaźń 🚀");
});

test("a keepalive-only stall fails loudly instead of returning an empty success", async () => {
  const { gateway } = await useUpstream(stallAfterCreated());

  const body = await postJson(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "hello", role: "user" }],
    model: "StallUpstream/gpt-stall"
  }, stallBudgetMs);

  assert.notEqual(body.status, 200, JSON.stringify(body.json));
  assert.equal(body.json?.content, undefined);
  assert.equal(body.text.includes("zażółć"), false);
});

test("a keepalive-only stall never emits a successful streaming terminator", async () => {
  const { gateway } = await useUpstream(stallAfterCreated({ withText: true }));

  const stream = await postStream(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "hello", role: "user" }],
    model: "StallUpstream/gpt-stall",
    stream: true
  }, stallBudgetMs);

  assert.equal(stream.clientTimedOut, false, "the router must stop the stall before the client deadline");
  assert.ok(stream.error, "the interrupted stream must fail explicitly");
  assert.match(stream.text, /"text":"partial"/);
  assert.equal(stream.text.includes("event: message_stop"), false, stream.text.slice(0, 400));
  assert.equal(stream.text.includes('"stop_reason":"end_turn"'), false, stream.text.slice(0, 400));
});

test("an upstream response.failed after partial text is not reported as a success", async () => {
  const { gateway } = await useUpstream(failAfterText());

  const body = await postJson(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "hello", role: "user" }],
    model: "StallUpstream/gpt-stall"
  }, stallBudgetMs);

  assert.notEqual(body.status, 200, JSON.stringify(body.json));
  assert.equal(body.json?.stop_reason, undefined);
});

test("a client that disconnects releases the upstream body", async () => {
  const { gateway, upstream } = await useUpstream(completeThenHeartbeat({ neverComplete: true }));

  const controller = new AbortController();
  const request = fetch(`${gateway.url}/v1/messages`, {
    body: JSON.stringify({
      max_tokens: 128,
      messages: [{ content: "hello", role: "user" }],
      model: "StallUpstream/gpt-stall"
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: controller.signal
  }).catch((error) => error);

  await upstream.waitForRequest();
  controller.abort();
  await request;
  await upstream.waitForResponseClose(stallBudgetMs);
});

test("providers on other protocols keep their plain JSON responses", async () => {
  const { gateway } = await useUpstream((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      content: [{ text: "anthropic canary", type: "text" }],
      id: "msg_canary",
      model: "canary-model",
      role: "assistant",
      stop_reason: "end_turn",
      type: "message",
      usage: { input_tokens: 3, output_tokens: 3 }
    }));
  });

  const body = await postJson(gateway.url, "/v1/messages", {
    max_tokens: 128,
    messages: [{ content: "hello", role: "user" }],
    model: "CanaryAnthropic/canary-model"
  }, stallBudgetMs);

  assert.equal(body.status, 200, JSON.stringify(body.json));
  assert.equal(body.json.content[0].text, "anthropic canary");
});

function completeThenHeartbeat({ gzip = false, neverComplete = false } = {}) {
  return (request, response) => {
    request.resume();
    const headers = { "content-type": "text/event-stream" };
    if (gzip) {
      headers["content-encoding"] = "gzip";
    }
    response.writeHead(200, headers);
    const sink = gzip ? createGzip() : undefined;
    sink?.pipe(response);
    const write = (chunk) => {
      if (sink) {
        sink.write(chunk);
        sink.flush();
        return;
      }
      response.write(chunk);
    };

    write(frame({ response: { id: "resp_1", status: "in_progress" }, type: "response.created" }));
    write(frame({
      item: { id: "msg_1", role: "assistant", status: "in_progress", type: "message" },
      output_index: 1,
      type: "response.output_item.added"
    }));
    // Split the delta frame mid multi-byte character and across a CRLF frame
    // terminator, so any re-encoding would corrupt the text.
    const delta = Buffer.from(
      `event: response.output_text.delta\r\ndata: ${JSON.stringify({
        delta: "zażółć gęślą jaźń 🚀",
        item_id: "msg_1",
        type: "response.output_text.delta"
      })}\r\n\r\n`,
      "utf8"
    );
    const cut = delta.indexOf(Buffer.from("🚀", "utf8")) + 2;
    write(delta.subarray(0, cut));
    write(delta.subarray(cut, delta.length - 2));
    write(delta.subarray(delta.length - 2));
    write(frame({
      arguments: toolArguments,
      item_id: "fc_1",
      type: "response.function_call_arguments.delta"
    }));
    if (!neverComplete) {
      write(frame({ response: completedResponse, type: "response.completed" }));
    }
    const beat = setInterval(() => {
      if (response.writableEnded) {
        return;
      }
      write(": keepalive\n\n");
      write(frame({ response: { id: "resp_1", status: "in_progress" }, type: "response.in_progress" }));
    }, 100);
    response.on("close", () => clearInterval(beat));
  };
}

function stallAfterCreated({ withText = false } = {}) {
  return (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ response: { id: "resp_1", status: "in_progress" }, type: "response.created" }));
    if (withText) {
      response.write(frame({ delta: "partial", item_id: "msg_1", type: "response.output_text.delta" }));
    }
    const beat = setInterval(() => {
      if (!response.writableEnded) {
        response.write(": keepalive\n\n");
      }
    }, 100);
    response.on("close", () => clearInterval(beat));
  };
}

function failAfterText() {
  return (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ response: { id: "resp_1", status: "in_progress" }, type: "response.created" }));
    response.write(frame({ delta: "half an answer", item_id: "msg_1", type: "response.output_text.delta" }));
    response.write(frame({
      response: { error: { code: "server_error", message: "upstream exploded" }, id: "resp_1", status: "failed" },
      type: "response.failed"
    }));
    const beat = setInterval(() => {
      if (!response.writableEnded) {
        response.write(": keepalive\n\n");
      }
    }, 100);
    response.on("close", () => clearInterval(beat));
  };
}

function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * One upstream and one gateway process per timeout profile: booting the real
 * gateway bundle per test would put the whole suite under needless load.
 */
async function useUpstream(handler, { upstreamTimeoutMs = 6000, useDefaultBaseUrl = false } = {}) {
  const upstream = await sharedUpstream();
  upstream.setHandler(handler);
  return { gateway: await sharedGateway(upstreamTimeoutMs, upstream.port, useDefaultBaseUrl), upstream };
}

let upstreamPromise;

function sharedUpstream() {
  upstreamPromise = upstreamPromise ?? startUpstream();
  return upstreamPromise;
}

const gatewayPromises = new Map();

function sharedGateway(upstreamTimeoutMs, upstreamPort, useDefaultBaseUrl) {
  const key = `${upstreamTimeoutMs}:${useDefaultBaseUrl}`;
  const existing = gatewayPromises.get(key);
  if (existing) {
    return existing;
  }
  const started = startGateway({ upstreamPort, upstreamTimeoutMs, useDefaultBaseUrl });
  gatewayPromises.set(key, started);
  return started;
}

after(async () => {
  for (const started of gatewayPromises.values()) {
    const gateway = await started.catch(() => undefined);
    gateway?.stop();
  }
  const upstream = await (upstreamPromise ?? Promise.resolve(undefined)).catch(() => undefined);
  upstream?.close();
});

async function startUpstream() {
  const state = { requests: 0 };
  let handler = () => undefined;
  let openResponse;
  let closed = false;
  const server = createServer((request, response) => {
    state.requests += 1;
    openResponse = response;
    closed = false;
    response.on("close", () => {
      closed = true;
    });
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    close() {
      server.closeAllConnections?.();
      server.close();
    },
    lastResponseEnded() {
      return Boolean(openResponse?.writableEnded);
    },
    port: server.address().port,
    setHandler(next) {
      handler = next;
      state.requests = 0;
      openResponse = undefined;
      closed = false;
    },
    async waitForRequest(timeoutMs = 5000) {
      await waitFor(() => state.requests > 0, timeoutMs, "the upstream never received a request");
    },
    async waitForResponseClose(timeoutMs) {
      await waitFor(() => closed, timeoutMs, "the upstream body was never released");
    }
  };
}

async function startGateway({ upstreamPort, upstreamTimeoutMs, useDefaultBaseUrl }) {
  const port = await freePort();
  const cwd = mkdtempSync(path.join(os.tmpdir(), "ccr-responses-guard-"));
  const config = {
    auth: { enabled: false },
    billing: { enabled: false },
    ccrResponsesStreamGuard: { idleTimeoutMs },
    host: "127.0.0.1",
    mcpGateway: { enabled: false },
    port,
    providers: [
      {
        apikey: "upstream-key",
        baseurl: useDefaultBaseUrl ? undefined : `http://127.0.0.1:${upstreamPort}/v1`,
        models: ["gpt-stall"],
        name: "StallUpstream",
        type: "openai_responses"
      },
      {
        apikey: "canary-key",
        baseurl: `http://127.0.0.1:${upstreamPort}`,
        models: ["canary-model"],
        name: "CanaryAnthropic",
        type: "anthropic_messages"
      }
    ],
    upstreamTimeoutMs
  };

  const env = {
    ...process.env,
    CCR_INTERNAL_HOME_DIR: path.join(cwd, "home"),
    CCR_INTERNAL_APP_DATA_DIR: path.join(cwd, "app-data"),
    CCR_INTERNAL_USER_DATA_DIR: path.join(cwd, "user-data"),
    HOME: path.join(cwd, "home"),
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    NODE_OPTIONS: "",
    OPENAI_BASE_URL: useDefaultBaseUrl ? `http://127.0.0.1:${upstreamPort}/v1` : "",
    PORT: String(port)
  };
  for (const name of ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "https_proxy", "http_proxy"]) {
    delete env[name];
  }
  const child = fork(gatewayBootstrapEntry, [], {
    cwd,
    env,
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let childOutput = "";
  child.stdout?.on("data", (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-4000);
  });
  child.stderr?.on("data", (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-4000);
  });
  child.send({ config, gatewayEntry, protocolVersion: 1, type: "gateway:start" });

  const stop = () => {
    child.kill("SIGKILL");
    rmSync(cwd, { force: true, recursive: true });
  };
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    try {
      const probe = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      await probe.text();
      return true;
    } catch {
      return false;
    }
  }, 20_000, `the gateway never started: ${childOutput}`).catch((error) => {
    stop();
    throw error;
  });

  return { child, stop, url };
}

async function postJson(baseUrl, route, payload, timeoutMs) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { json, status: response.status, text };
}

async function postStream(baseUrl, route, payload, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal
  });
  const decoder = new TextDecoder();
  let text = "";
  let failure;
  try {
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    failure = error;
  }
  return { clientTimedOut: signal.aborted, error: failure, status: response.status, text };
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs} ms: ${message}`);
}
