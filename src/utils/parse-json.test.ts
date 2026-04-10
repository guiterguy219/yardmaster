import { describe, it, expect } from "vitest";
import { parseAgentJson } from "./parse-json.js";

describe("parseAgentJson", () => {
  it("parses clean JSON objects", () => {
    const result = parseAgentJson<{ verdict: string }>('{"verdict":"pass"}');
    expect(result).toEqual({ verdict: "pass" });
  });

  it("parses clean JSON arrays", () => {
    const result = parseAgentJson<number[]>("[1,2,3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses JSON in a fenced block with language tag", () => {
    const text = "```json\n{\"verdict\":\"fail\",\"issues\":[]}\n```";
    const result = parseAgentJson<{ verdict: string; issues: unknown[] }>(text);
    expect(result).toEqual({ verdict: "fail", issues: [] });
  });

  it("parses JSON in a fenced block without language tag", () => {
    const text = "```\n{\"key\":\"value\"}\n```";
    const result = parseAgentJson<{ key: string }>(text);
    expect(result).toEqual({ key: "value" });
  });

  it("parses JSON preceded and followed by prose when fenced", () => {
    const text = "Here is the output:\n```json\n{\"score\":42}\n```\nEnd.";
    const result = parseAgentJson<{ score: number }>(text);
    expect(result).toEqual({ score: 42 });
  });

  it("returns null for plain text (non-JSON)", () => {
    expect(parseAgentJson("This is just a sentence.")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAgentJson("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseAgentJson("   \n  ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseAgentJson("{not valid json}")).toBeNull();
  });

  it("returns null for fenced block containing non-JSON", () => {
    const text = "```\nsome plain text\n```";
    expect(parseAgentJson(text)).toBeNull();
  });

  it("handles JSON with extra whitespace", () => {
    const result = parseAgentJson<{ a: number }>("  { \"a\": 1 }  ");
    expect(result).toEqual({ a: 1 });
  });
});
