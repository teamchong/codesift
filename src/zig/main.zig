///! codesift — WASM export layer for structural pattern matching.
///!
///! This is the entry point for the WASM binary. It exports functions that
///! the JavaScript host calls to run structural AST pattern matching
///! against JS/TS source code via tree-sitter.
///!
///! Exported functions:
///!   alloc(size)                     -> ptr    Allocate WASM memory
///!   dealloc(ptr, size)              ->        Free WASM memory
///!   struct_match(pat, plen, src, slen, lang) -> Run pattern match
///!   get_result_ptr()        -> ptr    Pointer to match JSON
///!   get_result_len()        -> u32    Length of match JSON
///!   compile_pattern(pat, len, lang) -> handle Compile & cache pattern
///!   match_pattern(handle, src, len) ->        Match compiled pattern
///!   free_pattern(handle)            ->        Free cached pattern
///!   compile_source(src, len, lang)  -> handle Compile & cache source
///!   match_compiled(pat_h, src_h)    ->        Match compiled pair
///!   free_source(handle)             ->        Free cached source

const std = @import("std");
const rules = @import("rules.zig");
const gpa = @import("alloc.zig").gpa;

// ── Output buffer ────────────────────────────────────────

const MAX_OUTPUT = 64 * 1024; // 64 KB

// ── WASM memory management ───────────────────────────────

export fn alloc(size: u32) ?[*]u8 {
    const slice = gpa.alloc(u8, size) catch return null;
    return slice.ptr;
}

export fn dealloc(ptr: [*]u8, size: u32) void {
    gpa.free(ptr[0..size]);
}

// ── Structural pattern matching exports ──────────────────
//
// struct_match(pattern_ptr, pattern_len, source_ptr, source_len, lang)
//   → writes match result JSON to result_buf.
//
// The JS host passes a single pattern string + the source code. The
// engine parses both with tree-sitter, runs structural matching, and
// returns a JSON array of match objects with bindings.

const matcher = @import("matcher.zig");
const ts = @import("ts_bridge.zig");

var result_buf: [MAX_OUTPUT]u8 = undefined;
var result_len: u32 = 0;

fn toTsLang(lang: u32) ts.Language {
    const language: rules.Language = @enumFromInt(@as(u8, @truncate(lang)));
    return switch (language) {
        .javascript => .javascript,
        .typescript => .typescript,
        .tsx => .tsx,
    };
}

// Static parser pool — avoids repeated alloc/free of tree-sitter parsers
// which exhaust dlmalloc's WASM heap after multiple calls.
var static_js_parser: ?ts.Parser = null;
var static_ts_parser: ?ts.Parser = null;

fn getOrInitParser(ts_lang: ts.Language) ?*ts.Parser {
    const slot: *?ts.Parser = switch (ts_lang) {
        .javascript => &static_js_parser,
        .typescript, .tsx => &static_ts_parser,
    };
    if (slot.* == null) {
        slot.* = ts.Parser.init(ts_lang);
    }
    return if (slot.*) |*p| p else null;
}

export fn struct_match(
    pattern_ptr: [*]const u8,
    pattern_len: u32,
    source_ptr: [*]const u8,
    source_len: u32,
    lang: u32,
) void {
    const pattern_source = pattern_ptr[0..pattern_len];
    const source = source_ptr[0..source_len];
    const ts_lang = toTsLang(lang);

    // Reuse static parsers to avoid dlmalloc heap exhaustion in WASM.
    const parser = getOrInitParser(ts_lang) orelse {
        writeEmptyArray();
        return;
    };

    // Parse source
    var source_tree = parser.parse(source) orelse {
        writeEmptyArray();
        return;
    };

    // Parse pattern with the same parser (tree-sitter supports sequential parses)
    var pattern_tree = parser.parse(pattern_source) orelse {
        source_tree.deinit();
        parser.reset();
        writeEmptyArray();
        return;
    };

    // Run structural matching
    var matches = matcher.MatchList{};
    matcher.searchMatches(pattern_tree.rootNode(), source_tree.rootNode(), &matches, 0);
    last_match_list = matches;
    result_len = serializeMatches(&matches, &result_buf);

    // Free trees then reset parser to release all internal caches.
    // Critical for WASM where dlmalloc can't return freed pages to the OS.
    pattern_tree.deinit();
    source_tree.deinit();
    parser.reset();
}

