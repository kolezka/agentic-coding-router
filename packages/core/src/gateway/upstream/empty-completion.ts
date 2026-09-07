/**
 * Detects upstream responses that complete without any client-visible output and
 * keeps them retryable on the same target. Two shapes are recognized:
 *
 * 1. The aggregate `502` the core gateway dependency returns when an
 *    `openai_responses` payload parses into a completed response with no text,
 *    reasoning, or tool calls.
 * 2. A streamed response that reaches its terminal event without emitting any
 *    meaningful content. The stream is gated before the client sees headers, so
 *    an empty stream can still be replaced by a retry.
 *
 * Nothing here trusts client headers: the streaming guard runs only for a target
 * protocol resolved from the prepared attempt, and the JSON matcher requires the
 * structured marker the dependency itself writes.
 */
import { ROUTER_FALLBACK_DEFAULT_EMPTY_COMPLETION_RETRY_COUNT, ROUTER_FALLBACK_MAX_EMPTY_COMPLETION_RETRY_COUNT } from "@ccr/core/contracts/app";
import type { GatewayProviderProtocol, RouterFallbackConfig } from "@ccr/core/contracts/app";
import { clampNumber } from "@ccr/core/gateway/internal/collections";
import { isRecord } from "@ccr/core/gateway/internal/value";

/** Short abortable backoff: an empty completion is a provider hiccup, not a rate limit. */
const emptyCompletionRetryDelaysMs = [150, 300];

/** Upper bound on bytes buffered before the first meaningful stream output. */
export const emptyCompletionStreamGuardMaxBytes = 1024 * 1024;

export const emptyCompletionParseFailureMessage =
  "OpenAI response does not contain text output, reasoning output, or tool calls.";

export const emptyCompletionErrorCode = "empty_model_output";

export type EmptyCompletionFailure = {
  /**
   * HTTP dispatches CCR itself sent to the upstream for this target, including
   * the first one. The nested `attempts` of an aggregate upstream error count
   * provider calls made inside the dependency, which CCR cannot observe.
   */
  attemptCount: number;
  kind: "empty_completion";
};

export type EmptyCompletionInspection =
  | { kind: "pass"; response: Response }
  | { errorBody?: Record<string, unknown>; headers: Headers; kind: "empty"; status: number }
  | { headers: Headers; kind: "overflow" };

export function emptyCompletionRetryCountForFallback(fallback: Pick<RouterFallbackConfig, "emptyCompletionRetryCount">): number {
  const configured = fallback.emptyCompletionRetryCount;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return ROUTER_FALLBACK_DEFAULT_EMPTY_COMPLETION_RETRY_COUNT;
  }
  return clampNumber(configured, 0, ROUTER_FALLBACK_MAX_EMPTY_COMPLETION_RETRY_COUNT);
}

export function emptyCompletionRetryDelayMs(retryIndex: number): number {
  const index = Math.max(0, Math.trunc(retryIndex));
  return emptyCompletionRetryDelaysMs[Math.min(index, emptyCompletionRetryDelaysMs.length - 1)];
}

/**
 * Classifies one upstream response. A non-matching response is returned as-is,
 * byte-for-byte, including any body bytes read while classifying it.
 */
export async function inspectUpstreamEmptyCompletion(input: {
  protocol?: GatewayProviderProtocol;
  response: Response;
}): Promise<EmptyCompletionInspection> {
  const response = input.response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (response.status === 502 && input.protocol === "openai_responses" && contentType.includes("json")) {
    return await inspectEmptyCompletionErrorBody(response);
  }

  if (response.ok && input.protocol === "openai_responses" && contentType.includes("text/event-stream")) {
    return await inspectEmptyCompletionStream(response);
  }

  return { kind: "pass", response };
}

/**
 * Builds the response returned once the empty-completion budget is spent. The
 * client always sees 502: a stream that ended empty was answered with 200 by
 * the upstream, but carried no usable output.
 */
