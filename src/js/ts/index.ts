import { wasmBase64 } from "./engine-wasm.generated.js";
import { langToInt, isWasmLanguage } from "../types.js";
import type { Language, Finding, Match, RichMatch, NodeInfo } from "../types.js";

export type { Language, RuleDefinition, RuleNode, StopBy, MetavarConstraint, TransformOp, Finding, Match, RichMatch, NodeInfo, TraceOptions, TraceEvent, TraceFinding, TraceResult, Confidence } from "../types.js";
export { langToInt, detectLanguage, isWasmLanguage } from "../types.js";
export { encodeRules } from "../encoder.js";
export { rewriteSource, trace, traceFile } from "../trace.js";

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined")
    return new Uint8Array(Buffer.from(b64, "base64").buffer);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  dealloc(ptr: number, size: number): void;
  struct_match(pat_ptr: number, pat_len: number, src_ptr: number, src_len: number, lang: number): void;
  get_result_ptr(): number;
  get_result_len(): number;
  compile_pattern(pat_ptr: number, pat_len: number, lang: number): number;
  match_pattern(handle: number, src_ptr: number, src_len: number): void;
  free_pattern(handle: number): void;
  compile_source(src_ptr: number, src_len: number, lang: number): number;
  match_compiled(pat_handle: number, src_handle: number): void;
  free_source(handle: number): void;
  store_matches(): number;
  filter_inside(matches_h: number, ctx_h: number): void;
  filter_not_inside(matches_h: number, ctx_h: number): void;
  filter_not(matches_h: number, excl_h: number): void;
  intersect_matches(a_h: number, b_h: number): void;
  free_matches(handle: number): void;
  kind_match(src_handle: number, kind_ptr: number, kind_len: number): void;
  match_in_range(pat_handle: number, src_handle: number, start_byte: number, end_byte: number): void;
  match_preceding(pat_handle: number, src_handle: number, node_start: number, node_end: number): void;
  match_following(pat_handle: number, src_handle: number, node_start: number, node_end: number): void;
  load_ruleset(bytecode_ptr: number, bytecode_len: number): number;
  apply_ruleset(ruleset_handle: number, src_handle: number): void;
  free_ruleset(handle: number): void;
  get_ruleset_result_ptr(): number;
  get_ruleset_result_len(): number;
  // Tree traversal
  node_root(src_handle: number): void;
  node_info(src_handle: number, start_byte: number, end_byte: number, is_root: number): void;
  node_children(src_handle: number, start_byte: number, end_byte: number, is_root: number): void;
  node_named_children(src_handle: number, start_byte: number, end_byte: number, is_root: number): void;
  node_parent(src_handle: number, start_byte: number, end_byte: number, is_root: number): void;
  node_field_child(src_handle: number, start_byte: number, end_byte: number, is_root: number, name_ptr: number, name_len: number): void;
  node_next(src_handle: number, start_byte: number, end_byte: number, is_root: number): void;
  node_prev(src_handle: number, start_byte: number, end_byte: number, is_root: number): void;
}

const { instance } = await WebAssembly.instantiate(
  decodeBase64(wasmBase64) as BufferSource, { env: {} },
) as WebAssembly.WebAssemblyInstantiatedSource;
const wasm = instance.exports as unknown as WasmExports;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── WASM helpers ─────────────────────────────────────────

/** Encode string into WASM linear memory. Caller must dealloc. Returns [ptr, len] or null. */
function writeStr(s: string): [number, number] | null {
  const bytes = enc.encode(s);
  if (bytes.length === 0) return null;
  const ptr = wasm.alloc(bytes.length);
  if (!ptr) return null;
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}

