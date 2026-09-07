import esbuild from "esbuild";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

export const projectRoot = path.resolve(__dirname, "..");
export const packagesRoot = path.join(projectRoot, "packages");
export const cliRoot = path.join(packagesRoot, "cli");
export const coreRoot = path.join(packagesRoot, "core");
export const uiRoot = path.join(packagesRoot, "ui");
export const cliSourceRoot = path.join(cliRoot, "src");
export const coreSourceRoot = path.join(coreRoot, "src");
export const uiSourceRoot = path.join(uiRoot, "src");
export const legacyDistDir = path.join(projectRoot, "dist");
export const cliDistDir = path.join(cliRoot, "dist");
export const coreDistDir = path.join(coreRoot, "dist");
export const uiDistDir = path.join(uiRoot, "dist");
export const cliMainOutDir = path.join(cliDistDir, "main");
export const coreMainOutDir = path.join(coreDistDir, "main");
export const rendererOutDir = path.join(uiDistDir, "renderer");
export const cliRendererOutDir = path.join(cliDistDir, "renderer");
export const coreRendererOutDir = path.join(coreDistDir, "renderer");
export const runtimeRendererOutDirs = [cliRendererOutDir, coreRendererOutDir];
export const rendererAssetsDir = path.join(rendererOutDir, "assets");
export const gatewayPackageRoot = path.dirname(requireFromHere.resolve("@the-next-ai/ai-gateway/package.json"));
export const gatewayRuntimeInput = path.join(gatewayPackageRoot, "bin", "next-ai-gateway.js");
export const modelCatalogInput = path.join(coreRoot, "models.json");
export const cliModelCatalogOutput = path.join(cliDistDir, "models.json");
export const coreModelCatalogOutput = path.join(coreDistDir, "models.json");
export const rendererRoot = uiSourceRoot;
export const rendererHtmlInput = path.join(rendererRoot, "pages", "home", "index.html");
export const rendererHtmlOutput = path.join(rendererOutDir, "pages", "home", "index.html");
export const cssInput = path.join(rendererRoot, "styles", "globals.css");
export const cssOutput = path.join(rendererAssetsDir, "main.css");
export const webClientBridgeOutput = path.join(rendererAssetsDir, "web-client-bridge.js");
export const requestLogBodyWorkerOutput = path.join(rendererAssetsDir, "log-body.worker.js");
export const requestLogBodyWorkerInput = path.join(rendererRoot, "pages", "home", "shared", "log-body.worker.ts");
export const undiciProxyAgentInput = path.join(coreSourceRoot, "proxy", "undici-proxy-agent.ts");
export const localAgentAuthProviderHookInput = path.join(coreSourceRoot, "gateway", "core-runtime", "local-agent-auth-provider-hook.ts");
export const upstreamHeaderSanitizerInput = path.join(coreSourceRoot, "gateway", "core-runtime", "upstream-header-sanitizer.ts");
const lightweightMcpBundleNames = ["fusion-vision-mcp.js", "fusion-tool-fallback-mcp.js", "media-tools-proxy-mcp.js"];
const lightweightMcpBundleMaxBytes = 128 * 1024;
const forbiddenLightweightMcpInputs = [
  { prefix: "packages/core/src/config/", reason: "config modules can pull in native storage side effects" },
  { prefix: "packages/core/src/storage/", reason: "native SQLite storage is not allowed in lightweight MCP subprocesses" },
  { prefix: "packages/ui/src/", reason: "UI modules do not belong in stdio MCP subprocesses" },
  { prefix: "node_modules/libsql/", reason: "native SQLite is not allowed in lightweight MCP subprocesses" }
];
const forbiddenLightweightMcpExternalImports = new Set(["libsql"]);

const nodeExternals = [
  "libsql",
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
];