fn writeEmptyArray() void {
    // Binary protocol: 4-byte count = 0
    result_len = 4;
    result_buf[0] = 0;
    result_buf[1] = 0;
    result_buf[2] = 0;
    result_buf[3] = 0;
}

export fn get_result_ptr() [*]const u8 {
    return &result_buf;
}

export fn get_result_len() u32 {
    return result_len;
}

// ── AOT compiled pattern cache ──────────────────────────
//
// compile_pattern(pat_ptr, pat_len, lang) → handle (1-based slot index, 0 = error)
// match_pattern(handle, src_ptr, src_len) → writes result JSON
// free_pattern(handle)                    → releases the cached tree
//
// Patterns are parsed once by tree-sitter and stored. Subsequent
// match_pattern calls skip the JS→WASM string copy and re-parse.

const MAX_COMPILED = 64;

const CompiledPattern = struct {
    tree: ts.Tree,
    lang: ts.Language,
    active: bool,
};

var compiled_slots: [MAX_COMPILED]?CompiledPattern = .{null} ** MAX_COMPILED;

/// Generic slot finder — replaces 4 identical findFreeXxxSlot functions.
fn findFree(comptime T: type, comptime N: usize, slots: *const [N]?T) ?u32 {
    for (0..N) |i| {
        if (slots[i] == null) return @intCast(i);
    }
    return null;
}

/// Compile a pattern string and cache the parsed AST. Returns a 1-based
/// handle (0 = error). The pattern string memory can be freed after this call.
export fn compile_pattern(
    pattern_ptr: [*]const u8,
    pattern_len: u32,
    lang: u32,
) u32 {
    const slot_idx = findFree(CompiledPattern, MAX_COMPILED, &compiled_slots) orelse return 0;
    const pattern_source = pattern_ptr[0..pattern_len];
    const ts_lang = toTsLang(lang);

    const parser = getOrInitParser(ts_lang) orelse return 0;

    var tree = parser.parse(pattern_source) orelse {
        parser.reset();
        return 0;
    };

    // Copy the pattern source into WASM-owned memory so the tree's
    // source slice stays valid after the caller frees the input buffer.
    const owned = gpa.alloc(u8, pattern_len) catch {
        tree.deinit();
        parser.reset();
        return 0;
    };
    @memcpy(owned, pattern_source);
    tree.source = owned;

    parser.reset();

    compiled_slots[slot_idx] = .{
        .tree = tree,
        .lang = ts_lang,
        .active = true,
    };

    return slot_idx + 1; // 1-based handle
}

/// Match a pre-compiled pattern against source code. Writes result JSON
/// to the result buffer (read via get_result_ptr/len).
export fn match_pattern(
    handle: u32,
    source_ptr: [*]const u8,
    source_len: u32,
) void {
    if (handle == 0 or handle > MAX_COMPILED) {
        writeEmptyArray();
        return;
    }

    const slot = compiled_slots[handle - 1] orelse {
        writeEmptyArray();
        return;
    };

    const source = source_ptr[0..source_len];
    const parser = getOrInitParser(slot.lang) orelse {
        writeEmptyArray();
        return;
    };

    var source_tree = parser.parse(source) orelse {
        parser.reset();
        writeEmptyArray();
        return;
    };

    var matches = matcher.MatchList{};
    matcher.searchMatches(slot.tree.rootNode(), source_tree.rootNode(), &matches, 0);
    last_match_list = matches;
    result_len = serializeMatches(&matches, &result_buf);

    source_tree.deinit();
    parser.reset();
}