function readResult(): Match[] {
  const ptr = wasm.get_result_ptr();
  const len = wasm.get_result_len();
  if (len < 4) return [];

  // Binary protocol: [4B count] then per match:
  //   [4B sb][4B eb][4B sr][4B sc][4B er][4B ec][4B binding_count]
  //   per binding: [4B name_len][name_bytes][4B text_len][text_bytes]
  const view = new DataView(wasm.memory.buffer, ptr, len);
  const count = view.getUint32(0, true);
  if (count === 0) return [];

  const matches: Match[] = [];
  let offset = 4;

  for (let i = 0; i < count; i++) {
    const start_byte = view.getUint32(offset, true); offset += 4;
    const end_byte = view.getUint32(offset, true); offset += 4;
    const start_row = view.getUint32(offset, true); offset += 4;
    const start_col = view.getUint32(offset, true); offset += 4;
    const end_row = view.getUint32(offset, true); offset += 4;
    const end_col = view.getUint32(offset, true); offset += 4;
    const bindingCount = view.getUint32(offset, true); offset += 4;

    const bindings: Record<string, string> = {};
    for (let b = 0; b < bindingCount; b++) {
      const nameLen = view.getUint32(offset, true); offset += 4;
      const name = dec.decode(new Uint8Array(wasm.memory.buffer, ptr + offset, nameLen)); offset += nameLen;
      const textLen = view.getUint32(offset, true); offset += 4;
      const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr + offset, textLen)); offset += textLen;
      bindings[name] = text;
    }

    matches.push({ start_byte, end_byte, start_row, start_col, end_row, end_col, bindings });
  }

  return matches;
}

function readRulesetResult(): Finding[] {
  const ptr = wasm.get_ruleset_result_ptr();
  const len = wasm.get_ruleset_result_len();
  if (len === 0) return [];
  return JSON.parse(dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len)));
}

function readResultJson(): string | null {
  const ptr = wasm.get_result_ptr();
  const len = wasm.get_result_len();
  if (len === 0) return null;
  return dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
}

function readNodeResult(): NodeInfo | null {
  const str = readResultJson();
  if (!str || str === "null") return null;
  return JSON.parse(str);
}

function readNodeArrayResult(): NodeInfo[] {
  const str = readResultJson();
  if (!str) return [];
  return JSON.parse(str);
}

// ── Pattern matching ─────────────────────────────────────

export function extractMatchText(source: string, m: Match): string {
  return dec.decode(enc.encode(source).slice(m.start_byte, m.end_byte));
}

/** One-shot pattern match against source code. */
export function structMatch(pattern: string, source: string, lang: Language): Match[] {
  if (!isWasmLanguage(lang)) return [];

  const pat = writeStr(pattern);
  const src = writeStr(source);
  if (!pat || !src) {
    if (pat) wasm.dealloc(pat[0], pat[1]);
    if (src) wasm.dealloc(src[0], src[1]);
    return [];
  }

  try {
    wasm.struct_match(pat[0], pat[1], src[0], src[1], langToInt(lang));
    return readResult();
  } finally {
    wasm.dealloc(pat[0], pat[1]);
    wasm.dealloc(src[0], src[1]);
  }
}

// ── AOT compiled patterns ────────────────────────────────

/** Compile a pattern for repeated matching. Returns handle (0 = error). */
export function compilePattern(pattern: string, lang: Language): number {
  if (!isWasmLanguage(lang)) return 0;
  const buf = writeStr(pattern);
  if (!buf) return 0;
  const handle = wasm.compile_pattern(buf[0], buf[1], langToInt(lang));
  wasm.dealloc(buf[0], buf[1]);
  return handle;
}

/** Match a compiled pattern against source. */
export function matchPattern(handle: number, source: string): Match[] {
  if (handle === 0) return [];
  const buf = writeStr(source);
  if (!buf) return [];
  try {
    wasm.match_pattern(handle, buf[0], buf[1]);
    return readResult();
  } finally {
    wasm.dealloc(buf[0], buf[1]);
  }
}

export function freePattern(handle: number): void {
  if (handle > 0) wasm.free_pattern(handle);
}

// ── Scanner ──────────────────────────────────────────────

