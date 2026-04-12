import { describe, it, expect } from "vitest";
import {
  parseChangedFiles,
  detectFunctionSignatureChanges,
  checkProtectedFiles,
} from "../protected-files.js";

const DIFF_TOUCH_DOCKER = `diff --git a/src/integration/docker.ts b/src/integration/docker.ts
index 1111111..2222222 100644
--- a/src/integration/docker.ts
+++ b/src/integration/docker.ts
@@ -10,3 +10,4 @@ const x = 1;
   const y = 2;
+  const z = 3;
   const w = 4;
diff --git a/src/other.ts b/src/other.ts
index aaaaaaa..bbbbbbb 100644
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,2 +1,2 @@
-export const a = 1;
+export const a = 2;
`;

const DIFF_SIG_CHANGE = `diff --git a/src/integration/docker.ts b/src/integration/docker.ts
index 1111111..2222222 100644
--- a/src/integration/docker.ts
+++ b/src/integration/docker.ts
@@ -5,3 +5,3 @@
-export function generateComposeFile(repo: string): string {
+export function generateComposeFile(repo: string, opts: object): string {
   return "";
`;

const DIFF_RENAME = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
`;

const DIFF_ASYNC_FUNC = `diff --git a/src/worker.ts b/src/worker.ts
index 1111111..2222222 100644
--- a/src/worker.ts
+++ b/src/worker.ts
@@ -1,1 +1,1 @@
-export async function processJob(id: string): Promise<void> {
+export async function processJob(id: string, opts: object): Promise<void> {
`;

const DIFF_CONST_ARROW = `diff --git a/src/util.ts b/src/util.ts
index 1111111..2222222 100644
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,1 +1,1 @@
-export const transform = (input: string): string => {
+export const transform = (input: string, flag: boolean): string => {
`;

const DIFF_NEW_FILE = `diff --git a/dev/null b/src/brand-new.ts
--- /dev/null
+++ b/src/brand-new.ts
@@ -0,0 +1,3 @@
+export function freshFunc(a: string): void {
+  return;
+}
`;

describe("parseChangedFiles", () => {
  it("extracts modified file paths from a multi-file diff", () => {
    const files = parseChangedFiles(DIFF_TOUCH_DOCKER);
    expect(files.has("src/integration/docker.ts")).toBe(true);
    expect(files.has("src/other.ts")).toBe(true);
    expect(files.size).toBe(2);
  });

  it("returns empty set for empty diff", () => {
    expect(parseChangedFiles("").size).toBe(0);
  });

  it("captures both old and new paths for a renamed file", () => {
    const files = parseChangedFiles(DIFF_RENAME);
    expect(files.has("src/old-name.ts")).toBe(true);
    expect(files.has("src/new-name.ts")).toBe(true);
  });

  it("captures a newly added file path (--- /dev/null header)", () => {
    const files = parseChangedFiles(DIFF_NEW_FILE);
    expect(files.has("src/brand-new.ts")).toBe(true);
    // /dev/null sentinel must not be included
    expect(files.has("/dev/null")).toBe(false);
  });
});

describe("detectFunctionSignatureChanges", () => {
  it("detects a removed function declaration line", () => {
    const changed = detectFunctionSignatureChanges(
      DIFF_SIG_CHANGE,
      "src/integration/docker.ts",
      ["generateComposeFile", "unrelated"]
    );
    expect(changed).toContain("generateComposeFile");
    expect(changed).not.toContain("unrelated");
  });

  it("ignores changes in other files", () => {
    const changed = detectFunctionSignatureChanges(
      DIFF_SIG_CHANGE,
      "src/agents/coder.ts",
      ["generateComposeFile"]
    );
    expect(changed).toEqual([]);
  });

  it("does not flag body-only edits that don't touch the declaration", () => {
    const changed = detectFunctionSignatureChanges(
      DIFF_TOUCH_DOCKER,
      "src/integration/docker.ts",
      ["generateComposeFile"]
    );
    expect(changed).toEqual([]);
  });

  it("detects an async function declaration change", () => {
    const changed = detectFunctionSignatureChanges(
      DIFF_ASYNC_FUNC,
      "src/worker.ts",
      ["processJob"]
    );
    expect(changed).toContain("processJob");
  });

  it("detects a const arrow function signature change", () => {
    const changed = detectFunctionSignatureChanges(
      DIFF_CONST_ARROW,
      "src/util.ts",
      ["transform"]
    );
    expect(changed).toContain("transform");
  });

  it("detects a function declaration in a newly added file (no diff --git header)", () => {
    const changed = detectFunctionSignatureChanges(
      DIFF_NEW_FILE,
      "src/brand-new.ts",
      ["freshFunc"]
    );
    expect(changed).toContain("freshFunc");
  });

  it("does not match a call site that looks like a function name", () => {
    const callSiteDiff = `diff --git a/src/caller.ts b/src/caller.ts
index 1111111..2222222 100644
--- a/src/caller.ts
+++ b/src/caller.ts
@@ -1,1 +1,1 @@
-  someObj.transform(input);
+  someObj.transform(input, true);
`;
    const changed = detectFunctionSignatureChanges(callSiteDiff, "src/caller.ts", ["transform"]);
    expect(changed).toEqual([]);
  });

  it("returns each changed function name only once even if multiple diff lines match", () => {
    const multiLineDiff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-export function myFn(a: string): void {
+export function myFn(a: string, b: number): void {
`;
    const changed = detectFunctionSignatureChanges(multiLineDiff, "src/foo.ts", ["myFn"]);
    expect(changed.filter((n) => n === "myFn")).toHaveLength(1);
  });
});

