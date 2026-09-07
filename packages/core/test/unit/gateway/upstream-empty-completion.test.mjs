import assert from "node:assert/strict";
import test from "node:test";
import { fetchUpstreamWithFallback } from "@ccr/core/gateway/upstream/executor.ts";

import capturedEmptyCompletionBody from "../../support/empty-completion-response.fixture.json" with { type: "json" };
import { RequestRouteTraceRecorder } from "@ccr/core/observability/route-trace.ts";
import { inspectUpstreamEmptyCompletion } from "@ccr/core/gateway/upstream/empty-completion.ts";

const capturedEmptyCompletionAttempt = capturedEmptyCompletionBody.error.attempts[0];

const successBody = {
  output: [
    {
      content: [{ annotations: [], text: "hello", type: "output_text" }],
      role: "assistant",
      status: "completed",
      type: "message"
    }
  ],
  status: "completed"
};

function responsesProvider(overrides = {}) {
  return {
    capabilities: [{ baseUrl: "https://openai.example", type: "openai_responses" }],
    credentials: [{ apiKey: "openai-key", id: "openai-main" }],
    id: "openai-main",
    models: ["gpt-primary"],
    name: "OpenAI",
    ...overrides
  };
}

function configWith(fallback, providers = [responsesProvider()]) {
  return {
    Providers: providers,
    Router: { fallback, rules: [] },
    virtualModelProfiles: []
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const parts = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[index]);
      index += 1;
    }
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
    status: 200
  });
}

function sseEvent(payload) {
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function runUpstream(input, fetchImpl) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ init: { ...init, headers: { ...init.headers } }, url: String(url) });
    return await fetchImpl(calls.length, { init, url: String(url) });
  };
  try {
    const result = await fetchUpstreamWithFallback({
      body: Buffer.from(JSON.stringify({ input: [], model: input.routedModel })),
      config: input.config,
      coreAuthToken: "core-token",
      fallback: input.fallback,
      headers: input.headers ?? {},
      method: "POST",
      path: input.path ?? "/v1/responses",
      routedModel: input.routedModel,
      signal: input.signal,
      trace: input.trace,
      upstreamUrl: `http://127.0.0.1:3456${input.path ?? "/v1/responses"}`
    });
    return { calls, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("empty retries have distinct trace attempts and upstream attempt headers", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 1 };
  const trace = new RequestRouteTraceRecorder(Date.now());
  const { calls } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary", trace },
    () => jsonResponse(capturedEmptyCompletionBody, 502)
  );
  assert.deepEqual(calls.map((call) => call.init.headers["x-ccr-route-attempt"]), ["1", "2", "3"]);
  assert.equal(trace.finish().attemptCount, 3);
});

test("an ordinary failure cannot reset the empty retry budget for the same target", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 2 };
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    (call) => call === 2 ? jsonResponse({ error: { message: "unavailable" } }, 503) : jsonResponse(capturedEmptyCompletionBody, 502)
  );
  assert.equal(calls.length, 4);
  assert.equal((await result.response.json()).error.details.ccr_empty_completion.ccr_upstream_attempts, 4);
});

test("JSON empty classification is confined to the Responses target protocol", async () => {
  const original = JSON.stringify(capturedEmptyCompletionBody);
  const inspected = await inspectUpstreamEmptyCompletion({
    protocol: "anthropic_messages",
    response: jsonResponse(capturedEmptyCompletionBody, 502)
  });
  assert.equal(inspected.kind, "pass");
  assert.equal(await inspected.response.text(), original);
});

test("incomplete evidence and real output never qualify as retryable completed JSON", async () => {
  const variants = [
    (body) => { delete body.error.attempts[0].details.status; },
    (body) => { body.error.attempts[0].details.gateway_error.retryable = false; },
    (body) => { body.error.attempts[0].details.output_text = "real answer"; },
    (body) => { body.error.attempts[0].details.output = [{ type: "reasoning", encrypted_content: "opaque-state" }]; }
  ];
  for (const mutate of variants) {
    const body = structuredClone(capturedEmptyCompletionBody);
    mutate(body);
    const inspected = await inspectUpstreamEmptyCompletion({ protocol: "openai_responses", response: jsonResponse(body, 502) });
    assert.equal(inspected.kind, "pass");
    assert.deepEqual(await inspected.response.json(), body);
  }
});

test("Responses targets preserve meaningful Chat Completions and Gemini client streams", async () => {
  const streams = [
    'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","type":"function","function":{"name":"lookup"}}]}}]}\n\ndata: [DONE]\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}\n\n'
  ];
  for (const text of streams) {
    const inspected = await inspectUpstreamEmptyCompletion({ protocol: "openai_responses", response: sseResponse([text]) });
    assert.equal(inspected.kind, "pass");
    assert.equal(await inspected.response.text(), text);
  }
});