/// Free a compiled pattern, releasing its cached AST.
export fn free_pattern(handle: u32) void {
    if (handle == 0 or handle > MAX_COMPILED) return;
    const idx = handle - 1;
    if (compiled_slots[idx]) |*slot| {
        // Free the owned source copy
        gpa.free(slot.tree.source);
        slot.tree.deinit();
        compiled_slots[idx] = null;
    }
}

// ── AOT compiled source cache ───────────────────────────
//
// compile_source(src_ptr, src_len, lang) → handle (1-based, 0 = error)
// match_compiled(pat_handle, src_handle) → writes result JSON
// free_source(handle)                    → releases the cached source tree

const MAX_SOURCES = 16;

const CompiledSource = struct {
    tree: ts.Tree,
    lang: ts.Language,
};

var source_slots: [MAX_SOURCES]?CompiledSource = .{null} ** MAX_SOURCES;

/// Compile source code and cache the parsed AST. Returns a 1-based handle.
export fn compile_source(
    source_ptr: [*]const u8,
    source_len: u32,
    lang: u32,
) u32 {
    const slot_idx = findFree(CompiledSource, MAX_SOURCES, &source_slots) orelse return 0;
    const source = source_ptr[0..source_len];
    const ts_lang = toTsLang(lang);

    const parser = getOrInitParser(ts_lang) orelse return 0;

    var tree = parser.parse(source) orelse {
        parser.reset();
        return 0;
    };

    // Copy source into WASM-owned memory
    const owned = gpa.alloc(u8, source_len) catch {
        tree.deinit();
        parser.reset();
        return 0;
    };
    @memcpy(owned, source);
    tree.source = owned;

    parser.reset();

    source_slots[slot_idx] = .{
        .tree = tree,
        .lang = ts_lang,
    };

    return slot_idx + 1;
}

/// Match a compiled pattern against a compiled source. Both ASTs are
/// already parsed — this is a pure tree walk, no parsing overhead.
export fn match_compiled(pat_handle: u32, src_handle: u32) void {
    if (pat_handle == 0 or pat_handle > MAX_COMPILED) {
        writeEmptyArray();
        return;
    }
    if (src_handle == 0 or src_handle > MAX_SOURCES) {
        writeEmptyArray();
        return;
    }

    const pat_slot = compiled_slots[pat_handle - 1] orelse {
        writeEmptyArray();
        return;
    };
    const src_slot = source_slots[src_handle - 1] orelse {
        writeEmptyArray();
        return;
    };

    var matches = matcher.MatchList{};
    matcher.searchMatches(pat_slot.tree.rootNode(), src_slot.tree.rootNode(), &matches, 0);
    last_match_list = matches;
    result_len = serializeMatches(&matches, &result_buf);
}

/// Free a compiled source, releasing its cached AST.
export fn free_source(handle: u32) void {
    if (handle == 0 or handle > MAX_SOURCES) return;
    const idx = handle - 1;
    if (source_slots[idx]) |*slot| {
        gpa.free(slot.tree.source);
        slot.tree.deinit();
        source_slots[idx] = null;
    }
}

// ── Match slot system ────────────────────────────────────
//
// After any match operation, the raw MatchList is saved to last_match_list.
// store_matches() moves it into a slot for later filtering/composition.
// Slots are 1-based handles (0 = error).

const MAX_MATCH_SLOTS = 4;

var last_match_list: matcher.MatchList = .{};
var match_slots: [MAX_MATCH_SLOTS]?matcher.MatchList = .{null} ** MAX_MATCH_SLOTS;

/// Move last_match_list into a slot. Returns 1-based handle (0 = error).
export fn store_matches() u32 {
    const idx = findFree(matcher.MatchList, MAX_MATCH_SLOTS, &match_slots) orelse return 0;
    match_slots[idx] = last_match_list;
    return idx + 1;
}

