/**
 * Tests for:
 *   src/prompts/claude-md-generator.ts
 *   src/prompts/discovery.ts
 *   src/prompts/spec-extractor.ts
 *
 * All functions here are pure (no I/O, no side-effects) so no mocks are needed.
 */

import { describe, it, expect } from "vitest";
import {
  CLAUDE_MD_GENERATOR_SYSTEM_PROMPT,
  buildClaudeMdGeneratorPrompt,
} from "../prompts/claude-md-generator.js";
import {
  DISCOVERY_SYSTEM_PROMPT,
  buildDiscoveryPrompt,
} from "../prompts/discovery.js";
import {
  SPEC_EXTRACTOR_SYSTEM_PROMPT,
  buildSpecExtractorPrompt,
} from "../prompts/spec-extractor.js";
import type { ProjectSpec } from "../new-project/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_SPEC: ProjectSpec = {
  name: "my-app",
  displayName: "My App",
  description: "A minimal test project",
  githubOrg: "acme",
  platform: "web",
  framework: "next",
  language: "typescript",
  darkMode: false,
};

// ---------------------------------------------------------------------------
// CLAUDE_MD_GENERATOR_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("CLAUDE_MD_GENERATOR_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof CLAUDE_MD_GENERATOR_SYSTEM_PROMPT).toBe("string");
    expect(CLAUDE_MD_GENERATOR_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("instructs agent to output only CLAUDE.md content (no fences, no preamble)", () => {
    expect(CLAUDE_MD_GENERATOR_SYSTEM_PROMPT).toContain("Output ONLY the CLAUDE.md markdown content");
  });

  it("covers the expected CLAUDE.md sections", () => {
    expect(CLAUDE_MD_GENERATOR_SYSTEM_PROMPT).toContain("project overview");
    expect(CLAUDE_MD_GENERATOR_SYSTEM_PROMPT).toContain("stack");
    expect(CLAUDE_MD_GENERATOR_SYSTEM_PROMPT).toContain("commands");
  });

  it("mentions impeccable design tool instructions", () => {
    expect(CLAUDE_MD_GENERATOR_SYSTEM_PROMPT).toContain("impeccable");
  });
});

// ---------------------------------------------------------------------------
// buildClaudeMdGeneratorPrompt
// ---------------------------------------------------------------------------

describe("buildClaudeMdGeneratorPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildClaudeMdGeneratorPrompt(MINIMAL_SPEC);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("embeds the spec as a JSON code block", () => {
    const prompt = buildClaudeMdGeneratorPrompt(MINIMAL_SPEC);
    expect(prompt).toContain("```json");
    expect(prompt).toContain(JSON.stringify(MINIMAL_SPEC, null, 2));
  });

  it("includes all spec fields in the JSON output", () => {
    const prompt = buildClaudeMdGeneratorPrompt(MINIMAL_SPEC);
    expect(prompt).toContain('"name": "my-app"');
    expect(prompt).toContain('"githubOrg": "acme"');
    expect(prompt).toContain('"framework": "next"');
  });

  it("asks agent to output only CLAUDE.md contents", () => {
    const prompt = buildClaudeMdGeneratorPrompt(MINIMAL_SPEC);
    expect(prompt).toContain("Output only the CLAUDE.md contents");
  });

  it("includes optional spec fields when present", () => {
    const spec: ProjectSpec = {
      ...MINIMAL_SPEC,
      backend: "supabase",
      styling: "tailwind",
      testing: { unit: "vitest", e2e: "playwright" },
    };
    const prompt = buildClaudeMdGeneratorPrompt(spec);
    expect(prompt).toContain('"backend": "supabase"');
    expect(prompt).toContain('"styling": "tailwind"');
    expect(prompt).toContain('"vitest"');
  });
});

// ---------------------------------------------------------------------------
// DISCOVERY_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("DISCOVERY_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof DISCOVERY_SYSTEM_PROMPT).toBe("string");
    expect(DISCOVERY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("lists all required ProjectSpec fields", () => {
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("name");
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("githubOrg");
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("platform");
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("framework");
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("language");
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("darkMode");
  });

  it("specifies that output must be a single JSON code block", () => {
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("JSON code block");
  });

  it("defaults language to typescript and darkMode to false", () => {
    expect(DISCOVERY_SYSTEM_PROMPT).toContain('"typescript"');
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("false");
  });

  it("instructs agent to leave githubOrg empty when not provided", () => {
    // The CLI can override it via --org
    expect(DISCOVERY_SYSTEM_PROMPT).toContain('""');
    expect(DISCOVERY_SYSTEM_PROMPT).toContain("--org");
  });
});

// ---------------------------------------------------------------------------
// buildDiscoveryPrompt
// ---------------------------------------------------------------------------

describe("buildDiscoveryPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildDiscoveryPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("mentions --file flag for providing a spec file", () => {
    expect(buildDiscoveryPrompt()).toContain("--file");
  });

  it("instructs output inside a fenced json code block", () => {
    const prompt = buildDiscoveryPrompt();
    expect(prompt).toContain("```json");
  });

  it("mentions TypeScript as the fallback skeleton language", () => {
    expect(buildDiscoveryPrompt()).toContain("TypeScript");
  });
});

// ---------------------------------------------------------------------------
// SPEC_EXTRACTOR_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe("SPEC_EXTRACTOR_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SPEC_EXTRACTOR_SYSTEM_PROMPT).toBe("string");
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("includes the ProjectSpec shape", () => {
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain('"name"');
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain('"framework"');
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain('"platform"');
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain('"darkMode"');
  });

  it("instructs agent to output only a fenced JSON code block", () => {
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain("```json");
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain("no prose");
  });

  it("defaults darkMode to false and language to typescript", () => {
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain("false");
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain('"typescript"');
  });

  it("instructs agent to use kebab-case for name", () => {
    expect(SPEC_EXTRACTOR_SYSTEM_PROMPT).toContain("kebab-case");
  });
});

// ---------------------------------------------------------------------------
// buildSpecExtractorPrompt
// ---------------------------------------------------------------------------

describe("buildSpecExtractorPrompt", () => {
  const FILE_PATH = "/home/user/specs/camplist.md";
  const FILE_CONTENT = "# Camplist\n\nA mobile app for managing camping trips.\n";

  it("returns a non-empty string", () => {
    const prompt = buildSpecExtractorPrompt(FILE_CONTENT, FILE_PATH);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("embeds the file path in the prompt", () => {
    const prompt = buildSpecExtractorPrompt(FILE_CONTENT, FILE_PATH);
    expect(prompt).toContain(FILE_PATH);
  });

  it("embeds the full file content between delimiters", () => {
    const prompt = buildSpecExtractorPrompt(FILE_CONTENT, FILE_PATH);
    expect(prompt).toContain(FILE_CONTENT);
    expect(prompt).toContain("BEGIN SPEC FILE");
    expect(prompt).toContain("END SPEC FILE");
  });

  it("asks for output as a fenced json code block", () => {
    const prompt = buildSpecExtractorPrompt(FILE_CONTENT, FILE_PATH);
    expect(prompt).toContain("```json");
  });

  it("content appears between the delimiters", () => {
    const prompt = buildSpecExtractorPrompt(FILE_CONTENT, FILE_PATH);
    const beginIdx = prompt.indexOf("BEGIN SPEC FILE");
    const endIdx = prompt.indexOf("END SPEC FILE");
    const contentIdx = prompt.indexOf(FILE_CONTENT);
    expect(beginIdx).toBeLessThan(contentIdx);
    expect(contentIdx).toBeLessThan(endIdx);
  });
});
