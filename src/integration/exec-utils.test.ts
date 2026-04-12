/**
 * Tests for src/integration/exec-utils.ts
 *
 * Covers getExecOutput priority: stderr → stdout → message → String() fallback.
 */

import { describe, it, expect } from "vitest";
import { getExecOutput } from "./exec-utils.js";

describe("getExecOutput", () => {
  it("returns stderr.toString() when stderr is a Buffer", () => {
    const err = { stderr: Buffer.from("stderr content") };
    expect(getExecOutput(err)).toBe("stderr content");
  });

  it("returns stderr when it is already a string", () => {
    const err = { stderr: "stderr string" };
    expect(getExecOutput(err)).toBe("stderr string");
  });

  it("returns stdout when stderr is absent", () => {
    const err = { stdout: Buffer.from("stdout content") };
    expect(getExecOutput(err)).toBe("stdout content");
  });

  it("prefers stderr over stdout when both are present", () => {
    const err = { stderr: Buffer.from("stderr wins"), stdout: Buffer.from("stdout loses") };
    expect(getExecOutput(err)).toBe("stderr wins");
  });

  it("returns message when neither stderr nor stdout is present", () => {
    const err = new Error("plain message");
    expect(getExecOutput(err)).toBe("plain message");
  });

  it("returns String(err) for a primitive string", () => {
    expect(getExecOutput("raw string error")).toBe("raw string error");
  });

  it("returns String(err) for a number", () => {
    expect(getExecOutput(42)).toBe("42");
  });

  it("returns 'null' for null", () => {
    expect(getExecOutput(null)).toBe("null");
  });

  it("returns 'undefined' for undefined", () => {
    expect(getExecOutput(undefined)).toBe("undefined");
  });

  it("returns empty string when stderr is an empty Buffer (Buffer is always truthy)", () => {
    // A Buffer object is truthy even when empty, so getExecOutput returns "" and
    // does NOT fall through to stdout. This documents the actual behavior.
    const err = { stderr: Buffer.from(""), stdout: Buffer.from("fallback stdout") };
    expect(getExecOutput(err)).toBe("");
  });
});