export function emptyCompletionFailureResponse(input: {
  attemptCount: number;
  errorBody?: Record<string, unknown>;
  headers: Headers;
}): Response {
  const body = input.errorBody ?? syntheticEmptyCompletionErrorBody();
  const error = isRecord(body.error) ? { ...body.error } : {};
  error.details = {
    ...(isRecord(error.details) ? error.details : {}),
    ccr_empty_completion: {
      ccr_upstream_attempts: input.attemptCount,
      reason: emptyCompletionErrorCode
    }
  };
  return jsonResponse({ ...body, error }, input.headers, 502);
}

/** Buffering the pre-output part of a stream is bounded, so the breach is reported instead of hidden. */
export function emptyCompletionGuardOverflowResponse(headers: Headers): Response {
  return jsonResponse(
    {
      error: {
        code: "empty_completion_guard_overflow",
        message: `Upstream stream sent more than ${emptyCompletionStreamGuardMaxBytes} bytes before any model output.`,
        type: "gateway_error"
      }
    },
    headers,
    502
  );
}

export function hasMeaningfulResponsesOutput(output: unknown): boolean {
  return Array.isArray(output) && output.some((item) => isMeaningfulResponsesOutputItem(item));
}

async function inspectEmptyCompletionErrorBody(response: Response): Promise<EmptyCompletionInspection> {
  const buffered = await readBoundedResponseBytes(response, emptyCompletionStreamGuardMaxBytes);
  if (!buffered.complete) {
    return { kind: "pass", response: replayResponse(response, buffered.chunks, buffered.reader) };
  }

  const errorBody = parseEmptyCompletionErrorBody(Buffer.concat(buffered.chunks).toString("utf8"));
  if (!errorBody) {
    return { kind: "pass", response: replayResponse(response, buffered.chunks, buffered.reader) };
  }
  return { errorBody, headers: response.headers, kind: "empty", status: response.status };
}

/**
 * Returns the parsed body only when every aggregated upstream attempt failed
 * with the dependency's structured empty-output marker on a completed response.
 * A mixed aggregate (an auth or rate-limit failure alongside it) does not match.
 */
export function parseEmptyCompletionErrorBody(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
  const attempts = parsed.error.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return undefined;
  return attempts.every((attempt) => isEmptyCompletionAttempt(attempt)) ? parsed : undefined;
}

function isEmptyCompletionAttempt(attempt: unknown): boolean {
  if (!isRecord(attempt)) return false;
  if (attempt.stage !== "response_parse") return false;
  if (attempt.status !== 502) return false;
  const details = attempt.details;
  if (!isRecord(details) || details.status !== "completed" || !Array.isArray(details.output)) return false;
  const gatewayError = details.gateway_error;
  if (!isRecord(gatewayError) || gatewayError.code !== emptyCompletionErrorCode || gatewayError.retryable !== true) return false;
  return !nonEmptyString(details.output_text) && !hasMeaningfulResponsesOutput(details.output);
}

async function inspectEmptyCompletionStream(response: Response): Promise<EmptyCompletionInspection> {
  const body = response.body;
  if (!body) return { kind: "pass", response };

  const reader = body.getReader();
  const scanner = new SseEventScanner();
  const chunks: Uint8Array[] = [];
  let bufferedBytes = 0;

  const release = () => ({ kind: "pass" as const, response: replayResponse(response, chunks, reader) });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      const events = done ? scanner.flush() : scanner.push(value as Uint8Array);
      if (value) {
        chunks.push(value as Uint8Array);
        bufferedBytes += value.byteLength;
      }
      for (const event of events) {
        const verdict = classifySseEvent(event);
        if (verdict === "meaningful" || verdict === "release") return release();
        if (verdict === "terminal-empty") {
          await cancelReader(reader);
          return { headers: response.headers, kind: "empty", status: response.status };
        }
      }
      if (done) {
        // A stream that ends without any meaningful output is the same failure
        // as an explicitly completed empty response.
        return { headers: response.headers, kind: "empty", status: response.status };
      }
      if (bufferedBytes > emptyCompletionStreamGuardMaxBytes) {
        await cancelReader(reader);
        return { headers: response.headers, kind: "overflow" };
      }
    }
  } catch (error) {
    await cancelReader(reader);
    throw error;
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The upstream stream is already gone; cleanup must not mask the outcome.
  }
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<{
  chunks: Uint8Array[];
  complete: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const body = response.body;
  if (!body) return { chunks: [], complete: true };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { chunks, complete: true };
    chunks.push(value as Uint8Array);
    total += (value as Uint8Array).byteLength;
    if (total > maxBytes) return { chunks, complete: false, reader };
  }
}

