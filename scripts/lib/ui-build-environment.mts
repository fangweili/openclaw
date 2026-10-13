/**
 * Shared build-identity policy for the UI command runner and Vite frontends.
 * Owns no persistent state or output files: each synchronous call reads source
 * metadata and returns an environment for its caller's build lifecycle. Identity
 * normalization and commit/timestamp pinning remain with their existing owners.
 * Importing this module never launches a build or loads publication machinery.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import { resolveBuildIdentityEnvironment } from "./build-identity.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type UiBuildEnvironmentSources = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readBuildInfo?: () => unknown;
  readGitCommit?: () => string | null;
  readPackageVersion?: () => string | null;
};

function readCurrentGitCommit(): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readCurrentPackageVersion(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function readExistingBuildInfo(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "dist/build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Return a fresh child-process environment without mutating the input. Explicit
 * identity overrides win; otherwise reuse dist metadata only when commit,
 * version and release mode match. Missing/unreadable metadata falls back to a
 * newly pinned identity. Invalid explicit commits reject before any output work.
 * Default source reads are synchronous and rooted at this repository.
 */
export function resolveUiBuildEnvironment(
  sources: UiBuildEnvironmentSources = {},
): NodeJS.ProcessEnv {
  const env = sources.env ?? process.env;
  const buildEnv = resolveBuildIdentityEnvironment({
    commitLabel: "Control UI build commit",
    env,
    now: sources.now,
    readGitCommit: sources.readGitCommit ?? readCurrentGitCommit,
  });
  if (env.OPENCLAW_BUILD_TIMESTAMP?.trim() || env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim()) {
    return buildEnv;
  }

  const existing = normalizeControlUiBuildInfo((sources.readBuildInfo ?? readExistingBuildInfo)());
  const version = (sources.readPackageVersion ?? readCurrentPackageVersion)();
  const release = env.OPENCLAW_CONTROL_UI_RELEASE_BUILD?.trim() === "1";
  if (
    existing.buildId === "dev" ||
    !existing.builtAt ||
    existing.commit !== buildEnv.GIT_COMMIT ||
    existing.version !== version ||
    existing.release !== release
  ) {
    return buildEnv;
  }
  return {
    ...buildEnv,
    OPENCLAW_BUILD_TIMESTAMP: existing.builtAt,
    OPENCLAW_CONTROL_UI_BUILD_ID: existing.buildId,
  };
}
