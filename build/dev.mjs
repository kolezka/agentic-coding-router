import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildStyles,
  cleanDist,
  coreSourceRoot,
  copyModelCatalog,
  copyRendererHtml,
  createRequestLogBodyWorkerBuildOptions,
  createCliBuildOptions,
  createRendererBuildOptions,
  createWebClientBridgeBuildOptions,
  modelCatalogInput,
  projectRoot,
  rendererRoot,
  rendererHtmlInput,
  syncUiRendererToRuntimeDists,
  watchPlugin
} from "./esbuild.config.mjs";

const watchSignatures = new Map();
const styleBuildDelayMs = 160;
const stylePollIntervalMs = 1000;
const ignoredSignatureEntries = new Set([".DS_Store"]);
let styleBuildTimer = null;
let styleBuildInFlight = false;
let queuedStyleBuildReason = null;
const ready = {
  cli: false,
  logWorker: false,
  renderer: false,
  webBridge: false
};
const devTarget = parseDevTarget(process.argv.slice(2));
const enabled = {
  cli: devTarget === "cli",
  ui: true
};
const coreSharedSourceRoot = path.join(coreSourceRoot, "shared");
const styleWatchRoots = [rendererRoot, coreSharedSourceRoot].filter((watchRoot) => existsSync(watchRoot));
const activeReadyNames = new Set([
  ...(enabled.ui ? ["renderer", "webBridge", "logWorker"] : []),
  ...(enabled.cli ? ["cli"] : [])
]);

function parseDevTarget(args) {
  const target = args[0] ?? "cli";
  if (target === "--help" || target === "-h") {
    console.log("Usage: node build/dev.mjs [ui|cli]");
    process.exit(0);
  }
  if (target === "ui" || target === "cli") {
    return target;
  }
  console.error(`Unknown dev target "${target}". Expected ui or cli.`);
  process.exit(2);
}

function logDev(message) {
  console.log(`[dev] ${new Date().toISOString()} ${message}`);
}

function relativePath(file) {
  return path.relative(projectRoot, file) || ".";
}

function readyState() {
  return Object.entries(ready)
    .filter(([name]) => activeReadyNames.has(name))
    .map(([name, value]) => `${name}:${value ? "ready" : "pending"}`)
    .join(" ");
}

function contentSignature(targetPath) {
  try {
    return readContentSignature(targetPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      key: `error:${message}`,
      summary: `signature-error=${message}`
    };
  }
}

function readContentSignature(targetPath) {
  if (!existsSync(targetPath)) {
    return {
      key: "missing",
      summary: "missing"
    };
  }

  const stats = statSync(targetPath);
  if (stats.isDirectory()) {
    return directorySignature(targetPath);
  }

  const content = readFileSync(targetPath);
  const hash = createHash("sha1").update(content).digest("hex").slice(0, 12);
  return {
    key: `file:${hash}`,
    summary: `size=${stats.size} mtime=${stats.mtime.toISOString()} ctime=${stats.ctime.toISOString()} sha1=${hash}`
  };
}

function directorySignature(targetPath) {
  const files = listDirectoryFiles(targetPath);
  const hash = createHash("sha1");
  let newestMtimeMs = 0;

  for (const file of files) {
    const absolutePath = path.join(targetPath, file);
    const stats = statSync(absolutePath);
    newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs);
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(absolutePath));
    hash.update("\0");
  }

  const digest = hash.digest("hex").slice(0, 12);
  const newestMtime = newestMtimeMs > 0 ? new Date(newestMtimeMs).toISOString() : "none";
  return {
    key: `dir:${digest}`,
    summary: `files=${files.length} newestMtime=${newestMtime} sha1=${digest}`
  };
}

function listDirectoryFiles(targetPath, basePath = targetPath) {
  const entries = readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => !ignoredSignatureEntries.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(targetPath, entry.name);
    const relative = path.relative(basePath, absolutePath);
    if (entry.isDirectory()) {
      files.push(...listDirectoryFiles(absolutePath, basePath));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }

  return files;
}

function rememberWatchSignature(label, targetPath, options = {}) {
  const signature = options.metadataOnly
    ? metadataSignature(targetPath)
    : contentSignature(targetPath);
  watchSignatures.set(label, signature.key);
  logDev(`watch baseline: ${label} ${relativePath(targetPath)}; ${signature.summary}`);
}

function scheduleStyleBuild(reason) {
  queuedStyleBuildReason = reason;
  if (styleBuildTimer) {
    clearTimeout(styleBuildTimer);
  }
  styleBuildTimer = setTimeout(() => {
    styleBuildTimer = null;
    void rebuildStyles(queuedStyleBuildReason ?? reason);
  }, styleBuildDelayMs);
}