/** Replays already-read bytes and then pulls the rest on demand, keeping backpressure. */
function replayResponse(
  response: Response,
  chunks: Uint8Array[],
  reader?: ReadableStreamDefaultReader<Uint8Array>
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel(reason) {
      return reader?.cancel(reason);
    },
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
        return;
      }
      if (!reader) {
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value as Uint8Array);
    }
  });
  return new Response(stream, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  });
}

function jsonResponse(body: unknown, headers: Headers, status: number): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.delete("content-length");
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("transfer-encoding");
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { headers: responseHeaders, status });
}

function syntheticEmptyCompletionErrorBody(): Record<string, unknown> {
  return {
    error: {
      attempts: [
        {
          message: emptyCompletionParseFailureMessage,
          stage: "response_parse",
          status: 502,
          details: {
            gateway_error: { code: emptyCompletionErrorCode, retryable: true }
          }
        }
      ],
      message: "All target providers failed."
    }
  };
}

type SseVerdict = "meaningful" | "neutral" | "release" | "terminal-empty";

/** Splits an SSE byte stream into event blocks across chunk boundaries and CRLF line endings. */
class SseEventScanner {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  flush(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    let text = this.buffer;
    let held = "";
    if (!final && text.endsWith("\r")) {
      // A trailing CR may still become CRLF once the next chunk arrives.
      held = "\r";
      text = text.slice(0, -1);
    }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const events: string[] = [];
    let start = 0;
    for (;;) {
      const boundary = normalized.indexOf("\n\n", start);
      if (boundary === -1) break;
      events.push(normalized.slice(start, boundary));
      start = boundary + 2;
    }
    this.buffer = normalized.slice(start) + held;
    if (final && this.buffer.trim()) {
      events.push(this.buffer);
      this.buffer = "";
    }
    return events;
  }
}

function classifySseEvent(block: string): SseVerdict {
  const { data, event } = parseSseEventBlock(block);
  if (!data) return "neutral";
  if (data.trim() === "[DONE]") return "terminal-empty";

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return "neutral";
  }
  if (!isRecord(payload)) return "neutral";

  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
      if (nonEmptyString(choice.text) || nonEmptyString(delta.content) || nonEmptyString(delta.reasoning_content) ||
          nonEmptyString(delta.reasoning) || nonEmptyString(delta.refusal) ||
          (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) || isRecord(delta.function_call)) return "meaningful";
      if (choice.finish_reason && choice.finish_reason !== "stop") return "release";
    }
    return "neutral";
  }
  if (Array.isArray(payload.candidates)) {
    for (const candidate of payload.candidates) {
      if (!isRecord(candidate)) continue;
      const content = isRecord(candidate.content) ? candidate.content : {};
      if (Array.isArray(content.parts) && content.parts.some((part) => isRecord(part) &&
          (nonEmptyString(part.text) || Object.keys(part).some((key) => key !== "text" && key !== "thought")))) return "meaningful";
      if (candidate.finishReason && candidate.finishReason !== "STOP") return "release";
    }
    return "neutral";
  }
  const type = typeof payload.type === "string" ? payload.type : event;
  if (!type) return payload.error ? "release" : "neutral";
  return type.startsWith("response.") || type === "response"
    ? classifyResponsesEvent(type, payload)
    : classifyAnthropicEvent(type, payload);
}

