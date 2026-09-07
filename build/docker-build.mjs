import {
  buildCoreServer,
  buildRenderer,
  buildStyles,
  buildWebClientBridge,
  cleanDist,
  copyModelCatalog,
  copyRendererHtml,
  syncUiRendererToRuntimeDists
} from "./esbuild.config.mjs";

const mode = process.argv.includes("--dev") ? "development" : "production";

cleanDist();
copyModelCatalog();
copyRendererHtml();

await Promise.all([
  buildCoreServer({ mode }),
  buildRenderer({ mode }),
  buildWebClientBridge({ mode }),
  buildStyles({ minify: mode === "production" })
]);

syncUiRendererToRuntimeDists();

console.log(`Built Docker core server and UI assets in ${mode} mode.`);