export function cleanDist() {
  rmSync(legacyDistDir, { force: true, recursive: true });
  rmSync(cliDistDir, { force: true, recursive: true });
  rmSync(coreDistDir, { force: true, recursive: true });
  rmSync(uiDistDir, { force: true, recursive: true });
  ensureDist();
}

export function ensureDist() {
  mkdirSync(cliMainOutDir, { recursive: true });
  mkdirSync(coreMainOutDir, { recursive: true });
  mkdirSync(rendererAssetsDir, { recursive: true });
  for (const outputDir of runtimeRendererOutDirs) {
    mkdirSync(path.join(outputDir, "assets"), { recursive: true });
  }
  mkdirSync(path.dirname(rendererHtmlOutput), { recursive: true });
}

export function copyModelCatalog() {
  ensureDist();
  if (existsSync(modelCatalogInput)) {
    cpSync(modelCatalogInput, cliModelCatalogOutput);
    cpSync(modelCatalogInput, coreModelCatalogOutput);
  }
}

export function copyRendererHtml() {
  copyRendererPageHtml(rendererHtmlInput, rendererHtmlOutput, "main.js", {
    beforeModuleScriptTags: ['    <script src="../../assets/web-client-bridge.js"></script>']
  });
}

export function syncUiRendererToRuntimeDists() {
  ensureDist();
  for (const outputDir of runtimeRendererOutDirs) {
    rmSync(outputDir, { force: true, recursive: true });
    if (existsSync(rendererOutDir)) {
      cpSync(rendererOutDir, outputDir, { recursive: true });
    }
  }
}

function copyRendererPageHtml(input, output, scriptName, options = {}) {
  ensureDist();
  const source = readFileSync(input, "utf8");
  const styleTag = '    <link rel="stylesheet" href="../../assets/main.css" />';
  const scriptTag = `    <script type="module" src="../../assets/${scriptName}"></script>`;
  let html = source.includes('<script type="module" src="./main.tsx"></script>')
    ? source.replace('    <script type="module" src="./main.tsx"></script>', scriptTag)
    : source.replace("</body>", `${scriptTag}\n  </body>`);

  for (const extraScriptTag of options.beforeModuleScriptTags ?? []) {
    if (!hasScriptTag(html, extraScriptTag)) {
      html = html.replace(scriptTag, `${extraScriptTag}\n${scriptTag}`);
    }
  }

  if (!html.includes('href="../../assets/main.css"')) {
    html = html.replace("</head>", `${styleTag}\n  </head>`);
  }

  writeFileSync(output, html, "utf8");
}

function hasScriptTag(html, scriptTag) {
  const sourceMatch = scriptTag.match(/\bsrc="([^"]+)"/);
  return sourceMatch ? html.includes(sourceMatch[1]) : html.includes(scriptTag);
}

function sharedRuntimeEntryPoints() {
  return [
    gatewayRuntimeInput,
    path.join(coreSourceRoot, "gateway", "core-runtime", "gateway-bootstrap.ts"),
    path.join(coreSourceRoot, "mcp", "fusion-vision-mcp.ts"),
    path.join(coreSourceRoot, "mcp", "fusion-tool-fallback-mcp.ts"),
    path.join(coreSourceRoot, "mcp", "media-tools-proxy-mcp.ts"),
    path.join(coreSourceRoot, "mcp", "toolhub-mcp.ts"),
    path.join(coreSourceRoot, "observability", "request-log-worker.ts"),
    path.join(coreSourceRoot, "routing", "route-script-worker.ts"),
    localAgentAuthProviderHookInput,
    upstreamHeaderSanitizerInput,
    undiciProxyAgentInput
  ];
}

export function createCliBuildOptions({ mode = "production", plugins = [] } = {}) {
  return {
    absWorkingDir: projectRoot,
    bundle: true,
    entryNames: "[name]",
    entryPoints: [
      path.join(cliSourceRoot, "cli.ts"),
      ...sharedRuntimeEntryPoints()
    ],
    external: nodeExternals,
    format: "cjs",
    legalComments: "none",
    logLevel: "info",
    metafile: true,
    minify: mode === "production",
    outdir: cliMainOutDir,
    platform: "node",
    plugins: [forbidCliElectronPlugin(), packageAliasPlugin(), ...plugins],
    sourcemap: mode !== "production",
    target: "node22"
  };
}