/// Shared filter dispatch — validates handles, copies first slot, applies filter, serializes.
fn runFilter(matches_h: u32, ctx_h: u32, comptime filterFn: fn (*matcher.MatchList, *const matcher.MatchList) matcher.MatchList) void {
    if (matches_h == 0 or matches_h > MAX_MATCH_SLOTS) { writeEmptyArray(); return; }
    if (ctx_h == 0 or ctx_h > MAX_MATCH_SLOTS) { writeEmptyArray(); return; }
    const m_slot = match_slots[matches_h - 1] orelse { writeEmptyArray(); return; };
    const c_slot = match_slots[ctx_h - 1] orelse { writeEmptyArray(); return; };
    var m_copy = m_slot;
    const result = filterFn(&m_copy, &c_slot);
    last_match_list = result;
    result_len = serializeMatches(&result, &result_buf);
}

export fn filter_inside(matches_h: u32, ctx_h: u32) void { runFilter(matches_h, ctx_h, matcher.filterInside); }
export fn filter_not_inside(matches_h: u32, ctx_h: u32) void { runFilter(matches_h, ctx_h, matcher.filterNotInside); }
export fn filter_not(matches_h: u32, excl_h: u32) void { runFilter(matches_h, excl_h, matcher.filterNot); }

/// Intersect two match lists.
export fn intersect_matches(a_h: u32, b_h: u32) void {
    if (a_h == 0 or a_h > MAX_MATCH_SLOTS) { writeEmptyArray(); return; }
    if (b_h == 0 or b_h > MAX_MATCH_SLOTS) { writeEmptyArray(); return; }
    const a_slot = match_slots[a_h - 1] orelse { writeEmptyArray(); return; };
    const b_slot = match_slots[b_h - 1] orelse { writeEmptyArray(); return; };
    const result = matcher.intersect(&a_slot, &b_slot);
    last_match_list = result;
    result_len = serializeMatches(&result, &result_buf);
}

/// Free a match slot.
export fn free_matches(handle: u32) void {
    if (handle == 0 or handle > MAX_MATCH_SLOTS) return;
    match_slots[handle - 1] = null;
}

// ── Kind matching export ─────────────────────────────────

/// Collect all nodes matching a kind string from a compiled source.
export fn kind_match(src_handle: u32, kind_ptr: [*]const u8, kind_len: u32) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeEmptyArray(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeEmptyArray(); return; };
    const kind = kind_ptr[0..kind_len];

    var matches = matcher.MatchList{};
    matcher.collectByKind(src_slot.tree.rootNode(), kind, &matches, 0);
    last_match_list = matches;
    result_len = serializeMatches(&matches, &result_buf);
}

// ── Range-constrained matching export ────────────────────

/// Match a compiled pattern against a compiled source within a byte range.
export fn match_in_range(pat_handle: u32, src_handle: u32, start_byte: u32, end_byte: u32) void {
    if (pat_handle == 0 or pat_handle > MAX_COMPILED) { writeEmptyArray(); return; }
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeEmptyArray(); return; }
    const pat_slot = compiled_slots[pat_handle - 1] orelse { writeEmptyArray(); return; };
    const src_slot = source_slots[src_handle - 1] orelse { writeEmptyArray(); return; };

    var matches = matcher.MatchList{};
    matcher.searchMatchesInRange(pat_slot.tree.rootNode(), src_slot.tree.rootNode(), &matches, 0, start_byte, end_byte);
    last_match_list = matches;
    result_len = serializeMatches(&matches, &result_buf);
}

// ── Sibling matching exports ─────────────────────────────

/// Match a pattern against preceding siblings of a node.
export fn match_preceding(pat_handle: u32, src_handle: u32, node_start: u32, node_end: u32) void {
    matchSiblings(pat_handle, src_handle, node_start, node_end, true);
}

/// Match a pattern against following siblings of a node.
export fn match_following(pat_handle: u32, src_handle: u32, node_start: u32, node_end: u32) void {
    matchSiblings(pat_handle, src_handle, node_start, node_end, false);
}

