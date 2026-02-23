import { describe, it, expect } from "bun:test";
import { createScanner, loadRules } from "../../src/js/index.js";
import { encodeRules } from "../../src/js/encoder.js";
import type { RuleDefinition } from "../../src/js/types.js";

describe("relational rules", () => {
  it("kind rule matches node types", () => {
    const rules: RuleDefinition[] = [
      {
        id: "find-ifs",
        language: "javascript",
        severity: "info",
        message: "found if statement",
        rule: { kind: "if_statement" },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("if (a) {} if (b) {} while (c) {}", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBe(1);
      expect(findings[0].matches.length).toBe(2);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("any rule matches multiple patterns", () => {
    const rules: RuleDefinition[] = [
      {
        id: "dangerous-functions",
        language: "javascript",
        severity: "error",
        message: "dangerous function call",
        rule: {
          any: [
            { pattern: "eval($X)" },
            { pattern: "new Function($X)" },
          ],
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner("eval(x); new Function(code); console.log(y)", "javascript");
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].matches.length).toBeGreaterThanOrEqual(2);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("inside: eval inside try_statement matches", () => {
    const rules: RuleDefinition[] = [
      {
        id: "eval-in-try",
        language: "javascript",
        severity: "info",
        message: "eval inside try",
        rule: {
          all: [
            { pattern: "eval($X)" },
            { inside: { kind: "try_statement" } },
          ],
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    // Use assignment context so expression_statement wrapping doesn't double-match
    const scanner = createScanner(
      "try { var r = eval(x); } catch(e) {} var s = eval(y);",
      "javascript"
    );
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBe(1);
      // Only eval(x) is inside try, not eval(y)
      expect(findings[0].matches.length).toBe(1);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("not inside: eval NOT inside try_statement", () => {
    const rules: RuleDefinition[] = [
      {
        id: "eval-outside-try",
        language: "javascript",
        severity: "warning",
        message: "eval outside try",
        rule: {
          all: [
            { pattern: "eval($X)" },
            { not: { inside: { kind: "try_statement" } } },
          ],
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    // Use assignment context so expression_statement wrapping doesn't double-match
    const scanner = createScanner(
      "try { var r = eval(x); } catch(e) {} var s = eval(y);",
      "javascript"
    );
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBe(1);
      // Only eval(y) is outside try
      expect(findings[0].matches.length).toBe(1);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("has: function containing eval", () => {
    const rules: RuleDefinition[] = [
      {
        id: "func-with-eval",
        language: "javascript",
        severity: "error",
        message: "function contains eval",
        rule: {
          all: [
            { kind: "function_declaration" },
            { has: { pattern: "eval($X)" } },
          ],
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner(
      "function foo() { eval(x); } function bar() { console.log(1); }",
      "javascript"
    );
    try {
      const findings = ruleset.apply(scanner);
      expect(findings.length).toBe(1);
      // Only foo contains eval
      expect(findings[0].matches.length).toBe(1);
    } finally {
      scanner.free();
      ruleset.free();
    }
  });

  it("follows: eval after import", () => {
    const rules: RuleDefinition[] = [
      {
        id: "eval-after-import",
        language: "javascript",
        severity: "info",
        message: "eval follows import",
        rule: {
          all: [
            { pattern: "eval($X)" },
            { follows: { kind: "import_statement" } },
          ],
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner(
      'import "mod"; eval(x);',
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

  it("precedes: statement before return", () => {
    const rules: RuleDefinition[] = [
      {
        id: "before-return",
        language: "javascript",
        severity: "info",
        message: "statement precedes return",
        rule: {
          all: [
            { pattern: "eval($X)" },
            { precedes: { kind: "return_statement" } },
          ],
        },
      },
    ];

    const bytecode = encodeRules(rules);
    const ruleset = loadRules(bytecode);
    const scanner = createScanner(
      "function f() { eval(x); return 1; }",
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
});
