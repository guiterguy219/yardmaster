import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "yarn" | "pnpm";
export type Language =
  | "typescript"
  | "javascript"
  | "go"
  | "rust"
  | "python"
  | "unknown";

export interface RepoDetection {
  language: Language;
  packageManager?: PackageManager;
  hasCI: boolean;
  hasDocker: boolean;
  hasClaude: boolean;
  checkCommand?: string;
  scripts: Record<string, string>;
  dependencies: string[];
}

export interface OnboardingResult {
  detection: RepoDetection;
  suggestions: string[];
}

export async function onboardRepo(repoPath: string, _repoName?: string): Promise<OnboardingResult> {
  const detection = detectRepo(repoPath);
  const suggestions = buildSuggestions(detection);
  return { detection, suggestions };
}

function detectRepo(repoPath: string): RepoDetection {
  const language = detectLanguage(repoPath);
  const packageManager = detectPackageManager(repoPath);
  const { scripts, dependencies } = readPackageJson(repoPath);
  const checkCommand = inferCheckCommand(language, scripts, packageManager);
  const hasCI = existsSync(join(repoPath, ".github", "workflows"));
  const hasDocker = existsSync(join(repoPath, "Dockerfile"));
  const hasClaude = existsSync(join(repoPath, "CLAUDE.md"));

  return {
    language,
    packageManager,
    hasCI,
    hasDocker,
    hasClaude,
    checkCommand,
    scripts,
    dependencies,
  };
}

function detectLanguage(repoPath: string): Language {
  if (existsSync(join(repoPath, "go.mod"))) return "go";
  if (existsSync(join(repoPath, "Cargo.toml"))) return "rust";
  if (existsSync(join(repoPath, "pyproject.toml")) || existsSync(join(repoPath, "requirements.txt"))) return "python";

  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      if ("typescript" in allDeps || "@types/node" in allDeps) return "typescript";
      return "javascript";
    } catch {
      return "javascript";
    }
  }

  return "unknown";
}

function detectPackageManager(repoPath: string): PackageManager | undefined {
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "package.json"))) return "npm";
  return undefined;
}

function readPackageJson(repoPath: string): { scripts: Record<string, string>; dependencies: string[] } {
  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return { scripts: {}, dependencies: [] };

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const dependencies = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    return { scripts, dependencies };
  } catch {
    return { scripts: {}, dependencies: [] };
  }
}

function inferCheckCommand(
  language: Language,
  scripts: Record<string, string>,
  packageManager: PackageManager | undefined
): string | undefined {
  const pm = packageManager ?? "npm";

  const runCmd = (script: string) => {
    if (pm === "yarn") return `yarn ${script}`;
    if (pm === "pnpm") return `pnpm run ${script}`;
    return `npm run ${script}`;
  };

  const tscCmd = () => {
    if (pm === "yarn") return "yarn tsc --noEmit";
    if (pm === "pnpm") return "pnpm exec tsc --noEmit";
    return "npx tsc --noEmit";
  };

  if (language === "typescript") {
    if ("typecheck" in scripts) return runCmd("typecheck");
    return tscCmd();
  }
  if (language === "go") return "go build ./...";
  if (language === "rust") return "cargo check";
  if (language === "python") return undefined;
  if ("test" in scripts) return runCmd("test");
  return undefined;
}

function buildSuggestions(detection: RepoDetection): string[] {
  const suggestions: string[] = [];

  if (!detection.hasClaude) {
    suggestions.push("Add a CLAUDE.md file to give the agent project-specific context.");
  }

  if (!detection.hasCI) {
    suggestions.push("No .github/workflows/ detected — consider adding CI for automated checks.");
  }

  if (detection.language === "unknown") {
    suggestions.push("Could not detect language. Set checkCommand manually in repos.json.");
  }

  if (!detection.checkCommand && detection.language !== "python") {
    suggestions.push("No check command inferred. Set checkCommand in repos.json to enable pre-PR validation.");
  }

  return suggestions;
}
