import { describe, it, expect } from "bun:test";
import { createScanner, loadRules } from "../../src/js/index.js";
import { encodeRules } from "../../src/js/encoder.js";
import type { RuleDefinition } from "../../src/js/types.js";

describe("rule engine end-to-end", () => {
  it("encodes and applies a simple pattern rule", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-eval",
        language: "javascript",
        severity: "error",
        message: "eval is dangerous",
        rule: { pattern: "eval($X)" },
      },
    ];

    const bytecode = encodeRules(rules);
    expect(bytecode.length).toBeGreaterThan(0);

    const ruleset = loadRules(bytecode);
    const scanner = createScanner("eval(userInput); console.log('safe')", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].ruleId).toBe("no-eval");
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toBe("eval is dangerous");
      expect(findings[0].matches.length).toBeGreaterThanOrEqual(1);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("applies multiple rules at once", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-eval",
        language: "javascript",
        severity: "error",
        message: "eval is dangerous",
        rule: { pattern: "eval($X)" },
      },
      {
        id: "no-settimeout",
        language: "javascript",
        severity: "warning",
        message: "setTimeout is discouraged",
        rule: { pattern: "setTimeout($FN, $MS)" },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("eval(x); setTimeout(fn, 0)", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBe(2);
      const ids = findings.map(f => f.ruleId);
      expect(ids).toContain("no-eval");
      expect(ids).toContain("no-settimeout");
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("returns empty for no matches", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-eval",
        language: "javascript",
        severity: "error",
        message: "eval is dangerous",
        rule: { pattern: "eval($X)" },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("console.log('safe')", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      expect(findings).toHaveLength(0);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("regex matches comment content (TODO)", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-todo",
        language: "javascript",
        severity: "warning",
        message: "TODO comment found",
        rule: { regex: "TODO" },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner(
      "// TODO: fix this\nconst x = 1; /* FIXME */",
      "javascript"
    );
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBe(1);
      expect(findings[0].matches.length).toBeGreaterThanOrEqual(1);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("all + kind comment + inside: comment inside exported function", () => {
    const rules: RuleDefinition[] = [
      {
        id: "comment-in-export",
        language: "javascript",
        severity: "warning",
        message: "comment in exported function",
        rule: {
          all: [
            { kind: "comment" },
            { inside: { kind: "export_statement" } },
          ],
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner(
      "export function foo() { /* TODO */ } function bar() { /* TODO */ }",
      "javascript"
    );
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBe(1);
      // Only the comment inside export_statement should match
      expect(findings[0].matches.length).toBe(1);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("memory safety: 50-iteration rule application", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-eval",
        language: "javascript",
        severity: "error",
        message: "eval is dangerous",
        rule: { pattern: "eval($X)" },
      },
    ];

    const bytecode = encodeRules(rules);

    for (let i = 0; i < 50; i++) {
      const ruleset = loadRules(bytecode);
      const scanner = createScanner("eval(x)", "javascript");
      try {
        const findings = ruleset.apply(scanner);
        expect(findings.length).toBeGreaterThanOrEqual(1);
      } finally {
        scanner.free();
        ruleset.free();
      }
    }
  });
});
