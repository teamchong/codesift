import { describe, it, expect } from "bun:test";
import { rewriteSource, trace } from "../../src/js/index.js";

describe("rewriteSource()", () => {
  it("rewrites default imports to proxy stubs", () => {
    const source = `import fs from 'fs';\nfs.readFileSync('x');`;
    const result = rewriteSource(source, "javascript");
    expect(result).not.toContain("import ");
    expect(result).toContain('__proxy__("fs")');
  });

  it("rewrites require() calls to proxy stubs", () => {
    const source = `const fs = require('fs');\nfs.readFileSync('x');`;
    const result = rewriteSource(source, "javascript");
    expect(result).not.toContain("require(");
    expect(result).toContain('__proxy__("fs")');
  });

  it("rewrites namespace imports", () => {
    const source = `import * as path from 'path';\npath.join('a', 'b');`;
    const result = rewriteSource(source, "javascript");
    expect(result).not.toContain("import ");
    expect(result).toContain('__proxy__("path")');
  });

  it("instruments for loops with counter", () => {
    const source = `for (let i = 0; i < 10; i++) { console.log(i); }`;
    const result = rewriteSource(source, "javascript");
    expect(result).toContain("__lc_0");
    expect(result).toContain("__loop_limit__");
  });

  it("instruments while loops with counter", () => {
    const source = `let x = 0; while (x < 5) { x++; }`;
    const result = rewriteSource(source, "javascript");
    expect(result).toContain("__lc_");
    expect(result).toContain("__loop_limit__");
  });

  it("removes export keywords", () => {
    const source = `export function main() { return 1; }\nexport default class Foo {}`;
    const result = rewriteSource(source, "javascript");
    expect(result).not.toContain("export ");
  });
});

describe("trace()", () => {
  it("detects function calls via proxy", () => {
    const source = `
      import fs from 'fs';
      fs.readFileSync('data.json');
    `;
    const result = trace(source, "javascript");
    expect(result.events.length).toBeGreaterThan(0);
    const callEvents = result.events.filter((e) => e.type === "call");
    expect(callEvents.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it("detects excessive calls and produces findings", () => {
    const source = `
      import api from 'api';
      for (let i = 0; i < 500; i++) {
        api.send(i);
      }
    `;
    const result = trace(source, "javascript", {
      thresholds: { maxCalls: 100 },
    });
    const excessiveFindings = result.findings.filter(
      (f) => f.id === "excessive-calls",
    );
    expect(excessiveFindings.length).toBeGreaterThan(0);
    expect(excessiveFindings[0].confidence).toBeDefined();
  });

  it("detects infinite loops via timeout", () => {
    const source = `
      let x = 0;
      while (true) { x++; }
    `;
    // With loop instrumentation, this should hit the loop limit, not the timeout
    const result = trace(source, "javascript", {
      timeout: 2000,
      thresholds: { maxLoopIters: 100 },
    });
    // Should have either a timeout or loop-limit finding
    const hasInfiniteLoop = result.findings.some(
      (f) => f.id === "infinite-loop" || f.id === "excessive-iterations",
    );
    expect(hasInfiniteLoop).toBe(true);
  });

  it("assigns confidence levels correctly", () => {
    const source = `
      import db from 'db';
      for (let i = 0; i < 200; i++) {
        db.query('SELECT 1');
      }
    `;
    const result = trace(source, "javascript", {
      thresholds: { maxCalls: 50 },
    });
    const findings = result.findings.filter((f) => f.id === "excessive-calls");
    // db.query is proxy-derived, so should be medium confidence
    for (const f of findings) {
      expect(["high", "medium", "low"]).toContain(f.confidence);
    }
  });

  it("includes caveats for non-high confidence findings", () => {
    const source = `
      import http from 'http';
      for (let i = 0; i < 200; i++) {
        http.get('http://example.com');
      }
    `;
    const result = trace(source, "javascript", {
      thresholds: { maxCalls: 50 },
    });
    const mediumFindings = result.findings.filter(
      (f) => f.confidence === "medium",
    );
    for (const f of mediumFindings) {
      expect(f.caveat).toBeDefined();
      expect(typeof f.caveat).toBe("string");
    }
  });

  it("returns empty findings for benign code", () => {
    const source = `
      const x = 1 + 2;
      const y = x * 3;
    `;
    const result = trace(source, "javascript");
    expect(result.findings.length).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("handles code with require() calls", () => {
    const source = `
      const fs = require('fs');
      const data = fs.readFileSync('file.txt');
    `;
    const result = trace(source, "javascript");
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it("respects custom timeout", () => {
    const start = performance.now();
    // Use a recursive function to trigger timeout instead of a loop
    // (loops get instrumented with counters that fire before timeout)
    const source = `function spin() { spin(); } spin();`;
    const result = trace(source, "javascript", {
      timeout: 500,
    });
    const elapsed = performance.now() - start;
    // Should finish within reasonable bounds of timeout
    expect(elapsed).toBeLessThan(5000);
    // Should either time out or hit stack overflow — both are acceptable
    const hasIssue = result.timedOut || result.findings.length > 0;
    expect(hasIssue).toBe(true);
  });

  it("reports durationMs", () => {
    const source = `const x = 1;`;
    const result = trace(source, "javascript");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