export interface Scanner {
  match(pattern: string): Match[];
  matchKind(kind: string): Match[];
  scanAll(patterns: string[]): RichMatch[];
  root(): SgNode;
  readonly source: string;
  readonly language: Language;
  readonly _srcHandle: number;
  free(): void;
}

export function createScanner(
  source: string,
  lang: Language,
): Scanner {
  const sourceBytes = enc.encode(source);
  const noopScanner: Scanner = {
    match: () => [],
    matchKind: () => [],
    scanAll: () => [],
    root: () => new SgNode(0, lang, source, sourceBytes, { kind: "program", sb: 0, eb: sourceBytes.length, sr: 0, sc: 0, er: 0, ec: 0, named: true, cc: 0, ncc: 0 }),
    source,
    language: lang,
    _srcHandle: 0,
    free: () => {},
  };

  if (!isWasmLanguage(lang)) return noopScanner;

  const buf = writeStr(source);
  if (!buf) return noopScanner;

  let srcHandle = wasm.compile_source(buf[0], buf[1], langToInt(lang));
  wasm.dealloc(buf[0], buf[1]);
  if (srcHandle === 0) return noopScanner;

  // Pattern cache: avoid recompiling the same pattern string on every match call
  const patternCache = new Map<string, number>();

  function cachedCompile(pattern: string): number {
    let h = patternCache.get(pattern);
    if (h !== undefined) return h;
    h = compilePattern(pattern, lang);
    if (h > 0) patternCache.set(pattern, h);
    return h;
  }

  function rawMatch(pattern: string): Match[] {
    if (srcHandle === 0) return [];
    const patHandle = cachedCompile(pattern);
    if (patHandle === 0) return [];
    wasm.match_compiled(patHandle, srcHandle);
    return readResult();
  }

  function rawKindMatch(kind: string): Match[] {
    if (srcHandle === 0) return [];
    const buf = writeStr(kind);
    if (!buf) return [];
    try {
      wasm.kind_match(srcHandle, buf[0], buf[1]);
      return readResult();
    } finally {
      wasm.dealloc(buf[0], buf[1]);
    }
  }

  return {
    match: rawMatch,
    matchKind: rawKindMatch,

    scanAll(patterns: string[]): RichMatch[] {
      const results: RichMatch[] = [];
      for (const pat of patterns) {
        for (const m of rawMatch(pat)) {
          results.push({ ...m, pattern: pat, text: dec.decode(sourceBytes.slice(m.start_byte, m.end_byte)) });
        }
      }
      return results;
    },

    root(): SgNode {
      wasm.node_root(srcHandle);
      const info = readNodeResult();
      if (!info) return new SgNode(srcHandle, lang, source, sourceBytes, { kind: "program", sb: 0, eb: sourceBytes.length, sr: 0, sc: 0, er: 0, ec: 0, named: true, cc: 0, ncc: 0 }, true, cachedCompile);
      return new SgNode(srcHandle, lang, source, sourceBytes, info, true, cachedCompile);
    },

    source,
    language: lang,
    get _srcHandle() { return srcHandle; },

    free(): void {
      for (const h of patternCache.values()) freePattern(h);
      patternCache.clear();
      if (srcHandle > 0) {
        wasm.free_source(srcHandle);
        srcHandle = 0;
      }
    },
  };
}

// ── Match slot operations ────────────────────────────────

export function storeMatches(): number { return wasm.store_matches(); }

export function filterInside(matchesH: number, ctxH: number): Match[] {
  wasm.filter_inside(matchesH, ctxH);
  return readResult();
}

export function filterNotInside(matchesH: number, ctxH: number): Match[] {
  wasm.filter_not_inside(matchesH, ctxH);
  return readResult();
}

export function filterNot(matchesH: number, exclH: number): Match[] {
  wasm.filter_not(matchesH, exclH);
  return readResult();
}

export function intersectMatches(aH: number, bH: number): Match[] {
  wasm.intersect_matches(aH, bH);
  return readResult();
}

export function freeMatches(handle: number): void {
  if (handle > 0) wasm.free_matches(handle);
}