fn matchSiblings(pat_handle: u32, src_handle: u32, node_start: u32, node_end: u32, preceding: bool) void {
    if (pat_handle == 0 or pat_handle > MAX_COMPILED) { writeEmptyArray(); return; }
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeEmptyArray(); return; }
    const pat_slot = compiled_slots[pat_handle - 1] orelse { writeEmptyArray(); return; };
    const src_slot = source_slots[src_handle - 1] orelse { writeEmptyArray(); return; };

    var sibling_matches = matcher.MatchList{};
    if (preceding) {
        matcher.collectPrecedingSiblings(src_slot.tree.rootNode(), node_start, node_end, &sibling_matches);
    } else {
        matcher.collectFollowingSiblings(src_slot.tree.rootNode(), node_start, node_end, &sibling_matches);
    }

    var matches = matcher.MatchList{};
    for (sibling_matches.slice()) |sib| {
        matcher.searchMatchesInRange(pat_slot.tree.rootNode(), src_slot.tree.rootNode(), &matches, 0, sib.start_byte, sib.end_byte);
    }
    last_match_list = matches;
    result_len = serializeMatches(&matches, &result_buf);
}

// ── Tree traversal exports ───────────────────────────────
//
// ast-grep style node navigation. Nodes are identified by (src_handle,
// start_byte, end_byte). The WASM engine locates the node via
// ts_node_descendant_for_byte_range, then navigates from there.
// Results are serialized as JSON to result_buf.

/// Find the deepest node exactly matching the given byte range.
/// Uses descendantForByteRange for O(log n) lookup.
/// When is_root=1, returns root directly (handles case where root and first
/// child share the same byte range in single-statement programs).
fn findNode(src_slot: *const CompiledSource, start_byte: u32, end_byte: u32, is_root: u32) ?ts.Node {
    const root = src_slot.tree.rootNode();
    if (is_root == 1) return root;
    const node = root.descendantForByteRange(start_byte, end_byte) orelse return null;
    // Verify exact match — descendantForByteRange may return a parent
    if (node.startByte() == start_byte and node.endByte() == end_byte) return node;
    return null;
}

fn serializeNodeInfo(node: ts.Node, w: anytype) !void {
    try w.writeAll("{\"kind\":\"");
    try w.writeAll(node.nodeType());
    try w.writeAll("\",\"sb\":");
    try w.print("{d}", .{node.startByte()});
    try w.writeAll(",\"eb\":");
    try w.print("{d}", .{node.endByte()});
    try w.writeAll(",\"sr\":");
    try w.print("{d}", .{node.startPoint().row});
    try w.writeAll(",\"sc\":");
    try w.print("{d}", .{node.startPoint().col});
    try w.writeAll(",\"er\":");
    try w.print("{d}", .{node.endPoint().row});
    try w.writeAll(",\"ec\":");
    try w.print("{d}", .{node.endPoint().col});
    try w.writeAll(",\"named\":");
    try w.writeAll(if (node.isNamed()) "true" else "false");
    try w.writeAll(",\"cc\":");
    try w.print("{d}", .{node.childCount()});
    try w.writeAll(",\"ncc\":");
    try w.print("{d}", .{node.namedChildCount()});
    try w.writeByte('}');
}

fn serializeNodeOrNull(maybe_node: ?ts.Node, buf: *[MAX_OUTPUT]u8) u32 {
    if (maybe_node) |node| {
        var stream = std.io.fixedBufferStream(buf);
        serializeNodeInfo(node, stream.writer()) catch return 0;
        return @intCast(stream.pos);
    }
    return writeNullTo(buf);
}

/// Get root node info. Returns JSON object.
export fn node_root(src_handle: u32) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeNull(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeNull(); return; };
    result_len = serializeNodeOrNull(src_slot.tree.rootNode(), &result_buf);
}

/// Get info about a node. Returns JSON object or "null".
export fn node_info(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeNull(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeNull(); return; };
    const node = findNode(&src_slot, start_byte, end_byte, is_root) orelse { writeNull(); return; };
    result_len = serializeNodeOrNull(node, &result_buf);
}

