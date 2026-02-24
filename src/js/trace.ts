/**
 * Behavioral trace engine — proxy-instrumented code execution.
 *
 * Rewrites source code to replace imports/globals with JS Proxy objects,
 * executes in a sandboxed vm context, and collects runtime telemetry.
 */
import * as vm from "node:vm";
import * as fs from "node:fs";
import { createScanner, detectLanguage, isWasmLanguage } from "./ts/index.js";
import type {
  Language,
  TraceOptions,
  TraceEvent,
  TraceFinding,
  TraceResult,
  Confidence,
} from "./types.js";

// ── Proxy runtime (injected into sandbox) ────────────────

const PROXY_RUNTIME = `
// __trace__ and __proxy__ are provided by the sandbox context — do not redeclare.

__proxy__ = function __proxy__(name) {
  function target() {}
  return new Proxy(target, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return () => 1;
      if (prop === Symbol.iterator) return function*() {};
      if (prop === "then") return undefined; // prevent auto-await
      if (prop === "toString") return () => "[proxy:" + name + "]";
      if (prop === "valueOf") return () => 1;
      const path = name + "." + String(prop);
      __trace__.proxyPaths.add(path);
      var gk = "get:" + path;
      var ev = __trace__.events.get(gk);
      if (!ev) { ev = { type: "get", target: path, count: 0 }; __trace__.events.set(gk, ev); }
      ev.count++;
      return __proxy__(path);
    },
    apply(_, thisArg, args) {
      var ck = "call:" + name;
      __trace__.proxyPaths.add(name);
      var ev = __trace__.events.get(ck);
      if (!ev) { ev = { type: "call", target: name, count: 0, args: [] }; __trace__.events.set(ck, ev); }
      ev.count++;
      if (ev.args.length < 5) ev.args.push(args.map(function(a) { try { return String(a).slice(0, 100); } catch(e) { return "?"; } }));
      return __proxy__(name + "(...)");
    },
    construct(_, args) {
      var nk = "construct:" + name;
      __trace__.proxyPaths.add(name);
      var ev = __trace__.events.get(nk);
      if (!ev) { ev = { type: "construct", target: name, count: 0, args: [] }; __trace__.events.set(nk, ev); }
      ev.count++;
      if (ev.args.length < 5) ev.args.push(args.map(function(a) { try { return String(a).slice(0, 100); } catch(e) { return "?"; } }));
      return __proxy__(name);
    },
    set(_, prop, value) {
      var sk = "set:" + name + "." + String(prop);
      var path = name + "." + String(prop);
      var ev = __trace__.events.get(sk);
      if (!ev) { ev = { type: "set", target: path, count: 0 }; __trace__.events.set(sk, ev); }
      ev.count++;
      return true;
    },
    has() { return true; },
    getPrototypeOf() { return Function.prototype; },
    ownKeys() { return []; },
    getOwnPropertyDescriptor(_, prop) {
      return { configurable: true, enumerable: false, value: __proxy__(name + "." + String(prop)) };
    },
  });
};
`;

// ── AST rewriting ────────────────────────────────────────

interface Patch {
  start: number;
  end: number;
  replacement: string;
}

