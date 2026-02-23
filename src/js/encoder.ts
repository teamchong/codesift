import type { RuleDefinition, RuleNode, StopBy, Language } from "./types.js";

// ── Opcodes ──────────────────────────────────────────────

const OP_PATTERN = 0x01;
const OP_KIND = 0x02;
const OP_REGEX = 0x03;
const OP_NTH_CHILD = 0x04;
const OP_ALL = 0x10;
const OP_ANY = 0x11;
const OP_NOT = 0x12;
const OP_INSIDE = 0x13;
const OP_HAS = 0x14;
const OP_FOLLOWS = 0x15;
const OP_PRECEDES = 0x16;
const OP_MATCHES = 0x17;
const OP_CONSTRAINT = 0x30;
const OP_TRANSFORM = 0x31;
const OP_STOPBY_END = 0x40;
const OP_STOPBY_NEIGHBOR = 0x41;
const OP_STOPBY_RULE = 0x42;
const OP_RULE = 0x50;
const OP_RULESET = 0xff;

// ── Severity ─────────────────────────────────────────────

const SEVERITY_MAP: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

// ── Language mapping ─────────────────────────────────────

const LANG_MAP: Record<Language, number> = {
  javascript: 1,
  typescript: 2,
  tsx: 3,
};

// ── Encoder ──────────────────────────────────────────────

const textEnc = new TextEncoder();

class BytecodeWriter {
  private buf: number[] = [];

  writeU8(v: number): void { this.buf.push(v & 0xff); }

  writeU16(v: number): void {
    this.buf.push(v & 0xff, (v >> 8) & 0xff);
  }

  writeU32(v: number): void {
    this.buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  writeString(s: string): void {
    const bytes = textEnc.encode(s);
    this.writeU16(bytes.length);
    for (const b of bytes) this.buf.push(b);
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

export function encodeRules(rules: RuleDefinition[]): Uint8Array {
  const w = new BytecodeWriter();

  // Header
  w.writeU8(OP_RULESET);
  w.writeU16(1); // version
  w.writeU16(rules.length);

  // Build a map of rule IDs to indices for `matches` references
  const ruleIndexMap = new Map<string, number>();
  rules.forEach((r, i) => ruleIndexMap.set(r.id, i));

  for (const rule of rules) {
    encodeRule(w, rule, ruleIndexMap);
  }

  return w.toUint8Array();
}

function encodeRule(
  w: BytecodeWriter,
  rule: RuleDefinition,
  ruleIndexMap: Map<string, number>,
): void {
  w.writeU8(OP_RULE);
  w.writeString(rule.id);
  w.writeU8(SEVERITY_MAP[rule.severity ?? "error"] ?? 0);
  w.writeString(rule.message);
  w.writeU8(LANG_MAP[rule.language] ?? 0);

  const constraintEntries = rule.constraints
    ? Object.entries(rule.constraints)
    : [];
  // Each constraint entry can produce 1 or 2 bytecode constraints (regex + notRegex)
  const constraintOps: Array<{
    metavar: string;
    type: number;
    pattern: string;
  }> = [];
  for (const [name, c] of constraintEntries) {
    if (c.regex) constraintOps.push({ metavar: name, type: 0, pattern: c.regex });
    if (c.notRegex)
      constraintOps.push({ metavar: name, type: 1, pattern: c.notRegex });
  }

  w.writeU16(constraintOps.length);
  for (const c of constraintOps) {
    w.writeU8(OP_CONSTRAINT);
    w.writeString(c.metavar);
    w.writeU8(c.type);
    w.writeString(c.pattern);
  }

  const transformEntries = rule.transform
    ? Object.entries(rule.transform)
    : [];
  w.writeU16(transformEntries.length);
  for (const [, t] of transformEntries) {
    w.writeU8(OP_TRANSFORM);
    w.writeString(t.source);
    // Encode op type + serialized arg
    if (t.substring) {
      w.writeU8(0); // substring
      w.writeString(
        JSON.stringify({ start: t.substring.start, end: t.substring.end }),
      );
    } else if (t.replace) {
      w.writeU8(1); // replace
      w.writeString(
        JSON.stringify({
          regex: t.replace.regex,
          replacement: t.replace.replacement,
        }),
      );
    } else if (t.convert) {
      w.writeU8(2); // convert
      w.writeString(t.convert);
    } else {
      w.writeU8(0);
      w.writeString("");
    }
  }

  encodeRuleNode(w, rule.rule, ruleIndexMap);
}

function encodeRuleNode(
  w: BytecodeWriter,
  node: RuleNode,
  ruleIndexMap: Map<string, number>,
): void {
  if ("pattern" in node) {
    w.writeU8(OP_PATTERN);
    w.writeString(node.pattern);
  } else if ("kind" in node) {
    w.writeU8(OP_KIND);
    w.writeString(node.kind);
  } else if ("regex" in node) {
    w.writeU8(OP_REGEX);
    w.writeString(node.regex);
  } else if ("nthChild" in node) {
    w.writeU8(OP_NTH_CHILD);
    w.writeU32(node.nthChild);
  } else if ("all" in node) {
    w.writeU8(OP_ALL);
    w.writeU16(node.all.length);
    for (const child of node.all) {
      encodeRuleNode(w, child, ruleIndexMap);
    }
  } else if ("any" in node) {
    w.writeU8(OP_ANY);
    w.writeU16(node.any.length);
    for (const child of node.any) {
      encodeRuleNode(w, child, ruleIndexMap);
    }
  } else if ("not" in node) {
    w.writeU8(OP_NOT);
    encodeRuleNode(w, node.not, ruleIndexMap);
  } else if ("inside" in node) {
    w.writeU8(OP_INSIDE);
    encodeStopBy(w, node.stopBy, ruleIndexMap);
    encodeRuleNode(w, node.inside, ruleIndexMap);
  } else if ("has" in node) {
    w.writeU8(OP_HAS);
    encodeStopBy(w, node.stopBy, ruleIndexMap);
    encodeRuleNode(w, node.has, ruleIndexMap);
  } else if ("follows" in node) {
    w.writeU8(OP_FOLLOWS);
    encodeStopBy(w, node.stopBy, ruleIndexMap);
    encodeRuleNode(w, node.follows, ruleIndexMap);
  } else if ("precedes" in node) {
    w.writeU8(OP_PRECEDES);
    encodeStopBy(w, node.stopBy, ruleIndexMap);
    encodeRuleNode(w, node.precedes, ruleIndexMap);
  } else if ("matches" in node) {
    w.writeU8(OP_MATCHES);
    w.writeU16(ruleIndexMap.get(node.matches) ?? 0);
  }
}

function encodeStopBy(
  w: BytecodeWriter,
  stopBy: StopBy | undefined,
  ruleIndexMap: Map<string, number>,
): void {
  if (!stopBy || stopBy === "neighbor") {
    w.writeU8(OP_STOPBY_NEIGHBOR);
  } else if (stopBy === "end") {
    w.writeU8(OP_STOPBY_END);
  } else {
    // stopBy is a RuleNode
    w.writeU8(OP_STOPBY_RULE);
    encodeRuleNode(w, stopBy, ruleIndexMap);
  }
}
