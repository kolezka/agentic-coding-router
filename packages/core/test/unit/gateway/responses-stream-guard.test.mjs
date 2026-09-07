import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRequestEndpoint,
  classifyResponsesFrame,
  guardResponsesStreamResponse,
  guardedResponsesStream,
  installResponsesStreamGuard,
  resolveResponsesStreamGuardSettings,
  responsesStreamGuardEndpoints,
  responsesStreamGuardFrameLimitCode,
  responsesStreamGuardIdleTimeoutCode,
  responsesStreamGuardUpstreamErrorCode,
  withoutResponsesStreamGuardOptions
} from "@ccr/core/gateway/core-runtime/responses-stream-guard.ts";

const encoder = new TextEncoder();
const created = sseFrame({ response: { id: "resp_1", status: "in_progress" }, type: "response.created" });
const textDelta = sseFrame({ delta: "hello", item_id: "msg_1", output_index: 0, type: "response.output_text.delta" });
const completed = sseFrame({
  response: { id: "resp_1", output: [], status: "completed" },
  type: "response.completed"
});

test("configured Responses providers define the guarded endpoints", () => {
  const endpoints = responsesStreamGuardEndpoints([
    { baseurl: "https://api.openai.test/v1", models: ["gpt-5"], name: "OpenAI", type: "openai_responses" },
    { baseurl: "https://chatgpt.com/backend-api/codex", models: ["gpt-5"], name: "Codex", type: "openai_responses" },
    { baseurl: "https://proxy.test/team/responses-api/", models: ["gpt-5"], name: "Proxy", type: "openai_responses" },
    { baseurl: "https://api.openai.test/v1", models: ["gpt-4"], name: "Chat", type: "openai_chat_completions" },
    { baseurl: "https://api.anthropic.test", models: ["sonnet"], name: "Anthropic", type: "anthropic_messages" },
    { baseurl: "not a url", models: ["x"], name: "Broken", type: "openai_responses" }
  ]);

  assert.deepEqual(endpoints, [
    "https://api.openai.test/v1/responses",
    "https://chatgpt.com/backend-api/codex/responses",
    "https://proxy.test/team/responses-api/responses"
  ]);
});

test("a Responses provider without a base URL uses the effective OpenAI fallback", () => {
  const previous = process.env.OPENAI_BASE_URL;
  try {
    delete process.env.OPENAI_BASE_URL;
    const providers = [{ name: "Default", type: "openai_responses" }];
    assert.deepEqual(resolveResponsesStreamGuardSettings({ providers })?.endpoints, [
      "https://api.openai.com/v1/responses"
    ]);
    assert.deepEqual(resolveResponsesStreamGuardSettings({ providers, openaiBaseUrl: "https://configured.test/v1" }).endpoints, [
      "https://configured.test/v1/responses"
    ]);
    process.env.OPENAI_BASE_URL = "https://environment.test/v1";
    assert.deepEqual(resolveResponsesStreamGuardSettings({ providers, openaiBaseUrl: "https://configured.test/v1" }).endpoints, [
      "https://environment.test/v1/responses"
    ]);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  }
});

test("a buffered terminal releases the upstream before the consumer drains preceding frames", async () => {
  const upstream = manualStream();
  const reader = guardedResponsesStream(upstream.stream, 0).getReader();
  upstream.push(created + textDelta + textDelta + completed);
  assert.equal(Buffer.from((await reader.read()).value).toString("utf8"), created);
  assert.equal(upstream.cancelled, true);
  await reader.cancel();
});

test("repeated tool lifecycle and empty output items cannot renew the watchdog", async () => {
  const upstream = manualStream();
  const outcome = collect(guardedResponsesStream(upstream.stream, 120)).then(() => undefined, (error) => error);
  upstream.push(created);
  const timer = setInterval(() => {
    if (!upstream.cancelled) upstream.push(
      sseFrame({ type: "response.web_search_call.searching" }) +
      sseFrame({ type: "response.output_item.added", output_index: 0, item: {} })
    );
  }, 20);
  try {
    await sleep(300);
    if (!upstream.cancelled) upstream.push(completed);
    assert.equal((await outcome)?.code, responsesStreamGuardIdleTimeoutCode);
  } finally {
    clearInterval(timer);
    if (!upstream.cancelled) upstream.close();
  }
});

