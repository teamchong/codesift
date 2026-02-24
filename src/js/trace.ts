/**
 * Behavioral trace engine — proxy-instrumented code execution.
 *
 * Rewrites source code to replace imports/globals with JS Proxy objects,
 * executes in a sandboxed vm context, and collects runtime telemetry.
 */
import * as vm from "node:vm";
import * as fs from "node:fs";
import { detectLanguage, isWasmLanguage } from "./ts/index.js";
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
// __trace__ and __proxy__ are provided by the sandbox context.

function __track__(type, key, args) {
  __trace__.proxyPaths.add(key);
  var k = type + ":" + key;
  var ev = __trace__.events.get(k);
  if (!ev) { ev = { type: type, target: key, count: 0 }; if (args) ev.args = []; __trace__.events.set(k, ev); }
  ev.count++;
  if (args && ev.args.length < 5) ev.args.push(args.map(function(a) { try { return String(a).slice(0, 100); } catch(e) { return "?"; } }));
  return ev;
}

__proxy__ = function __proxy__(name) {
  return new Proxy(function(){}, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive || prop === "valueOf") return () => 1;
      if (prop === Symbol.iterator) return function*() {};
      if (prop === "then") return undefined;
      if (prop === "toString") return () => "[proxy:" + name + "]";
      var path = name + "." + String(prop);
      __track__("get", path);
      return __proxy__(path);
    },
    apply(_, __, args) {
      __track__("call", name, args);
      return __proxy__(name + "(...)");
    },
    construct(_, args) {
      __track__("construct", "new " + name, args);
      return __proxy__(name);
    },
    set(_, prop) {
      __track__("set", name + "." + String(prop));
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

// ── AST rewriting (regex-based) ──────────────────────────

/** Rewrite source: replace imports/requires with proxy stubs, instrument loops. */
export function rewriteSource(
  source: string,
  lang: Language,
  maxLoopIters = 10_000,
): string {
  if (!isWasmLanguage(lang)) return source;

  let result = source;

  // Replace imports with proxy stubs
  // import X from 'mod'
  result = result.replace(
    /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g,
    (_, name, mod) => `const ${name} = __proxy__("${mod}");`,
  );
  // import { a, b as c } from 'mod'
  result = result.replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (_, names: string, mod: string) => {
      const bindings = names.split(",").map((n) => n.trim()).filter(Boolean).map((n) => {
        const [imported, local] = n.split(/\s+as\s+/).map((s) => s.trim());
        return `const ${local ?? imported} = __proxy__("${mod}.${imported}");`;
      });
      return bindings.join(" ");
    },
  );
  // import * as X from 'mod'
  result = result.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    (_, name, mod) => `const ${name} = __proxy__("${mod}");`,
  );
  // require() → __proxy__
  result = result.replace(
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    (_, mod) => `__proxy__("${mod}")`,
  );

  // Instrument for/while loops with iteration counters
  let loopId = 0;
  const loopDecls: string[] = [];
  const instrumentLoop = (match: string) => {
    const id = loopId++;
    loopDecls.push(`let __lc_${id} = 0;`);
    return match.replace("{", `{ if (++__lc_${id} > ${maxLoopIters}) throw new Error("__loop_limit__: loop ${id} exceeded ${maxLoopIters} iterations");`);
  };
  result = result.replace(/\b(for\s*\([^)]*\)\s*)\{/g, instrumentLoop);
  result = result.replace(/\b(while\s*\([^)]*\)\s*)\{/g, instrumentLoop);

  if (loopDecls.length > 0) {
    result = loopDecls.join("\n") + "\n" + result;
  }

  // Remove export keywords (not valid in vm context)
  result = result.replace(/\bexport\s+(default\s+)?/g, "");

  return result;
}

// ── Finding analysis ─────────────────────────────────────

function analyzeEvents(
  events: TraceEvent[],
  maxCalls: number,
  timedOut: boolean,
  proxyPaths: Set<string>,
): TraceFinding[] {
  const findings: TraceFinding[] = [];

  if (timedOut) {
    findings.push({
      id: "infinite-loop",
      severity: "error",
      message: "Execution timed out — likely infinite loop or recursion",
      confidence: "high",
      event: { type: "call", target: "<timeout>", count: 0 },
    });
  }

  for (const ev of events) {
    if (ev.type === "call" && ev.count > maxCalls) {
      const confidence: Confidence = proxyPaths.has(ev.target) ? "medium" : "high";
      findings.push({
        id: "excessive-calls",
        severity: "warning",
        message: `${ev.target} called ${ev.count} times (threshold: ${maxCalls})`,
        confidence,
        event: ev,
        caveat: confidence === "medium"
          ? "Call count measured under proxy execution; real count may differ based on actual return values"
          : undefined,
      });
    }

    if (ev.type === "get" && ev.count > maxCalls * 10) {
      findings.push({
        id: "excessive-property-access",
        severity: "info",
        message: `${ev.target} accessed ${ev.count} times`,
        confidence: "low",
        event: ev,
        caveat: "Property access count measured under proxy execution; may include proxy chain amplification",
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
  const traceState = {
    events: new Map<string, TraceEvent>(),
    proxyPaths: new Set<string>(),
  };

  const sandbox = vm.createContext({
    ...globals,
    __trace__: traceState,
    __proxy__: null,
    console: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    process: undefined,
  });

  const start = performance.now();
  let timedOut = false;
  let loopLimitHit: string | null = null;

  try {
    new vm.Script(PROXY_RUNTIME + "\n" + rewritten, { filename: "trace-sandbox.js" })
      .runInContext(sandbox, { timeout });
  } catch (err: any) {
    const msg = err?.message ?? "";
    if (err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || msg.includes("Script execution timed out")) {
      timedOut = true;
    } else if (msg.startsWith("__loop_limit__")) {
      loopLimitHit = msg;
    } else if (msg.includes("Maximum call stack size exceeded")) {
      timedOut = true;
    }
  }

  const durationMs = performance.now() - start;
  const events = Array.from(traceState.events.values());
  const findings = analyzeEvents(events, maxCalls, timedOut, traceState.proxyPaths);

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
export function traceFile(filePath: string, opts?: TraceOptions): TraceResult {
  return trace(fs.readFileSync(filePath, "utf-8"), detectLanguage(filePath), opts);
}
