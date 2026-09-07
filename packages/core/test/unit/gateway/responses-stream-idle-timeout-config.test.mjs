import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const testRoot = path.join(
  process.env.CCR_INTERNAL_HOME_DIR,
  `responses-stream-idle-timeout-${process.pid}`
);
process.env.CCR_INTERNAL_HOME_DIR = path.join(testRoot, "home");
process.env.CCR_INTERNAL_APP_DATA_DIR = path.join(testRoot, "app-data");
process.env.CCR_INTERNAL_USER_DATA_DIR = path.join(testRoot, "user-data");

let modulesPromise;

/** Imported lazily so the isolated config directories are set first. */
function coreModules() {
  modulesPromise = modulesPromise ?? Promise.all([
    import("@ccr/core/config/config.ts"),
    import("@ccr/core/config/default-config.ts"),
    import("@ccr/core/gateway/core-runtime/config-compiler.ts"),
    import("@ccr/core/gateway/core-runtime/responses-stream-guard.ts")
  ]).then(([config, defaults, compiler, guard]) => ({
    compileCoreGatewayConfig: compiler.compileCoreGatewayConfig,
    createDefaultAppConfig: defaults.createDefaultAppConfig,
    guardConfigKey: guard.responsesStreamGuardConfigKey,
    loadAppConfig: config.loadAppConfig,
    saveAppConfig: config.saveAppConfig
  }));
  return modulesPromise;
}

test("the stream idle budget inherits API_TIMEOUT_MS and honours an explicit override", async () => {
  assert.equal(await compiledIdleTimeout({}), 600000);
  assert.equal(await compiledIdleTimeout({ API_TIMEOUT_MS: 90000 }), 90000);
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: 45000 }), 45000);
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: "45000" }), 45000);
  assert.equal(
    await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: 45000, API_TIMEOUT_MS: 600000 }),
    45000
  );
});

test("only a literal zero disables the watchdog", async () => {
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: 0 }), 0);
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: "0" }), 0);
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: 0.5 }), 1);
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: " " }), 600000);
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: "" }), 600000);
});

test("unusable idle budgets fall back to the request budget instead of disabling the watchdog", async () => {
  for (const value of [-1, "-1", "abc", Number.NaN, Number.POSITIVE_INFINITY, 25 * 60 * 60 * 1000, true]) {
    assert.equal(
      await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: value }),
      600000,
      `unexpected idle budget for ${String(value)}`
    );
  }
  assert.equal(await compiledIdleTimeout({ API_STREAM_IDLE_TIMEOUT_MS: "abc", API_TIMEOUT_MS: "abc" }), 0);
});

test("the compiled gateway config keeps API_TIMEOUT_MS untouched", async () => {
  const { guardConfigKey } = await coreModules();
  const compiled = await compile({ API_STREAM_IDLE_TIMEOUT_MS: 15000, API_TIMEOUT_MS: 300000 });

  assert.equal(compiled.upstreamTimeoutMs, 300000);
  assert.equal(compiled[guardConfigKey].idleTimeoutMs, 15000);
  assert.equal("API_STREAM_IDLE_TIMEOUT_MS" in compiled, false);
});

test("the idle budget survives a config save and load", async () => {
  const { loadAppConfig, saveAppConfig } = await coreModules();
  const current = await loadAppConfig();
  assert.equal(current.API_STREAM_IDLE_TIMEOUT_MS, undefined);

  const saved = await saveAppConfig({ ...current, API_STREAM_IDLE_TIMEOUT_MS: 45000 });
  assert.equal(saved.API_STREAM_IDLE_TIMEOUT_MS, 45000);
  assert.equal((await loadAppConfig()).API_STREAM_IDLE_TIMEOUT_MS, 45000);
  assert.equal((await loadAppConfig()).API_TIMEOUT_MS, 600000);

  const disabled = await saveAppConfig({ ...current, API_STREAM_IDLE_TIMEOUT_MS: 0 });
  assert.equal(disabled.API_STREAM_IDLE_TIMEOUT_MS, 0);

  const cleared = await saveAppConfig({ ...current, API_STREAM_IDLE_TIMEOUT_MS: undefined });
  assert.equal(cleared.API_STREAM_IDLE_TIMEOUT_MS, undefined);
});

async function compiledIdleTimeout(overrides) {
  const { guardConfigKey } = await coreModules();
  return (await compile(overrides))[guardConfigKey].idleTimeoutMs;
}

async function compile(overrides) {
  const { compileCoreGatewayConfig, createDefaultAppConfig } = await coreModules();
  const config = { ...createDefaultAppConfig(), ...overrides };
  return compileCoreGatewayConfig(config, "raw-trace-token", "billing-usage-token", "core-auth-token");
}