test("whitespace text and completed encrypted reasoning are not discarded", async () => {
  const streams = [
    sseEvent({ type: "response.output_text.delta", delta: " " }) + sseEvent({ type: "response.completed", response: { output: [] } }),
    sseEvent({ type: "response.completed", response: { output: [{ type: "reasoning", encrypted_content: "opaque-state" }] } }),
    sseEvent({ type: "response.completed", response: { output_text: "hello", output: [] } })
  ];
  for (const text of streams) {
    const inspected = await inspectUpstreamEmptyCompletion({ protocol: "openai_responses", response: sseResponse([text]) });
    assert.equal(inspected.kind, "pass");
    assert.equal(await inspected.response.text(), text);
  }
});

test("an empty completion retries the same target and returns the later success", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 1 };
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    (call) => call === 1
      ? jsonResponse(capturedEmptyCompletionBody, 502)
      : jsonResponse(successBody, 200)
  );

  assert.equal(result.response.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(await result.response.json(), successBody);
  assert.equal(result.failure, undefined);
});

test("an exhausted empty-completion budget returns the original error body plus CCR attempt metadata", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 1 };
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => jsonResponse(capturedEmptyCompletionBody, 502)
  );

  assert.equal(calls.length, 3);
  assert.equal(result.response.status, 502);
  assert.deepEqual(result.failure, { attemptCount: 3, kind: "empty_completion" });
  const body = await result.response.json();
  assert.deepEqual(body, {
    ...capturedEmptyCompletionBody,
    error: {
      ...capturedEmptyCompletionBody.error,
      details: { ccr_empty_completion: { ccr_upstream_attempts: 3, reason: "empty_model_output" } }
    }
  });
});

test("emptyCompletionRetryCount 0 dispatches the request once", async () => {
  const fallback = { emptyCompletionRetryCount: 0, mode: "retry", models: [], retryCount: 1 };
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => jsonResponse(capturedEmptyCompletionBody, 502)
  );

  assert.equal(calls.length, 1);
  assert.equal(result.response.status, 502);
  assert.deepEqual(result.failure, { attemptCount: 1, kind: "empty_completion" });
});

test("empty-completion retries do not multiply the generic same-target retry budget", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 3 };
  const { calls } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => jsonResponse(capturedEmptyCompletionBody, 502)
  );

  assert.equal(calls.length, 3);
});

test("a genuinely different model-chain target is tried after the empty budget is spent", async () => {
  const fallback = {
    emptyCompletionRetryCount: 1,
    mode: "model-chain",
    models: ["Backup/gpt-backup"],
    retryCount: 0
  };
  const config = configWith(fallback, [
    responsesProvider(),
    responsesProvider({
      capabilities: [{ baseUrl: "https://backup.example", type: "openai_responses" }],
      credentials: [{ apiKey: "backup-key", id: "backup-main" }],
      id: "backup",
      models: ["gpt-backup"],
      name: "Backup"
    })
  ]);
  const { calls, result } = await runUpstream(
    { config, fallback, routedModel: "OpenAI/gpt-primary" },
    (call) => call <= 2 ? jsonResponse(capturedEmptyCompletionBody, 502) : jsonResponse(successBody, 200)
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => JSON.parse(call.init.body).model), [
    "gpt-primary",
    "gpt-primary",
    "gpt-backup"
  ]);
  assert.equal(result.response.status, 200);
});

test("an ordinary 502 keeps the existing retry policy and an untouched body", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 1 };
  const ordinaryBody = '{"error":{"message":"boom","type":"upstream_error"}}';
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => new Response(ordinaryBody, {
      headers: { "content-type": "application/json", "retry-after": "0.001" },
      status: 502
    })
  );

  assert.equal(calls.length, 2);
  assert.equal(result.response.status, 502);
  assert.equal(await result.response.text(), ordinaryBody);
  assert.equal(result.failure, undefined);
});

test("a mixed aggregate error is not treated as an empty completion", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const mixedBody = {
    error: {
      attempts: [
        capturedEmptyCompletionAttempt,
        { message: "rate limited", stage: "response", status: 429 }
      ],
      message: "All target providers failed."
    }
  };
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => jsonResponse(mixedBody, 502)
  );

  assert.equal(calls.length, 1);
  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), mixedBody);
});

test("an empty Anthropic-shaped stream retries and releases the successful stream", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 1 };
  const emptyStream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];
  const successStream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","content":[]}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];
  const { calls, result } = await runUpstream(
    {
      config: configWith(fallback),
      fallback,
      path: "/v1/messages",
      routedModel: "OpenAI/gpt-primary"
    },
    (call) => sseResponse(call === 1 ? emptyStream : successStream)
  );

  assert.equal(calls.length, 2);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), successStream.join(""));
});

