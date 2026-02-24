# codesift

[![npm](https://img.shields.io/npm/v/codesift)](https://www.npmjs.com/package/codesift)
[![license](https://img.shields.io/npm/l/codesift)](https://github.com/teamchong/codesift/blob/main/LICENSE)

Structural code analysis + behavioral tracing in a single WASM module. Runs anywhere — browser, Node.js, edge workers, serverless.

## Why codesift

- **Edge-native.** WASM runs in browsers, edge workers, and serverless — no native binary, no Python runtime, no subprocess.
- **Structural matching.** ast-grep-compatible pattern matching with a bytecode rule engine. Find `eval($X)`, banned imports, missing auth checks — in microseconds.
- **Behavioral tracing.** Proxy-instrumented execution detects what static analysis can't: infinite loops, excessive API calls, resource exhaustion. Know what code *does*, not just what it *looks like*.

## Use Cases

### AI Code Gateway

AI agents write code and execute it immediately. No human reviews it. codesift scans AI-generated code **before** it reaches the user:

- **Static rules** catch dangerous patterns (`eval()`, `process.exit()`, raw `child_process`)
- **Behavioral trace** catches runtime issues (infinite loops, 10K API calls in a loop, stack overflow)
- Runs inline at the edge — no round-trip to a separate service

### CI/CD Pipeline

Enforce code standards with structural rules. Pre-compile rules to bytecode for deterministic, fast scanning across your codebase.

### Code Review Automation

Combine pattern matching (what the code *looks like*) with trace analysis (what the code *does*). Catch issues that linters miss.

## Quick Start

```bash
npm install codesift
```

Zero-config — just import and use. No `init()`, no WASM setup:

```js
import { structMatch } from "codesift";

// One-shot pattern match
const matches = structMatch("eval($X)", source, "javascript");
// → [{ bindings: { X: "userInput" }, start_row: 3, ... }]
```

**Scanner** — compile source once, match many patterns:

```js
import { createScanner } from "codesift";

const scanner = createScanner(source, "typescript");

scanner.match("eval($X)");           // → Match[]
scanner.match("document.write($X)"); // reuses compiled AST
scanner.matchKind("template_string"); // match by node type

scanner.free(); // release WASM memory
```

**Rule engine** — compile rules to bytecode, evaluate in WASM:

```js
import { createScanner, loadRules } from "codesift";
import { encodeRules } from "codesift/encoder";

const bytecode = encodeRules([{
  id: "no-eval",
  language: "javascript",
  severity: "error",
  message: "eval() is dangerous",
  rule: { pattern: "eval($X)" },
}]);

const ruleset = loadRules(bytecode);
const scanner = createScanner(source, "javascript");
const findings = ruleset.apply(scanner);
// → [{ ruleId: "no-eval", message: "eval() is dangerous", matches: [...] }]

scanner.free();
ruleset.free();
```

**Behavioral trace** — detect runtime issues via proxy execution:

```js
import { trace } from "codesift";

const result = trace(`
  import fs from 'fs';
  for (let i = 0; ; i++) {
    fs.readFileSync('data.json');
  }
`, "javascript");

// result.findings → [
//   { id: "excessive-iterations", confidence: "high", message: "loop exceeded 10000 iterations" },
//   { id: "excessive-calls", confidence: "medium", message: "fs.readFileSync called 10001 times" }
// ]
```

## Pattern Syntax

Metavariables bind matched subtrees:

| Pattern | Matches |
|---------|---------|
| `eval($X)` | Any `eval()` call, binds argument to `$X` |
| `console.log($X)` | Any `console.log()` call |
| `fetch($URL, $OPTS)` | Two-argument `fetch()` calls |
| `$FN($$$ARGS)` | Any function call (`$$$` = variadic) |
| `document.innerHTML = $X` | Direct innerHTML assignment |

## Trace: Behavioral Analysis

Static analysis catches *that* `delete()` is called. Trace catches *that it's called 10,000 times in a loop*. This is fundamentally different from what linters, semgrep, or ast-grep can do.

### How It Works

1. **Rewrite** — codesift uses its own AST engine to rewrite imports and `require()` calls into Proxy stubs, and instruments loops with iteration counters.
2. **Execute** — the rewritten code runs in a sandboxed `vm` context with a timeout. All function calls, property accesses, and constructions are intercepted by the Proxy.
3. **Analyze** — collected telemetry (call counts, argument samples, loop iterations) is analyzed against configurable thresholds to produce findings.

### Confidence Levels

Since proxy execution ≠ real execution (Proxies return Proxies, not real values), every finding includes a **confidence level**:

| Confidence | Meaning | Example |
|---|---|---|
| **high** | Very likely a real issue | Timeout, stack overflow, >10K loop iterations |
| **medium** | Probably real, but mock behavior may differ | Function called 5K times via proxy chain |
| **low** | Detected under mock conditions only | Excessive property access from proxy amplification |

Findings with confidence < high include a `caveat` field explaining why it might be a false positive.

### Trace API

```js
import { trace, traceFile, rewriteSource } from "codesift";
```

#### `trace(source, lang, opts?): TraceResult`

Rewrite + execute + analyze in one call.

```ts
interface TraceOptions {
  timeout?: number;        // Execution timeout in ms (default: 5000)
  globals?: Record<string, unknown>;  // Custom sandbox globals
  thresholds?: {
    maxCalls?: number;     // Max calls to single fn (default: 1000)
    maxLoopIters?: number; // Max loop iterations (default: 10000)
  };
}

interface TraceResult {
  events: TraceEvent[];     // All intercepted operations
  findings: TraceFinding[]; // Issues that exceeded thresholds
  timedOut: boolean;        // True if execution hit timeout
  durationMs: number;       // Wall-clock execution time
}

interface TraceFinding {
  id: string;               // "excessive-calls", "infinite-loop", etc.
  severity: "error" | "warning" | "info";
  message: string;
  confidence: "high" | "medium" | "low";
  event: TraceEvent;
  caveat?: string;          // Why confidence may be reduced
}
```

#### `traceFile(filePath, opts?): TraceResult`

Convenience: reads file, detects language, traces.

#### `rewriteSource(source, lang): string`

Just the rewriting step — useful for inspecting what the sandbox will execute.

## API Reference

### `codesift` (main entry)

```js
import {
  structMatch,
  createScanner,
  compilePattern,
  matchPattern,
  freePattern,
  loadRules,
  detectLanguage,
  isWasmLanguage,
  // Trace
  trace,
  traceFile,
  rewriteSource,
  // Match slot operations
  storeMatches,
  filterInside,
  filterNotInside,
  filterNot,
  intersectMatches,
  freeMatches,
  // Range/sibling matching
  matchInRange,
  matchPreceding,
  matchFollowing,
} from "codesift";
```

#### `structMatch(pattern, source, lang): Match[]`

One-shot pattern match. Parses both pattern and source, matches, returns results.

```js
const matches = structMatch("eval($X)", "const x = eval(input);", "javascript");
// [{ start_row: 0, start_col: 10, end_row: 0, end_col: 21, bindings: { X: "input" } }]
```

#### `createScanner(source, lang): Scanner`

Compile source once, match many patterns. Uses AOT-compiled AST internally — each `.match()` call only compiles the pattern, not the source.

```ts
interface Scanner {
  match(pattern: string): Match[];
  matchKind(kind: string): Match[];
  scanAll(patterns: string[]): RichMatch[];
  root(): SgNode;
  readonly source: string;
  readonly language: Language;
  free(): void;
}
```

#### `compilePattern(pattern, lang): number`

Compile a pattern for repeated matching across multiple sources. Returns a handle (0 = error).

```js
const handle = compilePattern("eval($X)", "javascript");
const matches1 = matchPattern(handle, source1);
const matches2 = matchPattern(handle, source2);
freePattern(handle);
```

#### `loadRules(bytecode): CompiledRuleset`

Load bytecode-compiled rules into the WASM engine.

```ts
interface CompiledRuleset {
  apply(scanner: Scanner): Finding[];
  free(): void;
}
```

#### `detectLanguage(filename): Language`

Detect language from file extension. Returns `"javascript"`, `"typescript"`, or `"tsx"`.

#### `isWasmLanguage(lang): boolean`

Check if a language is supported by the WASM engine.

#### Match Slot Operations

For complex multi-pattern matching, intermediate match results can be stored in slots and combined:

```js
const scanner = createScanner(source, "javascript");

scanner.match("fetch($URL)");
const fetchSlot = storeMatches();

scanner.match("async function $FN($$$) { $$$ }");
const asyncSlot = storeMatches();

// Keep fetch calls inside async functions
const results = filterInside(fetchSlot, asyncSlot);

freeMatches(fetchSlot);
freeMatches(asyncSlot);
scanner.free();
```

### `codesift/encoder`

```js
import { encodeRules } from "codesift/encoder";
```

#### `encodeRules(rules: RuleDefinition[]): Uint8Array`

Compile rule definitions to bytecode:

```ts
interface RuleDefinition {
  id: string;
  language: "javascript" | "typescript" | "tsx";
  severity?: "error" | "warning" | "info" | "hint";
  message: string;
  rule: RuleNode;
  constraints?: Record<string, { regex?: string; notRegex?: string }>;
  transform?: Record<string, TransformOp>;
}
```

**Rule combinators** — `all`, `any`, `not`, `inside`, `has`, `follows`, `precedes`:

```js
encodeRules([{
  id: "no-eval-in-handler",
  language: "javascript",
  message: "eval() inside event handler",
  rule: {
    all: [
      { pattern: "eval($X)" },
      { inside: { pattern: "addEventListener($E, $$$)" } },
    ],
  },
}]);
```

### Types

```ts
interface Match {
  start_row: number;
  start_col: number;
  end_row: number;
  end_col: number;
  start_byte: number;
  end_byte: number;
  bindings: Record<string, string>;
}

interface Finding {
  ruleId: string;
  severity: string;
  message: string;
  matches: Match[];
}

type Language = "javascript" | "typescript" | "tsx";
type Confidence = "high" | "medium" | "low";
```

## CLI

```bash
# One-shot pattern match
codesift run "eval(\$X)" src/

# Scan with JSON rules
codesift scan --rules rules/ src/
codesift scan --rules rules/ --format sarif src/

# Behavioral trace
codesift trace suspicious.js
codesift trace script.js --confidence low --timeout 10000
codesift trace script.js --max-calls 500 --format json

# Pre-compile rules to bytecode
codesift compile rules.json -o rules.bin

# Test rules against fixtures
codesift test --rules rules/
```

## Runtime Support

| Runtime | Pattern Matching | Behavioral Trace | Notes |
|---------|:---:|:---:|-------|
| Node.js 20+ | ✅ | ✅ | Full support |
| Bun | ✅ | ✅ | Full support |
| Browsers | ✅ | ❌ | Trace requires `node:vm` |
| Deno | ✅ | ✅ | Full support |
| Edge Workers | ✅ | ❌ | Trace requires `node:vm` |

WASM is embedded as base64 in the JS bundle and auto-initialized via top-level `await`. No setup required — just `import { structMatch } from "codesift"`.

Behavioral trace uses `node:vm` for sandboxed execution, so it's available in Node.js, Bun, and Deno but not in browsers or edge workers.

## How It Works

codesift compiles [tree-sitter](https://tree-sitter.github.io/) C parsers (JavaScript, TypeScript, TSX) and a Zig-native structural AST matching engine to WebAssembly. The WASM module handles parsing and pattern matching with SIMD-accelerated byte comparison. A thin JS layer provides the Scanner API and bytecode rule encoder.

**Two-tier design:**
- **Hot path** (Zig/WASM): Parse + structural match in <1ms
- **JS layer**: Scanner, bytecode encoder, trace engine

**Bytecode rule engine:** Rules are compiled to flat bytecode in JS (`encodeRules()`), passed to WASM as a single `Uint8Array`, decoded into fixed-size structs in WASM linear memory, and evaluated with zero re-parsing at match time.

**Zero heap allocation during matching:** The WASM engine uses fixed-size arrays for match results and bindings — no `malloc` calls during pattern matching. Tree-sitter parsers are pooled and reused across calls.

**Trace engine:** Rewrites source code via AST-based transforms (replacing imports with Proxy stubs, instrumenting loops), executes in a sandboxed `vm` context, and analyzes runtime telemetry with a confidence-based finding system.

## Building from Source

Requires: [Zig](https://ziglang.org/) 0.15+, [Bun](https://bun.sh/) or Node.js 20+.

Optional: [Binaryen](https://github.com/WebAssembly/binaryen) (`wasm-opt`) for optimized builds.

```bash
# macOS
brew install binaryen

# Ubuntu / Debian
sudo apt-get install -y binaryen
```

```bash
bun run build      # Zig → WASM → wasm-opt → embed → JS bundle
bun test           # integration tests
zig build test     # native Zig tests
```

## Acknowledgments

codesift is built on the work of:

- **[tree-sitter](https://tree-sitter.github.io/)** by Max Brunsfeld — the incremental parsing framework powering the AST analysis

## License

Apache-2.0
