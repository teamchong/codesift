/**
 * codesift benchmarks
 *
 * Measures throughput of core operations: pattern matching, scanner reuse,
 * compiled pattern reuse, tree traversal, rule engine, and slot operations.
 *
 * Run: bun bench/index.ts
 */

import {
  structMatch,
  createScanner,
  compilePattern,
  matchPattern,
  freePattern,
  loadRules,
  storeMatches,
  filterInside,
  freeMatches,
  SgNode,
} from "../src/js/ts/index.js";
import { encodeRules } from "../src/js/encoder.js";
import type { RuleDefinition } from "../src/js/types.js";

// ── Helpers ──────────────────────────────────────────────

function bench(name: string, fn: () => void, iterations = 1_000): { name: string; opsPerSec: number; avgNs: number } {
  // Warmup
  for (let i = 0; i < Math.min(iterations, 50); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const avgMs = elapsed / iterations;
  const avgNs = avgMs * 1_000_000;
  const opsPerSec = 1000 / avgMs;

  return { name, opsPerSec, avgNs };
}

function formatOps(ops: number): string {
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(2)}K`;
  return ops.toFixed(2);
}

function formatNs(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function printResults(group: string, results: { name: string; opsPerSec: number; avgNs: number }[]) {
  const maxNameLen = Math.max(...results.map(r => r.name.length));
  console.log(`\n── ${group} ${"─".repeat(60 - group.length)}`);
  for (const r of results) {
    const name = r.name.padEnd(maxNameLen);
    const ops = formatOps(r.opsPerSec).padStart(10);
    const avg = formatNs(r.avgNs).padStart(12);
    console.log(`  ${name}  ${ops} ops/s  ${avg}/op`);
  }
}

// ── Source fixtures ──────────────────────────────────────

const SMALL_SOURCE = `const x = eval(input);`;
const MEDIUM_SOURCE = `
import { readFile } from 'fs';
import fetch from 'node-fetch';

function processData(input) {
  const result = eval(input);
  console.log(result);
  return result;
}

async function fetchData(url) {
  const response = await fetch(url);
  const data = await response.json();
  setTimeout(() => console.log(data), 1000);
  return data;
}

export function main() {
  const rawData = readFile('data.json');
  processData(rawData);
  fetchData('https://api.example.com/data');
}
`.trim();

const LARGE_SOURCE = Array.from({ length: 50 }, (_, i) => `
function fn${i}(arg${i}) {
  const val${i} = eval(arg${i});
  console.log("result:", val${i});
  setTimeout(() => process(val${i}), ${i * 100});
  if (val${i} > 0) {
    return fetch("https://api.example.com/" + val${i});
  }
  return null;
}
`).join("\n").trim();

// ── Benchmarks ───────────────────────────────────────────

console.log("codesift benchmark");
console.log("=".repeat(68));

// 1. One-shot structMatch
{
  const results = [
    bench("small source (22 bytes)", () => { structMatch("eval($X)", SMALL_SOURCE, "javascript"); }, 5_000),
    bench("medium source (450 bytes)", () => { structMatch("eval($X)", MEDIUM_SOURCE, "javascript"); }, 2_000),
    bench("large source (5KB)", () => { structMatch("eval($X)", LARGE_SOURCE, "javascript"); }, 200),
  ];
  printResults("structMatch (one-shot)", results);
}

// 2. Scanner: compile source once, match many
{
  const scannerSmall = createScanner(SMALL_SOURCE, "javascript");
  const scannerMed = createScanner(MEDIUM_SOURCE, "javascript");
  const scannerLarge = createScanner(LARGE_SOURCE, "javascript");

  const results = [
    bench("small source", () => { scannerSmall.match("eval($X)"); }, 5_000),
    bench("medium source", () => { scannerMed.match("eval($X)"); }),
    bench("large source", () => { scannerLarge.match("eval($X)"); }, 200),
    bench("medium, complex pattern", () => { scannerMed.match("setTimeout($FN, $MS)"); }, 500),
    bench("medium, no match", () => { scannerMed.match("document.write($X)"); }, 500),
    bench("matchKind (medium)", () => { scannerMed.matchKind("call_expression"); }, 5_000),
  ];
  printResults("scanner.match (compiled source)", results);

  scannerSmall.free();
  scannerMed.free();
  scannerLarge.free();
}

// 3. Compiled pattern: compile once, match many sources
{
  const handle = compilePattern("eval($X)", "javascript");

  const results = [
    bench("small source", () => { matchPattern(handle, SMALL_SOURCE); }, 2_000),
    bench("medium source", () => { matchPattern(handle, MEDIUM_SOURCE); }, 500),
    bench("large source", () => { matchPattern(handle, LARGE_SOURCE); }, 100),
  ];
  printResults("matchPattern (compiled pattern)", results);

  freePattern(handle);
}

// 4. Scanner with multiple patterns (scanAll)
{
  const scanner = createScanner(MEDIUM_SOURCE, "javascript");
  const patterns = ["eval($X)", "setTimeout($FN, $MS)", "fetch($URL)", "console.log($X)"];

  const results = [
    bench("4 patterns, medium source", () => { scanner.scanAll(patterns); }),
  ];
  printResults("scanner.scanAll", results);

  scanner.free();
}

// 5. Tree traversal (SgNode)
{
  const scanner = createScanner(MEDIUM_SOURCE, "javascript");
  const root = scanner.root();

  const results = [
    bench("root()", () => { scanner.root(); }),
    bench("root.children()", () => { root.children(); }),
    bench("root.namedChildren()", () => { root.namedChildren(); }),
    bench("child(0)", () => { root.child(0); }),
    bench("find('eval($X)')", () => { root.find("eval($X)"); }),
    bench("findAll('eval($X)')", () => { root.findAll("eval($X)"); }),
  ];

  // Deep navigation benchmark
  const fn = root.namedChildren()[2]; // function
  if (fn) {
    results.push(bench("field('name')", () => { fn.field("name"); }));
    results.push(bench("parent()", () => { fn.parent(); }));
    results.push(bench("next()", () => { fn.next(); }));
  }

  printResults("tree traversal (SgNode)", results);
  scanner.free();
}

// 6. Rule engine
{
  const rules: RuleDefinition[] = [
    { id: "no-eval", language: "javascript", severity: "error", message: "eval is dangerous", rule: { pattern: "eval($X)" } },
    { id: "no-settimeout", language: "javascript", severity: "warning", message: "setTimeout is discouraged", rule: { pattern: "setTimeout($FN, $MS)" } },
    { id: "no-fetch-in-sync", language: "javascript", severity: "info", message: "fetch in sync context", rule: { pattern: "fetch($URL)" } },
  ];

  // Encode timing
  const encodeResults = [
    bench("encodeRules (3 rules)", () => { encodeRules(rules); }, 10_000),
  ];
  printResults("rule engine: encode", encodeResults);

  const bytecode = encodeRules(rules);

  // Load timing
  const loadResults = [
    bench("loadRules (3 rules)", () => {
      const rs = loadRules(bytecode);
      rs.free();
    }, 5_000),
  ];
  printResults("rule engine: load", loadResults);

  // Apply timing
  const ruleset = loadRules(bytecode);
  const scannerSmall = createScanner(SMALL_SOURCE, "javascript");
  const scannerMed = createScanner(MEDIUM_SOURCE, "javascript");
  const scannerLarge = createScanner(LARGE_SOURCE, "javascript");

  const applyResults = [
    bench("apply, small source", () => { ruleset.apply(scannerSmall); }, 2_000),
    bench("apply, medium source", () => { ruleset.apply(scannerMed); }, 500),
    bench("apply, large source", () => { ruleset.apply(scannerLarge); }, 100),
  ];
  printResults("rule engine: apply", applyResults);

  scannerSmall.free();
  scannerMed.free();
  scannerLarge.free();
  ruleset.free();
}

// 7. Rule engine with combinators (all, inside, has)
{
  const complexRules: RuleDefinition[] = [
    {
      id: "eval-in-export",
      language: "javascript",
      severity: "error",
      message: "eval in exported function",
      rule: {
        all: [
          { pattern: "eval($X)" },
          { inside: { kind: "export_statement" } },
        ],
      },
    },
  ];

  const bytecode = encodeRules(complexRules);
  const ruleset = loadRules(bytecode);
  const source = `export function foo() { eval(x); } function bar() { eval(y); }`;
  const scanner = createScanner(source, "javascript");

  const results = [
    bench("all + inside combinator", () => { ruleset.apply(scanner); }),
  ];
  printResults("rule engine: combinators", results);

  scanner.free();
  ruleset.free();
}

// 8. Match slot operations (filter/intersect)
{
  const scanner = createScanner(MEDIUM_SOURCE, "javascript");

  // Setup: get some match sets
  scanner.match("eval($X)");
  const evalSlot = storeMatches();
  scanner.match("$FN($$$ARGS)");
  const callSlot = storeMatches();

  const results = [
    bench("filterInside", () => {
      filterInside(evalSlot, callSlot);
    }),
  ];
  printResults("match slot operations", results);

  freeMatches(evalSlot);
  freeMatches(callSlot);
  scanner.free();
}

// 9. Throughput summary
{
  console.log(`\n── Throughput summary ${"─".repeat(47)}`);

  // Lines/sec for medium source
  const lines = MEDIUM_SOURCE.split("\n").length;
  const scanner = createScanner(MEDIUM_SOURCE, "javascript");

  const start = performance.now();
  const iters = 1_000;
  for (let i = 0; i < iters; i++) scanner.match("eval($X)");
  const elapsed = performance.now() - start;

  const matchesPerSec = (iters / elapsed) * 1000;
  const linesPerSec = matchesPerSec * lines;

  console.log(`  Pattern match throughput: ${formatOps(matchesPerSec)} matches/s`);
  console.log(`  Effective: ${formatOps(linesPerSec)} lines/s (${lines}-line source)`);
  console.log(`  Source sizes: small=${SMALL_SOURCE.length}B, medium=${MEDIUM_SOURCE.length}B, large=${LARGE_SOURCE.length}B`);

  scanner.free();
}

console.log(`\n${"=".repeat(68)}`);
