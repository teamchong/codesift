import { describe, it, expect } from "bun:test";
import { structMatch, compilePattern, matchPattern, freePattern, createScanner, type Match, type RichMatch } from "../../src/js/index.js";

describe("structMatch()", () => {
  it("finds eval($X) pattern in source", () => {
    const matches = structMatch("eval($X)", "eval(userInput)", "javascript");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].bindings.X).toBe("userInput");
    // Verify byte offsets are present
    expect(matches[0].start_byte).toBeDefined();
    expect(matches[0].end_byte).toBeDefined();
    expect(typeof matches[0].start_byte).toBe("number");
    expect(typeof matches[0].end_byte).toBe("number");
    expect(matches[0].end_byte).toBeGreaterThan(matches[0].start_byte);
  });

  it("finds nested matches", () => {
    const matches = structMatch(
      "eval($X)",
      "function foo() { eval(dangerous); }",
      "javascript",
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.bindings.X === "dangerous")).toBe(true);
  });

  it("returns no matches for non-matching pattern", () => {
    const matches = structMatch(
      "eval($X)",
      "console.log('hello')",
      "javascript",
    );
    expect(matches).toHaveLength(0);
  });

  it("captures metavariables in member expression", () => {
    const matches = structMatch(
      "$OBJ.$METHOD($ARG)",
      "obj.method(arg)",
      "javascript",
    );
    expect(matches.length).toBeGreaterThan(0);
    const m = matches[0];
    expect(m.bindings.OBJ).toBe("obj");
    expect(m.bindings.METHOD).toBe("method");
    expect(m.bindings.ARG).toBe("arg");
  });

  it("enforces metavariable unification", () => {
    // foo($X, $X) should match foo(a, a) but NOT foo(a, b)
    const good = structMatch("foo($X, $X)", "foo(a, a)", "javascript");
    expect(good.length).toBeGreaterThan(0);

    const bad = structMatch("foo($X, $X)", "foo(a, b)", "javascript");
    expect(bad).toHaveLength(0);
  });

  it("works with TypeScript", () => {
    const matches = structMatch(
      "eval($X)",
      "const x: string = eval(input)",
      "typescript",
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it("returns empty for unsupported language", () => {
    const matches = structMatch("eval($X)", "eval(x)", "python");
    expect(matches).toHaveLength(0);
  });

  it("handles empty pattern gracefully", () => {
    const matches = structMatch("", "eval(x)", "javascript");
    expect(matches).toHaveLength(0);
  });

  it("handles empty source gracefully", () => {
    const matches = structMatch("eval($X)", "", "javascript");
    expect(matches).toHaveLength(0);
  });

  it("runs 100 sequential matches without memory leak", () => {
    for (let i = 0; i < 100; i++) {
      const matches = structMatch("eval($X)", "eval(x)", "javascript");
      expect(matches.length).toBeGreaterThan(0);
    }
  });
});

describe("compilePattern / matchPattern / freePattern", () => {
  it("compiles a pattern and matches against source", () => {
    const handle = compilePattern("eval($X)", "javascript");
    expect(handle).toBeGreaterThan(0);

    const matches = matchPattern(handle, "eval(userInput)");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].bindings.X).toBe("userInput");

    freePattern(handle);
  });

  it("reuses compiled pattern across multiple sources", () => {
    const handle = compilePattern("$OBJ.$METHOD($ARG)", "javascript");
    expect(handle).toBeGreaterThan(0);

    const m1 = matchPattern(handle, "foo.bar(1)");
    expect(m1.length).toBeGreaterThan(0);

    const m2 = matchPattern(handle, "console.log('hello')");
    expect(m2.length).toBeGreaterThan(0);

    const m3 = matchPattern(handle, "42");
    expect(m3).toHaveLength(0);

    freePattern(handle);
  });

  it("runs 100 matches with compiled pattern without memory leak", () => {
    const handle = compilePattern("eval($X)", "javascript");
    expect(handle).toBeGreaterThan(0);

    for (let i = 0; i < 100; i++) {
      const matches = matchPattern(handle, "eval(x)");
      expect(matches.length).toBeGreaterThan(0);
    }

    freePattern(handle);
  });

  it("returns 0 for unsupported language", () => {
    const handle = compilePattern("eval($X)", "python");
    expect(handle).toBe(0);
  });

  it("matchPattern returns empty for invalid handle", () => {
    const matches = matchPattern(0, "eval(x)");
    expect(matches).toHaveLength(0);

    const matches2 = matchPattern(999, "eval(x)");
    expect(matches2).toHaveLength(0);
  });

  it("freePattern is safe to call on invalid handle", () => {
    freePattern(0);
    freePattern(999);
  });

  it("can compile multiple patterns simultaneously", () => {
    const h1 = compilePattern("eval($X)", "javascript");
    const h2 = compilePattern("$OBJ.$METHOD($ARG)", "javascript");
    expect(h1).toBeGreaterThan(0);
    expect(h2).toBeGreaterThan(0);
    expect(h1).not.toBe(h2);

    const m1 = matchPattern(h1, "eval(x)");
    expect(m1.length).toBeGreaterThan(0);

    const m2 = matchPattern(h2, "foo.bar(1)");
    expect(m2.length).toBeGreaterThan(0);

    freePattern(h1);
    freePattern(h2);
  });
});