test("an exhausted empty stream fails with the typed parse error before any client bytes", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 1 };
  const emptyStream = [
    sseEvent({ response: { id: "resp_1", output: [], status: "in_progress" }, type: "response.created" }),
    sseEvent({
      response: {
        id: "resp_1",
        output: [
          {
            content: [{ annotations: [], text: "", type: "output_text" }],
            role: "assistant",
            status: "completed",
            type: "message"
          }
        ],
        status: "completed",
        usage: { output_tokens: 4 }
      },
      type: "response.completed"
    }),
    "data: [DONE]\n\n"
  ];
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => sseResponse(emptyStream)
  );

  assert.equal(calls.length, 3);
  assert.equal(result.response.status, 502);
  assert.equal(result.response.headers.get("content-type"), "application/json");
  assert.deepEqual(result.failure, { attemptCount: 3, kind: "empty_completion" });
  const body = await result.response.json();
  assert.equal(body.error.attempts[0].details.gateway_error.code, "empty_model_output");
  assert.equal(body.error.details.ccr_empty_completion.ccr_upstream_attempts, 3);
});

test("a tool-only stream is released untouched", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const toolStream = [
    sseEvent({ response: { id: "resp_1", output: [], status: "in_progress" }, type: "response.created" }),
    sseEvent({
      item: { arguments: "{}", call_id: "call_1", name: "read_file", type: "function_call" },
      output_index: 0,
      type: "response.output_item.added"
    }),
    sseEvent({
      response: {
        id: "resp_1",
        output: [{ arguments: "{}", call_id: "call_1", name: "read_file", type: "function_call" }],
        status: "completed",
        usage: { output_tokens: 4 }
      },
      type: "response.completed"
    })
  ];
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => sseResponse(toolStream)
  );

  assert.equal(calls.length, 1);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), toolStream.join(""));
});

test("a reasoning-only stream is released untouched", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const reasoningStream = [
    sseEvent({ delta: "thinking about it", item_id: "rs_1", type: "response.reasoning_summary_text.delta" }),
    sseEvent({
      response: {
        id: "resp_1",
        output: [{ summary: [{ text: "thinking about it", type: "summary_text" }], type: "reasoning" }],
        status: "completed"
      },
      type: "response.completed"
    })
  ];
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => sseResponse(reasoningStream)
  );

  assert.equal(calls.length, 1);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), reasoningStream.join(""));
});

test("an incomplete max_tokens stream is released untouched", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const incompleteStream = [
    sseEvent({
      response: {
        id: "resp_1",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        status: "incomplete"
      },
      type: "response.incomplete"
    })
  ];
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => sseResponse(incompleteStream)
  );

  assert.equal(calls.length, 1);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), incompleteStream.join(""));
});

test("an Anthropic max_tokens stop reason is released untouched", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const truncatedStream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4096}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];
  const { calls, result } = await runUpstream(
    {
      config: configWith(fallback),
      fallback,
      path: "/v1/messages",
      routedModel: "OpenAI/gpt-primary"
    },
    () => sseResponse(truncatedStream)
  );

  assert.equal(calls.length, 1);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), truncatedStream.join(""));
});

test("split CRLF stream chunks are replayed byte for byte", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const chunks = [
    "event: response.output_text.de",
    'lta\r\ndata: {"type":"response.output_text.delta","delta":"he',
    'llo"}\r\n\r\nevent: response.completed\r\ndata: {"type":"response.completed","response":',
    '{"id":"resp_1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"status":"completed"}}\r\n\r\n'
  ];
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => sseResponse(chunks)
  );

  assert.equal(calls.length, 1);
  assert.equal(await result.response.text(), chunks.join(""));
});

test("a stream that buffers past the guard bound fails visibly instead of succeeding silently", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const filler = sseEvent({ sequence_number: 1, type: "response.in_progress" });
  const chunks = Array.from({ length: 40 }, () => filler.repeat(400));
  const { calls, result } = await runUpstream(
    { config: configWith(fallback), fallback, routedModel: "OpenAI/gpt-primary" },
    () => sseResponse(chunks)
  );

  assert.equal(calls.length, 1);
  assert.equal(result.response.status, 502);
  const body = await result.response.json();
  assert.equal(body.error.code, "empty_completion_guard_overflow");
});

test("aborting during the empty-completion backoff stops before another dispatch", async () => {
  const fallback = { emptyCompletionRetryCount: 2, mode: "retry", models: [], retryCount: 0 };
  const controller = new AbortController();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delayMs, ...args) => {
    queueMicrotask(() => controller.abort(new Error("client disconnected")));
    return originalSetTimeout(callback, delayMs, ...args);
  };

  try {
    await assert.rejects(
      runUpstream(
        {
          config: configWith(fallback),
          fallback,
          routedModel: "OpenAI/gpt-primary",
          signal: controller.signal
        },
        () => jsonResponse(capturedEmptyCompletionBody, 502)
      ),
      /client disconnected/
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