test("endpoint matching compares origin and path instead of substrings", () => {
  const endpoints = new Set(responsesStreamGuardEndpoints([
    { baseurl: "https://api.openai.test/v1", models: ["gpt-5"], name: "OpenAI", type: "openai_responses" }
  ]));

  assert.equal(endpoints.has(canonicalRequestEndpoint("https://api.openai.test/v1/responses")), true);
  assert.equal(endpoints.has(canonicalRequestEndpoint("https://api.openai.test/v1/responses/?store=false")), true);
  assert.equal(endpoints.has(canonicalRequestEndpoint("https://api.openai.test/v1/responses/resp_1")), false);
  assert.equal(endpoints.has(canonicalRequestEndpoint("https://api.openai.test/v1/responses-preview")), false);
  assert.equal(endpoints.has(canonicalRequestEndpoint("https://api.openai.test/v1/models")), false);
  assert.equal(endpoints.has(canonicalRequestEndpoint("https://evil.test/api.openai.test/v1/responses")), false);
  assert.equal(endpoints.has(canonicalRequestEndpoint("http://api.openai.test/v1/responses")), false);
});

test("guard settings are absent when no provider exposes a Responses endpoint", () => {
  assert.equal(
    resolveResponsesStreamGuardSettings({
      ccrResponsesStreamGuard: { idleTimeoutMs: 1000 },
      providers: [{ baseurl: "https://api.anthropic.test", name: "Anthropic", type: "anthropic_messages" }]
    }),
    undefined
  );

  const settings = resolveResponsesStreamGuardSettings({
    ccrResponsesStreamGuard: { idleTimeoutMs: 1234 },
    providers: [{ baseurl: "https://api.openai.test/v1", name: "OpenAI", type: "openai_responses" }]
  });
  assert.deepEqual(settings, { endpoints: ["https://api.openai.test/v1/responses"], idleTimeoutMs: 1234 });
});

test("the private guard options never reach the gateway configuration", () => {
  const stripped = withoutResponsesStreamGuardOptions({
    ccrResponsesStreamGuard: { idleTimeoutMs: 1000 },
    port: 3457,
    providers: []
  });

  assert.deepEqual(stripped, { port: 3457, providers: [] });
  assert.equal("ccrResponsesStreamGuard" in stripped, false);
});

test("a terminal event ends the body without waiting for the upstream to close", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0));

  upstream.push(created + textDelta + completed);
  upstream.push(": ping\n\n");

  const received = await chunks;
  assert.equal(received, created + textDelta + completed);
  assert.equal(upstream.cancelled, true);
});

test("bytes and UTF-8 survive chunk splits, CRLF terminators and comment frames", async () => {
  const payload = "zażółć gęślą jaźń 🚀";
  const delta = `event: response.output_text.delta\r\ndata: ${JSON.stringify({
    delta: payload,
    type: "response.output_text.delta"
  })}\r\n\r\n`;
  const original = `: keepalive\r\n\r\n${delta}${completed.replace(/\n\n$/, "\r\n\r\n")}`;
  const bytes = Buffer.from(original, "utf8");

  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0));
  for (let index = 0; index < bytes.length; index += 7) {
    upstream.pushBytes(bytes.subarray(index, index + 7));
  }

  const received = await chunks;
  assert.equal(received, original);
  assert.equal(received.includes(payload), true);
});

test("heartbeats and repeated lifecycle events do not hold the watchdog off", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 120));

  upstream.push(created);
  const beat = setInterval(() => {
    upstream.push(`: ping\n\n${sseFrame({ response: { id: "resp_1" }, type: "response.in_progress" })}`);
  }, 20);

  const error = await chunks.then(() => undefined, (raised) => raised);
  clearInterval(beat);
  assert.equal(error?.code, responsesStreamGuardIdleTimeoutCode);
  assert.match(error.message, /no progress for 120 ms/);
  assert.equal(upstream.cancelled, true);
});

test("real deltas keep a slow stream alive past the idle budget", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 150));

  upstream.push(created);
  for (let index = 0; index < 5; index += 1) {
    await sleep(90);
    upstream.push(sseFrame({ delta: `chunk-${index}`, type: "response.output_text.delta" }));
  }
  await sleep(90);
  upstream.push(completed);

  const received = await chunks;
  assert.equal(received.includes("chunk-4"), true);
  assert.equal(received.endsWith(completed), true);
});

test("an upstream failure event fails the read after the delivered content", async () => {
  const failed = sseFrame({
    response: { error: { code: "server_error", message: "upstream exploded" }, id: "resp_1", status: "failed" },
    type: "response.failed"
  });
  const upstream = manualStream();
  const reader = guardedResponsesStream(upstream.stream, 0).getReader();

  upstream.push(created + textDelta + failed);

  const seen = [];
  let error;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      seen.push(Buffer.from(result.value).toString("utf8"));
    }
  } catch (raised) {
    error = raised;
  }

  assert.equal(seen.join(""), created + textDelta + failed);
  assert.equal(error?.code, responsesStreamGuardUpstreamErrorCode);
  assert.match(error.message, /response\.failed: upstream exploded/);
  assert.equal(upstream.cancelled, true);
});