export function matchInRange(patH: number, srcH: number, start: number, end: number): Match[] {
  wasm.match_in_range(patH, srcH, start, end);
  return readResult();
}

export function matchPreceding(patH: number, srcH: number, start: number, end: number): Match[] {
  wasm.match_preceding(patH, srcH, start, end);
  return readResult();
}

export function matchFollowing(patH: number, srcH: number, start: number, end: number): Match[] {
  wasm.match_following(patH, srcH, start, end);
  return readResult();
}

// ── Tree traversal (SgNode) ──────────────────────────────

/** ast-grep style tree node. Navigate the CST and match patterns at any subtree. */
export class SgNode {
  private _srcHandle: number;
  private _lang: Language;
  private _source: string;
  private _sourceBytes: Uint8Array;
  private _info: NodeInfo;
  private _isRoot: boolean;
  private _compile: ((pattern: string) => number) | null;

  /** @internal — use scanner.root() to create */
  constructor(srcHandle: number, lang: Language, source: string, sourceBytes: Uint8Array, info: NodeInfo, isRoot = false, compileFn: ((pattern: string) => number) | null = null) {
    this._srcHandle = srcHandle;
    this._lang = lang;
    this._source = source;
    this._sourceBytes = sourceBytes;
    this._info = info;
    this._isRoot = isRoot;
    this._compile = compileFn;
  }

  private _ir(): number { return this._isRoot ? 1 : 0; }

  private _makeNode(info: NodeInfo | null): SgNode | null {
    if (!info) return null;
    return new SgNode(this._srcHandle, this._lang, this._source, this._sourceBytes, info, false, this._compile);
  }

  /** Node type string (e.g. "call_expression", "identifier"). */
  kind(): string { return this._info.kind; }

  /** Source text spanned by this node. */
  text(): string {
    return dec.decode(this._sourceBytes.slice(this._info.sb, this._info.eb));
  }

  /** Whether this is a named node (vs anonymous punctuation). */
  isNamed(): boolean { return this._info.named; }

  /** Byte range of this node. */
  range(): { startByte: number; endByte: number; startRow: number; startCol: number; endRow: number; endCol: number } {
    return {
      startByte: this._info.sb,
      endByte: this._info.eb,
      startRow: this._info.sr,
      startCol: this._info.sc,
      endRow: this._info.er,
      endCol: this._info.ec,
    };
  }

  /** Total child count (named + anonymous). */
  childCount(): number { return this._info.cc; }

  /** Named child count. */
  namedChildCount(): number { return this._info.ncc; }

  /** Get all children (named + anonymous). */
  children(): SgNode[] {
    wasm.node_children(this._srcHandle, this._info.sb, this._info.eb, this._ir());
    return readNodeArrayResult().map(info => this._makeNode(info)!);
  }

  /** Get named children only. */
  namedChildren(): SgNode[] {
    wasm.node_named_children(this._srcHandle, this._info.sb, this._info.eb, this._ir());
    return readNodeArrayResult().map(info => this._makeNode(info)!);
  }

  /** Get child by index (all children). */
  child(index: number): SgNode | null {
    const kids = this.children();
    return kids[index] ?? null;
  }

  /** Get child by field name (e.g. "function", "arguments"). */
  field(name: string): SgNode | null {
    const buf = writeStr(name);
    if (!buf) return null;
    try {
      wasm.node_field_child(this._srcHandle, this._info.sb, this._info.eb, this._ir(), buf[0], buf[1]);
      return this._makeNode(readNodeResult());
    } finally {
      wasm.dealloc(buf[0], buf[1]);
    }
  }

  /** Parent node, or null if root. */
  parent(): SgNode | null {
    if (this._isRoot) return null;
    wasm.node_parent(this._srcHandle, this._info.sb, this._info.eb, 0);
    const info = readNodeResult();
    if (!info) return null;
    // Check if parent is root (program node at top level)
    wasm.node_root(this._srcHandle);
    const rootInfo = readNodeResult();
    const parentIsRoot = rootInfo && info.sb === rootInfo.sb && info.eb === rootInfo.eb && info.kind === rootInfo.kind;
    return new SgNode(this._srcHandle, this._lang, this._source, this._sourceBytes, info, !!parentIsRoot, this._compile);
  }

