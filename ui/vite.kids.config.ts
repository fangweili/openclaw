/** Kids assets share the built Gateway identity; the admin artifact remains separate. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { resolveUiBuildEnvironment } from "../scripts/lib/ui-build-environment.mts";
import { controlUiLocaleModulesPlugin } from "./config/control-ui-locales.ts";
import { normalizeControlUiBuildInfo } from "./src/build-info-normalizers.ts";
import {
  controlUiBrowserOnlySharedModuleAliases,
  resolveControlUiBuildInfo,
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "./vite.config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayBuildInfoPath = path.join(here, "../dist/build-info.json");
const BUILD_GATEWAY_FIRST =
  "Kids UI requires matching Gateway build provenance in dist/build-info.json. Run pnpm build from this checkout first, then rebuild the kids UI without changing commits or build identity overrides.";

/**
 * Reuse the canonical UI build owner's matching runtime identity. Production
 * assets must share version, source commit, timestamp, and ID with the built
 * Gateway; a missing or stale runtime artifact is an error, never a dev bypass.
 */
export function resolveKidsBuildInfo(
  sources: NonNullable<Parameters<typeof resolveUiBuildEnvironment>[0]> = {},
) {
  const readBuildInfo =
    sources.readBuildInfo ??
    (() => {
      try {
        return JSON.parse(fs.readFileSync(gatewayBuildInfoPath, "utf8"));
      } catch {
        throw new Error(BUILD_GATEWAY_FIRST);
      }
    });
  const existing = normalizeControlUiBuildInfo(readBuildInfo());
  const env = resolveUiBuildEnvironment({ ...sources, readBuildInfo: () => existing });
  const buildInfo = resolveControlUiBuildInfo({ ...sources, env });
  if (
    existing.buildId === "dev" ||
    !existing.builtAt ||
    existing.buildId !== buildInfo.buildId ||
    existing.commit !== buildInfo.commit ||
    existing.version !== buildInfo.version ||
    existing.builtAt !== buildInfo.builtAt
  ) {
    throw new Error(BUILD_GATEWAY_FIRST);
  }
  return buildInfo;
}

export default defineConfig(({ command }) => ({
  root: path.join(here, "kids"),
  base: "/kids/",
  publicDir: path.join(here, "kids/public"),
  define: {
    "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(
      command === "build" ? resolveKidsBuildInfo() : resolveControlUiBuildInfo(),
    ),
  },
  resolve: {
    alias: [
      ...resolveExternalPackageAliasesForVite(),
      ...resolveSourcePackageAliasesForVite(),
      ...resolveTsconfigPathAliasesForVite(),
    ],
  },
  plugins: [controlUiLocaleModulesPlugin(), controlUiBrowserOnlySharedModuleAliases()],
  build: {
    outDir: path.join(here, "../extensions/kids-ui/assets"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { host: "127.0.0.1", port: 5187, strictPort: true },
}));
