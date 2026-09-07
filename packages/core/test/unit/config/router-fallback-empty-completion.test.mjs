import assert from "node:assert/strict";
import test from "node:test";
import { loadAppConfig, saveAppConfig } from "@ccr/core/config/config.ts";

test("the empty-completion retry knob survives a config save and load", async () => {
  const current = await loadAppConfig();

  const saved = await saveAppConfig({
    ...current,
    Router: {
      ...current.Router,
      fallback: { emptyCompletionRetryCount: 0, mode: "retry", models: [], retryCount: 1 }
    }
  });
  assert.equal(saved.Router.fallback.emptyCompletionRetryCount, 0);
  assert.equal((await loadAppConfig()).Router.fallback.emptyCompletionRetryCount, 0);

  const withoutKnob = await saveAppConfig({
    ...current,
    Router: {
      ...current.Router,
      fallback: { mode: "retry", models: [], retryCount: 1 }
    }
  });
  assert.equal(withoutKnob.Router.fallback.emptyCompletionRetryCount, 2);

  const clamped = await saveAppConfig({
    ...current,
    Router: {
      ...current.Router,
      fallback: { emptyCompletionRetryCount: 500, mode: "retry", models: [], retryCount: 1 }
    }
  });
  assert.equal(clamped.Router.fallback.emptyCompletionRetryCount, 10);

  await saveAppConfig(current);
});
