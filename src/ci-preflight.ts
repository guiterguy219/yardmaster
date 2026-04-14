import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import YAML from "js-yaml";
import type { YardmasterConfig, RepoConfig } from "./config.js";
import { runCoder } from "./agents/coder.js";
import { getDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CIPreflightResult {
  ran: boolean;
  passed: boolean;
  attempts: number;
  output: string;
  skippedJobs: string[];
}

interface WorkflowJob {
  name: string;
  workflowFile: string;
  steps: WorkflowStep[];
  workingDirectory?: string;
}

interface WorkflowStep {
  name?: string;
  run: string;
  workingDirectory?: string;
}

interface CachedWorkflow {
  repo: string;
  workflow_path: string;
  file_hash: string;
  jobs: string; // JSON-serialized WorkflowJob[]
  cached_at: string;
}

// ---------------------------------------------------------------------------
// GitHub Actions YAML types (partial)
// ---------------------------------------------------------------------------

interface GHWorkflow {
  name?: string;
  jobs?: Record<string, GHJob>;
}

interface GHJob {
  name?: string;
  steps?: GHStep[];
  services?: Record<string, unknown>;
  "runs-on"?: string;
  strategy?: { matrix?: Record<string, unknown> };
  defaults?: { run?: { "working-directory"?: string } };
  env?: Record<string, string>;
  if?: string;
}

interface GHStep {
  name?: string;
  run?: string;
  uses?: string;
  "working-directory"?: string;
  env?: Record<string, string>;
  if?: string;
  with?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Job name patterns that are likely to contain useful local checks. */
const INCLUDE_JOB_PATTERNS = [
  /lint/i, /format/i, /check/i, /test/i, /ci\b/i, /build/i, /typecheck/i,
  /prettier/i, /eslint/i, /tsc/i, /vitest/i, /jest/i,
];

/** Job name patterns we should skip — deploy, release, notifications, etc. */
const EXCLUDE_JOB_PATTERNS = [
  /deploy/i, /release/i, /publish/i, /notify/i, /notification/i,
  /docker/i, /container/i, /upload/i, /download/i, /coverage-report/i,
  /pages/i, /cdn/i,
];

/** Step-level skip indicators — secrets, cloud CLIs, external actions. */
const SECRET_PATTERN = /\$\{\{\s*secrets\./;
const CLOUD_CLI_PATTERNS = [/aws\s/, /gcloud\s/, /az\s/, /kubectl\s/];

const MAX_FIX_ATTEMPTS = 2;
const COMMAND_TIMEOUT_MS = 120_000; // 2 minutes per command

// ---------------------------------------------------------------------------
// DB migration
// ---------------------------------------------------------------------------

export function migrateCIWorkflows(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ci_workflows (
      repo TEXT NOT NULL,
      workflow_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      jobs TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo, workflow_path)
    );
  `);
}

// ---------------------------------------------------------------------------
// Workflow discovery + caching
// ---------------------------------------------------------------------------

function discoverWorkflowFiles(repoPath: string): string[] {
  const workflowDir = join(repoPath, ".github", "workflows");
  if (!existsSync(workflowDir)) return [];

  try {
    const files = execSync("ls *.yml *.yaml 2>/dev/null || true", {
      cwd: workflowDir,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    return files.map((f) => join(workflowDir, f));
  } catch {
    return [];
  }
}

function hashFile(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

function getCachedJobs(repo: string, workflowPath: string, fileHash: string): WorkflowJob[] | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM ci_workflows WHERE repo = ? AND workflow_path = ? AND file_hash = ?")
    .get(repo, workflowPath, fileHash) as CachedWorkflow | undefined;

  if (!row) return null;
  return JSON.parse(row.jobs) as WorkflowJob[];
}

function cacheJobs(repo: string, workflowPath: string, fileHash: string, jobs: WorkflowJob[]): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO ci_workflows (repo, workflow_path, file_hash, jobs, cached_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(repo, workflowPath, fileHash, JSON.stringify(jobs));
}

// ---------------------------------------------------------------------------
// Workflow parsing
// ---------------------------------------------------------------------------

function shouldIncludeJob(jobKey: string, job: GHJob): boolean {
  const name = job.name ?? jobKey;
  const combined = `${jobKey} ${name}`;

  // Exclude first
  if (EXCLUDE_JOB_PATTERNS.some((p) => p.test(combined))) return false;
  // Include by pattern match
  if (INCLUDE_JOB_PATTERNS.some((p) => p.test(combined))) return true;
  // Default: include — better to run an extra check than miss one
  return true;
}

function shouldSkipJob(job: GHJob): { skip: boolean; reason?: string } {
  // Skip Docker-service-dependent jobs unless integration infra is present
  if (job.services && Object.keys(job.services).length > 0) {
    return { skip: true, reason: "requires Docker services" };
  }
  return { skip: false };
}

function shouldSkipStep(step: GHStep): { skip: boolean; reason?: string } {
  // Only interested in `run:` steps (not action `uses:`)
  if (!step.run) return { skip: true, reason: "no run command" };

  // Skip steps that reference secrets
  if (SECRET_PATTERN.test(step.run)) {
    return { skip: true, reason: "references secrets" };
  }
  if (step.env) {
    const envValues = Object.values(step.env).join(" ");
    if (SECRET_PATTERN.test(envValues)) {
      return { skip: true, reason: "env references secrets" };
    }
  }

  // Skip steps that use cloud CLIs
  if (CLOUD_CLI_PATTERNS.some((p) => p.test(step.run!))) {
    return { skip: true, reason: "uses cloud CLI" };
  }

  // Skip checkout steps (we already have the code)
  if (step.uses?.startsWith("actions/checkout")) {
    return { skip: true, reason: "checkout action" };
  }

  // Skip setup-node / setup-python etc. (already have runtime)
  if (step.uses?.startsWith("actions/setup-")) {
    return { skip: true, reason: "setup action" };
  }

  // Skip any `uses:` action steps (we only run `run:` commands)
  if (step.uses && !step.run) {
    return { skip: true, reason: "action step" };
  }

  return { skip: false };
}

function extractJobsFromWorkflow(workflowPath: string): { jobs: WorkflowJob[]; skipped: string[] } {
  const content = readFileSync(workflowPath, "utf-8");
  let workflow: GHWorkflow;
  try {
    workflow = YAML.load(content) as GHWorkflow;
  } catch {
    return { jobs: [], skipped: [`${workflowPath}: failed to parse YAML`] };
  }

  if (!workflow?.jobs) return { jobs: [], skipped: [] };

  const jobs: WorkflowJob[] = [];
  const skipped: string[] = [];
  const workflowName = workflow.name ?? relative(process.cwd(), workflowPath);

  for (const [jobKey, job] of Object.entries(workflow.jobs)) {
    const jobName = job.name ?? jobKey;
    const qualifiedName = `${workflowName} / ${jobName}`;

    if (!shouldIncludeJob(jobKey, job)) {
      skipped.push(`${qualifiedName}: excluded by pattern`);
      continue;
    }

    const skipResult = shouldSkipJob(job);
    if (skipResult.skip) {
      skipped.push(`${qualifiedName}: ${skipResult.reason}`);
      continue;
    }

    const defaultWorkDir = job.defaults?.run?.["working-directory"];
    const steps: WorkflowStep[] = [];

    for (const step of job.steps ?? []) {
      const stepSkip = shouldSkipStep(step);
      if (stepSkip.skip) continue;

      steps.push({
        name: step.name,
        run: step.run!,
        workingDirectory: step["working-directory"] ?? defaultWorkDir,
      });
    }

    if (steps.length > 0) {
      jobs.push({
        name: qualifiedName,
        workflowFile: workflowPath,
        steps,
        workingDirectory: defaultWorkDir,
      });
    }
  }

  return { jobs, skipped };
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

function expandMatrixVars(command: string): string {
  // Replace ${{ matrix.* }} with sensible defaults
  // e.g. ${{ matrix.node-version }} → current node version
  let expanded = command;

  // Node version: use current
  expanded = expanded.replace(
    /\$\{\{\s*matrix\.node[_-]?version\s*\}\}/gi,
    process.versions.node.split(".")[0]
  );

  // Generic matrix vars: strip the expression (leave empty string)
  expanded = expanded.replace(/\$\{\{\s*matrix\.[^}]+\}\}/g, "");

  // GitHub context vars that are safe to stub
  expanded = expanded.replace(/\$\{\{\s*github\.workspace\s*\}\}/g, ".");
  expanded = expanded.replace(/\$\{\{\s*runner\.os\s*\}\}/g, "Linux");

  return expanded;
}

function shouldSkipCommand(command: string): boolean {
  const trimmed = command.trim();
  // Skip pure install commands (npm ci, yarn install, pnpm install)
  // — we assume deps are already installed in the worktree
  if (/^(npm\s+ci|npm\s+install|yarn(\s+install)?|pnpm\s+install)\s*$/.test(trimmed)) {
    return true;
  }
  return false;
}

interface CommandResult {
  command: string;
  step: string;
  job: string;
  passed: boolean;
  output: string;
}

function runCommand(
  command: string,
  cwd: string,
  stepName: string,
  jobName: string
): CommandResult {
  const expanded = expandMatrixVars(command);

  // Some steps have multiple commands separated by newlines
  // Run them sequentially with &&
  const lines = expanded
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (lines.length === 0 || lines.every((l) => shouldSkipCommand(l))) {
    return { command: expanded, step: stepName, job: jobName, passed: true, output: "skipped" };
  }

  // Filter out install-only lines but keep the rest
  const commandsToRun = lines.filter((l) => !shouldSkipCommand(l));
  const fullCommand = commandsToRun.join(" && ");

  try {
    const output = execSync(fullCommand, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        CI: "true",
        NODE_ENV: "test",
      },
    });
    return { command: fullCommand, step: stepName, job: jobName, passed: true, output };
  } catch (err) {
    const output =
      (err as any).stderr?.toString() ||
      (err as any).stdout?.toString() ||
      (err instanceof Error ? err.message : String(err));
    return { command: fullCommand, step: stepName, job: jobName, passed: false, output };
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runCIPreflight(
  config: YardmasterConfig,
  repo: RepoConfig,
  taskId: string,
  worktreePath: string,
  description: string
): Promise<CIPreflightResult> {
  // Ensure cache table exists
  migrateCIWorkflows();

  // Discover workflow files
  const workflowFiles = discoverWorkflowFiles(worktreePath);
  if (workflowFiles.length === 0) {
    return {
      ran: false,
      passed: true,
      attempts: 0,
      output: "no workflow files found",
      skippedJobs: [],
    };
  }

  // Parse and extract jobs (with caching)
  const allJobs: WorkflowJob[] = [];
  const allSkipped: string[] = [];

  for (const wfPath of workflowFiles) {
    const fileHash = hashFile(wfPath);
    const relPath = relative(worktreePath, wfPath);

    // Check cache
    const cached = getCachedJobs(repo.name, relPath, fileHash);
    if (cached) {
      allJobs.push(...cached);
      continue;
    }

    // Parse fresh
    const { jobs, skipped } = extractJobsFromWorkflow(wfPath);
    allJobs.push(...jobs);
    allSkipped.push(...skipped);

    // Cache result
    cacheJobs(repo.name, relPath, fileHash, jobs);
  }

  if (allJobs.length === 0) {
    return {
      ran: true,
      passed: true,
      attempts: 0,
      output: "no runnable CI jobs found",
      skippedJobs: allSkipped,
    };
  }

  console.log(`  CI preflight: ${allJobs.length} job(s) to check`);
  if (allSkipped.length > 0) {
    console.log(`  CI preflight: ${allSkipped.length} job(s) skipped:`);
    for (const s of allSkipped) {
      console.log(`    - ${s}`);
    }
  }

  // Run checks, with coder fix loop on failure
  const failures = runAllJobs(allJobs, worktreePath);

  if (failures.length === 0) {
    return {
      ran: true,
      passed: true,
      attempts: 0,
      output: "all CI checks passed",
      skippedJobs: allSkipped,
    };
  }

  // Feed failures to coder for fixing
  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    console.log(`  CI preflight fix attempt ${attempt}/${MAX_FIX_ATTEMPTS}...`);
    const failureSummary = formatFailures(failures);

    const fixPrompt = `${description}

## CI Preflight Failures

The following CI checks (extracted from the repo's GitHub Actions workflows) failed locally. Fix the code so these checks pass.

${failureSummary}

Fix the issues above. These are the same checks that run in CI — the PR will fail if they are not resolved.`;

    await runCoder(config, repo, fixPrompt, worktreePath);

    // Re-run failed checks
    const retryFailures = runAllJobs(allJobs, worktreePath);
    if (retryFailures.length === 0) {
      console.log(`  CI preflight passed after ${attempt} fix attempt(s)`);
      return {
        ran: true,
        passed: true,
        attempts: attempt,
        output: `passed after ${attempt} fix attempt(s)`,
        skippedJobs: allSkipped,
      };
    }

    // Update failures for next iteration
    failures.length = 0;
    failures.push(...retryFailures);
  }

  return {
    ran: true,
    passed: false,
    attempts: MAX_FIX_ATTEMPTS,
    output: formatFailures(failures),
    skippedJobs: allSkipped,
  };
}

function runAllJobs(jobs: WorkflowJob[], worktreePath: string): CommandResult[] {
  const failures: CommandResult[] = [];

  for (const job of jobs) {
    for (const step of job.steps) {
      const cwd = step.workingDirectory
        ? join(worktreePath, step.workingDirectory)
        : worktreePath;

      const result = runCommand(
        step.run,
        cwd,
        step.name ?? "unnamed step",
        job.name
      );

      if (!result.passed) {
        failures.push(result);
      }
    }
  }

  return failures;
}

function formatFailures(failures: CommandResult[]): string {
  return failures
    .map(
      (f) =>
        `### ${f.job} — ${f.step}

Command: \`${f.command}\`

\`\`\`
${f.output.slice(0, 3000)}
\`\`\``
    )
    .join("\n\n");
}
