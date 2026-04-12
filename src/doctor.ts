import { execSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { auditTokens, ghExecEnv } from "./gh-auth.js";

// ── ANSI helpers ─────────────────────────────────────────
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red   = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold  = (s: string) => `\x1b[1m${s}\x1b[0m`;

function pass(label: string, detail?: string) {
  const suffix = detail ? `  ${detail}` : "";
  console.log(`  ${green("✓")} ${label}${suffix}`);
}

function fail(label: string, detail?: string) {
  const suffix = detail ? `  ${detail}` : "";
  console.log(`  ${red("✗")} ${label}${suffix}`);
}

function warn(label: string, detail?: string) {
  const suffix = detail ? `  ${detail}` : "";
  console.log(`  ${yellow("⚠")} ${label}${suffix}`);
}

// ── Individual checks ─────────────────────────────────────

function checkGitConfig(): boolean {
  let ok = true;

  try {
    const name = execSync("git config --get user.name", { stdio: "pipe" }).toString().trim();
    pass("git user.name", name);
  } catch (err: unknown) {
    const detail = (err as { code?: string }).code === "ENOENT"
      ? "git not found — install git"
      : "not set — run: git config --global user.name \"Your Name\"";
    fail("git user.name", detail);
    ok = false;
  }

  try {
    const email = execSync("git config --get user.email", { stdio: "pipe" }).toString().trim();
    pass("git user.email", email);
  } catch (err: unknown) {
    const detail = (err as { code?: string }).code === "ENOENT"
      ? "git not found — install git"
      : "not set — run: git config --global user.email \"you@example.com\"";
    fail("git user.email", detail);
    ok = false;
  }

  return ok;
}

function checkSshGithub(): boolean {
  try {
    execSync("ssh -T git@github.com", { stdio: "pipe", timeout: 10000 });
    // exit 0 = unusual but fine
    pass("ssh git@github.com");
    return true;
  } catch (err: unknown) {
    const killed = (err as { killed?: boolean }).killed;
    if (killed) {
      warn("ssh git@github.com", "timed out — check network/firewall");
      return true;
    }
    // GitHub always exits 1 on successful auth, so check stderr content
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (stderr.toLowerCase().includes("successfully authenticated")) {
      pass("ssh git@github.com", stderr.trim().split("\n")[0]);
      return true;
    }
    // not a fatal check — warn only
    warn("ssh git@github.com", "could not authenticate — check your SSH key");
    return true;
  }
}

function checkGhAuth(): boolean {
  try {
    // gh auth status writes to stderr in most versions; merge streams to capture it
    const out = execSync("gh auth status 2>&1", { stdio: "pipe" }).toString().trim();
    const firstLine = out.split("\n")[0];
    pass("gh auth status", firstLine);
    return true;
  } catch (err: unknown) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? "";
    const combined = (stderr || stdout).trim();
    const detail = combined.split("\n")[0].trim();
    fail("gh auth status", detail || "not authenticated — run: gh auth login");
    return false;
  }
}

function checkClaude(): boolean {
  try {
    const out = execSync("claude --version", { stdio: "pipe" }).toString().trim();
    pass("claude --version", out);
    return true;
  } catch {
    fail("claude --version", "not found — install Claude Code CLI");
    return false;
  }
}

function checkUvx(): boolean {
  try {
    const out = execSync("uvx --version", { stdio: "pipe" }).toString().trim();
    pass("uvx --version", out);
    return true;
  } catch {
    fail("uvx --version", "not found — install uv (https://docs.astral.sh/uv/)");
    return false;
  }
}

function checkRedis(): void {
  try {
    execSync("redis-cli ping", { stdio: "pipe" });
    pass("redis-cli ping");
  } catch {
    warn("redis-cli ping", "Redis not reachable (queue features may be unavailable)");
  }
}

function checkRepoRemote(org: string, repo: string, name: string): void {
  const remote = `git@github.com:${org}/${repo}.git`;
  try {
    execFileSync("git", ["ls-remote", remote, "HEAD"], { stdio: "pipe", timeout: 10000 });
    pass(`repo ${name}`, remote);
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? "";
    const detail = msg.includes("ETIMEDOUT") || msg.includes("timed out")
      ? `timed out reaching ${remote}`
      : `cannot reach ${remote}`;
    warn(`repo ${name}`, detail);
  }
}

