export type Language = "javascript" | "typescript" | "tsx";

// ── Language utilities ───────────────────────────────────

const LANG_MAP: Record<Language, number> = { javascript: 1, typescript: 2, tsx: 3 };

export function langToInt(lang: Language): number {
  return LANG_MAP[lang];
}

export function detectLanguage(filename: string): Language {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".ts")) return "typescript";
  return "javascript";
}

export function isWasmLanguage(lang: Language): boolean {
  return lang in LANG_MAP;
}

// ── Rule engine types ─────────────────────────────────────

export type StopBy = "end" | "neighbor" | RuleNode;

export type RuleNode =
  | { pattern: string }
  | { kind: string }
  | { regex: string }
  | { nthChild: number }
  | { all: RuleNode[] }
  | { any: RuleNode[] }
  | { not: RuleNode }
  | { inside: RuleNode; stopBy?: StopBy }
  | { has: RuleNode; stopBy?: StopBy }
  | { follows: RuleNode; stopBy?: StopBy }
  | { precedes: RuleNode; stopBy?: StopBy }
  | { matches: string };

export interface MetavarConstraint {
  regex?: string;
  notRegex?: string;
}

export interface TransformOp {
  source: string;
  substring?: { start: number; end?: number };
  replace?: { regex: string; replacement: string };
  convert?: "camelCase" | "snakeCase" | "upperCase" | "lowerCase";
}

export interface RuleDefinition {
  id: string;
  language: Language;
  severity?: "error" | "warning" | "info" | "hint";
  message: string;
  note?: string;
  rule: RuleNode;
  constraints?: Record<string, MetavarConstraint>;
  transform?: Record<string, TransformOp>;
}

export interface Match {
  start_row: number;
  start_col: number;
  end_row: number;
  end_col: number;
  start_byte: number;
  end_byte: number;
  bindings: Record<string, string>;
}

/** Match enriched with source text and originating pattern. Returned by scanAll(). */
export interface RichMatch extends Match {
  pattern: string;
  text: string;
}

export interface Finding {
  ruleId: string;
  severity: string;
  message: string;
  matches: Match[];
}

// ── Trace types ──────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

export interface TraceOptions {
  /** Execution timeout in ms (default: 5000) */
  timeout?: number;
  /** Custom global stubs: name → value (injected into sandbox) */
  globals?: Record<string, unknown>;
  /** Thresholds that trigger findings */
  thresholds?: {
    /** Max calls to a single function before flagging (default: 1000) */
    maxCalls?: number;
    /** Max iterations of a single loop before flagging (default: 10000) */
    maxLoopIters?: number;
  };
}

export interface TraceEvent {
  type: "call" | "get" | "set" | "construct";
  /** Fully-qualified name, e.g. "fs.readFileSync", "console.log" */
  target: string;
  count: number;
  /** Sample of stringified arg lists (max 5) */
  args?: string[][];
}

export interface TraceFinding {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
  confidence: Confidence;
  event: TraceEvent;
  /** Explanation when confidence < high (why this might be a false positive) */
  caveat?: string;
}

export interface TraceResult {
  events: TraceEvent[];
  findings: TraceFinding[];
  /** True if execution hit the timeout */
  timedOut: boolean;
  /** Wall-clock execution time in ms */
  durationMs: number;
}

// ── Tree traversal types ─────────────────────────────────

/** Raw node descriptor returned from WASM. */
export interface NodeInfo {
  kind: string;
  sb: number;
  eb: number;
  sr: number;
  sc: number;
  er: number;
  ec: number;
  named: boolean;
  cc: number;
  ncc: number;
}
