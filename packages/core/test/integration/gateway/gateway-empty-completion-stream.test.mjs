import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { gatewayService } from "@ccr/core/gateway/service.ts";
import { waitForTcpListener } from "../../support/loopback-listener.mjs";

const emptyResponsesStream = [
  `data: ${JSON.stringify({ response: { id: "resp_empty", output: [], status: "in_progress" }, type: "response.created" })}\n\n`,
  `data: ${JSON.stringify({
    response: {
      id: "resp_empty",
      output: [
        {
          content: [{ annotations: [], logprobs: [], text: "", type: "output_text" }],
          role: "assistant",
          status: "completed",
          type: "message"
        }
      ],
      status: "completed",
      usage: { output_tokens: 4 }
    },
    type: "response.completed"
  })}\n\n`,
  "data: [DONE]\n\n"
];

const meaningfulDelta = `data: ${JSON.stringify({
  delta: "hello",
  item_id: "msg_1",
  output_index: 0,
  type: "response.output_text.delta"
})}\n\n`;

test("an empty upstream stream is retried without the client seeing it", async (t) => {
  const upstreamRequests = [];
  let openStreamResponse;
  const upstream = createServer((request, response) => {
    request.resume();
    upstreamRequests.push(request.url);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (upstreamRequests.length === 1) {
      for (const chunk of emptyResponsesStream) response.write(chunk);
      response.end();
      return;
    }
    response.write(meaningfulDelta);
    // Left open on purpose: the client must receive the first bytes before the
    // upstream stream ends, so the guard cannot be buffering to EOF.
    openStreamResponse = response;
  });
  const gateway = createGatewayServer();

  try {
    await listen(upstream);
    await waitForTcpListener(upstream);
    await listen(gateway);
    await waitForTcpListener(gateway);
    await configureGateway(serverPort(upstream));

    const response = await fetch(`http://127.0.0.1:${serverPort(gateway)}/v1/responses`, {
      body: JSON.stringify({ input: "hello", model: "EmptyUpstream/gpt-empty", stream: true }),
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json"
      },
      method: "POST"
    });

    const errorText = response.status === 200 ? "" : await response.text();
    assert.equal(response.status, 200, errorText);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(openStreamResponse?.writableEnded, false, "upstream must still be streaming");
    const firstText = new TextDecoder().decode(first.value);
    assert.match(firstText, /"delta":"hello"/);
    assert.doesNotMatch(firstText, /resp_empty/);

    openStreamResponse.end();
    await reader.cancel("test complete");
    assert.equal(upstreamRequests.length, 2);
  } finally {
    await closeServer(gateway);
    await closeServer(upstream);
    await gatewayService.stop();
  }
});

test("an exhausted empty stream reaches the client as a typed 502 with no leaked stream bytes", async (t) => {
  const upstreamRequests = [];
  const upstream = createServer((request, response) => {
    request.resume();
    upstreamRequests.push(request.url);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of emptyResponsesStream) response.write(chunk);
    response.end();
  });
  const gateway = createGatewayServer();

  try {
    await listen(upstream);
    await waitForTcpListener(upstream);
    await listen(gateway);
    await waitForTcpListener(gateway);
    await configureGateway(serverPort(upstream));

    const response = await fetch(`http://127.0.0.1:${serverPort(gateway)}/v1/responses`, {
      body: JSON.stringify({ input: "hello", model: "EmptyUpstream/gpt-empty", stream: true }),
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json"
      },
      method: "POST"
    });

    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const text = await response.text();
    assert.doesNotMatch(text, /event: |data: /);
    const body = JSON.parse(text);
    assert.equal(body.error.details.ccr_empty_completion.ccr_upstream_attempts, 3);
    assert.equal(body.error.details.ccr_empty_completion.reason, "empty_model_output");
    assert.equal(body.error.attempts[0].details.gateway_error.code, "empty_model_output");
    assert.equal(upstreamRequests.length, 3);
  } finally {
    await closeServer(gateway);
    await closeServer(upstream);
    await gatewayService.stop();
  }
});

function createGatewayServer() {
  return createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    void gatewayService.proxyRequest(request, response, requestPath).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      if (!response.writableEnded) {
        response.end(`${JSON.stringify({ error: { message: String(error?.message ?? error) } })}\n`);
      }
    });
  });
}

async function configureGateway(upstreamPort) {
  const config = createDefaultAppConfig();
  config.APIKEY = "test-api-key";
  config.Providers = [
    {
      capabilities: [{ baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, type: "openai_responses" }],
      credentials: [{ apiKey: "upstream-key", id: "main" }],
      id: "empty-upstream",
      models: ["gpt-empty"],
      name: "EmptyUpstream"
    }
  ];
  config.Router.fallback = {
    emptyCompletionRetryCount: 2,
    mode: "retry",
    models: [],
    retryCount: 1
  };
  config.gateway.coreHost = "127.0.0.1";
  config.gateway.corePort = upstreamPort;
  config.gateway.host = "127.0.0.1";
  config.gateway.port = 0;
  await gatewayService.updateConfig(config);
  gatewayService.coreAuthToken = "test-core-auth-token";
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serverPort(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return address.port;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => server.closeAllConnections?.(), 1000);
    server.close((error) => {
      clearTimeout(timeout);
      error ? reject(error) : resolve();
    });
  });
}