export function createCoreServerBuildOptions({ mode = "production", plugins = [] } = {}) {
  return {
    absWorkingDir: projectRoot,
    bundle: true,
    entryNames: "[name]",
    entryPoints: [
      path.join(coreSourceRoot, "entrypoints", "server.ts"),
      ...sharedRuntimeEntryPoints()
    ],
    external: nodeExternals,
    format: "cjs",
    legalComments: "none",
    logLevel: "info",
    metafile: true,
    minify: mode === "production",
    outdir: coreMainOutDir,
    platform: "node",
    plugins: [forbidCliElectronPlugin(), packageAliasPlugin(), ...plugins],
    sourcemap: mode !== "production",
    target: "node22"
  };
}

export function createRendererBuildOptions({ mode = "production", plugins = [] } = {}) {
  return {
    absWorkingDir: projectRoot,
    assetNames: "assets/[name]-[hash]",
    bundle: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode)
    },
    entryPoints: [path.join(rendererRoot, "pages", "home", "main.tsx")],
    format: "esm",
    jsx: "automatic",
    legalComments: "none",
    loader: {
      ".gif": "file",
      ".ico": "file",
      ".jpg": "file",
      ".jpeg": "file",
      ".png": "file",
      ".svg": "file",
      ".webp": "file"
    },
    logLevel: "info",
    minify: mode === "production",
    outfile: path.join(rendererAssetsDir, "main.js"),
    platform: "browser",
    plugins: [rendererAliasPlugin(), packageAliasPlugin(), ...plugins],
    publicPath: "../../assets",
    sourcemap: mode !== "production",
    target: "chrome120"
  };
}

export function createWebClientBridgeBuildOptions({ mode = "production", plugins = [] } = {}) {
  return {
    absWorkingDir: projectRoot,
    bundle: true,
    entryPoints: [path.join(uiSourceRoot, "web-client-bridge.ts")],
    format: "iife",
    legalComments: "none",
    logLevel: "info",
    minify: mode === "production",
    outfile: webClientBridgeOutput,
    platform: "browser",
    plugins: [packageAliasPlugin(), ...plugins],
    sourcemap: mode !== "production",
    target: "chrome120"
  };
}

export function createRequestLogBodyWorkerBuildOptions({ mode = "production", plugins = [] } = {}) {
  return {
    absWorkingDir: projectRoot,
    bundle: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode)
    },
    entryPoints: [requestLogBodyWorkerInput],
    format: "esm",
    legalComments: "none",
    logLevel: "info",
    minify: mode === "production",
    outfile: requestLogBodyWorkerOutput,
    platform: "browser",
    plugins: [rendererAliasPlugin(), packageAliasPlugin(), ...plugins],
    sourcemap: mode !== "production",
    target: "chrome120"
  };
}

export function watchPlugin(name, onEnd) {
  return {
    name: `${name}-watch`,
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          onEnd(name);
        }
      });
    }
  };
}

export async function buildCli(options = {}) {
  const result = await esbuild.build(createCliBuildOptions(options));
  validateLightweightMcpBundles(result.metafile);
}

export async function buildCoreServer(options = {}) {
  const result = await esbuild.build(createCoreServerBuildOptions(options));
  validateLightweightMcpBundles(result.metafile);
}

export async function buildRenderer(options = {}) {
  await esbuild.build(createRendererBuildOptions(options));
}

export async function buildWebClientBridge(options = {}) {
  await esbuild.build(createWebClientBridgeBuildOptions(options));
}

export async function buildRequestLogBodyWorker(options = {}) {
  await esbuild.build(createRequestLogBodyWorkerBuildOptions(options));
}

