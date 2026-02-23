import { describe, it, expect } from "bun:test";
import { createScanner } from "../../src/js/index.js";

describe("Scanner.matchKind()", () => {
  it("finds all call_expression nodes", () => {
    const s = createScanner("eval(x); foo(y); bar(z)", "javascript");
    const matches = s.matchKind("call_expression");
    expect(matches.length).toBeGreaterThanOrEqual(3);
    s.free();
  });

  it("finds if_statement nodes", () => {
    const s = createScanner("if (a) { } if (b) { } while (c) { }", "javascript");
    const matches = s.matchKind("if_statement");
    expect(matches.length).toBe(2);
    s.free();
  });

  it("returns empty for non-existent kind", () => {
    const s = createScanner("const x = 1", "javascript");
    const matches = s.matchKind("nonexistent_node_type");
    expect(matches).toHaveLength(0);
    s.free();
  });

  it("returns empty after free", () => {
    const s = createScanner("eval(x)", "javascript");
    s.free();
    const matches = s.matchKind("call_expression");
    expect(matches).toHaveLength(0);
  });

  it("includes byte offsets", () => {
    const s = createScanner("eval(x)", "javascript");
    const matches = s.matchKind("call_expression");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].start_byte).toBeDefined();
    expect(matches[0].end_byte).toBeDefined();
    expect(matches[0].end_byte).toBeGreaterThan(matches[0].start_byte);
    s.free();
  });
});
