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
  devCommand?: string;
  devPort?: number;
  readyPattern?: string;
  useSerena?: boolean;
  coderTimeout?: number;
  overagePolicy?: OveragePolicy;
  protectedFiles?: string[];
  protectedFunctions?: Record<string, string[]>;
  integrationStrategy?: IntegrationStrategy;
  integrationTestCommand?: string;
  smokeCommand?: string;
  smokeTimeoutMs?: number;
  buildCommand?: string;
}

export type OveragePolicy = "defer-low" | "defer-normal" | "block-all" | "allow";

export type IntegrationStrategy =
  | "full-docker"
  | "test-suite"
  | "smoke"
  | "self-exec"
  | "ask-agent";

export const INTEGRATION_STRATEGIES: readonly IntegrationStrategy[] = [
  "full-docker",
  "test-suite",
  "smoke",
  "self-exec",
  "ask-agent",
];

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface YardmasterConfig {
  repos: RepoConfig[];
  dataDir: string;
  worktreeBaseDir: string;
  claudeBinary: string;
  defaultModel: string;
  maxConcurrentAgents: number;
  timeouts: {
    coder: number;
    reviewer: number;
    gitAgent: number;
    diagnostician: number;
    diagnosticianEscalated: number;
  };
  telegram?: TelegramConfig;
}

export function loadTelegramConfig(): TelegramConfig | undefined {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return undefined;
  return { botToken, chatId };
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
      devCommand?: string;
      devPort?: number;
      readyPattern?: string;
      useSerena?: boolean;
      coderTimeout?: number;
      overagePolicy?: OveragePolicy;
      protectedFiles?: string[];
      protectedFunctions?: Record<string, string[]>;
      integrationStrategy?: IntegrationStrategy;
      integrationTestCommand?: string;
      smokeCommand?: string;
      smokeTimeoutMs?: number;
      buildCommand?: string;
    }>;
    maxConcurrentAgents?: number;
  };

  const repos: RepoConfig[] = raw.repos.map((r) => {
    let integrationStrategy = r.integrationStrategy;
    if (integrationStrategy && !INTEGRATION_STRATEGIES.includes(integrationStrategy)) {
      throw new Error(
        `Invalid integrationStrategy "${integrationStrategy}" for repo "${r.name}". ` +
          `Must be one of: ${INTEGRATION_STRATEGIES.join(", ")}`
      );
    }
    if (!integrationStrategy) {
      // Safe fallback that forces clarity — agents must request guidance before proceeding.
      console.warn(
        `  [config] repo "${r.name}" has no integrationStrategy — defaulting to "ask-agent". ` +
          `Set integrationStrategy in repos.json (one of: ${INTEGRATION_STRATEGIES.join(", ")}).`
      );
      integrationStrategy = "ask-agent";
    }
    return {
      name: r.name,
      localPath: resolve(r.path.replace("~", homedir())),
      githubOrg: r.org,
      githubRepo: r.repo,
      defaultBranch: r.branch ?? "main",
      checkCommand: r.checkCommand,
      testCommand: r.testCommand,
      devCommand: r.devCommand,
      devPort: r.devPort,
      readyPattern: r.readyPattern,
      useSerena: r.useSerena,
      coderTimeout: r.coderTimeout,
      overagePolicy: r.overagePolicy ?? "defer-low",
      protectedFiles: r.protectedFiles,
      protectedFunctions: r.protectedFunctions,
      integrationStrategy,
      integrationTestCommand: r.integrationTestCommand,
      smokeCommand: r.smokeCommand,
      smokeTimeoutMs: r.smokeTimeoutMs,
      buildCommand: r.buildCommand,
    };
  });

  return {
    repos,
    dataDir: DATA_DIR,
    worktreeBaseDir: join(DATA_DIR, "worktrees"),
    claudeBinary: "claude",
    defaultModel: "sonnet",
    maxConcurrentAgents: raw.maxConcurrentAgents ?? 1,
    timeouts: {
      coder: 15 * 60 * 1000,
      reviewer: 5 * 60 * 1000,
      gitAgent: 3 * 60 * 1000,
      diagnostician: 3 * 60 * 1000,
      diagnosticianEscalated: 5 * 60 * 1000,
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