  /** Next named sibling. */
  next(): SgNode | null {
    wasm.node_next(this._srcHandle, this._info.sb, this._info.eb, this._ir());
    return this._makeNode(readNodeResult());
  }

  /** Previous named sibling. */
  prev(): SgNode | null {
    wasm.node_prev(this._srcHandle, this._info.sb, this._info.eb, this._ir());
    return this._makeNode(readNodeResult());
  }

  private _compilePattern(pattern: string): number {
    if (this._compile) return this._compile(pattern);
    return compilePattern(pattern, this._lang);
  }

  private _freePatternIfUncached(handle: number): void {
    if (!this._compile) freePattern(handle);
  }

  /** Find first descendant matching a structural pattern. */
  find(pattern: string): SgNode | null {
    const patHandle = this._compilePattern(pattern);
    if (patHandle === 0) return null;
    try {
      wasm.match_in_range(patHandle, this._srcHandle, this._info.sb, this._info.eb);
      const matches = readResult();
      if (matches.length === 0) return null;
      const m = matches[0];
      wasm.node_info(this._srcHandle, m.start_byte, m.end_byte, 0);
      const info = readNodeResult();
      return this._makeNode(info);
    } finally {
      this._freePatternIfUncached(patHandle);
    }
  }

  /** Find all descendants matching a structural pattern. */
  findAll(pattern: string): SgNode[] {
    const patHandle = this._compilePattern(pattern);
    if (patHandle === 0) return [];
    try {
      wasm.match_in_range(patHandle, this._srcHandle, this._info.sb, this._info.eb);
      const matches = readResult();
      // Deduplicate by byte range (same pattern can match at different AST levels)
      const seen = new Set<string>();
      const nodes: SgNode[] = [];
      for (const m of matches) {
        const key = `${m.start_byte}:${m.end_byte}`;
        if (seen.has(key)) continue;
        seen.add(key);
        wasm.node_info(this._srcHandle, m.start_byte, m.end_byte, 0);
        const info = readNodeResult();
        const node = this._makeNode(info);
        if (node) nodes.push(node);
      }
      return nodes;
    } finally {
      this._freePatternIfUncached(patHandle);
    }
  }

  /** Check if this node matches a structural pattern. */
  matches(pattern: string): boolean {
    const patHandle = this._compilePattern(pattern);
    if (patHandle === 0) return false;
    try {
      wasm.match_in_range(patHandle, this._srcHandle, this._info.sb, this._info.eb);
      const results = readResult();
      return results.some(m => m.start_byte === this._info.sb && m.end_byte === this._info.eb);
    } finally {
      this._freePatternIfUncached(patHandle);
    }
  }
}

// ── Rule engine ──────────────────────────────────────────

export interface CompiledRuleset {
  apply(scanner: Scanner): Finding[];
  free(): void;
}

export function loadRules(bytecode: Uint8Array): CompiledRuleset {
  const ptr = wasm.alloc(bytecode.length);
  if (!ptr) throw new Error("WASM alloc failed for bytecode");
  new Uint8Array(wasm.memory.buffer, ptr, bytecode.length).set(bytecode);

  const handle = wasm.load_ruleset(ptr, bytecode.length);
  if (handle === 0) {
    wasm.dealloc(ptr, bytecode.length);
    throw new Error("Failed to load ruleset");
  }

  // Bytecode buffer must stay alive — WASM holds offset references into it
  return {
    apply(scanner: Scanner): Finding[] {
      if (scanner._srcHandle === 0) return [];
      wasm.apply_ruleset(handle, scanner._srcHandle);
      return readRulesetResult();
    },
    free(): void {
      wasm.free_ruleset(handle);
      wasm.dealloc(ptr, bytecode.length);
    },
  };
}