function classifyResponsesEvent(type: string, payload: Record<string, unknown>): SseVerdict {
  if (type === "response.completed") {
    const response = isRecord(payload.response) ? payload.response : undefined;
    return nonEmptyString(response?.output_text) || hasMeaningfulResponsesOutput(response?.output) ? "release" : "terminal-empty";
  }
  if (type === "response.incomplete" || type === "response.failed" || type === "response.error") {
    // A truncated or failed response is a real upstream outcome, not an empty completion.
    return "release";
  }
  if (type.endsWith(".delta")) {
    return nonEmptyString(payload.delta) ? "meaningful" : "neutral";
  }
  if (type === "response.output_text.done" || type === "response.refusal.done") {
    return nonEmptyString(payload.text) || nonEmptyString(payload.refusal) ? "meaningful" : "neutral";
  }
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    return isMeaningfulResponsesOutputItem(payload.item) ? "meaningful" : "neutral";
  }
  if (type === "response.content_part.added" || type === "response.content_part.done") {
    return isMeaningfulResponsesContentPart(payload.part) ? "meaningful" : "neutral";
  }
  return "neutral";
}

const anthropicTerminalStopReasons = new Set(["max_tokens", "pause_turn", "refusal", "tool_use"]);

function classifyAnthropicEvent(type: string, payload: Record<string, unknown>): SseVerdict {
  if (type === "message_stop") return "terminal-empty";
  if (type === "error") return "release";
  if (type === "content_block_start") {
    return isMeaningfulAnthropicContentBlock(payload.content_block) ? "meaningful" : "neutral";
  }
  if (type === "content_block_delta") {
    const delta = isRecord(payload.delta) ? payload.delta : undefined;
    return nonEmptyString(delta?.text) || nonEmptyString(delta?.thinking) || nonEmptyString(delta?.partial_json)
      ? "meaningful"
      : "neutral";
  }
  if (type === "message_delta") {
    const delta = isRecord(payload.delta) ? payload.delta : undefined;
    const stopReason = typeof delta?.stop_reason === "string" ? delta.stop_reason : undefined;
    return stopReason && anthropicTerminalStopReasons.has(stopReason) ? "release" : "neutral";
  }
  return "neutral";
}

function isMeaningfulAnthropicContentBlock(block: unknown): boolean {
  if (!isRecord(block)) return false;
  const type = typeof block.type === "string" ? block.type : "";
  if (type === "text") return nonEmptyString(block.text);
  if (type === "thinking") return nonEmptyString(block.thinking);
  if (type === "redacted_thinking") return nonEmptyString(block.data);
  // Tool blocks and any block type this gateway does not know are real output.
  return type !== "";
}

function isMeaningfulResponsesOutputItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "message") {
    return Array.isArray(item.content) && item.content.some((part) => isMeaningfulResponsesContentPart(part));
  }
  if (type === "reasoning") {
    if (nonEmptyString(item.encrypted_content)) return true;
    const summary = Array.isArray(item.summary) ? item.summary : [];
    const content = Array.isArray(item.content) ? item.content : [];
    return [...summary, ...content].some((part) => isRecord(part) && nonEmptyString(part.text));
  }
  // Tool calls and unknown item types are treated as real output and never discarded.
  return type !== "";
}

function isMeaningfulResponsesContentPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "output_text") return nonEmptyString(part.text);
  if (type === "refusal") return nonEmptyString(part.refusal);
  return type !== "" && type !== "input_text";
}

function parseSseEventBlock(block: string): { data: string; event?: string } {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value.trim();
    else if (field === "data") dataLines.push(value);
  }
  return { data: dataLines.join("\n"), event };
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
