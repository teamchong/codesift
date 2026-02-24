#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import {
  structMatch,
  createScanner,
  loadRules,
  detectLanguage,
  isWasmLanguage,
  type Match,
  type Finding,
} from "./ts/index.js";
import { encodeRules } from "./encoder.js";
import { traceFile } from "./trace.js";
import type { RuleDefinition, Language, Confidence } from "./types.js";

// ── Argument parsing ─────────────────────────────────────

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

// ── File discovery ───────────────────────────────────────

const EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

function discoverFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    const stat = fs.statSync(p);
    if (stat.isFile() && EXTENSIONS.has(path.extname(p))) {
      files.push(p);
    } else if (stat.isDirectory()) {
      const entries = fs.readdirSync(p, { recursive: true }) as string[];
      for (const entry of entries) {
        const fullPath = path.join(p, entry);
        if (fs.statSync(fullPath).isFile() && EXTENSIONS.has(path.extname(fullPath))) {
          files.push(fullPath);
        }
      }
    }
  }
  return files;
}

// ── JSON rule loading ────────────────────────────────────

function loadRuleFiles(rulesPath: string): RuleDefinition[] {
  const rules: RuleDefinition[] = [];

  if (!fs.existsSync(rulesPath)) {
    console.error(`Rules path not found: ${rulesPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(rulesPath);
  const jsonFiles: string[] = [];

  if (stat.isFile()) {
    jsonFiles.push(rulesPath);
  } else if (stat.isDirectory()) {
    const entries = fs.readdirSync(rulesPath, { recursive: true }) as string[];
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        jsonFiles.push(path.join(rulesPath, entry));
      }
    }
  }

  for (const file of jsonFiles) {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { rules?: RuleDefinition[] };
    if (data && Array.isArray(data.rules)) {
      rules.push(...data.rules);
    }
  }

  return rules;
}

// ── SARIF output ─────────────────────────────────────────

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      };
    };
  }>;
}

function toSarif(
  allFindings: Array<{ file: string; findings: Finding[] }>,
  rules: RuleDefinition[],
): object {
  const results: SarifResult[] = [];

  for (const { file, findings } of allFindings) {
    for (const f of findings) {
      for (const m of f.matches) {
        results.push({
          ruleId: f.ruleId,
          level: f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "note",
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: file },
                region: {
                  startLine: m.start_row + 1,
                  startColumn: m.start_col + 1,
                  endLine: m.end_row + 1,
                  endColumn: m.end_col + 1,
                },
              },
            },
          ],
        });
      }
    }
  }

  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "codesift",
            version: "0.1.0",
            rules: rules.map((r) => ({
              id: r.id,
              shortDescription: { text: r.message },
              defaultConfiguration: { level: r.severity ?? "error" },
            })),
          },
        },
        results,
      },
    ],
  };
}

// ── Formatters ───────────────────────────────────────────

function formatTextFindings(file: string, findings: Finding[], source: string): string {
  const sourceLines = source.split("\n");
  const lines: string[] = [];
  for (const f of findings) {
    for (const m of f.matches) {
      const line = sourceLines[m.start_row] ?? "";
      lines.push(`${file}:${m.start_row + 1}:${m.start_col + 1}: ${f.severity} [${f.ruleId}] ${f.message}`);
      lines.push(`  ${line.trimEnd()}`);
      lines.push(`  ${" ".repeat(m.start_col)}${"^".repeat(Math.max(1, m.end_col - m.start_col))}`);
    }
  }
  return lines.join("\n");
}

function formatTextMatch(file: string, matches: Match[], source: string, pattern: string): string {
  const sourceLines = source.split("\n");
  const lines: string[] = [];
  for (const m of matches) {
    const line = sourceLines[m.start_row] ?? "";
    lines.push(`${file}:${m.start_row + 1}:${m.start_col + 1}: match [${pattern}]`);
    lines.push(`  ${line.trimEnd()}`);
    if (Object.keys(m.bindings).length > 0) {
      const binds = Object.entries(m.bindings).map(([k, v]) => `$${k}=${v}`).join(", ");
      lines.push(`  bindings: ${binds}`);
    }
  }
  return lines.join("\n");
}

// ── Commands ─────────────────────────────────────────────

function cmdScan(positionals: string[], flags: Record<string, string | boolean>): void {
  const rulesPath = flags.rules as string;
  if (!rulesPath) {
    console.error("Error: --rules <path> is required for scan command");
    process.exit(1);
  }

  const format = (flags.format as string) ?? "text";

  const rules = loadRuleFiles(rulesPath);
  if (rules.length === 0) {
    console.error("No rules found");
    process.exit(1);
  }

  const bytecode = encodeRules(rules);
  const ruleset = loadRules(bytecode);

  const files = discoverFiles(positionals.length > 0 ? positionals : ["."]);
  const allFindings: Array<{ file: string; findings: Finding[] }> = [];
  let totalFindings = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf-8");
    const lang = detectLanguage(file);
    if (!isWasmLanguage(lang)) continue;

    const scanner = createScanner(source, lang);
    const findings = ruleset.apply(scanner);
    scanner.free();

    if (findings.length > 0) {
      allFindings.push({ file, findings });
      totalFindings += findings.length;

      if (format === "text") {
        console.log(formatTextFindings(file, findings, source));
      }
    }
  }

  ruleset.free();

  if (format === "json") {
    console.log(JSON.stringify(allFindings, null, 2));
  } else if (format === "sarif") {
    console.log(JSON.stringify(toSarif(allFindings, rules), null, 2));
  } else if (format === "text") {
    console.log(`\n${totalFindings} finding(s) in ${files.length} file(s)`);
  }

  process.exit(totalFindings > 0 ? 1 : 0);
}

function cmdRun(positionals: string[], flags: Record<string, string | boolean>): void {
  const pattern = positionals[0];
  if (!pattern) {
    console.error("Error: pattern argument is required");
    console.error('Usage: codesift run "<pattern>" [files...]');
    process.exit(1);
  }

  const format = (flags.format as string) ?? "text";
  const langFlag = flags.lang as string | undefined;
  const filePaths = positionals.slice(1);
  const files = discoverFiles(filePaths.length > 0 ? filePaths : ["."]);

  let totalMatches = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, "utf-8");
    const lang = (langFlag ?? detectLanguage(file)) as Language;
    if (!isWasmLanguage(lang)) continue;

    const matches = structMatch(pattern, source, lang);
    totalMatches += matches.length;

    if (matches.length > 0) {
      if (format === "json") {
        console.log(JSON.stringify({ file, matches }, null, 2));
      } else {
        console.log(formatTextMatch(file, matches, source, pattern));
      }
    }
  }

  if (format === "text") {
    console.log(`\n${totalMatches} match(es) in ${files.length} file(s)`);
  }

  process.exit(totalMatches > 0 ? 1 : 0);
}

function cmdCompile(positionals: string[], flags: Record<string, string | boolean>): void {
  const input = positionals[0];
  if (!input) {
    console.error("Error: input JSON rules file is required");
    console.error("Usage: codesift compile <rules.json> [-o rules.bin]");
    process.exit(1);
  }

  const output = (flags.o as string) ?? input.replace(/\.json$/, ".bin");
  const rules = loadRuleFiles(input);

  if (rules.length === 0) {
    console.error("No rules found in input file");
    process.exit(1);
  }

  const bytecode = encodeRules(rules);
  fs.writeFileSync(output, bytecode);
  console.log(`Compiled ${rules.length} rule(s) → ${output} (${bytecode.length} bytes)`);
}

function cmdTest(flags: Record<string, string | boolean>): void {
  const rulesPath = (flags.rules as string) ?? ".";
  const rules = loadRuleFiles(rulesPath);

  if (rules.length === 0) {
    console.error("No rules found");
    process.exit(1);
  }

  console.log(`Testing ${rules.length} rule(s)...`);

  const bytecode = encodeRules(rules);
  const ruleset = loadRules(bytecode);

  let passed = 0;
  let failed = 0;

  for (const rule of rules) {
    // Look for test fixtures adjacent to rule files
    const testDir = path.join(rulesPath, "__tests__");
    if (!fs.existsSync(testDir)) {
      console.log(`  ⊘ ${rule.id} — no test fixtures found`);
      continue;
    }

    const testFiles = fs.readdirSync(testDir).filter((f) =>
      f.startsWith(rule.id) && EXTENSIONS.has(path.extname(f)),
    );

    for (const testFile of testFiles) {
      const source = fs.readFileSync(path.join(testDir, testFile), "utf-8");
      const lang = detectLanguage(testFile);
      if (!isWasmLanguage(lang)) continue;

      const scanner = createScanner(source, lang);
      const findings = ruleset.apply(scanner);
      scanner.free();

      if (findings.length > 0) {
        console.log(`  ✓ ${rule.id} — ${findings.length} finding(s) in ${testFile}`);
        passed++;
      } else {
        console.log(`  ✗ ${rule.id} — no findings in ${testFile}`);
        failed++;
      }
    }
  }

  ruleset.free();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function cmdTrace(positionals: string[], flags: Record<string, string | boolean>): void {
  const filePath = positionals[0];
  if (!filePath) {
    console.error("Error: file argument is required");
    console.error("Usage: codesift trace <file> [--timeout 5000] [--confidence high|medium|low] [--format text|json]");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  const format = (flags.format as string) ?? "text";
  const minConfidence = (flags.confidence as Confidence) ?? "medium";
  const timeout = flags.timeout ? Number(flags.timeout) : undefined;
  const maxCalls = flags["max-calls"] ? Number(flags["max-calls"]) : undefined;
  const maxLoopIters = flags["max-loop-iters"] ? Number(flags["max-loop-iters"]) : undefined;

  const confidenceOrder: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
  const minLevel = confidenceOrder[minConfidence] ?? 2;

  const result = traceFile(filePath, {
    timeout,
    thresholds: {
      ...(maxCalls !== undefined && { maxCalls }),
      ...(maxLoopIters !== undefined && { maxLoopIters }),
    },
  });

  const filtered = result.findings.filter(
    (f) => confidenceOrder[f.confidence] >= minLevel,
  );

  if (format === "json") {
    console.log(JSON.stringify({ ...result, findings: filtered }, null, 2));
  } else {
    // Text format
    if (result.timedOut) {
      console.log("⚠ Execution timed out");
    }
    console.log(`Traced ${filePath} in ${result.durationMs.toFixed(1)}ms — ${result.events.length} event(s)\n`);

    if (filtered.length === 0) {
      console.log("No findings above confidence threshold.");
    } else {
      for (const f of filtered) {
        const icon = f.severity === "error" ? "✗" : f.severity === "warning" ? "⚠" : "ℹ";
        console.log(`  ${icon} [${f.confidence}] ${f.id}: ${f.message}`);
        if (f.caveat) {
          console.log(`    ↳ ${f.caveat}`);
        }
      }
    }

    console.log(`\n${filtered.length} finding(s) (confidence ≥ ${minConfidence})`);
    if (minConfidence !== "low" && result.findings.length > filtered.length) {
      console.log(`  (${result.findings.length - filtered.length} lower-confidence finding(s) hidden; use --confidence low to show all)`);
    }
  }

  process.exit(filtered.length > 0 ? 1 : 0);
}

function showHelp(): void {
  console.log(`codesift — Structural code analysis + behavioral tracing

Commands:
  scan [files...] --rules <path>     Scan files with JSON rules
    --format text|json|sarif         Output format (default: text)

  run "<pattern>" [files...]         One-shot pattern match
    --lang js|ts|tsx                 Language (default: auto-detect)
    --format text|json               Output format (default: text)

  trace <file>                       Behavioral trace via proxy execution
    --timeout <ms>                   Execution timeout (default: 5000)
    --confidence high|medium|low     Min confidence to show (default: medium)
    --max-calls <n>                  Max calls threshold (default: 1000)
    --max-loop-iters <n>             Max loop iterations (default: 10000)
    --format text|json               Output format (default: text)

  compile <rules.json> [-o out.bin]  Pre-compile rules to bytecode

  test --rules <dir>                 Test rules against fixtures

Examples:
  codesift run "eval(\\$X)" src/
  codesift scan --rules rules/ src/
  codesift trace suspicious.js
  codesift trace script.js --confidence low --timeout 10000
  codesift compile rules.json -o rules.bin
`);
}

function main(): void {
  const { command, positionals, flags } = parseArgs(process.argv);

  switch (command) {
    case "scan":
      cmdScan(positionals, flags);
      break;
    case "run":
      cmdRun(positionals, flags);
      break;
    case "trace":
      cmdTrace(positionals, flags);
      break;
    case "compile":
      cmdCompile(positionals, flags);
      break;
    case "test":
      cmdTest(flags);
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main();
