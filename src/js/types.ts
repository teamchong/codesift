export type Language = "javascript" | "typescript" | "tsx";

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