/** Rewrite source: replace imports/requires with proxy stubs, instrument loops. */
export function rewriteSource(
  source: string,
  lang: Language,
  maxLoopIters = 10_000,
): string {
  if (!isWasmLanguage(lang)) return source;

  const scanner = createScanner(source, lang);
  const root = scanner.root();
  const patches: Patch[] = [];

  // 1. Default imports: import X from 'mod'
  for (const node of root.findAll("import $NAME from '$MOD'")) {
    const r = node.range();
    const nameNode = node.field("source"); // get the module specifier
    // Extract the import name and module from the node text
    const text = node.text();
    const defaultMatch = text.match(/^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultMatch) {
      patches.push({
        start: r.startByte,
        end: r.endByte,
        replacement: `const ${defaultMatch[1]} = __proxy__("${defaultMatch[2]}");`,
      });
    }
  }

  // 2. Named imports: import { a, b } from 'mod'
  for (const node of root.findAll("import { $$$NAMES } from '$MOD'")) {
    const r = node.range();
    const text = node.text();
    const namedMatch = text.match(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/);
    if (namedMatch) {
      const names = namedMatch[1].split(",").map((n) => n.trim()).filter(Boolean);
      const mod = namedMatch[2];
      const bindings = names
        .map((n) => {
          const parts = n.split(/\s+as\s+/);
          const imported = parts[0].trim();
          const local = (parts[1] ?? parts[0]).trim();
          return `  ${local}: __proxy__("${mod}.${imported}")`;
        })
        .join(",\n");
      patches.push({
        start: r.startByte,
        end: r.endByte,
        replacement: `const {\n${bindings}\n} = { ${names.map((n) => {
          const parts = n.split(/\s+as\s+/);
          const imported = parts[0].trim();
          const local = (parts[1] ?? parts[0]).trim();
          return `${local}: __proxy__("${mod}.${imported}")`;
        }).join(", ")} };`,
      });
    }
  }

  // 3. Namespace imports: import * as X from 'mod'
  for (const node of root.findAll("import * as $NAME from '$MOD'")) {
    const r = node.range();
    const text = node.text();
    const nsMatch = text.match(/^import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/);
    if (nsMatch) {
      patches.push({
        start: r.startByte,
        end: r.endByte,
        replacement: `const ${nsMatch[1]} = __proxy__("${nsMatch[2]}");`,
      });
    }
  }

  scanner.free();

  // Fallback: regex-based rewriting for patterns AST matching may miss
  // This catches require() calls and any import statements not matched above
  let result = source;

  if (patches.length > 0) {
    // Apply AST-based patches in reverse byte order
    patches.sort((a, b) => b.start - a.start);
    for (const p of patches) {
      result = result.slice(0, p.start) + p.replacement + result.slice(p.end);
    }
  } else {
    // Regex fallback for imports if AST matching didn't find any
    // import X from 'mod'
    result = result.replace(
      /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
      (_, name, mod) => `const ${name} = __proxy__("${mod}");`,
    );
    // import { a, b } from 'mod'
    result = result.replace(
      /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
      (_, names, mod) => {
        const bindings = names
          .split(",")
          .map((n: string) => n.trim())
          .filter(Boolean)
          .map((n: string) => {
            const parts = n.split(/\s+as\s+/);
            const imported = parts[0].trim();
            const local = (parts[1] ?? parts[0]).trim();
            return `${local} = __proxy__("${mod}.${imported}")`;
          })
          .join(", ");
        return `const ${bindings};`;
      },
    );
    // import * as X from 'mod'
    result = result.replace(
      /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
      (_, name, mod) => `const ${name} = __proxy__("${mod}");`,
    );
  }

  // require() calls → __proxy__
  result = result.replace(
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    (_, mod) => `__proxy__("${mod}")`,
  );

  // Instrument loops: inject iteration counter at the start of loop bodies
  // for/while/do-while — inject `if (++__lc_N > MAX) throw new Error("__loop_limit__")`
  let loopId = 0;
  const loopDecls: string[] = [];

  // for loops
  result = result.replace(
    /\b(for\s*\([^)]*\)\s*)\{/g,
    (match) => {
      const id = loopId++;
      loopDecls.push(`let __lc_${id} = 0;`);
      return match.replace(
        "{",
        `{ if (++__lc_${id} > ${maxLoopIters}) throw new Error("__loop_limit__: loop ${id} exceeded ${maxLoopIters} iterations");`,
      );
    },
  );

  // while loops
  result = result.replace(
    /\b(while\s*\([^)]*\)\s*)\{/g,
    (match) => {
      const id = loopId++;
      loopDecls.push(`let __lc_${id} = 0;`);
      return match.replace(
        "{",
        `{ if (++__lc_${id} > ${maxLoopIters}) throw new Error("__loop_limit__: loop ${id} exceeded ${maxLoopIters} iterations");`,
      );
    },
  );

  // Prepend loop counter declarations
  if (loopDecls.length > 0) {
    result = loopDecls.join("\n") + "\n" + result;
  }

  // Remove export keywords (not valid in vm context)
  result = result.replace(/\bexport\s+(default\s+)?/g, "");

  return result;
}

