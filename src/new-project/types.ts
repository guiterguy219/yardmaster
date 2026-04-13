export interface ProjectSpec {
  name: string;
  displayName?: string;
  description: string;
  githubOrg?: string;
  platform: "mobile" | "web" | "api" | "fullstack";
  framework?: string;
  language: "typescript" | "javascript";
  styling?: string;
  backend?: string;
  auth?: string;
  designTools?: string[];
  testing?: {
    unit?: string;
    e2e?: string;
  };
  darkMode: boolean;
  additionalDeps?: string[];
  additionalDevDeps?: string[];
  notes?: string;
  /** Override the parent directory name under ~/code/. Defaults to "gibson-ops". */
  companyDir?: string;
  /** Declared project files from spec (used by generic scaffolder). */
  files?: string[];
}

export interface RawRepoConfigEntry {
  name: string;
  path: string;
  org: string;
  repo: string;
  branch: string;
  checkCommand?: string;
  testCommand?: string;
  devCommand?: string;
  devPort?: number;
  readyPattern?: string;
}

export interface ScaffoldResult {
  projectPath: string;
  githubUrl: string;
  repoConfigEntry: RawRepoConfigEntry;
  filesCreated: string[];
  initialCommitSha: string;
}