test("a bare error event fails the read instead of ending it as a success", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0));

  upstream.push(created + sseFrame({ code: "rate_limit_exceeded", message: "slow down", type: "error" }));

  const error = await chunks.then(() => undefined, (raised) => raised);
  assert.equal(error?.code, responsesStreamGuardUpstreamErrorCode);
  assert.match(error.message, /error: slow down/);
});

test("frames after a terminal event are dropped, including a late failure", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0));

  upstream.push(created + completed + sseFrame({ message: "too late", type: "response.failed" }) + "data: [DONE]\n\n");

  const received = await chunks;
  assert.equal(received, created + completed);
});

test("a [DONE] sentinel also ends the body", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0));

  upstream.push(`${created}data: [DONE]\n\n`);

  assert.equal(await chunks, `${created}data: [DONE]\n\n`);
});

test("an idle timeout of zero disables the watchdog but keeps the terminal close", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0));

  upstream.push(created);
  await sleep(120);
  upstream.push(": ping\n\n");
  await sleep(120);
  upstream.push(completed);

  assert.equal(await chunks, `${created}: ping\n\n${completed}`);
});

test("a slow consumer does not read as a stalled model", async () => {
  const upstream = manualStream();
  const reader = guardedResponsesStream(upstream.stream, 120).getReader();

  upstream.push(created + textDelta + textDelta);
  await reader.read();
  await sleep(400);
  const second = await reader.read();
  assert.equal(Buffer.from(second.value).toString("utf8"), textDelta);

  await sleep(400);
  const third = await reader.read();
  assert.equal(Buffer.from(third.value).toString("utf8"), textDelta);

  const error = await reader.read().then(() => undefined, (raised) => raised);
  assert.equal(error?.code, responsesStreamGuardIdleTimeoutCode);
});

test("many small frames in one chunk do not trip the single-frame limit", async () => {
  const frames = Array.from({ length: 400 }, (_value, index) =>
    sseFrame({ delta: `d${index}`, type: "response.output_text.delta" })
  ).join("");
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0, 512));

  upstream.push(frames + completed);

  assert.equal(await chunks, frames + completed);
});

test("a complete oversized frame fails even when its delimiter is already buffered", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0, 256));

  upstream.push(sseFrame({ delta: "x".repeat(600), type: "response.output_text.delta" }) + completed);

  const error = await chunks.then(() => undefined, (raised) => raised);
  assert.equal(error?.code, responsesStreamGuardFrameLimitCode);
  assert.equal(upstream.cancelled, true);
});

test("an event that never closes its frame fails with an explicit limit error", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0, 256));

  upstream.push(`data: ${"x".repeat(600)}`);

  const error = await chunks.then(() => undefined, (raised) => raised);
  assert.equal(error?.code, responsesStreamGuardFrameLimitCode);
  assert.match(error.message, /exceeded 256 bytes/);
  assert.equal(upstream.cancelled, true);
});

test("cancelling the guarded body cancels the upstream read", async () => {
  const upstream = manualStream();
  const reader = guardedResponsesStream(upstream.stream, 0).getReader();

  upstream.push(created);
  await reader.read();
  await reader.cancel("client disconnected");

  assert.equal(upstream.cancelled, true);
});

test("an aborted upstream body surfaces as a stream error", async () => {
  const upstream = manualStream();
  const chunks = collect(guardedResponsesStream(upstream.stream, 0));

  upstream.push(created);
  upstream.fail(new Error("aborted by the client"));

  const error = await chunks.then(() => undefined, (raised) => raised);
  assert.match(error?.message ?? "", /aborted by the client/);
});

test("only meaningful Responses events count as progress", () => {
  const progressOf = (payload) => classifyResponsesFrame(Buffer.from(sseFrame(payload), "utf8")).progress;

  assert.equal(progressOf({ delta: "hi", type: "response.output_text.delta" }), true);
  assert.equal(progressOf({ delta: "", type: "response.output_text.delta" }), false);
  assert.equal(progressOf({ delta: "let me think", type: "response.reasoning_summary_text.delta" }), true);
  assert.equal(progressOf({ delta: "sorry", type: "response.refusal.delta" }), true);
  assert.equal(progressOf({ delta: '{"a":', type: "response.function_call_arguments.delta" }), true);
  assert.equal(progressOf({ item: { id: "msg_1", type: "message" }, type: "response.output_item.added" }), false);
  assert.equal(progressOf({ part: { type: "output_text" }, type: "response.content_part.done" }), false);
  assert.equal(progressOf({ type: "response.web_search_call.searching" }), false);
  assert.equal(progressOf({ type: "response.created" }), false);
  assert.equal(progressOf({ type: "response.in_progress" }), false);
  assert.equal(progressOf({ type: "keepalive" }), false);
  assert.equal(progressOf({ type: "response.keepalive" }), false);
  assert.equal(progressOf({ ok: true }), false);
});

