import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, type YardmasterConfig } from "../config.js";
import { generateClaudeMd } from "./claude-md-generator.js";
import type { ProjectSpec, RawRepoConfigEntry, ScaffoldResult } from "./types.js";

interface ShellOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

function runShell(command: string, opts: ShellOptions): string {
  try {
    return execSync(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "pipe",
      encoding: "utf-8",
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message: string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    const stdout = e.stdout ? e.stdout.toString() : "";
    throw new Error(
      `Command failed in ${opts.cwd}: ${command}\n${stderr || stdout || e.message}`
    );
  }
}

function runShellQuiet(command: string, opts: ShellOptions): { ok: boolean; output: string } {
  try {
    const output = execSync(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
    const out = (e.stderr ? e.stderr.toString() : "") + (e.stdout ? e.stdout.toString() : "");
    return { ok: false, output: out };
  }
}

// Validation: kebab-case identifier (project + org names interpolated into shell)
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// npm package name (with optional scope). Conservative — rejects shell metacharacters.
const SAFE_PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function assertSafeName(value: string, label: string): void {
  if (!SAFE_NAME_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}" — must match ${SAFE_NAME_RE} (kebab-case, no shell metacharacters).`
    );
  }
}

function assertSafePackages(packages: readonly string[], label: string): void {
  for (const pkg of packages) {
    if (!SAFE_PACKAGE_RE.test(pkg)) {
      throw new Error(
        `Invalid ${label} package name: "${pkg}" — contains characters not allowed in npm package names.`
      );
    }
  }
}

function getScaffoldCommand(spec: ProjectSpec, projectPath: string): { cmd: string; cwd: string } {
  switch (spec.framework) {
    case "expo":
      return {
        cmd: `npx --yes create-expo-app ${spec.name} --template blank-typescript`,
        cwd: join(projectPath, ".."),
      };
    case "next":
      return {
        cmd: `npx --yes create-next-app@latest ${spec.name} --typescript --tailwind --app --yes`,
        cwd: join(projectPath, ".."),
      };
    case "nestjs":
      return {
        cmd: `npx --yes @nestjs/cli new ${spec.name} --package-manager npm --strict`,
        cwd: join(projectPath, ".."),
      };
    case "express":
      // Caller pre-creates projectPath (cross-platform); npm init runs inside it.
      return { cmd: `npm init -y`, cwd: projectPath };
    default:
      throw new Error(`Unsupported framework: ${spec.framework}`);
  }
}

function inferCheckCommand(spec: ProjectSpec): string | undefined {
  if (spec.language === "typescript") return "npx tsc --noEmit";
  return undefined;
}

function inferTestCommand(spec: ProjectSpec): string | undefined {
  const unit = spec.testing?.unit;
  if (unit === "vitest") return "npx vitest run";
  if (unit === "jest") return "npx jest";
  return undefined;
}

function inferDevCommand(spec: ProjectSpec): string | undefined {
  switch (spec.framework) {
    case "expo":
      return "npx expo start";
    case "next":
      return "npm run dev";
    case "nestjs":
      return "npm run start:dev";
    case "express":
      return "node index.js";
    default:
      return undefined;
  }
}

function inferDevPort(spec: ProjectSpec): number | undefined {
  switch (spec.framework) {
    case "expo":
      return 8081;
    case "next":
      return 3000;
    case "nestjs":
      return 3000;
    case "express":
      return 3000;
    default:
      return undefined;
  }
}

function inferBackendDeps(spec: ProjectSpec): string[] {
  if (!spec.backend || spec.backend === "none") return [];
  if (spec.backend === "instantdb") {
    if (spec.platform === "mobile") {
      return [
        "@instantdb/react-native",
        "@react-native-async-storage/async-storage",
        "@react-native-community/netinfo",
        "react-native-get-random-values",
      ];
    }
    return ["@instantdb/react"];
  }
  if (spec.backend === "supabase") {
    return ["@supabase/supabase-js"];
  }
  return [];
}

function inferStylingDeps(spec: ProjectSpec): string[] {
  if (spec.styling === "nativewind" && spec.platform === "mobile") {
    return ["nativewind", "tailwindcss"];
  }
  return [];
}

function inferTestingDeps(spec: ProjectSpec): { deps: string[]; devDeps: string[] } {
  const deps: string[] = [];
  const devDeps: string[] = [];
  const unit = spec.testing?.unit;
  if (unit === "jest") devDeps.push("jest", "@types/jest", "ts-jest");
  if (unit === "vitest") devDeps.push("vitest");
  const e2e = spec.testing?.e2e;
  if (e2e === "playwright") devDeps.push("@playwright/test");
  // maestro is a CLI tool, no npm dep
  return { deps, devDeps };
}

