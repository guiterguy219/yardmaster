import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_PATH = join(homedir(), ".git-credentials");

type TokenMap = Record<string, string>;

let cachedTokens: TokenMap | null = null;

/**
 * Parse ~/.git-credentials to build an org → token map.
 * Entries look like: https://user:TOKEN@github.com/ORG/REPO.git
 * or:                https://user:TOKEN@github.com/ORG
 *
 * When multiple entries match the same org, the org-level entry (no repo)
 * takes precedence; otherwise the first match wins.
 */
function loadTokens(): TokenMap {
  if (cachedTokens) return cachedTokens;

  if (!existsSync(CREDENTIALS_PATH)) {
    cachedTokens = {};
    return cachedTokens;
  }

  const tokens: TokenMap = {};
  const lines = readFileSync(CREDENTIALS_PATH, "utf-8").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const url = new URL(trimmed);
      if (url.hostname !== "github.com") continue;

      const token = url.password;
      if (!token) continue;

      // pathname is like /ORG/REPO.git or /ORG
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 0) continue;

      const org = parts[0];
      const isOrgLevel = parts.length === 1;

      // Org-level entries take precedence over repo-level ones
      if (isOrgLevel || !tokens[org]) {
        tokens[org] = token;
      }
    } catch {
      // Skip malformed lines
    }
  }

  cachedTokens = tokens;
  return tokens;
}

/**
 * Get the GitHub PAT for a given org. Returns undefined if no token is found,
 * which means the default `gh` auth will be used.
 */
export function getGhToken(org: string): string | undefined {
  const tokens = loadTokens();
  return tokens[org];
}

/**
 * Return environment overrides for running `gh` CLI commands against a specific org.
 * Sets GH_TOKEN so `gh` uses the correct PAT. If no token is found for the org,
 * returns an empty object (falls back to default gh auth).
 */
export function ghEnvForOrg(org: string): Record<string, string> {
  const token = getGhToken(org);
  if (!token) return {};
  return { GH_TOKEN: token };
}

/**
 * Return a full process.env-compatible object with the correct GH_TOKEN for an org.
 * Suitable for passing as the `env` option to execSync/execFileSync/spawn.
 */
export function ghExecEnv(org: string): NodeJS.ProcessEnv {
  return { ...process.env, ...ghEnvForOrg(org) };
}

/**
 * Resolve the org from an issue reference like "org/repo#123".
 */
export function orgFromIssueRef(issueRef: string): string | null {
  const match = issueRef.match(/^([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Check which orgs have tokens configured and which don't.
 */
export function auditTokens(orgs: string[]): { configured: string[]; missing: string[] } {
  const tokens = loadTokens();
  const configured: string[] = [];
  const missing: string[] = [];

  for (const org of orgs) {
    if (tokens[org]) {
      configured.push(org);
    } else {
      missing.push(org);
    }
  }

  return { configured, missing };
}

/** Clear cached tokens (useful after rotating credentials). */
export function clearTokenCache(): void {
  cachedTokens = null;
}
