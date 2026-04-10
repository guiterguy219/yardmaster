import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export interface RepoConfig {
  name: string;
  localPath: string;
  githubOrg: string;
  githubRepo: string;
  defaultBranch: string;
  checkCommand?: string;
  testCommand?: string;
}

export interface YardmasterConfig {
  repos: RepoConfig[];
  dataDir: string;
  worktreeBaseDir: string;
  claudeBinary: string;
  defaultModel: string;
  timeouts: {
    coder: number;
    reviewer: number;
    gitAgent: number;
  };
}

const CONFIG_PATH = join(homedir(), "code", "gibson-ops", "yardmaster", "repos.json");
const DATA_DIR = join(homedir(), "code", "gibson-ops", "yardmaster", "data");

export function loadConfig(): YardmasterConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}\nRun 'ym init' or create repos.json manually.`);
  }

  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as {
    repos: Array<{
      name: string;
      path: string;
      org: string;
      repo: string;
      branch?: string;
      checkCommand?: string;
      testCommand?: string;
    }>;
  };

  const repos: RepoConfig[] = raw.repos.map((r) => ({
    name: r.name,
    localPath: resolve(r.path.replace("~", homedir())),
    githubOrg: r.org,
    githubRepo: r.repo,
    defaultBranch: r.branch ?? "main",
    checkCommand: r.checkCommand,
    testCommand: r.testCommand,
  }));

  return {
    repos,
    dataDir: DATA_DIR,
    worktreeBaseDir: join(DATA_DIR, "worktrees"),
    claudeBinary: "claude",
    defaultModel: "sonnet",
    timeouts: {
      coder: 10 * 60 * 1000,
      reviewer: 5 * 60 * 1000,
      gitAgent: 3 * 60 * 1000,
    },
  };
}

export function getRepo(config: YardmasterConfig, name: string): RepoConfig {
  const repo = config.repos.find((r) => r.name === name);
  if (!repo) {
    const available = config.repos.map((r) => r.name).join(", ");
    throw new Error(`Unknown repo: "${name}". Available: ${available}`);
  }
  return repo;
}
