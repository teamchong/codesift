/**
 * Dist artifact tests — validates the built output works correctly.
 * Run after `bun run build`. Imports from dist/, not src/.
 */
import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist");

// ── Dist file existence ──────────────────────────────────

describe("dist artifacts", () => {
  const required = [
    "index.js",
    "index.d.ts",
    "cli.js",
    "engine.wasm",
    "types.js",
    "types.d.ts",
    "encoder.js",
    "encoder.d.ts",
    "ts/index.d.ts",
  ];

  for (const file of required) {
    it(`dist/${file} exists`, () => {
      expect(existsSync(join(dist, file))).toBe(true);
    });
  }
});

// ── Main entry (codesift) ────────────────────────────────

describe("dist/index.js (main entry)", async () => {
  const mod = await import("../dist/index.js");

  it("exports structMatch", () => {
    expect(typeof mod.structMatch).toBe("function");
  });

  it("exports createScanner", () => {
    expect(typeof mod.createScanner).toBe("function");
  });

  it("exports compilePattern / matchPattern / freePattern", () => {
    expect(typeof mod.compilePattern).toBe("function");
    expect(typeof mod.matchPattern).toBe("function");
    expect(typeof mod.freePattern).toBe("function");
  });

  it("exports loadRules / encodeRules", () => {
    expect(typeof mod.loadRules).toBe("function");
    expect(typeof mod.encodeRules).toBe("function");
  });

  it("exports detectLanguage / isWasmLanguage", () => {
    expect(typeof mod.detectLanguage).toBe("function");
    expect(typeof mod.isWasmLanguage).toBe("function");
  });

  it("exports match slot operations", () => {
    expect(typeof mod.storeMatches).toBe("function");
    expect(typeof mod.filterInside).toBe("function");
    expect(typeof mod.filterNotInside).toBe("function");
    expect(typeof mod.filterNot).toBe("function");
    expect(typeof mod.intersectMatches).toBe("function");
    expect(typeof mod.freeMatches).toBe("function");
  });

  it("exports range/sibling matching", () => {
    expect(typeof mod.matchInRange).toBe("function");
    expect(typeof mod.matchPreceding).toBe("function");
    expect(typeof mod.matchFollowing).toBe("function");
  });

  it("exports SgNode class", () => {
    expect(typeof mod.SgNode).toBe("function");
  });

  it("structMatch works end-to-end", () => {
    const matches = mod.structMatch("console.log($X)", "console.log(42);", "javascript");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((m: any) => m.bindings.X === "42")).toBe(true);
  });

  it("createScanner works end-to-end", () => {
    const scanner = mod.createScanner("const x = eval(input);", "javascript");
    const matches = scanner.match("eval($X)");
    expect(matches.length).toBe(1);
    expect(matches[0].bindings.X).toBe("input");
    scanner.free();
  });

  it("detectLanguage resolves correctly", () => {
    expect(mod.detectLanguage("foo.ts")).toBe("typescript");
    expect(mod.detectLanguage("foo.tsx")).toBe("tsx");
    expect(mod.detectLanguage("foo.js")).toBe("javascript");
  });

  it("scanner.root() returns SgNode for tree traversal", () => {
    const scanner = mod.createScanner("const x = 1;", "javascript");
    const root = scanner.root();
    expect(root).toBeInstanceOf(mod.SgNode);
    expect(root.kind()).toBe("program");
    expect(root.namedChildren().length).toBeGreaterThan(0);
    scanner.free();
  });
});

// ── Subpath: codesift/encoder ────────────────────────────

describe("dist/encoder.js (codesift/encoder)", async () => {
  const mod = await import("../dist/encoder.js");

  it("exports encodeRules", () => {
    expect(typeof mod.encodeRules).toBe("function");
  });

  it("encodeRules produces Uint8Array", () => {
    const bytecode = mod.encodeRules([{
      id: "test",
      language: "javascript",
      message: "test rule",
      rule: { pattern: "eval($X)" },
    }]);
    expect(bytecode).toBeInstanceOf(Uint8Array);
    expect(bytecode.length).toBeGreaterThan(0);
    // Bytecode starts with OP_RULESET (0xFF)
    expect(bytecode[0]).toBe(0xFF);
  });
});

// ── Subpath: codesift/types ──────────────────────────────

describe("dist/types.js (codesift/types)", async () => {
  const mod = await import("../dist/types.js");

  it("imports without error", () => {
    expect(mod).toBeDefined();
  });
});

// ── Rule engine round-trip via dist ──────────────────────

describe("rule engine round-trip (dist)", async () => {
  const { createScanner, loadRules } = await import("../dist/index.js");
  const { encodeRules } = await import("../dist/encoder.js");

  it("encode → load → apply → findings", () => {
    const bytecode = encodeRules([{
      id: "no-eval",
      language: "javascript",
      severity: "error",
      message: "eval is dangerous",
      rule: { pattern: "eval($X)" },
    }]);

    const ruleset = loadRules(bytecode);
    const scanner = createScanner("const x = eval(userInput);", "javascript");
    const findings = ruleset.apply(scanner);

    expect(findings.length).toBe(1);
    expect(findings[0].ruleId).toBe("no-eval");
    expect(findings[0].message).toBe("eval is dangerous");
    expect(findings[0].matches[0].bindings.X).toBe("userInput");

    scanner.free();
    ruleset.free();
  });
});