/// Get all children of a node. Returns JSON array.
export fn node_children(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32) void {
    serializeChildren(src_handle, start_byte, end_byte, is_root, false);
}

/// Get named children of a node. Returns JSON array.
export fn node_named_children(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32) void {
    serializeChildren(src_handle, start_byte, end_byte, is_root, true);
}

fn serializeChildren(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32, named_only: bool) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeEmptyArray(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeEmptyArray(); return; };
    const node = findNode(&src_slot, start_byte, end_byte, is_root) orelse { writeEmptyArray(); return; };

    var stream = std.io.fixedBufferStream(&result_buf);
    var w = stream.writer();
    w.writeByte('[') catch { result_len = 0; return; };

    const count = if (named_only) node.namedChildCount() else node.childCount();
    var first = true;
    var i: u32 = 0;
    while (i < count) : (i += 1) {
        const ch = if (named_only) node.namedChild(i) else node.child(i);
        if (ch) |child| {
            if (!first) w.writeByte(',') catch { result_len = 0; return; };
            first = false;
            serializeNodeInfo(child, w) catch { result_len = 0; return; };
        }
    }

    w.writeByte(']') catch { result_len = 0; return; };
    result_len = @intCast(stream.pos);
}

/// Get parent of a node. Returns JSON object or "null".
export fn node_parent(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeNull(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeNull(); return; };
    const node = findNode(&src_slot, start_byte, end_byte, is_root) orelse { writeNull(); return; };
    result_len = serializeNodeOrNull(node.parent(), &result_buf);
}

/// Get child by field name. Returns JSON object or "null".
export fn node_field_child(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32, name_ptr: [*]const u8, name_len: u32) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeNull(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeNull(); return; };
    const node = findNode(&src_slot, start_byte, end_byte, is_root) orelse { writeNull(); return; };
    const name = name_ptr[0..name_len];
    result_len = serializeNodeOrNull(node.childByFieldName(name), &result_buf);
}

/// Get next named sibling. Returns JSON object or "null".
export fn node_next(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeNull(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeNull(); return; };
    const node = findNode(&src_slot, start_byte, end_byte, is_root) orelse { writeNull(); return; };
    result_len = serializeNodeOrNull(node.nextNamedSibling(), &result_buf);
}

/// Get previous named sibling. Returns JSON object or "null".
export fn node_prev(src_handle: u32, start_byte: u32, end_byte: u32, is_root: u32) void {
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeNull(); return; }
    const src_slot = source_slots[src_handle - 1] orelse { writeNull(); return; };
    const node = findNode(&src_slot, start_byte, end_byte, is_root) orelse { writeNull(); return; };
    result_len = serializeNodeOrNull(node.prevNamedSibling(), &result_buf);
}

fn writeNullTo(buf: *[MAX_OUTPUT]u8) u32 {
    buf[0] = 'n';
    buf[1] = 'u';
    buf[2] = 'l';
    buf[3] = 'l';
    return 4;
}

fn writeNull() void {
    result_len = writeNullTo(&result_buf);
}

// ── Rule engine exports ──────────────────────────────────

const rule_engine = @import("rule_engine.zig");

const MAX_RULESETS = 2;
var ruleset_slots: [MAX_RULESETS]?rule_engine.CompiledRuleset = .{null} ** MAX_RULESETS;

/// Decode bytecode → CompiledRuleset, compile all patterns → handles.
/// Returns 1-based ruleset handle (0 = error).
export fn load_ruleset(bytecode_ptr: [*]const u8, bytecode_len: u32) u32 {
    const slot_idx = findFree(rule_engine.CompiledRuleset, MAX_RULESETS, &ruleset_slots) orelse return 0;
    const bytecode = bytecode_ptr[0..bytecode_len];

    var rs = rule_engine.decode(bytecode) orelse return 0;

    // Compile all pattern strings into cached pattern handles
    rule_engine.compilePatterns(&rs, &compiled_slots, &getOrInitParser) orelse return 0;

    ruleset_slots[slot_idx] = rs;
    return slot_idx + 1;
}