describe("createScanner()", () => {
  it("matches multiple patterns against same source", () => {
    const s = createScanner("eval(x); setTimeout(fn, 100)", "javascript");

    const m1 = s.match("eval($X)");
    expect(m1.length).toBeGreaterThan(0);
    expect(m1[0].bindings.X).toBe("x");

    const m2 = s.match("setTimeout($FN, $MS)");
    expect(m2.length).toBeGreaterThan(0);

    s.free();
  });

  it("returns empty after free", () => {
    const s = createScanner("eval(x)", "javascript");
    s.free();
    const m = s.match("eval($X)");
    expect(m).toHaveLength(0);
  });

  it("free is safe to call multiple times", () => {
    const s = createScanner("eval(x)", "javascript");
    s.free();
    s.free();
  });

  it("handles unsupported language", () => {
    const s = createScanner("eval(x)", "python");
    const m = s.match("eval($X)");
    expect(m).toHaveLength(0);
    s.free();
  });

  it("runs 100 patterns against same source without leak", () => {
    const s = createScanner("eval(x); foo.bar(1); setTimeout(fn, 0)", "javascript");
    for (let i = 0; i < 100; i++) {
      const m = s.match("eval($X)");
      expect(m.length).toBeGreaterThan(0);
    }
    s.free();
  });

  it("exposes source and language properties", () => {
    const s = createScanner("eval(x)", "javascript");
    expect(s.source).toBe("eval(x)");
    expect(s.language).toBe("javascript");
    s.free();
  });
});

// ── scanAll + RichMatch ───────────────────────────────────

describe("scanner.scanAll()", () => {
  it("returns RichMatch with pattern and matched text", () => {
    const src = "eval(userInput)";
    const s = createScanner(src, "javascript");

    const results = s.scanAll(["eval($X)"]);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const r = results[0];
    expect(r.pattern).toBe("eval($X)");
    expect(r.text).toBe("eval(userInput)");
    expect(r.bindings.X).toBe("userInput");
    expect(r.start_row).toBe(0);
    expect(r.start_col).toBe(0);

    s.free();
  });

  it("batches multiple patterns into one result array", () => {
    const src = "eval(x); setTimeout(fn, 100)";
    const s = createScanner(src, "javascript");

    const results = s.scanAll(["eval($X)", "setTimeout($FN, $MS)"]);

    // Should have matches from both patterns
    const evalMatches = results.filter((r) => r.pattern === "eval($X)");
    const timerMatches = results.filter((r) => r.pattern === "setTimeout($FN, $MS)");

    expect(evalMatches.length).toBeGreaterThanOrEqual(1);
    expect(timerMatches.length).toBeGreaterThanOrEqual(1);

    // Verify text extraction (engine may match expression_statement including ";")
    expect(evalMatches[0].text).toContain("eval(x)");
    expect(evalMatches[0].bindings.X).toBe("x");
    expect(timerMatches[0].text).toContain("setTimeout(fn, 100)");

    s.free();
  });

  it("extracts multi-line matched text correctly", () => {
    const src = "eval(\n  userInput\n)";
    const s = createScanner(src, "javascript");

    const results = s.scanAll(["eval($X)"]);
    expect(results.length).toBeGreaterThanOrEqual(1);

    // The match should span multiple lines
    const r = results[0];
    expect(r.text).toContain("eval(");
    expect(r.text).toContain("userInput");

    s.free();
  });

  it("returns empty array for no matches", () => {
    const s = createScanner("const x = 1", "javascript");
    const results = s.scanAll(["eval($X)"]);
    expect(results).toHaveLength(0);
    s.free();
  });

  it("returns empty array for empty patterns list", () => {
    const s = createScanner("eval(x)", "javascript");
    const results = s.scanAll([]);
    expect(results).toHaveLength(0);
    s.free();
  });

  it("works after free (returns empty)", () => {
    const s = createScanner("eval(x)", "javascript");
    s.free();
    const results = s.scanAll(["eval($X)"]);
    expect(results).toHaveLength(0);
  });

  it("handles unsupported language gracefully", () => {
    const s = createScanner("eval(x)", "python");
    const results = s.scanAll(["eval($X)"]);
    expect(results).toHaveLength(0);
    s.free();
  });

  it("agent-style rule set scan with 10 patterns", () => {
    const src = `
      eval(userInput);
      new Function(code);
      setTimeout(fn, 0);
      setInterval(tick, 1000);
      console.log("debug");
    `;

    const patterns = [
      "eval($X)",
      "new Function($X)",
      "setTimeout($FN, $MS)",
      "setInterval($FN, $MS)",
      "console.log($X)",
    ];

    const s = createScanner(src, "javascript");
    const results = s.scanAll(patterns);

    // Each pattern should have at least one match
    for (const pat of patterns) {
      const hits = results.filter((r) => r.pattern === pat);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      // Every RichMatch should have non-empty text
      for (const h of hits) {
        expect(h.text.length).toBeGreaterThan(0);
      }
    }

    s.free();
  });
});