function getGitConfig(key: string, cwd?: string): string | null {
  try {
    const args = cwd
      ? ["-C", cwd, "config", "--get", key]
      : ["config", "--get", key];
    return execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

function checkRepoGitIdentity(repoName: string, repoPath: string): boolean {
  let ok = true;

  // Check user.name: local config first, then global fallback
  const localName = getGitConfig("user.name", repoPath);
  const resolvedName = localName ?? getGitConfig("user.name");
  if (resolvedName) {
    const resolvedSource = localName ? "local" : "global";
    pass(`${repoName} user.name`, `${resolvedName} (${resolvedSource})`);
  } else {
    fail(`${repoName} user.name`, "not set — run: git -C <repo> config user.name \"Your Name\"");
    ok = false;
  }

  // Check user.email: local config first, then global fallback
  const localEmail = getGitConfig("user.email", repoPath);
  const resolvedEmail = localEmail ?? getGitConfig("user.email");
  if (resolvedEmail) {
    const resolvedSource = localEmail ? "local" : "global";
    pass(`${repoName} user.email`, `${resolvedEmail} (${resolvedSource})`);
  } else {
    fail(`${repoName} user.email`, "not set — run: git -C <repo> config user.email \"you@example.com\"");
    ok = false;
  }

  return ok;
}

function checkRepoPushCredentials(repoName: string, repoPath: string, org: string, repo: string): boolean {
  // Test actual push access via dry-run push from within the repo directory
  try {
    execFileSync("git", ["-C", repoPath, "push", "--dry-run", "origin", "HEAD"], {
      stdio: "pipe",
      timeout: 10000,
    });
    pass(`${repoName} push credentials`, "git push --dry-run OK");
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? "";
    if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
      warn(`${repoName} push credentials`, "timed out — check network");
      return true; // not a definitive failure
    }
    fail(
      `${repoName} push credentials`,
      "cannot reach origin — verify SSH key or HTTPS credentials",
    );
    return false;
  }

  // If credential.useHttpPath is enabled, check for per-repo entries in .git-credentials
  const useHttpPath = getGitConfig("credential.useHttpPath", repoPath)
    ?? getGitConfig("credential.useHttpPath");
  if (useHttpPath === "true") {
    const credFile = join(homedir(), ".git-credentials");
    if (existsSync(credFile)) {
      const contents = readFileSync(credFile, "utf-8");
      // .git-credentials format: https://user:token@github.com/org/repo
      const pattern = new RegExp(`github\\.com/${org}/${repo}(\\.git)?\\b`);
      if (pattern.test(contents)) {
        pass(`${repoName} credential.useHttpPath`, `per-repo entry found for ${org}/${repo}`);
      } else {
        warn(
          `${repoName} credential.useHttpPath`,
          `credential.useHttpPath=true but no entry for ${org}/${repo} in ~/.git-credentials`,
        );
      }
    } else {
      warn(
        `${repoName} credential.useHttpPath`,
        "credential.useHttpPath=true but ~/.git-credentials not found",
      );
    }
  }

  return true;
}

function checkGhTokens(orgs: string[]): boolean {
  const uniqueOrgs = [...new Set(orgs)];
  const { configured = [], missing = [] } = auditTokens(uniqueOrgs) ?? {};

  for (const org of configured) {
    // Validate the token actually works
    try {
      execSync(`gh auth status 2>&1`, {
        stdio: "pipe",
        env: ghExecEnv(org),
      });
      pass(`gh token (${org})`);
    } catch {
      fail(`gh token (${org})`, "token configured but invalid or expired");
      return false;
    }
  }

  for (const org of missing) {
    fail(`gh token (${org})`, "no token — add to data/.gh-tokens.json");
  }

  return missing.length === 0;
}

// ── Main export ───────────────────────────────────────────

export async function runDoctor(): Promise<number> {
  console.log(`\n${bold("Yardmaster — pre-flight checks")}\n`);

  let criticalFailed = false;

  // Critical checks
  console.log(bold("Git config"));
  if (!checkGitConfig()) criticalFailed = true;

  console.log();
  console.log(bold("GitHub CLI"));
  if (!checkGhAuth()) criticalFailed = true;

  console.log();
  console.log(bold("Claude CLI"));
  if (!checkClaude()) criticalFailed = true;

  // SSH (warning only)
  console.log();
  console.log(bold("SSH"));
  checkSshGithub();

  // Redis (warning only)
  console.log();
  console.log(bold("Redis"));
  checkRedis();

  // Repos from config + conditional Serena check
  try {
    const config = loadConfig();

    console.log();
    console.log(bold("GitHub tokens (per-org)"));
    if (!checkGhTokens(config.repos.map((r) => r.githubOrg))) criticalFailed = true;

    const serenaRepos = config.repos.filter((r) => r.useSerena);
    if (serenaRepos.length > 0) {
      console.log();
      console.log(bold("Serena (uvx)"));
      if (!checkUvx()) criticalFailed = true;
    }

    if (config.repos.length > 0) {
      console.log();
      console.log(bold("Repos (git ls-remote)"));
      for (const repo of config.repos) {
        checkRepoRemote(repo.githubOrg, repo.githubRepo, repo.name);
      }

      console.log();
      console.log(bold("Per-repo git identity"));
      for (const repo of config.repos) {
        if (!checkRepoGitIdentity(repo.name, repo.localPath)) {
          criticalFailed = true;
        }
      }

      console.log();
      console.log(bold("Per-repo push credentials"));
      for (const repo of config.repos) {
        if (!checkRepoPushCredentials(repo.name, repo.localPath, repo.githubOrg, repo.githubRepo)) {
          criticalFailed = true;
        }
      }
    }
  } catch {
    // config missing — skip repo checks silently
  }

  console.log();
  if (criticalFailed) {
    console.log(red("One or more critical checks failed. Fix the issues above before running tasks."));
    console.log();
    return 1;
  }

  console.log(green("All critical checks passed."));
  console.log();
  return 0;
}
