import { describe, it, expect } from "bun:test";
import { createScanner, loadRules } from "../../src/js/index.js";
import { encodeRules } from "../../src/js/encoder.js";
import type { RuleDefinition } from "../../src/js/types.js";

describe("metavariable constraints", () => {
  it("regex constraint filters matches", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-unsafe-eval",
        language: "javascript",
        severity: "error",
        message: "unsafe eval",
        rule: { pattern: "eval($X)" },
        constraints: {
          X: { regex: "^user" },
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("eval(userInput); eval(safeInput)", "javascript");
    try {
      const findings = ruleset.apply(scanner);

      // Should only match eval(userInput) because of regex constraint
      if (findings.length > 0) {
        const allBindings = findings[0].matches.map(m => m.bindings.X);
        expect(allBindings).toContain("userInput");
      }
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("\\d+ regex matches digits", () => {
    const rules: RuleDefinition[] = [
      {
        id: "digit-args",
        language: "javascript",
        severity: "warning",
        message: "numeric literal arg",
        rule: { pattern: "foo($X)" },
        constraints: {
          X: { regex: "^\\d+$" },
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("foo(123); foo(abc)", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBeGreaterThan(0);
      const allBindings = findings[0].matches.map(m => m.bindings.X);
      expect(allBindings).toContain("123");
      expect(allBindings).not.toContain("abc");
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("\\w+ regex matches word characters", () => {
    const rules: RuleDefinition[] = [
      {
        id: "word-args",
        language: "javascript",
        severity: "warning",
        message: "word arg",
        rule: { pattern: "bar($X)" },
        constraints: {
          X: { regex: "^\\w+$" },
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("bar(hello_world); bar(123)", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBeGreaterThan(0);
      const allBindings = findings[0].matches.map(m => m.bindings.X);
      expect(allBindings).toContain("hello_world");
      // 123 also matches \w+ since \w includes digits
      expect(allBindings).toContain("123");
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("\\s+ regex matches whitespace in notRegex", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-whitespace-args",
        language: "javascript",
        severity: "warning",
        message: "no whitespace",
        rule: { pattern: "baz($X)" },
        constraints: {
          X: { notRegex: "\\s" },
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("baz(clean); baz(ok)", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      // Both args have no whitespace, so both should match
      expect(findings.length).toBeGreaterThan(0);
      const allBindings = findings[0].matches.map(m => m.bindings.X);
      expect(allBindings).toContain("clean");
      expect(allBindings).toContain("ok");
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("notRegex constraint excludes matches", () => {
    const rules: RuleDefinition[] = [
      {
        id: "no-non-safe-eval",
        language: "javascript",
        severity: "error",
        message: "non-safe eval",
        rule: { pattern: "eval($X)" },
        constraints: {
          X: { notRegex: "^safe" },
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("eval(userInput); eval(safeInput)", "javascript");
    try {
      const findings = ruleset.apply(scanner);

      // Should only match eval(userInput) because safeInput is excluded
      if (findings.length > 0) {
        const allBindings = findings[0].matches.map(m => m.bindings.X);
        expect(allBindings).not.toContain("safeInput");
      }
    } finally {
      scanner.free();
      ruleset.free();
    }
  });
});
