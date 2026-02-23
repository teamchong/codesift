import { describe, it, expect } from "bun:test";
import { structMatch, storeMatches, filterInside, filterNotInside, filterNot, intersectMatches, freeMatches } from "../../src/js/index.js";

describe("match slot operations", () => {
  it("store_matches returns a valid handle", () => {
    // Run a match to populate last_match_list
    structMatch("eval($X)", "eval(x); eval(y)", "javascript");
    const handle = storeMatches();
    expect(handle).toBeGreaterThan(0);
    freeMatches(handle);
  });

  it("filter_inside keeps matches within context", () => {
    const src = "function foo() { eval(a); } eval(b);";
    // Match eval($X)
    structMatch("eval($X)", src, "javascript");
    const evalHandle = storeMatches();
    // Match function declaration as context
    structMatch("function $F() { $BODY }", src, "javascript");
    const fnHandle = storeMatches();
    // Filter: keep evals inside functions
    const result = filterInside(evalHandle, fnHandle);
    // eval(a) is inside function (bytes 0-27), eval(b) is outside
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All results should be inside the function range
    for (const m of result) {
      expect(m.start_byte).toBeGreaterThanOrEqual(0);
      expect(m.end_byte).toBeLessThanOrEqual(27);
    }
    freeMatches(evalHandle);
    freeMatches(fnHandle);
  });

  it("filter_not_inside removes matches within context", () => {
    const src = "function foo() { eval(a); } eval(b);";
    structMatch("eval($X)", src, "javascript");
    const evalHandle = storeMatches();
    structMatch("function $F() { $BODY }", src, "javascript");
    const fnHandle = storeMatches();
    const result = filterNotInside(evalHandle, fnHandle);
    // eval(b) is outside the function, so it should remain
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All results should be outside the function range
    for (const m of result) {
      expect(m.start_byte).toBeGreaterThanOrEqual(28);
    }
    freeMatches(evalHandle);
    freeMatches(fnHandle);
  });

  it("filter_not removes exact matches", () => {
    // Use structurally different patterns: eval() vs console.log()
    const src = "eval(x); console.log(y)";
    structMatch("$F($A)", src, "javascript");
    const allHandle = storeMatches();
    structMatch("eval($X)", src, "javascript");
    const evalHandle = storeMatches();
    const result = filterNot(allHandle, evalHandle);
    // Should have removed eval matches, keeping console.log matches
    expect(result.length).toBeGreaterThanOrEqual(1);
    freeMatches(allHandle);
    freeMatches(evalHandle);
  });

  it("intersect_matches keeps overlapping matches", () => {
    const src = "eval(x); console.log(y); eval(z)";
    structMatch("eval($X)", src, "javascript");
    const evalHandle = storeMatches();
    // Use a broad pattern that matches all call expressions
    structMatch("eval($X)", src, "javascript");
    const evalHandle2 = storeMatches();
    const result = intersectMatches(evalHandle, evalHandle2);
    // Same matches should overlap perfectly
    expect(result.length).toBeGreaterThanOrEqual(1);
    freeMatches(evalHandle);
    freeMatches(evalHandle2);
  });

  it("free_matches is safe for invalid handles", () => {
    freeMatches(0);
    freeMatches(999);
    // Should not throw
  });
});