/// Evaluate all rules against compiled source.
/// Write result JSON to result_buf.
export fn apply_ruleset(ruleset_handle: u32, src_handle: u32) void {
    if (ruleset_handle == 0 or ruleset_handle > MAX_RULESETS) { writeEmptyArray(); return; }
    if (src_handle == 0 or src_handle > MAX_SOURCES) { writeEmptyArray(); return; }
    const rs = &(ruleset_slots[ruleset_handle - 1] orelse { writeEmptyArray(); return; });
    const src_slot = source_slots[src_handle - 1] orelse { writeEmptyArray(); return; };

    result_len = rule_engine.applyAndSerialize(rs, &src_slot, &compiled_slots, &result_buf);
}

/// Free all compiled pattern handles and release ruleset slot.
export fn free_ruleset(handle: u32) void {
    if (handle == 0 or handle > MAX_RULESETS) return;
    const idx = handle - 1;
    if (ruleset_slots[idx]) |*rs| {
        rule_engine.freePatterns(rs, &compiled_slots);
        rule_engine.freeConstraintRegexes(rs);
        ruleset_slots[idx] = null;
    }
}

export fn get_ruleset_result_ptr() [*]const u8 {
    return &result_buf;
}

export fn get_ruleset_result_len() u32 {
    return result_len;
}

// ── Serialization (Binary protocol) ──────────────────────
//
// Binary format per match:
//   [4B start_byte][4B end_byte][4B start_row][4B start_col][4B end_row][4B end_col][4B binding_count]
//   per binding: [4B name_len][name_bytes][4B text_len][text_bytes]
//
// Header: [4B match_count] followed by match_count match records.
// All integers are little-endian u32.

fn serializeMatches(matches: *const matcher.MatchList, buf: *[MAX_OUTPUT]u8) u32 {
    var pos: usize = 0;
    const slice = matches.slice();

    // Header: match count
    if (pos + 4 > MAX_OUTPUT) return 0;
    writeU32LE(buf, pos, @intCast(slice.len));
    pos += 4;

    for (slice) |m| {
        // 7 fixed u32 fields = 28 bytes
        if (pos + 28 > MAX_OUTPUT) return 0;
        writeU32LE(buf, pos, m.start_byte);
        pos += 4;
        writeU32LE(buf, pos, m.end_byte);
        pos += 4;
        writeU32LE(buf, pos, m.start_row);
        pos += 4;
        writeU32LE(buf, pos, m.start_col);
        pos += 4;
        writeU32LE(buf, pos, m.end_row);
        pos += 4;
        writeU32LE(buf, pos, m.end_col);
        pos += 4;
        writeU32LE(buf, pos, m.bindings.count);
        pos += 4;

        // Bindings
        for (m.bindings.items[0..m.bindings.count]) |b| {
            // name_len + name + text_len + text
            const needed = 4 + b.name_len + 4 + b.text_len;
            if (pos + needed > MAX_OUTPUT) return 0;
            writeU32LE(buf, pos, b.name_len);
            pos += 4;
            @memcpy(buf[pos..][0..b.name_len], b.name[0..b.name_len]);
            pos += b.name_len;
            writeU32LE(buf, pos, b.text_len);
            pos += 4;
            @memcpy(buf[pos..][0..b.text_len], b.text[0..b.text_len]);
            pos += b.text_len;
        }
    }

    return @intCast(pos);
}

inline fn writeU32LE(buf: *[MAX_OUTPUT]u8, pos: usize, val: u32) void {
    buf[pos] = @truncate(val);
    buf[pos + 1] = @truncate(val >> 8);
    buf[pos + 2] = @truncate(val >> 16);
    buf[pos + 3] = @truncate(val >> 24);
}

// Force the compiler to analyze all referenced modules
comptime {
    _ = @import("alloc.zig");
    _ = @import("matcher.zig");
    _ = @import("rule_engine.zig");
}
