import { describe, it, expect } from "vitest";
import { extractExecError, extractExecOutput } from "./exec-error.js";
import type { ExecError } from "./exec-error.js";

// ---------------------------------------------------------------------------
// extractExecError
// ---------------------------------------------------------------------------

describe("extractExecError", () => {
  describe("when the error is an object with stderr", () => {
    it("converts a Buffer stderr to string", () => {
      const err = { stderr: Buffer.from("type error in foo.ts") };
      const result = extractExecError(err);
      expect(result.stderr).toBe("type error in foo.ts");
    });

    it("keeps a string stderr as-is", () => {
      const err = { stderr: "compilation failed" };
      const result = extractExecError(err);
      expect(result.stderr).toBe("compilation failed");
    });
  });

  describe("when the error is an object with stdout", () => {
    it("converts a Buffer stdout to string", () => {
      const err = { stdout: Buffer.from("test output") };
      const result = extractExecError(err);
      expect(result.stdout).toBe("test output");
    });

    it("keeps a string stdout as-is", () => {
      const err = { stdout: "PASS src/foo.test.ts" };
      const result = extractExecError(err);
      expect(result.stdout).toBe("PASS src/foo.test.ts");
    });

    it("leaves stderr empty when only stdout is present", () => {
      const err = { stdout: "output" };
      const result = extractExecError(err);
      expect(result.stderr).toBe("");
    });
  });

  describe("exit code extraction", () => {
    it("uses status as the code", () => {
      const err = { status: 1, stderr: "err" };
      const result = extractExecError(err);
      expect(result.code).toBe(1);
    });

    it("falls back to code when status is absent", () => {
      const err = { code: 2, stderr: "err" };
      const result = extractExecError(err);
      expect(result.code).toBe(2);
    });

    it("prefers status over code when both are present", () => {
      const err = { status: 3, code: 127, stderr: "err" };
      const result = extractExecError(err);
      expect(result.code).toBe(3);
    });

    it("returns null when neither status nor code is present", () => {
      const err = { stderr: "err" };
      const result = extractExecError(err);
      expect(result.code).toBeNull();
    });
  });

  describe("message extraction", () => {
    it("uses the message property when present", () => {
      const err = new Error("spawn failed");
      const result = extractExecError(err);
      expect(result.message).toBe("spawn failed");
    });

    it("falls back to String(err) when message is absent", () => {
      const err = { stderr: "err" }; // no message property
      const result = extractExecError(err);
      expect(result.message).toBe("[object Object]");
    });
  });

  describe("when stderr and stdout are absent", () => {
    it("returns empty strings for both", () => {
      const err = new Error("oops");
      const result = extractExecError(err);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
    });
  });

  describe("non-object inputs", () => {
    it("handles a plain string throw", () => {
      const result = extractExecError("something went wrong");
      expect(result).toEqual<ExecError>({
        stderr: "",
        stdout: "",
        code: null,
        message: "something went wrong",
      });
    });

    it("handles a number throw", () => {
      const result = extractExecError(42);
      expect(result.message).toBe("42");
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      expect(result.code).toBeNull();
    });

    it("handles null", () => {
      const result = extractExecError(null);
      expect(result.message).toBe("null");
      expect(result.stderr).toBe("");
    });

    it("handles undefined", () => {
      const result = extractExecError(undefined);
      expect(result.message).toBe("undefined");
      expect(result.stderr).toBe("");
    });
  });

  describe("full execSync error shape (as thrown by Node.js)", () => {
    it("extracts all fields from a realistic execSync error", () => {
      const err = Object.assign(new Error("Command failed: npx tsc --noEmit"), {
        status: 2,
        stderr: Buffer.from("src/foo.ts(1,1): error TS2322: type mismatch"),
        stdout: Buffer.from(""),
      });

      const result = extractExecError(err);

      expect(result.stderr).toBe("src/foo.ts(1,1): error TS2322: type mismatch");
      expect(result.stdout).toBe("");
      expect(result.code).toBe(2);
      expect(result.message).toBe("Command failed: npx tsc --noEmit");
    });
  });
});

// ---------------------------------------------------------------------------
// extractExecOutput
// ---------------------------------------------------------------------------

describe("extractExecOutput", () => {
  it("returns stderr when present", () => {
    const err = { stderr: "stderr content", stdout: "stdout content", message: "msg" };
    expect(extractExecOutput(err)).toBe("stderr content");
  });

  it("falls back to stdout when stderr is empty", () => {
    const err = { stderr: "", stdout: "stdout content", message: "msg" };
    expect(extractExecOutput(err)).toBe("stdout content");
  });

  it("falls back to message when both stderr and stdout are empty", () => {
    const err = new Error("raw message");
    expect(extractExecOutput(err)).toBe("raw message");
  });

  it("returns the message for a plain string throw", () => {
    expect(extractExecOutput("boom")).toBe("boom");
  });

  it("returns the stringified form for a number throw", () => {
    expect(extractExecOutput(1)).toBe("1");
  });

  it("prefers non-empty stderr over non-empty stdout", () => {
    const err = {
      stderr: Buffer.from("compiler error"),
      stdout: Buffer.from("some output"),
    };
    expect(extractExecOutput(err)).toBe("compiler error");
  });

  it("handles a Buffer stderr correctly (returns string)", () => {
    const err = { stderr: Buffer.from("error line") };
    const output = extractExecOutput(err);
    expect(typeof output).toBe("string");
    expect(output).toBe("error line");
  });
});
