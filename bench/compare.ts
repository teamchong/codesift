/**
 * codesift vs @ast-grep/napi — head-to-head benchmark
 *
 * Compares the same operations across both libraries:
 *   1. One-shot pattern match
 *   2. Compiled source + pattern match (Scanner vs SgRoot)
 *   3. Tree traversal (SgNode navigation)
 *   4. Rule engine (bytecode vs NapiConfig)
 *   5. Multiple pattern scan
 *
 * Run: bun bench/compare.ts
 */

import * as codesift from "../src/js/ts/index.js";
import { encodeRules } from "../src/js/encoder.js";
import { parse, Lang } from "@ast-grep/napi";
import { bench, formatOps, formatNs, type BenchResult } from "./utils.js";

// ── Helpers ──────────────────────────────────────────────

type Result = BenchResult;

function printComparison(group: string, codesiftR: Result, astgrepR: Result) {
  const maxLen = Math.max(codesiftR.name.length, astgrepR.name.length);
  const ratio = codesiftR.opsPerSec / astgrepR.opsPerSec;
  const winner = ratio >= 1 ? "codesift" : "ast-grep";
  const factor = ratio >= 1 ? ratio : 1 / ratio;

  console.log(`\n── ${group} ${"─".repeat(60 - group.length)}`);
  console.log(`  ${"codesift".padEnd(12)} ${formatOps(codesiftR.opsPerSec).padStart(10)} ops/s  ${formatNs(codesiftR.avgNs).padStart(12)}/op`);
  console.log(`  ${"ast-grep".padEnd(12)} ${formatOps(astgrepR.opsPerSec).padStart(10)} ops/s  ${formatNs(astgrepR.avgNs).padStart(12)}/op`);
  console.log(`  → ${winner} is ${factor.toFixed(2)}x faster`);
}

