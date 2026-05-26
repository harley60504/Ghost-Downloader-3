import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const upstreamDir = path.resolve(appRoot, "../upstream");
const catchScriptDir = path.resolve(upstreamDir, "catch-script");
const upstreamContentScript = path.resolve(upstreamDir, "js/content-script.js");

// Firefox Add-ons 上架時建議換成你正式使用的固定 id。
// Android 測試版可以先用你原本的 id。
const firefoxAddonId = "ghostdownloader-browser-android@ccu-lab.example";

const manifestTemplate = JSON.parse(
  await readFile(path.resolve(appRoot, "public/manifest.json"), "utf8"),
);

const buildTargets = {
  chromium: {
    outDir: path.resolve(appRoot, "../chromium"),
    runtimeTarget: "chrome114",
  },
  firefox: {
    outDir: path.resolve(appRoot, "../firefox"),
    runtimeTarget: "firefox113",
  },
};

function uniqueArray(values) {
  return [...new Set(values.filter(Boolean))];
}

function createManifest(target) {
  const manifest = structuredClone(manifestTemplate);

  manifest.permissions = uniqueArray(manifest.permissions ?? []);
  manifest.host_permissions = uniqueArray(manifest.host_permissions ?? ["<all_urls>"]);

  delete manifest.background;
  delete manifest.minimum_chrome_version;
  delete manifest.browser_specific_settings;

  if (target === "firefox") {
    manifest.permissions = uniqueArray([
      ...manifest.permissions,
      "webRequestBlocking",
    ]);

    manifest.background = {
      scripts: ["background.js"],
      type: "module",
    };

    manifest.browser_specific_settings = {
      gecko: {
        id: firefoxAddonId,
        strict_min_version: "113.0",
        data_collection_permissions: {
          required: ["browsingActivity", "websiteContent"],
        },
      },
    };

    return manifest;
  }

  manifest.permissions = manifest.permissions.filter(
    (permission) => permission !== "webRequestBlocking",
  );

  manifest.background = {
    service_worker: "background.js",
    type: "module",
  };

  manifest.minimum_chrome_version = "114";

  return manifest;
}

try {
  await access(catchScriptDir);
  await access(upstreamContentScript);
} catch {
  throw new Error(
    "Missing browser_extension/upstream files. Run `git submodule update --init --recursive browser_extension/upstream` first.",
  );
}

for (const [target, config] of Object.entries(buildTargets)) {
  process.env.GD4B_BROWSER_TARGET = target;

  await viteBuild({
    configFile: path.resolve(appRoot, "vite.config.ts"),
    mode: "production",
    build: {
      outDir: config.outDir,
      emptyOutDir: true,
      target: config.runtimeTarget,
    },
  });

  await esbuild({
    entryPoints: [path.resolve(appRoot, "src/background.ts")],
    bundle: true,
    format: "esm",
    target: config.runtimeTarget,
    platform: "browser",
    outfile: path.resolve(config.outDir, "background.js"),
  });

  await esbuild({
    entryPoints: [path.resolve(appRoot, "src/content-script.ts")],
    bundle: true,
    format: "iife",
    target: config.runtimeTarget,
    platform: "browser",
    outfile: path.resolve(config.outDir, "content-script.js"),
  });

  await mkdir(config.outDir, { recursive: true });
  await cp(catchScriptDir, path.resolve(config.outDir, "catch-script"), { recursive: true });
  await cp(upstreamContentScript, path.resolve(config.outDir, "cat-catch-content-script.js"));

  await writeFile(
    path.resolve(config.outDir, "manifest.json"),
    `${JSON.stringify(createManifest(target), null, 2)}\n`,
  );
}

delete process.env.GD4B_BROWSER_TARGET;