test("a complete frame with invalid JSON is forwarded without a terminal verdict", () => {
  const outcome = classifyResponsesFrame(Buffer.from('data: {"type":"response.compl\n\n', "utf8"));

  assert.deepEqual(outcome, { progress: false });
});

test("the guarded response drops transfer headers that no longer describe the body", () => {
  const upstream = new Response(readableOf(created + completed), {
    headers: {
      "content-encoding": "gzip",
      "content-length": "42",
      "content-type": "text/event-stream",
      "x-request-id": "req_1"
    },
    status: 200
  });

  const guarded = guardResponsesStreamResponse(upstream, 0);

  assert.equal(guarded.headers.get("content-encoding"), null);
  assert.equal(guarded.headers.get("content-length"), null);
  assert.equal(guarded.headers.get("content-type"), "text/event-stream");
  assert.equal(guarded.headers.get("x-request-id"), "req_1");
  assert.equal(guarded.status, 200);
});

test("non-stream, failed and already guarded responses pass through untouched", () => {
  const json = new Response("{}", { headers: { "content-type": "application/json" }, status: 200 });
  assert.equal(guardResponsesStreamResponse(json, 0), json);

  const failed = new Response(readableOf("boom"), {
    headers: { "content-type": "text/event-stream" },
    status: 500
  });
  assert.equal(guardResponsesStreamResponse(failed, 0), failed);

  const stream = new Response(readableOf(completed), {
    headers: { "content-type": "text/event-stream" },
    status: 200
  });
  const guarded = guardResponsesStreamResponse(stream, 0);
  assert.notEqual(guarded, stream);
  assert.equal(guardResponsesStreamResponse(guarded, 0), guarded);
});

test("the guard wraps both the global fetch and the gateway undici fetch exactly once", async () => {
  const settings = { endpoints: ["https://api.openai.test/v1/responses"], idleTimeoutMs: 0 };
  const calls = [];
  const undiciModule = {
    Response,
    fetch: async (input) => {
      calls.push(`dependency:${String(input)}`);
      return new Response(readableOf(created + completed), {
        headers: { "content-type": "text/event-stream" },
        status: 200
      });
    }
  };
  const originalGlobalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(`global:${String(input)}`);
    return new Response(readableOf(created + completed), {
      headers: { "content-type": "text/event-stream" },
      status: 200
    });
  };

  try {
    const first = installResponsesStreamGuard(settings, import.meta.filename, () => undefined, undiciModule);
    assert.deepEqual(first, { dependencyFetch: true, globalFetch: true });
    const wrappedGlobal = globalThis.fetch;
    const wrappedDependency = undiciModule.fetch;

    const second = installResponsesStreamGuard(settings, import.meta.filename, () => undefined, undiciModule);
    assert.deepEqual(second, { dependencyFetch: false, globalFetch: false });
    assert.equal(globalThis.fetch, wrappedGlobal);
    assert.equal(undiciModule.fetch, wrappedDependency);

    const guarded = await undiciModule.fetch("https://api.openai.test/v1/responses");
    assert.equal(await readAll(guarded), created + completed);

    const untouched = await undiciModule.fetch("https://api.openai.test/v1/models");
    assert.equal(untouched.headers.get("content-encoding"), null);
    await untouched.body.cancel();
    assert.deepEqual(calls, [
      "dependency:https://api.openai.test/v1/responses",
      "dependency:https://api.openai.test/v1/models"
    ]);
  } finally {
    globalThis.fetch = originalGlobalFetch;
  }
});

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function readableOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

function manualStream() {
  const state = { cancelled: false };
  let streamController;
  state.stream = new ReadableStream({
    cancel() {
      state.cancelled = true;
    },
    start(controller) {
      streamController = controller;
    }
  });
  state.push = (text) => streamController.enqueue(encoder.encode(text));
  state.pushBytes = (bytes) => streamController.enqueue(new Uint8Array(bytes));
  state.close = () => streamController.close();
  state.fail = (error) => streamController.error(error);
  return state;
}

async function collect(stream) {
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      return text;
    }
    text += Buffer.from(result.value).toString("utf8");
  }
}

async function readAll(response) {
  return collect(response.body);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