export async function buildStyles({ minify = false } = {}) {
  ensureDist();
  const args = ["-i", cssInput, "-o", cssOutput];
  if (minify) {
    args.push("--minify");
  }
  await runCommand(binPath("tailwindcss"), args);
}

export function binPath(name) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  return path.join(projectRoot, "node_modules", ".bin", `${name}${extension}`);
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

function rendererAliasPlugin() {
  return {
    name: "renderer-alias",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => {
        return { path: resolveRendererImport(args.path.slice(2)) };
      });
    }
  };
}

function packageAliasPlugin() {
  return {
    name: "ccr-package-alias",
    setup(build) {
      build.onResolve({ filter: /^@ccr\/cli\// }, (args) => {
        return { path: resolvePackageImport(cliSourceRoot, args.path.slice("@ccr/cli/".length)) };
      });
      build.onResolve({ filter: /^@ccr\/core\// }, (args) => {
        return { path: resolvePackageImport(coreSourceRoot, args.path.slice("@ccr/core/".length)) };
      });
      build.onResolve({ filter: /^@ccr\/ui\// }, (args) => {
        return { path: resolvePackageImport(uiSourceRoot, args.path.slice("@ccr/ui/".length)) };
      });
    }
  };
}

function forbidCliElectronPlugin() {
  return {
    name: "forbid-cli-electron",
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => {
        return {
          errors: [
            {
              text: "CLI bundle must not import electron. Move the dependency behind a desktop-only boundary."
            }
          ]
        };
      });
    }
  };
}

function validateLightweightMcpBundles(metafile) {
  if (!metafile) {
    return;
  }

  const outputsByName = new Map(
    Object.entries(metafile.outputs).map(([outputPath, output]) => [path.basename(outputPath), { output, outputPath }])
  );

  for (const bundleName of lightweightMcpBundleNames) {
    const entry = outputsByName.get(bundleName);
    if (!entry) {
      continue;
    }

    const violations = [];
    if (entry.output.bytes > lightweightMcpBundleMaxBytes) {
      violations.push(`bundle size ${entry.output.bytes} bytes exceeds ${lightweightMcpBundleMaxBytes} bytes`);
    }

    for (const inputPath of Object.keys(entry.output.inputs ?? {})) {
      const normalizedInput = normalizeBuildPath(inputPath);
      for (const rule of forbiddenLightweightMcpInputs) {
        if (normalizedInput.startsWith(rule.prefix)) {
          violations.push(`${normalizedInput} (${rule.reason})`);
        }
      }
    }

    for (const imported of entry.output.imports ?? []) {
      if (imported.external && forbiddenLightweightMcpExternalImports.has(imported.path)) {
        violations.push(`${imported.path} (external native/runtime dependency is not allowed)`);
      }
    }

    if (violations.length > 0) {
      throw new Error([
        `Lightweight MCP bundle ${bundleName} crossed its dependency boundary.`,
        ...violations.map((violation) => `- ${violation}`)
      ].join("\n"));
    }
  }
}

function normalizeBuildPath(value) {
  return value.split(path.sep).join("/");
}

function resolveRendererImport(importPath) {
  return resolvePackageImport(rendererRoot, importPath);
}

function resolvePackageImport(rootDir, importPath) {
  const packageBasePath = path.resolve(rootDir, importPath);
  const candidates = [
    packageBasePath,
    `${packageBasePath}.tsx`,
    `${packageBasePath}.ts`,
    `${packageBasePath}.jsx`,
    `${packageBasePath}.js`,
    `${packageBasePath}.json`,
    `${packageBasePath}.css`,
    path.join(packageBasePath, "index.tsx"),
    path.join(packageBasePath, "index.ts"),
    path.join(packageBasePath, "index.jsx"),
    path.join(packageBasePath, "index.js")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return packageBasePath;
}