// ── Finding analysis ─────────────────────────────────────

interface AnalysisContext {
  maxCalls: number;
  maxLoopIters: number;
  timedOut: boolean;
  proxyPaths: Set<string>;
}

function analyzeEvents(
  events: TraceEvent[],
  ctx: AnalysisContext,
): TraceFinding[] {
  const findings: TraceFinding[] = [];

  if (ctx.timedOut) {
    findings.push({
      id: "infinite-loop",
      severity: "error",
      message: "Execution timed out — likely infinite loop or recursion",
      confidence: "high",
      event: { type: "call", target: "<timeout>", count: 0 },
    });
  }

  for (const ev of events) {
    if (ev.type === "call" && ev.count > ctx.maxCalls) {
      const isProxyDerived = ctx.proxyPaths.has(ev.target);
      const confidence: Confidence = isProxyDerived ? "medium" : "high";
      findings.push({
        id: "excessive-calls",
        severity: "warning",
        message: `${ev.target} called ${ev.count} times (threshold: ${ctx.maxCalls})`,
        confidence,
        event: ev,
        caveat:
          confidence === "medium"
            ? "Call count measured under proxy execution; real count may differ based on actual return values"
            : undefined,
      });
    }

    if (ev.type === "get" && ev.count > ctx.maxCalls * 10) {
      findings.push({
        id: "excessive-property-access",
        severity: "info",
        message: `${ev.target} accessed ${ev.count} times`,
        confidence: "low",
        event: ev,
        caveat:
          "Property access count measured under proxy execution; may include proxy chain amplification",
      });
    }
  }

  return findings;
}

// ── Main trace functions ─────────────────────────────────

/** Rewrite + execute + analyze in one call. */
export function trace(
  source: string,
  lang: Language,
  opts: TraceOptions = {},
): TraceResult {
  const { timeout = 5000, globals = {}, thresholds = {} } = opts;
  const maxCalls = thresholds.maxCalls ?? 1000;
  const maxLoopIters = thresholds.maxLoopIters ?? 10_000;

  const rewritten = rewriteSource(source, lang, maxLoopIters);
  const fullSource = PROXY_RUNTIME + "\n" + rewritten;

  const traceState = {
    events: new Map<string, TraceEvent>(),
    proxyPaths: new Set<string>(),
  };

  const sandboxObj: Record<string, unknown> = {
    ...globals,
    __trace__: traceState,
    __proxy__: null, // assigned by PROXY_RUNTIME
    console: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    process: undefined,
  };
  const sandbox = vm.createContext(sandboxObj);

  const start = performance.now();
  let timedOut = false;
  let loopLimitHit: string | null = null;

  try {
    const script = new vm.Script(fullSource, { filename: "trace-sandbox.js" });
    script.runInContext(sandbox, { timeout });
  } catch (err: any) {
    const msg = err?.message ?? "";
    if (err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || msg.includes("Script execution timed out")) {
      timedOut = true;
    } else if (msg.startsWith("__loop_limit__")) {
      loopLimitHit = msg;
    } else if (msg.includes("Maximum call stack size exceeded")) {
      // Stack overflow from infinite recursion — treat like infinite loop
      timedOut = true;
    } else {
      // Execution error — still collect whatever telemetry we have
    }
  }

  const durationMs = performance.now() - start;
  const events = Array.from(traceState.events.values());
  const findings = analyzeEvents(events, {
    maxCalls,
    maxLoopIters,
    timedOut,
    proxyPaths: traceState.proxyPaths,
  });

  if (loopLimitHit) {
    findings.push({
      id: "excessive-iterations",
      severity: "warning",
      message: loopLimitHit.replace("__loop_limit__: ", ""),
      confidence: "high",
      event: { type: "call", target: "<loop>", count: maxLoopIters },
    });
  }

  return { events, findings, timedOut, durationMs };
}

/** File-based convenience: reads file, detects language, traces. */
export function traceFile(
  filePath: string,
  opts?: TraceOptions,
): TraceResult {
  const source = fs.readFileSync(filePath, "utf-8");
  const lang = detectLanguage(filePath);
  return trace(source, lang, opts);
}