async function rebuildStyles(reason) {
  if (styleBuildInFlight) {
    queuedStyleBuildReason = reason;
    return;
  }

  styleBuildInFlight = true;
  queuedStyleBuildReason = null;
  try {
    logDev(`rebuilding styles: ${reason}`);
    await buildStyles({ minify: false });
    syncUiRendererToRuntimeDists();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDev(`style rebuild failed: ${message}`);
  } finally {
    styleBuildInFlight = false;
    if (queuedStyleBuildReason) {
      const queuedReason = queuedStyleBuildReason;
      queuedStyleBuildReason = null;
      scheduleStyleBuild(queuedReason);
    }
  }
}

function pollStyleWatchRoots() {
  for (const styleWatchRoot of styleWatchRoots) {
    const label = `styles ${relativePath(styleWatchRoot)}`;
    const signature = contentSignature(styleWatchRoot);
    const previousSignature = watchSignatures.get(label);
    if (previousSignature === signature.key) {
      continue;
    }

    watchSignatures.set(label, signature.key);
    logDev(`watch event: ${label}; ${signature.summary}; content=changed`);
    scheduleStyleBuild(label);
  }
}

function pollWatchedInput(label, targetPath, onChange, options = {}) {
  const signature = options.metadataOnly
    ? metadataSignature(targetPath)
    : contentSignature(targetPath);
  const previousSignature = watchSignatures.get(label);
  if (previousSignature === signature.key) {
    return;
  }

  watchSignatures.set(label, signature.key);
  logDev(`watch event: ${label} ${relativePath(targetPath)}; ${signature.summary}; content=changed`);
  try {
    onChange();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDev(`watch action failed: ${label}; ${message}`);
  }
}

function metadataSignature(targetPath) {
  if (!existsSync(targetPath)) {
    return {
      key: "missing",
      summary: "missing"
    };
  }

  const stats = statSync(targetPath);
  return {
    key: `metadata:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`,
    summary: `size=${stats.size} mtime=${stats.mtime.toISOString()} ctime=${stats.ctime.toISOString()}`
  };
}

function pollSourceWatchTargets() {
  pollWatchedInput("home html", rendererHtmlInput, () => {
    copyRendererHtml();
    syncUiRendererToRuntimeDists();
  });
  if (enabled.cli && existsSync(modelCatalogInput)) {
    pollWatchedInput("model catalog", modelCatalogInput, copyModelCatalog, { metadataOnly: true });
  }
}

function markReady(name, reason = `${name} esbuild completed`) {
  if (name === "cli" || name === "logWorker" || name === "renderer" || name === "webBridge") {
    ready[name] = true;
  }
  logDev(`build ready: ${reason}; ${readyState()}`);
}

logDev(`starting dev build target=${devTarget} ui=${enabled.ui ? "on" : "off"} cli=${enabled.cli ? "on" : "off"}`);
cleanDist();
if (enabled.cli) {
  copyModelCatalog();
}
copyRendererHtml();
await buildStyles({ minify: false });
syncUiRendererToRuntimeDists();

rememberWatchSignature("home html", rendererHtmlInput);
for (const styleWatchRoot of styleWatchRoots) {
  rememberWatchSignature(`styles ${relativePath(styleWatchRoot)}`, styleWatchRoot);
}
if (enabled.cli && existsSync(modelCatalogInput)) {
  rememberWatchSignature("model catalog", modelCatalogInput, { metadataOnly: true });
}

const sourcePoller = setInterval(() => {
  pollStyleWatchRoots();
  pollSourceWatchTargets();
}, stylePollIntervalMs);

const contexts = [];

if (enabled.cli) {
  contexts.push(
    await esbuild.context(
      createCliBuildOptions({
        mode: "development",
        plugins: [watchPlugin("cli", (name) => markReady(name))]
      })
    )
  );
}

if (enabled.ui) {
  contexts.push(
    await esbuild.context(
      createRendererBuildOptions({
        mode: "development",
        plugins: [
          watchPlugin("renderer", (name) => {
            copyRendererHtml();
            syncUiRendererToRuntimeDists();
            markReady(name);
          })
        ]
      })
    ),
    await esbuild.context(
      createWebClientBridgeBuildOptions({
        mode: "development",
        plugins: [
          watchPlugin("webBridge", (name) => {
            syncUiRendererToRuntimeDists();
            markReady(name);
          })
        ]
      })
    ),
    await esbuild.context(
      createRequestLogBodyWorkerBuildOptions({
        mode: "development",
        plugins: [
          watchPlugin("logWorker", (name) => {
            syncUiRendererToRuntimeDists();
            markReady(name);
          })
        ]
      })
    )
  );
}

await Promise.all(contexts.map((context) => context.watch()));
logDev("watchers are active");

async function shutdown() {
  logDev("shutting down dev build");
  if (styleBuildTimer) {
    clearTimeout(styleBuildTimer);
  }
  clearInterval(sourcePoller);
  await Promise.all(contexts.map((context) => context.dispose()));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
