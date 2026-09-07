/**
 * The bundled gateway collects a Responses event stream until the HTTP body
 * reaches EOF, so an upstream that stays open after `response.completed` hangs
 * the request. This guard wraps the upstream body before the gateway sees it:
 * frames are forwarded byte-for-byte, a terminal event ends the body, and a
 * stream that stops making progress fails instead of stalling. It only touches
 * successful `text/event-stream` bodies from the Responses endpoint of a
 * configured `openai_responses` provider.
 */
import { createRequire } from "node:module";
import { isRecord, numberValue, stringValue } from "@ccr/core/gateway/internal/value";

export type ResponsesStreamGuardSettings = {
  endpoints: string[];
  idleTimeoutMs: number;
};

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

type UndiciModule = {
  Response?: typeof Response;
  fetch?: FetchLike;
};

export type FrameOutcome = {
  failure?: Error;
  progress: boolean;
  terminal?: boolean;
};

type SseFrameFields = {
  data: string;
  name?: string;
};

export type ResponsesStreamGuardInstallResult = {
  dependencyFetch: boolean;
  globalFetch: boolean;
};

export const responsesStreamGuardConfigKey = "ccrResponsesStreamGuard";

/** Largest single SSE frame the scanner will hold before failing the read. */
export const responsesStreamGuardMaxFrameBytes = 16 * 1024 * 1024;

export const responsesStreamGuardIdleTimeoutCode = "ccr_responses_stream_idle_timeout";
export const responsesStreamGuardUpstreamErrorCode = "ccr_responses_stream_upstream_error";
export const responsesStreamGuardFrameLimitCode = "ccr_responses_stream_frame_limit";

const guardedFetchMarker = Symbol.for("ccr.responsesStreamGuard.fetch");
const guardedResponseMarker = Symbol.for("ccr.responsesStreamGuard.response");

const carriageReturn = 0x0d;
const lineFeed = 0x0a;
const upstreamFailureDetailLimit = 300;

const terminalEventTypes = new Set(["response.completed", "response.incomplete"]);
const failureEventTypes = new Set(["error", "response.error", "response.failed"]);
const progressEventTypes = new Set([
  "response.output_text.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.refusal.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta"
]);

/**
 * Returns undefined when no configured provider exposes a Responses endpoint,
 * so callers can skip resolving the gateway's undici copy entirely.
 */
export function resolveResponsesStreamGuardSettings(
  config: Record<string, unknown>
): ResponsesStreamGuardSettings | undefined {
  const providers = Array.isArray(config.providers) ? config.providers.filter(isRecord) : [];
  const defaultOpenAIProvider = providers.find((provider) => {
    const type = stringValue(provider.type) ?? "";
    return /^openai(?:[_.:]|$)/.test(type) &&
      type !== "openai_image_generations" && type !== "openai_video_generations";
  });
  const fallbackBaseUrl = stringValue(process.env.OPENAI_BASE_URL)?.trim() ||
    stringValue(defaultOpenAIProvider?.baseurl) || stringValue(config.openaiBaseUrl) ||
    "https://api.openai.com/v1";
  const endpoints = responsesStreamGuardEndpoints(providers, fallbackBaseUrl);
  if (endpoints.length === 0) {
    return undefined;
  }
  const options = isRecord(config[responsesStreamGuardConfigKey]) ? config[responsesStreamGuardConfigKey] : {};
  const idleTimeoutMs = numberValue(options.idleTimeoutMs);
  return {
    endpoints,
    idleTimeoutMs: idleTimeoutMs !== undefined && idleTimeoutMs >= 0 ? idleTimeoutMs : 0
  };
}

/** Strips the CCR-private guard options from the config handed to the gateway. */
export function withoutResponsesStreamGuardOptions(config: Record<string, unknown>): Record<string, unknown> {
  if (!(responsesStreamGuardConfigKey in config)) {
    return config;
  }
  const { [responsesStreamGuardConfigKey]: _guard, ...rest } = config;
  return rest;
}

/**
 * Canonical `origin + path` of the Responses endpoint of every configured
 * `openai_responses` provider. Codex bases and custom Responses proxies fall
 * out of the same rule: the gateway always posts to `<baseurl>/responses`.
 */