function npmInstall(projectPath: string, packages: string[], dev: boolean): void {
  if (packages.length === 0) return;
  const flag = dev ? "--save-dev" : "--save";
  runShell(`npm install ${flag} ${packages.join(" ")}`, { cwd: projectPath });
}

interface RollbackState {
  projectDirCreated: boolean;
  githubRepoCreated: boolean;
  reposJsonModified: boolean;
  projectPath: string;
  reposJsonOriginal?: string;
  spec: ProjectSpec;
}

function rollback(state: RollbackState): void {
  if (state.reposJsonModified && state.reposJsonOriginal !== undefined) {
    try {
      writeFileSync(CONFIG_PATH, state.reposJsonOriginal);
      console.warn(`  ↩ rolled back ${CONFIG_PATH}`);
    } catch (err) {
      console.warn(`  ⚠ failed to roll back repos.json: ${(err as Error).message}`);
    }
  }
  if (state.githubRepoCreated) {
    const result = runShellQuiet(
      `gh repo delete ${state.spec.githubOrg}/${state.spec.name} --yes`,
      { cwd: homedir() }
    );
    if (result.ok) {
      console.warn(`  ↩ deleted GitHub repo ${state.spec.githubOrg}/${state.spec.name}`);
    } else {
      console.warn(
        `  ⚠ could not delete GitHub repo ${state.spec.githubOrg}/${state.spec.name} (delete it manually): ${result.output.slice(0, 200)}`
      );
    }
  }
  if (state.projectDirCreated && existsSync(state.projectPath)) {
    try {
      rmSync(state.projectPath, { recursive: true, force: true });
      console.warn(`  ↩ removed ${state.projectPath}`);
    } catch (err) {
      console.warn(`  ⚠ failed to remove ${state.projectPath}: ${(err as Error).message}`);
    }
  }
}