function printGroup(group: string, rows: Array<[string, Result, Result]>) {
  console.log(`\n── ${group} ${"─".repeat(60 - group.length)}`);
  console.log(`  ${"operation".padEnd(32)} ${"codesift".padStart(14)}  ${"ast-grep".padStart(14)}  ${"winner".padStart(14)}`);
  console.log(`  ${"─".repeat(32)} ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(14)}`);
  for (const [label, cs, ag] of rows) {
    const ratio = cs.opsPerSec / ag.opsPerSec;
    const winner = ratio >= 1 ? `cs ${ratio.toFixed(1)}x` : `ag ${(1/ratio).toFixed(1)}x`;
    console.log(`  ${label.padEnd(32)} ${formatNs(cs.avgNs).padStart(14)}  ${formatNs(ag.avgNs).padStart(14)}  ${winner.padStart(14)}`);
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

console.log("codesift vs @ast-grep/napi");
console.log("=".repeat(82));

// 1. One-shot parse + match
{
  const rows: Array<[string, Result, Result]> = [];

  for (const [label, source, iters] of [
    ["small (22B)", SMALL_SOURCE, 20_000],
    ["medium (450B)", MEDIUM_SOURCE, 10_000],
    ["large (5KB)", LARGE_SOURCE, 2_000],
  ] as const) {
    const cs = bench("codesift", () => {
      codesift.structMatch("eval($X)", source, "javascript");
    }, iters);

    const ag = bench("ast-grep", () => {
      const root = parse(Lang.JavaScript, source).root();
      root.findAll("eval($X)");
    }, iters);

    rows.push([label, cs, ag]);
  }

  printGroup("one-shot: parse + match", rows);
}

// 2. Compiled source, repeated pattern match
{
  const rows: Array<[string, Result, Result]> = [];

  for (const [label, source, iters] of [
    ["small (22B)", SMALL_SOURCE, 20_000],
    ["medium (450B)", MEDIUM_SOURCE, 10_000],
    ["large (5KB)", LARGE_SOURCE, 2_000],
  ] as const) {
    // codesift: createScanner (compile source once), then match
    const scanner = codesift.createScanner(source, "javascript");
    const cs = bench("codesift", () => {
      scanner.match("eval($X)");
    }, iters);
    scanner.free();

    // ast-grep: parse (compile source once), then findAll
    const sgRoot = parse(Lang.JavaScript, source).root();
    const ag = bench("ast-grep", () => {
      sgRoot.findAll("eval($X)");
    }, iters);

    rows.push([label, cs, ag]);
  }

  printGroup("compiled source + match", rows);
}

// 3. Tree traversal
{
  const csScanner = codesift.createScanner(MEDIUM_SOURCE, "javascript");
  const csRoot = csScanner.root();
  const agRoot = parse(Lang.JavaScript, MEDIUM_SOURCE).root();

  const rows: Array<[string, Result, Result]> = [];

  // children
  rows.push(["root.children()",
    bench("cs", () => { csRoot.children(); }, 20_000),
    bench("ag", () => { agRoot.children(); }, 20_000),
  ]);

  // kind
  rows.push(["root.kind()",
    bench("cs", () => { csRoot.kind(); }, 50_000),
    bench("ag", () => { agRoot.kind(); }, 50_000),
  ]);

  // text
  rows.push(["root.text()",
    bench("cs", () => { csRoot.text(); }, 20_000),
    bench("ag", () => { agRoot.text(); }, 20_000),
  ]);

  // find
  rows.push(["find('eval($X)')",
    bench("cs", () => { csRoot.find("eval($X)"); }, 10_000),
    bench("ag", () => { agRoot.find("eval($X)"); }, 10_000),
  ]);

  // findAll
  rows.push(["findAll('eval($X)')",
    bench("cs", () => { csRoot.findAll("eval($X)"); }, 10_000),
    bench("ag", () => { agRoot.findAll("eval($X)"); }, 10_000),
  ]);

  // parent
  const csChild = csRoot.namedChildren()[0];
  const agChild = agRoot.children()[0];
  if (csChild && agChild) {
    rows.push(["child.parent()",
      bench("cs", () => { csChild.parent(); }, 20_000),
      bench("ag", () => { agChild.parent(); }, 20_000),
    ]);
  }

  // field
  const csFn = csRoot.namedChildren().find(n => n.kind() === "function_declaration");
  const agFn = agRoot.children().find(n => n.kind() === "function_declaration");
  if (csFn && agFn) {
    rows.push(["fn.field('name')",
      bench("cs", () => { csFn.field("name"); }, 20_000),
      bench("ag", () => { agFn.field("name"); }, 20_000),
    ]);
  }

  // matches — test on a call_expression node with identical patterns (no ellipsis)
  const csEvalNode = csRoot.find("eval($X)");
  const agEvalNode = agRoot.find("eval($X)");
  if (csEvalNode && agEvalNode) {
    rows.push(["node.matches(pattern)",
      bench("cs", () => { csEvalNode.matches("$FUNC($ARG)"); }, 10_000),
      bench("ag", () => { agEvalNode.matches("$FUNC($ARG)"); }, 10_000),
    ]);
  }

  printGroup("tree traversal (SgNode)", rows);
  csScanner.free();
}

// 4. Multiple patterns
{
  const patterns = ["eval($X)", "setTimeout($FN, $MS)", "fetch($URL)", "console.log($X)"];

  const csScanner = codesift.createScanner(MEDIUM_SOURCE, "javascript");
  const agRoot = parse(Lang.JavaScript, MEDIUM_SOURCE).root();

  const rows: Array<[string, Result, Result]> = [];

  rows.push(["4 patterns (medium)",
    bench("cs", () => { csScanner.scanAll(patterns); }, 5_000),
    bench("ag", () => { for (const p of patterns) agRoot.findAll(p); }, 5_000),
  ]);

  printGroup("multi-pattern scan", rows);
  csScanner.free();
}

// 5. Rule engine (codesift bytecode vs ast-grep NapiConfig)
{
  const bytecode = encodeRules([
    { id: "no-eval", language: "javascript", severity: "error", message: "eval is dangerous", rule: { pattern: "eval($X)" } },
    { id: "no-settimeout", language: "javascript", severity: "warning", message: "setTimeout is discouraged", rule: { pattern: "setTimeout($FN, $MS)" } },
    { id: "no-fetch", language: "javascript", severity: "info", message: "raw fetch usage", rule: { pattern: "fetch($URL)" } },
  ]);

  const agConfigs = [
    { rule: { pattern: "eval($X)" } },
    { rule: { pattern: "setTimeout($FN, $MS)" } },
    { rule: { pattern: "fetch($URL)" } },
  ];

  const rows: Array<[string, Result, Result]> = [];

  for (const [label, source, iters] of [
    ["small (22B)", SMALL_SOURCE, 10_000],
    ["medium (450B)", MEDIUM_SOURCE, 5_000],
    ["large (5KB)", LARGE_SOURCE, 1_000],
  ] as const) {
    const csScanner = codesift.createScanner(source, "javascript");
    const csRuleset = codesift.loadRules(bytecode);

    const agRoot = parse(Lang.JavaScript, source).root();

    const cs = bench("cs", () => {
      csRuleset.apply(csScanner);
    }, iters);

    const ag = bench("ag", () => {
      for (const cfg of agConfigs) agRoot.findAll(cfg as any);
    }, iters);

    rows.push([`3 rules, ${label}`, cs, ag]);

    csScanner.free();
    csRuleset.free();
  }

  printGroup("rule engine (3 rules)", rows);
}

// Summary
console.log(`\n${"=".repeat(82)}`);
console.log(`Source sizes: small=${SMALL_SOURCE.length}B, medium=${MEDIUM_SOURCE.length}B, large=${LARGE_SOURCE.length}B`);
console.log(`codesift: WASM (Zig + tree-sitter) | ast-grep: native NAPI (Rust + tree-sitter)`);

// Sources
console.log(`\nReferences:`);
console.log(`  ast-grep API: https://ast-grep.github.io/reference/api.html`);
console.log(`  ast-grep napi: https://www.npmjs.com/package/@ast-grep/napi`);
