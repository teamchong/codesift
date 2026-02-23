# codesift

[![npm](https://img.shields.io/npm/v/codesift)](https://www.npmjs.com/package/codesift)
[![license](https://img.shields.io/npm/l/codesift)](https://github.com/teamchong/codesift/blob/main/LICENSE)

Embeddable WASM-based structural code pattern matcher for JavaScript and TypeScript. Runs anywhere WASM runs — browser, Node.js, Cloudflare Workers.

## The Problem

Agents write code and execute it immediately. No human reviews it. Claude Code with CLI access, OpenClaw going full autopilot — that's where things are heading.

But agents make mistakes. And the ways to catch them all have tradeoffs:

1. **System prompts.** They don't always follow them.
2. **Use another agent to review.** That agent can be wrong too.
3. **Restrict access.** The agent loops burning tokens trying to figure out what happened.

codesift is a structural code pattern matcher designed to run **in-process**. One npm package, no CLI install, no subprocess, no network call. Import the function, pass it a pattern and source code, get matches back in microseconds.

```js
import { structMatch } from "codesift";

const matches = structMatch("eval($X)", source, "javascript");
// → [{ bindings: { X: "userInput" }, start_row: 3, ... }]
```

For structural patterns — `eval()` usage, raw SQL concatenation, missing auth checks, banned imports — it's fast, deterministic, and embeddable.

## Quick Start

```bash
npm install codesift
```

Zero-config — just import and use. No `init()`, no WASM setup:

```js
import { structMatch } from "codesift";

// One-shot pattern match
const matches = structMatch("console.log($X)", source, "javascript");
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

## Pattern Syntax

Metavariables bind matched subtrees:

| Pattern | Matches |
|---------|---------|
| `eval($X)` | Any `eval()` call, binds argument to `$X` |
| `console.log($X)` | Any `console.log()` call |
| `fetch($URL, $OPTS)` | Two-argument `fetch()` calls |
| `$FN($$$ARGS)` | Any function call (`$$$` = variadic) |
| `document.innerHTML = $X` | Direct innerHTML assignment |

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
  fix?: string;
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

### `codesift/types`

```js
import type {
  Language,
  RuleDefinition,
  RuleNode,
  StopBy,
  MetavarConstraint,
  TransformOp,
  Finding,
  Match,
  RichMatch,
} from "codesift/types";
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
  fix?: string;
}

type Language = "javascript" | "typescript" | "tsx";
```

## CLI

```bash
# One-shot pattern match
codesift run "eval($X)" src/

# Scan with JSON rules
codesift scan --rules rules/ src/
codesift scan --rules rules/ --format sarif src/
# Pre-compile rules to bytecode
codesift compile rules.json -o rules.bin

# Test rules against fixtures
codesift test --rules rules/
```

## Runtime Support

| Runtime | Status | Notes |
|---------|--------|-------|
| Node.js 20+ | ✅ | WASM embedded in bundle — zero config |
| Bun | ✅ | WASM embedded in bundle — zero config |
| Browsers | ✅ | WASM embedded in bundle — zero config |
| Deno | ✅ | WASM embedded in bundle — zero config |
| Cloudflare Workers | ✅ | WASM embedded in bundle — zero config |

WASM is embedded as base64 in the JS bundle and auto-initialized via top-level `await`. No setup required — just `import { structMatch } from "codesift"`.

## How It Works

codesift compiles [tree-sitter](https://tree-sitter.github.io/) C parsers (JavaScript, TypeScript, TSX) and a Zig-native structural AST matching engine to WebAssembly. The WASM module handles parsing and pattern matching with SIMD-accelerated byte comparison. A thin JS layer provides the Scanner API and bytecode rule encoder.

**Two-tier design:**
- **Hot path** (Zig/WASM): Parse + structural match in <1ms
- **JS layer**: Scanner, bytecode encoder

**Bytecode rule engine:** Rules are compiled to flat bytecode in JS (`encodeRules()`), passed to WASM as a single `Uint8Array`, decoded into fixed-size structs in WASM linear memory, and evaluated with zero re-parsing at match time.

**Zero heap allocation during matching:** The WASM engine uses fixed-size arrays for match results and bindings — no `malloc` calls during pattern matching. Tree-sitter parsers are pooled and reused across calls.

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