export function responsesStreamGuardEndpoints(
  providers: unknown,
  fallbackBaseUrl = "https://api.openai.com/v1"
): string[] {
  if (!Array.isArray(providers)) {
    return [];
  }
  const endpoints = new Set<string>();
  for (const provider of providers) {
    if (!isRecord(provider) || stringValue(provider.type) !== "openai_responses") {
      continue;
    }
    const endpoint = canonicalResponsesEndpoint(stringValue(provider.baseurl) || fallbackBaseUrl);
    if (endpoint) {
      endpoints.add(endpoint);
    }
  }
  return [...endpoints];
}

function canonicalResponsesEndpoint(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${trimTrailingSlashes(url.pathname)}/responses`;
  } catch {
    return undefined;
  }
}

/** Canonical `origin + path` of a request URL, with query and hash removed. */
export function canonicalRequestEndpoint(value: unknown): string | undefined {
  const raw = typeof value === "string"
    ? value
    : value instanceof URL
      ? value.href
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : undefined;
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return `${url.origin}${trimTrailingSlashes(url.pathname)}`;
  } catch {
    return undefined;
  }
}

function trimTrailingSlashes(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}

/**
 * Wraps `globalThis.fetch` and the `fetch` export of the undici copy the
 * gateway entry resolves. The gateway pairs its own dispatcher with that
 * module's fetch, so patching the global alone would never see the stream.
 * Must run before the entry is required: the bundle captures
 * `require("undici").fetch` while it initializes.
 */
export function installResponsesStreamGuard(
  settings: ResponsesStreamGuardSettings,
  gatewayEntry: string,
  onWarning?: (message: string) => void,
  gatewayUndici?: UndiciModule
): ResponsesStreamGuardInstallResult {
  const result: ResponsesStreamGuardInstallResult = { dependencyFetch: false, globalFetch: false };
  const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (typeof globalThis.fetch === "function" && globalDescriptor?.writable) {
    const wrapped = wrapFetch(globalThis.fetch as FetchLike, settings, undefined);
    if (wrapped) {
      globalThis.fetch = wrapped as typeof globalThis.fetch;
      result.globalFetch = true;
    }
  }

  let undici: UndiciModule;
  try {
    undici = gatewayUndici ?? (createRequire(gatewayEntry)("undici") as UndiciModule);
  } catch (error) {
    onWarning?.(`Responses stream guard could not resolve the gateway undici module: ${errorText(error)}`);
    return result;
  }

  const descriptor = Object.getOwnPropertyDescriptor(undici, "fetch");
  if (typeof undici.fetch !== "function" || !descriptor?.writable) {
    onWarning?.("Responses stream guard could not wrap the gateway undici fetch export.");
    return result;
  }
  const wrapped = wrapFetch(undici.fetch, settings, undici.Response);
  if (wrapped) {
    undici.fetch = wrapped;
    result.dependencyFetch = true;
  }
  return result;
}

function wrapFetch(
  originalFetch: FetchLike,
  settings: ResponsesStreamGuardSettings,
  responseConstructor: typeof Response | undefined
): FetchLike | undefined {
  if ((originalFetch as unknown as Record<symbol, unknown>)[guardedFetchMarker]) {
    return undefined;
  }
  const endpoints = new Set(settings.endpoints);
  const guarded: FetchLike = async (input, init) => {
    const response = await originalFetch(input, init);
    const endpoint = canonicalRequestEndpoint(input);
    if (!endpoint || !endpoints.has(endpoint)) {
      return response;
    }
    return guardResponsesStreamResponse(response, settings.idleTimeoutMs, responseConstructor);
  };
  Object.defineProperty(guarded, guardedFetchMarker, { value: true });
  return guarded;
}

/** Non-streaming, failed and already guarded responses are returned unchanged. */
export function guardResponsesStreamResponse(
  response: Response,
  idleTimeoutMs: number,
  responseConstructor: typeof Response = Response
): Response {
  if (!isGuardableResponsesStream(response)) {
    return response;
  }
  const body = response.body;
  if (!body) {
    return response;
  }
  const headers = new Headers(response.headers);
  // The body arrives decoded and re-framed, so the upstream transfer metadata
  // would describe bytes that no longer exist.
  headers.delete("content-encoding");
  headers.delete("content-length");
  const guarded = new responseConstructor(guardedResponsesStream(body, idleTimeoutMs), {
    headers,
    status: response.status,
    statusText: response.statusText
  });
  Object.defineProperty(guarded, guardedResponseMarker, { value: true });
  if (response.url) {
    Object.defineProperty(guarded, "url", { configurable: true, value: response.url });
  }
  return guarded;
}

function isGuardableResponsesStream(response: Response): boolean {
  if ((response as unknown as Record<symbol, unknown>)[guardedResponseMarker]) {
    return false;
  }
  if (!response.ok) {
    return false;
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

type PreparedFrame = {
  bytes: Buffer;
  outcome: FrameOutcome;
};

export function guardedResponsesStream(
  source: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  maxFrameBytes: number = responsesStreamGuardMaxFrameBytes
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const ready: PreparedFrame[] = [];
  let pending = Buffer.alloc(0);
  let scanIndex = 0;
  let terminatorRun = 0;
  let sourceDone = false;
  let released = false;
  let stopped = false;
  let failure: Error | undefined;
  let idleElapsedMs = 0;

  const releaseUpstream = (reason?: unknown): void => {
    if (released) {
      return;
    }
    released = true;
    // Never await the cancel: a stalled upstream can leave it pending forever.
    void Promise.resolve(reader.cancel(reason)).catch(() => undefined);
  };

  const readNext = async (): Promise<Uint8Array | undefined> => {
    const read = reader.read();
    read.catch(() => undefined);
    if (idleTimeoutMs <= 0) {
      const result = await read;
      return result.done ? undefined : result.value;
    }
    // The watchdog is armed only while a read is outstanding, so a slow
    // consumer holding the stream back never reads as a stalled model.
    const armedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(idleTimeoutError(idleTimeoutMs)),
        Math.max(1, idleTimeoutMs - idleElapsedMs)
      );
    });
    watchdog.catch(() => undefined);
    try {
      const result = await Promise.race([read, watchdog]);
      idleElapsedMs += Date.now() - armedAt;
      return result.done ? undefined : result.value;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const nextFrame = (): Buffer | undefined => {
    let index = scanIndex;
    while (index < pending.length) {
      const byte = pending[index];
      let width: number;
      if (byte === carriageReturn) {
        if (index + 1 >= pending.length && !sourceDone) {
          scanIndex = index;
          return undefined;
        }
        width = pending[index + 1] === lineFeed ? 2 : 1;
      } else if (byte === lineFeed) {
        width = 1;
      } else {
        terminatorRun = 0;
        index += 1;
        continue;
      }
      terminatorRun += 1;
      index += width;
      if (terminatorRun >= 2) {
        const frame = Buffer.from(pending.subarray(0, index));
        pending = Buffer.from(pending.subarray(index));
        scanIndex = 0;
        terminatorRun = 0;
        return frame;
      }
    }
    scanIndex = index;
    return undefined;
  };

  const extractFrames = (): void => {
    while (!stopped) {
      const bytes = nextFrame();
      if (!bytes) {
        return;
      }
      if (bytes.length > maxFrameBytes) {
        throw frameLimitError(maxFrameBytes);
      }
      const outcome = classifyResponsesFrame(bytes);
      ready.push({ bytes, outcome });
      if (outcome.terminal || outcome.failure) {
        releaseUpstream(outcome.failure);
        // Everything the upstream sent after its terminal event is dropped, so
        // a late frame in the same chunk cannot rewrite a finished result.
        stopped = true;
        pending = Buffer.alloc(0);
        scanIndex = 0;
        terminatorRun = 0;
      }
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (failure) {
        controller.error(failure);
        return;
      }
      try {
        for (;;) {
          const frame = ready.shift();
          if (frame) {
            if (frame.outcome.progress) {
              idleElapsedMs = 0;
            }
            controller.enqueue(frame.bytes);
            if (frame.outcome.failure) {
              // close() would keep the queued bytes, error() would discard
              // them, so the error waits for the next pull.
              failure = frame.outcome.failure;
              releaseUpstream(failure);
            } else if (frame.outcome.terminal) {
              releaseUpstream();
              controller.close();
            }
            return;
          }
          if (stopped) {
            releaseUpstream();
            controller.close();
            return;
          }
          if (sourceDone) {
            if (pending.length > 0) {
              const tail = pending;
              pending = Buffer.alloc(0);
              scanIndex = 0;
              controller.enqueue(tail);
              return;
            }
            releaseUpstream();
            controller.close();
            return;
          }
          const chunk = await readNext();
          if (chunk === undefined) {
            sourceDone = true;
            extractFrames();
            continue;
          }
          pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
          extractFrames();
          if (!stopped && pending.length > maxFrameBytes) {
            throw frameLimitError(maxFrameBytes);
          }
        }
      } catch (error) {
        const raised = error instanceof Error ? error : new Error(String(error));
        releaseUpstream(raised);
        controller.error(raised);
      }
    },
    cancel(reason) {
      releaseUpstream(reason);
    }
  });
}

export function classifyResponsesFrame(frame: Buffer): FrameOutcome {
  const fields = readSseFrameFields(frame);
  const data = fields.data.trim();
  if (!data) {
    return { progress: false };
  }
  if (data === "[DONE]") {
    return { progress: false, terminal: true };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return { progress: false };
  }
  if (!isRecord(payload)) {
    return { progress: false };
  }
  const eventType = stringValue(payload.type) ?? fields.name ?? "";
  if (failureEventTypes.has(eventType)) {
    return { failure: upstreamFailureError(eventType, payload), progress: false };
  }
  if (terminalEventTypes.has(eventType)) {
    return { progress: true, terminal: true };
  }
  return { progress: isResponsesProgressEvent(eventType, payload) };
}

// Powtarzane stany narzędzi i elementów wyjścia nie dowodzą postępu modelu.
function isResponsesProgressEvent(eventType: string, payload: Record<string, unknown>): boolean {
  return progressEventTypes.has(eventType) && hasMeaningfulDelta(payload);
}

function readSseFrameFields(frame: Buffer): SseFrameFields {
  const lines = frame.toString("utf8").split(/\r\n|\n|\r/);
  const data: string[] = [];
  let name: string | undefined;
  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
      continue;
    }
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    }
  }
  return { data: data.join("\n"), name };
}

function hasMeaningfulDelta(payload: Record<string, unknown>): boolean {
  const delta = payload.delta;
  if (typeof delta === "string") {
    return delta.length > 0;
  }
  if (typeof payload.arguments === "string" && payload.arguments.length > 0) {
    return true;
  }
  if (isRecord(delta)) {
    return Object.values(delta).some((value) =>
      typeof value === "string" ? value.length > 0 : value !== undefined && value !== null
    );
  }
  return delta !== undefined && delta !== null;
}

function upstreamFailureError(eventType: string, payload: Record<string, unknown>): Error {
  const detail = upstreamFailureDetail(payload);
  const error = new Error(
    `Upstream Responses stream reported ${eventType}${detail ? `: ${detail}` : "."}`
  );
  error.name = "ResponsesStreamUpstreamError";
  Object.assign(error, { code: responsesStreamGuardUpstreamErrorCode });
  return error;
}

function upstreamFailureDetail(payload: Record<string, unknown>): string | undefined {
  const response = isRecord(payload.response) ? payload.response : undefined;
  const candidates = [
    isRecord(response?.error) ? response.error.message : undefined,
    isRecord(payload.error) ? payload.error.message : undefined,
    payload.message,
    isRecord(response?.error) ? response.error.code : undefined,
    payload.code
  ];
  for (const candidate of candidates) {
    const text = stringValue(candidate);
    if (text) {
      return text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, upstreamFailureDetailLimit);
    }
  }
  return undefined;
}

function idleTimeoutError(idleTimeoutMs: number): Error {
  const error = new Error(
    `Responses stream made no progress for ${idleTimeoutMs} ms and was closed by the router.`
  );
  error.name = "ResponsesStreamIdleTimeoutError";
  Object.assign(error, { code: responsesStreamGuardIdleTimeoutCode });
  return error;
}

function frameLimitError(maxFrameBytes: number): Error {
  const error = new Error(
    `Responses stream event exceeded ${maxFrameBytes} bytes without a frame boundary.`
  );
  error.name = "ResponsesStreamFrameLimitError";
  Object.assign(error, { code: responsesStreamGuardFrameLimitCode });
  return error;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
