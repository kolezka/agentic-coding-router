import { buildCli, buildCoreServer, buildRenderer, buildRequestLogBodyWorker, buildStyles, buildWebClientBridge, cleanDist, copyModelCatalog, copyRendererHtml, syncUiRendererToRuntimeDists } from "./esbuild.config.mjs";

const mode = process.argv.includes("--dev") ? "development" : "production";

cleanDist();
copyModelCatalog();
copyRendererHtml();

await Promise.all([
  buildCli({ mode }),
  buildCoreServer({ mode }),
  buildRenderer({ mode }),
  buildRequestLogBodyWorker({ mode }),
  buildWebClientBridge({ mode }),
  buildStyles({ minify: mode === "production" })
]);

syncUiRendererToRuntimeDists();

console.log(`Built monorepo package assets in ${mode} mode.`);