export async function runScaffold(
  config: YardmasterConfig,
  spec: ProjectSpec
): Promise<ScaffoldResult> {
  if (!spec.name || !spec.githubOrg || !spec.framework) {
    throw new Error("ProjectSpec is missing required fields (name, githubOrg, framework)");
  }

  // Validate inputs that get interpolated into shell commands.
  assertSafeName(spec.name, "spec.name");
  assertSafeName(spec.githubOrg, "spec.githubOrg");
  assertSafePackages(spec.additionalDeps ?? [], "additionalDeps");
  assertSafePackages(spec.additionalDevDeps ?? [], "additionalDevDeps");

  const filesCreated: string[] = [];
  const state: RollbackState = {
    projectDirCreated: false,
    githubRepoCreated: false,
    reposJsonModified: false,
    projectPath: "",
    spec,
  };

  try {
    // Step 1: scaffold
    const parentDir = join(homedir(), "code", spec.githubOrg);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    const projectPath = join(parentDir, spec.name);
    state.projectPath = projectPath;
    if (existsSync(projectPath)) {
      throw new Error(`Project directory already exists: ${projectPath}`);
    }

    // For express we pre-create the directory in Node (cross-platform); other
    // scaffolders create it themselves.
    if (spec.framework === "express") {
      mkdirSync(projectPath, { recursive: true });
      state.projectDirCreated = true;
    }

    const { cmd: scaffoldCmd, cwd: scaffoldCwd } = getScaffoldCommand(spec, projectPath);
    console.log(`  → scaffolding: ${scaffoldCmd}`);
    runShell(scaffoldCmd, { cwd: scaffoldCwd });

    if (!existsSync(projectPath)) {
      throw new Error(`Scaffold completed but project directory not found: ${projectPath}`);
    }
    state.projectDirCreated = true;

    // Step 2: dependencies
    const backend = inferBackendDeps(spec);
    const styling = inferStylingDeps(spec);
    const testing = inferTestingDeps(spec);

    const runtimeDeps = [...backend, ...styling, ...(spec.additionalDeps ?? []), ...testing.deps];
    const devDeps = [...(spec.additionalDevDeps ?? []), ...testing.devDeps];

    if (runtimeDeps.length > 0) {
      console.log(`  → installing deps: ${runtimeDeps.join(" ")}`);
      npmInstall(projectPath, runtimeDeps, false);
    }
    if (devDeps.length > 0) {
      console.log(`  → installing dev deps: ${devDeps.join(" ")}`);
      npmInstall(projectPath, devDeps, true);
    }

    if (spec.designTools?.includes("impeccable")) {
      console.log(`  → adding impeccable skill`);
      const result = runShellQuiet(`npx --yes skills add pbakaus/impeccable`, { cwd: projectPath });
      if (!result.ok) {
        console.warn(`    (impeccable install failed, continuing): ${result.output.slice(0, 200)}`);
      }
    }

    // Step 3: initialize git, then create GitHub repo + push.
    const gitDir = join(projectPath, ".git");
    if (!existsSync(gitDir)) {
      runShell(`git init`, { cwd: projectPath });
    }
    // Ensure the default branch is "main" before any commits land. If the
    // scaffolder already produced commits on another branch, `git branch -M main`
    // below will rename it.
    runShellQuiet(`git symbolic-ref HEAD refs/heads/main`, { cwd: projectPath });

    runShell(`git add -A`, { cwd: projectPath });
    const commitResult = runShellQuiet(
      `git commit -m "Initial scaffold via ym new"`,
      { cwd: projectPath }
    );
    if (!commitResult.ok && !/nothing to commit/i.test(commitResult.output)) {
      throw new Error(`git commit failed: ${commitResult.output}`);
    }
    runShell(`git branch -M main`, { cwd: projectPath });

    console.log(`  → creating GitHub repo ${spec.githubOrg}/${spec.name}`);
    runShell(
      `gh repo create ${spec.githubOrg}/${spec.name} --public --source=. --remote=origin`,
      { cwd: projectPath }
    );
    state.githubRepoCreated = true;

    runShell(`git push -u origin main`, { cwd: projectPath });

    const initialCommitSha = runShell(`git rev-parse HEAD`, { cwd: projectPath }).trim();

    // Step 4: register in repos.json (snapshot original for rollback).
    const reposJsonRaw = readFileSync(CONFIG_PATH, "utf-8");
    state.reposJsonOriginal = reposJsonRaw;
    const reposJson = JSON.parse(reposJsonRaw) as { repos: RawRepoConfigEntry[]; [k: string]: unknown };
    if (!Array.isArray(reposJson.repos)) {
      throw new Error(`repos.json is malformed: missing 'repos' array`);
    }
    if (reposJson.repos.some((r) => r.name === spec.name)) {
      throw new Error(`Repo "${spec.name}" already registered in repos.json`);
    }

    const repoConfigEntry: RawRepoConfigEntry = {
      name: spec.name,
      path: `~/code/${spec.githubOrg}/${spec.name}`,
      org: spec.githubOrg,
      repo: spec.name,
      branch: "main",
    };
    const checkCommand = inferCheckCommand(spec);
    if (checkCommand) repoConfigEntry.checkCommand = checkCommand;
    const testCommand = inferTestCommand(spec);
    if (testCommand) repoConfigEntry.testCommand = testCommand;
    const devCommand = inferDevCommand(spec);
    if (devCommand) repoConfigEntry.devCommand = devCommand;
    const devPort = inferDevPort(spec);
    if (devPort) repoConfigEntry.devPort = devPort;

    reposJson.repos.push(repoConfigEntry);
    writeFileSync(CONFIG_PATH, JSON.stringify(reposJson, null, 2) + "\n");
    state.reposJsonModified = true;

    // Step 5: generate CLAUDE.md
    console.log(`  → generating CLAUDE.md`);
    const claudeMd = await generateClaudeMd(config, spec);
    const claudeMdPath = join(projectPath, "CLAUDE.md");
    writeFileSync(claudeMdPath, claudeMd.endsWith("\n") ? claudeMd : claudeMd + "\n");
    filesCreated.push(claudeMdPath);

    // Step 6: commit + push CLAUDE.md
    runShell(`git add -A`, { cwd: projectPath });
    const claudeCommit = runShellQuiet(
      `git commit -m "Add CLAUDE.md and project configuration"`,
      { cwd: projectPath }
    );
    if (!claudeCommit.ok && !/nothing to commit/i.test(claudeCommit.output)) {
      throw new Error(`git commit (CLAUDE.md) failed: ${claudeCommit.output}`);
    }
    if (claudeCommit.ok) {
      runShell(`git push`, { cwd: projectPath });
    }

    const githubUrl = `https://github.com/${spec.githubOrg}/${spec.name}`;

    return {
      projectPath,
      githubUrl,
      repoConfigEntry,
      filesCreated,
      initialCommitSha,
    };
  } catch (err) {
    console.error(`\n✗ scaffold failed: ${(err as Error).message}`);
    console.error(`  attempting rollback…`);
    rollback(state);
    throw err;
  }
}