describe("checkProtectedFiles", () => {
  it("emits a warning when a protected file is touched", () => {
    const result = checkProtectedFiles(DIFF_TOUCH_DOCKER, {
      protectedFiles: ["src/integration/docker.ts"],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].file).toBe("src/integration/docker.ts");
    expect(result.blocks).toHaveLength(0);
  });

  it("includes the file path in the warning message", () => {
    const result = checkProtectedFiles(DIFF_TOUCH_DOCKER, {
      protectedFiles: ["src/integration/docker.ts"],
    });
    expect(result.warnings[0].message).toContain("src/integration/docker.ts");
  });

  it("emits a block when a protected function signature changes", () => {
    const result = checkProtectedFiles(DIFF_SIG_CHANGE, {
      protectedFunctions: {
        "src/integration/docker.ts": ["generateComposeFile"],
      },
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].function).toBe("generateComposeFile");
    expect(result.blocks[0].file).toBe("src/integration/docker.ts");
  });

  it("includes function name and file in the block message", () => {
    const result = checkProtectedFiles(DIFF_SIG_CHANGE, {
      protectedFunctions: {
        "src/integration/docker.ts": ["generateComposeFile"],
      },
    });
    expect(result.blocks[0].message).toContain("generateComposeFile");
    expect(result.blocks[0].message).toContain("src/integration/docker.ts");
  });

  it("emits both a warning and a block when file is protected and signature changes", () => {
    const result = checkProtectedFiles(DIFF_SIG_CHANGE, {
      protectedFiles: ["src/integration/docker.ts"],
      protectedFunctions: {
        "src/integration/docker.ts": ["generateComposeFile"],
      },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.blocks).toHaveLength(1);
  });

  it("returns empty results when no protected entries match", () => {
    const result = checkProtectedFiles(DIFF_TOUCH_DOCKER, {
      protectedFiles: ["src/never-touched.ts"],
      protectedFunctions: { "src/never-touched.ts": ["foo"] },
    });
    expect(result.warnings).toEqual([]);
    expect(result.blocks).toEqual([]);
  });

  it("returns empty results when config is empty", () => {
    const result = checkProtectedFiles(DIFF_TOUCH_DOCKER, {});
    expect(result.warnings).toEqual([]);
    expect(result.blocks).toEqual([]);
  });
});
