///! matcher.zig — Structural AST pattern matching engine.
///!
///! Implements structural pattern matching against tree-sitter ASTs with:
///!   - Metavariable capture and unification ($X, $FUNC, $...ARGS)
///!   - Ellipsis matching (...) for variable-length sequences
///!   - Pattern composition: AND (patterns), OR (pattern-either)
///!   - Context operators: pattern-inside, pattern-not-inside, pattern-not
///!   - Metavariable constraints: metavariable-regex
///!
///! All storage is fixed-size (zero heap allocation during matching).
///! Patterns are parsed via the same tree-sitter parser as the source code.

const std = @import("std");
const builtin = @import("builtin");
const ts = @import("ts_bridge.zig");
const rules = @import("rules.zig");

// ── SIMD batch operations on match ranges ─────────────────────
//
// Match deduplication and filter operations run O(n²) range comparisons.
// We pack start_byte/end_byte into u64 pairs and use 128-bit SIMD to
// compare 2 match ranges per vector operation.

const Vec2u64 = @Vector(2, u64);

/// Pack two match ranges into a SIMD-friendly u64 pair vector.
/// Each element is (start_byte << 32) | end_byte, so equality check
/// on the full u64 catches both fields at once.
inline fn packRange(start: u32, end: u32) u64 {
    return (@as(u64, start) << 32) | @as(u64, end);
}

/// Check if a match range [start, end) already exists in a match list.
/// Uses SIMD to compare 2 packed ranges per iteration.
fn isDuplicate(matches: []const Match, start: u32, end: u32) bool {
    const needle = packRange(start, end);
    const needle_vec: Vec2u64 = @splat(needle);

    var i: usize = 0;
    // Process 2 matches at a time with SIMD
    while (i + 2 <= matches.len) : (i += 2) {
        const a = packRange(matches[i].start_byte, matches[i].end_byte);
        const b = packRange(matches[i + 1].start_byte, matches[i + 1].end_byte);
        const haystack = Vec2u64{ a, b };
        const cmp = haystack == needle_vec;
        if (@reduce(.Or, cmp)) return true;
    }

    // Scalar tail
    while (i < matches.len) : (i += 1) {
        if (matches[i].start_byte == start and matches[i].end_byte == end) return true;
    }
    return false;
}

/// SIMD containment check: is range [inner_start, inner_end) inside any of the
/// context ranges? Uses vectorized comparison of 2 contexts per iteration.
fn isInsideAny(contexts: []const Match, inner_start: u32, inner_end: u32) bool {
    var i: usize = 0;
    const start_vec: Vec2u64 = @splat(@as(u64, inner_start));
    const end_vec: Vec2u64 = @splat(@as(u64, inner_end));

    while (i + 2 <= contexts.len) : (i += 2) {
        const ctx_starts = Vec2u64{
            @as(u64, contexts[i].start_byte),
            @as(u64, contexts[i + 1].start_byte),
        };
        const ctx_ends = Vec2u64{
            @as(u64, contexts[i].end_byte),
            @as(u64, contexts[i + 1].end_byte),
        };
        // ctx.start <= inner.start AND ctx.end >= inner.end
        const start_ok = ctx_starts <= start_vec;
        const end_ok = ctx_ends >= end_vec;
        // Both conditions must hold for containment
        const both = start_ok & end_ok;
        if (@reduce(.Or, both)) return true;
    }

    // Scalar tail
    while (i < contexts.len) : (i += 1) {
        if (contexts[i].start_byte <= inner_start and contexts[i].end_byte >= inner_end) return true;
    }
    return false;
}

/// SIMD exact-range match: does [start, end) exactly match any exclusion range?
fn isExactMatch(exclusions: []const Match, start: u32, end: u32) bool {
    return isDuplicate(exclusions, start, end);
}

/// SIMD overlap check: does range [a_start, a_end) overlap with any range in list?
fn overlapsAny(list: []const Match, a_start: u32, a_end: u32) bool {
    var i: usize = 0;
    const start_vec: Vec2u64 = @splat(@as(u64, a_start));
    const end_vec: Vec2u64 = @splat(@as(u64, a_end));

    while (i + 2 <= list.len) : (i += 2) {
        const b_starts = Vec2u64{
            @as(u64, list[i].start_byte),
            @as(u64, list[i + 1].start_byte),
        };
        const b_ends = Vec2u64{
            @as(u64, list[i].end_byte),
            @as(u64, list[i + 1].end_byte),
        };
        // Overlap: a_start < b_end AND b_start < a_end
        const cond1 = start_vec < b_ends;
        const cond2 = b_starts < end_vec;
        const both = cond1 & cond2;
        if (@reduce(.Or, both)) return true;
    }

    // Scalar tail
    while (i < list.len) : (i += 1) {
        if (a_start < list[i].end_byte and list[i].start_byte < a_end) return true;
    }
    return false;
}

// ── Metavariable bindings ─────────────────────────────────────

pub const MAX_BINDINGS = 16;
pub const MAX_BINDING_TEXT = 256;

/// A single metavariable binding: $NAME -> captured text + location.
pub const Binding = struct {
    /// Metavariable name without $ prefix (e.g. "FUNC", "X").
    name: [64]u8 = undefined,
    name_len: u32 = 0,
    /// Captured source text.
    text: [MAX_BINDING_TEXT]u8 = undefined,
    text_len: u32 = 0,
    /// Location in source.
    start_byte: u32 = 0,
    end_byte: u32 = 0,
};

/// Fixed-size set of metavariable bindings for one match.
pub const Bindings = struct {
    items: [MAX_BINDINGS]Binding = undefined,
    count: u32 = 0,

    /// Look up a binding by name. Returns the text if found.
    pub fn get(self: *const Bindings, name: []const u8) ?[]const u8 {
        for (self.items[0..self.count]) |*b| {
            if (std.mem.eql(u8, b.name[0..b.name_len], name)) {
                return b.text[0..b.text_len];
            }
        }
        return null;
    }

    /// Bind a metavariable. If already bound, check unification (must match).
    /// Returns false if unification fails.
    pub fn bind(self: *Bindings, name: []const u8, text: []const u8, start: u32, end: u32) bool {
        // Check existing binding (unification)
        for (self.items[0..self.count]) |*b| {
            if (std.mem.eql(u8, b.name[0..b.name_len], name)) {
                return std.mem.eql(u8, b.text[0..b.text_len], text);
            }
        }
        // New binding
        if (self.count >= MAX_BINDINGS) return false;
        if (name.len > 64 or text.len > MAX_BINDING_TEXT) return false;
        var b = &self.items[self.count];
        @memcpy(b.name[0..name.len], name);
        b.name_len = @intCast(name.len);
        @memcpy(b.text[0..text.len], text);
        b.text_len = @intCast(text.len);
        b.start_byte = start;
        b.end_byte = end;
        self.count += 1;
        return true;
    }

    /// Clone bindings (for backtracking).
    pub fn clone(self: *const Bindings) Bindings {
        var result = Bindings{};
        result.count = self.count;
        if (self.count > 0) {
            @memcpy(result.items[0..self.count], self.items[0..self.count]);
        }
        return result;
    }
};

// ── Match result ──────────────────────────────────────────────

pub const MAX_MATCHES = 64;

pub const Match = struct {
    start_byte: u32,
    end_byte: u32,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    bindings: Bindings,
};

pub const MatchList = struct {
    items: [MAX_MATCHES]Match = undefined,
    count: u32 = 0,

    pub fn add(self: *MatchList, m: Match) void {
        if (self.count < MAX_MATCHES) {
            self.items[self.count] = m;
            self.count += 1;
        }
    }

    pub fn slice(self: *const MatchList) []const Match {
        return self.items[0..self.count];
    }
};

// ── Pattern token types ───────────────────────────────────────

/// Check if a node's text is a metavariable ($UPPERCASE...).
fn isMetavar(node_text: []const u8) bool {
    if (node_text.len < 2) return false;
    if (node_text[0] != '$') return false;
    // $... is an ellipsis metavariable, handled separately
    if (node_text.len >= 4 and std.mem.startsWith(u8, node_text[1..], "...")) return false;
    // Rest must be uppercase/underscores/digits
    for (node_text[1..]) |c| {
        if (!std.ascii.isUpper(c) and c != '_' and !std.ascii.isDigit(c)) return false;
    }
    return true;
}

/// Extract metavariable name (without $).
fn metavarName(node_text: []const u8) []const u8 {
    return node_text[1..];
}

/// Check if a node represents ellipsis (...).
fn isEllipsis(node_text: []const u8) bool {
    return std.mem.eql(u8, node_text, "...");
}

/// Check if a node is an ellipsis metavariable ($...NAME).
fn isEllipsisMetavar(node_text: []const u8) bool {
    if (node_text.len < 5) return false; // $...X minimum
    return node_text[0] == '$' and std.mem.startsWith(u8, node_text[1..], "...");
}

// ── Structural pattern matcher ────────────────────────────────

/// Match a pattern AST node against a source AST node.
/// Returns true if the structure matches, populating bindings.
pub fn matchNode(
    pattern: ts.Node,
    source: ts.Node,
    bindings: *Bindings,
    depth: u32,
) bool {
    if (depth > 100) return false;

    const pat_text = pattern.text();

    // ── Metavariable: matches any single node ─────────────
    if (isMetavar(pat_text)) {
        const name = metavarName(pat_text);
        return bindings.bind(name, source.text(), source.startByte(), source.endByte());
    }

    // ── Ellipsis: matches zero-or-more (handled by parent) ─
    if (isEllipsis(pat_text)) {
        return true; // Ellipsis always matches in isolation
    }

    const pat_type = pattern.nodeType();
    const src_type = source.nodeType();

    // ── Same node type: compare children structurally ─────
    if (std.mem.eql(u8, pat_type, src_type)) {
        return matchChildren(pattern, source, bindings, depth);
    }

    // ── Leaf node: compare text if both are leaves ────────
    if (pattern.namedChildCount() == 0 and source.namedChildCount() == 0) {
        return std.mem.eql(u8, pat_text, source.text());
    }

    // ── Try matching pattern as a sub-expression ──────────
    // If the pattern is an expression_statement wrapping an expression,
    // try unwrapping it to match against the source directly.
    if (std.mem.eql(u8, pat_type, "expression_statement") and pattern.namedChildCount() == 1) {
        if (pattern.namedChild(0)) |inner| {
            return matchNode(inner, source, bindings, depth + 1);
        }
    }
    if (std.mem.eql(u8, src_type, "expression_statement") and source.namedChildCount() == 1) {
        if (source.namedChild(0)) |inner| {
            return matchNode(pattern, inner, bindings, depth + 1);
        }
    }

    return false;
}

/// Match children of two nodes, handling ellipsis sequences.
fn matchChildren(
    pattern: ts.Node,
    source: ts.Node,
    bindings: *Bindings,
    depth: u32,
) bool {
    const pat_count = pattern.namedChildCount();
    const src_count = source.namedChildCount();

    // No pattern children = structural type match is enough
    if (pat_count == 0) return true;

    return matchChildSeq(pattern, 0, pat_count, source, 0, src_count, bindings, depth + 1);
}

/// Match a sequence of pattern children against source children,
/// handling ellipsis (...) which can match 0+ children.
fn matchChildSeq(
    pattern: ts.Node,
    pat_idx: u32,
    pat_count: u32,
    source: ts.Node,
    src_idx: u32,
    src_count: u32,
    bindings: *Bindings,
    depth: u32,
) bool {
    if (depth > 100) return false;

    // Both exhausted: match
    if (pat_idx >= pat_count and src_idx >= src_count) return true;

    // Pattern exhausted but source has more: no match
    if (pat_idx >= pat_count) return false;

    const pat_child = pattern.namedChild(pat_idx) orelse return false;
    const pat_child_text = pat_child.text();

    // ── Ellipsis: try matching 0, 1, 2, ... source children ──
    if (isEllipsis(pat_child_text) or isEllipsisMetavar(pat_child_text)) {
        // Try consuming 0 source children (skip ellipsis)
        if (matchChildSeq(pattern, pat_idx + 1, pat_count, source, src_idx, src_count, bindings, depth + 1)) {
            return true;
        }
        // Try consuming 1+ source children
        var skip: u32 = src_idx;
        while (skip < src_count) : (skip += 1) {
            if (matchChildSeq(pattern, pat_idx + 1, pat_count, source, skip + 1, src_count, bindings, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    // Source exhausted but pattern has more (non-ellipsis): no match
    if (src_idx >= src_count) return false;

    // ── Normal child: must match current source child ─────
    const src_child = source.namedChild(src_idx) orelse return false;

    // Save bindings for backtracking
    const saved = bindings.clone();

    if (matchNode(pat_child, src_child, bindings, depth + 1)) {
        if (matchChildSeq(pattern, pat_idx + 1, pat_count, source, src_idx + 1, src_count, bindings, depth + 1)) {
            return true;
        }
    }

    // Backtrack
    bindings.* = saved;
    return false;
}

// ── Search: find all matches of a pattern in a source tree ────

/// Walk the entire source tree and collect all nodes that match the pattern.
pub fn searchMatches(
    pattern_root: ts.Node,
    source_root: ts.Node,
    matches: *MatchList,
    depth: u32,
) void {
    if (depth > 200) return;

    // Try matching at this node
    var bindings = Bindings{};
    // Get the actual pattern node (skip program root wrapper if present)
    const pat = unwrapProgramRoot(pattern_root);
    if (matchNode(pat, source_root, &bindings, 0)) {
        const sb = source_root.startByte();
        const eb = source_root.endByte();
        if (!isDuplicate(matches.slice(), sb, eb)) {
            const sp = source_root.startPoint();
            const ep = source_root.endPoint();
            matches.add(.{
                .start_byte = sb,
                .end_byte = eb,
                .start_row = sp.row,
                .start_col = sp.col,
                .end_row = ep.row,
                .end_col = ep.col,
                .bindings = bindings,
            });
        }
    }

    // Recurse into children
    var i: u32 = 0;
    while (i < source_root.namedChildCount()) : (i += 1) {
        if (source_root.namedChild(i)) |child| {
            searchMatches(pattern_root, child, matches, depth + 1);
        }
    }
}

/// Skip the "program" root node wrapper (tree-sitter always wraps in a program node).
fn unwrapProgramRoot(node: ts.Node) ts.Node {
    if (std.mem.eql(u8, node.nodeType(), "program") and node.namedChildCount() == 1) {
        if (node.namedChild(0)) |inner| return inner;
    }
    return node;
}

// ── Range operations for pattern composition ──────────────────

pub const Range = struct {
    start_byte: u32,
    end_byte: u32,

    pub fn contains(self: Range, other: Range) bool {
        return self.start_byte <= other.start_byte and self.end_byte >= other.end_byte;
    }

    pub fn overlaps(self: Range, other: Range) bool {
        return self.start_byte < other.end_byte and other.start_byte < self.end_byte;
    }
};

/// Filter matches: keep only those inside any of the context ranges.
/// Uses SIMD-accelerated containment checks.
pub fn filterInside(matches: *MatchList, contexts: *const MatchList) MatchList {
    var result = MatchList{};
    for (matches.slice()) |m| {
        if (isInsideAny(contexts.slice(), m.start_byte, m.end_byte)) {
            result.add(m);
        }
    }
    return result;
}

/// Filter matches: keep only those NOT inside any of the context ranges.
/// Uses SIMD-accelerated containment checks.
pub fn filterNotInside(matches: *MatchList, contexts: *const MatchList) MatchList {
    var result = MatchList{};
    for (matches.slice()) |m| {
        if (!isInsideAny(contexts.slice(), m.start_byte, m.end_byte)) {
            result.add(m);
        }
    }
    return result;
}

/// Filter matches: remove those with exact byte-range match in exclusions.
/// Uses SIMD-accelerated dedup/exact-match checks.
pub fn filterNot(matches: *MatchList, exclusions: *const MatchList) MatchList {
    var result = MatchList{};
    for (matches.slice()) |m| {
        if (!isExactMatch(exclusions.slice(), m.start_byte, m.end_byte)) {
            result.add(m);
        }
    }
    return result;
}

/// Intersect two match lists: keep matches from A that overlap with any in B.
/// Uses SIMD-accelerated overlap checks.
pub fn intersect(a: *const MatchList, b: *const MatchList) MatchList {
    var result = MatchList{};
    for (a.slice()) |ma| {
        if (overlapsAny(b.slice(), ma.start_byte, ma.end_byte)) {
            result.add(ma);
        }
    }
    return result;
}

// ── Kind matching ─────────────────────────────────────────────

/// Walk the tree and collect all nodes whose nodeType() matches `kind`.
pub fn collectByKind(source_root: ts.Node, kind: []const u8, matches: *MatchList, depth: u32) void {
    if (depth > 200) return;

    if (std.mem.eql(u8, source_root.nodeType(), kind)) {
        const sb = source_root.startByte();
        const eb = source_root.endByte();
        if (!isDuplicate(matches.slice(), sb, eb)) {
            const sp = source_root.startPoint();
            const ep = source_root.endPoint();
            matches.add(.{
                .start_byte = sb,
                .end_byte = eb,
                .start_row = sp.row,
                .start_col = sp.col,
                .end_row = ep.row,
                .end_col = ep.col,
                .bindings = .{},
            });
        }
    }

    var i: u32 = 0;
    while (i < source_root.namedChildCount()) : (i += 1) {
        if (source_root.namedChild(i)) |child_node| {
            collectByKind(child_node, kind, matches, depth + 1);
        }
    }
}

// ── Kind matching (all children, including extras) ────────────

/// Walk the tree using child()/childCount() and collect nodes by type.
/// This sees "extra" nodes (comments) that namedChild() skips.
pub fn collectByKindAll(source_root: ts.Node, kind: []const u8, matches: *MatchList, depth: u32) void {
    if (depth > 200) return;

    if (std.mem.eql(u8, source_root.nodeType(), kind)) {
        const sb = source_root.startByte();
        const eb = source_root.endByte();
        if (!isDuplicate(matches.slice(), sb, eb)) {
            const sp = source_root.startPoint();
            const ep = source_root.endPoint();
            matches.add(.{
                .start_byte = sb,
                .end_byte = eb,
                .start_row = sp.row,
                .start_col = sp.col,
                .end_row = ep.row,
                .end_col = ep.col,
                .bindings = .{},
            });
        }
    }

    // Walk ALL children (including extras like comments)
    var i: u32 = 0;
    while (i < source_root.childCount()) : (i += 1) {
        if (source_root.child(i)) |child_node| {
            collectByKindAll(child_node, kind, matches, depth + 1);
        }
    }
}

// ── Range-constrained matching ────────────────────────────────

/// Same as searchMatches but skips nodes outside [range_start, range_end).
pub fn searchMatchesInRange(
    pattern_root: ts.Node,
    source_root: ts.Node,
    matches: *MatchList,
    depth: u32,
    range_start: u32,
    range_end: u32,
) void {
    if (depth > 200) return;

    const node_start = source_root.startByte();
    const node_end = source_root.endByte();

    // Skip nodes entirely outside the range
    if (node_end <= range_start or node_start >= range_end) return;

    // Try matching at this node if it's within range
    if (node_start >= range_start and node_end <= range_end) {
        var bindings = Bindings{};
        const pat = unwrapProgramRoot(pattern_root);
        if (matchNode(pat, source_root, &bindings, 0)) {
            const sb = source_root.startByte();
            const eb = source_root.endByte();
            if (!isDuplicate(matches.slice(), sb, eb)) {
                const sp = source_root.startPoint();
                const ep = source_root.endPoint();
                matches.add(.{
                    .start_byte = sb,
                    .end_byte = eb,
                    .start_row = sp.row,
                    .start_col = sp.col,
                    .end_row = ep.row,
                    .end_col = ep.col,
                    .bindings = bindings,
                });
            }
        }
    }

    // Recurse into children
    var i: u32 = 0;
    while (i < source_root.namedChildCount()) : (i += 1) {
        if (source_root.namedChild(i)) |child_node| {
            searchMatchesInRange(pattern_root, child_node, matches, depth + 1, range_start, range_end);
        }
    }
}

// ── Sibling matching ──────────────────────────────────────────

/// Find the node at the given byte range by walking the tree.
fn findNodeAtRange(root: ts.Node, target_start: u32, target_end: u32, depth: u32) ?ts.Node {
    if (depth > 200) return null;
    if (root.startByte() == target_start and root.endByte() == target_end) return root;

    var i: u32 = 0;
    while (i < root.namedChildCount()) : (i += 1) {
        if (root.namedChild(i)) |child_node| {
            if (child_node.startByte() <= target_start and child_node.endByte() >= target_end) {
                if (findNodeAtRange(child_node, target_start, target_end, depth + 1)) |found| {
                    return found;
                }
            }
        }
    }
    return null;
}

/// Collect all preceding named siblings of the node at [node_start, node_end).
pub fn collectPrecedingSiblings(source_root: ts.Node, node_start: u32, node_end: u32, matches: *MatchList) void {
    const target = findNodeAtRange(source_root, node_start, node_end, 0) orelse return;
    var current = target;
    while (current.prevNamedSibling()) |sib| {
        const sp = sib.startPoint();
        const ep = sib.endPoint();
        matches.add(.{
            .start_byte = sib.startByte(),
            .end_byte = sib.endByte(),
            .start_row = sp.row,
            .start_col = sp.col,
            .end_row = ep.row,
            .end_col = ep.col,
            .bindings = .{},
        });
        current = sib;
    }
}

/// Collect all following named siblings of the node at [node_start, node_end).
pub fn collectFollowingSiblings(source_root: ts.Node, node_start: u32, node_end: u32, matches: *MatchList) void {
    const target = findNodeAtRange(source_root, node_start, node_end, 0) orelse return;
    var current = target;
    while (current.nextNamedSibling()) |sib| {
        const sp = sib.startPoint();
        const ep = sib.endPoint();
        matches.add(.{
            .start_byte = sib.startByte(),
            .end_byte = sib.endByte(),
            .start_row = sp.row,
            .start_col = sp.col,
            .end_row = ep.row,
            .end_col = ep.col,
            .bindings = .{},
        });
        current = sib;
    }
}

// ── nthChild matching ─────────────────────────────────────────

/// Collect all nodes that are the nth named child (0-based) of their parent.
pub fn collectByNthChild(source_root: ts.Node, index: u32, matches: *MatchList, depth: u32) void {
    if (depth > 200) return;

    // Check if this node is the nth named child of its parent
    if (source_root.parent()) |par| {
        if (par.namedChild(index)) |nth| {
            if (nth.startByte() == source_root.startByte() and nth.endByte() == source_root.endByte()) {
                const sp = source_root.startPoint();
                const ep = source_root.endPoint();
                matches.add(.{
                    .start_byte = source_root.startByte(),
                    .end_byte = source_root.endByte(),
                    .start_row = sp.row,
                    .start_col = sp.col,
                    .end_row = ep.row,
                    .end_col = ep.col,
                    .bindings = .{},
                });
            }
        }
    }

    var i: u32 = 0;
    while (i < source_root.namedChildCount()) : (i += 1) {
        if (source_root.namedChild(i)) |child_node| {
            collectByNthChild(child_node, index, matches, depth + 1);
        }
    }
}

/// Union two match lists: combine results, deduplicating by byte range.
pub fn unionMatches(a: *const MatchList, b: *const MatchList) MatchList {
    var result = MatchList{};
    for (a.slice()) |m| {
        result.add(m);
    }
    for (b.slice()) |m| {
        if (!isDuplicate(result.slice(), m.start_byte, m.end_byte)) {
            result.add(m);
        }
    }
    return result;
}

// ── High-level: parse pattern + match against source ──────────

/// Parse a pattern string with tree-sitter and search for matches in the source tree.
/// Returns the match list. Caller provides the parser to reuse.
pub fn findMatches(
    pattern_source: []const u8,
    source_root: ts.Node,
    lang: ts.Language,
) MatchList {
    var matches = MatchList{};

    var parser = ts.Parser.init(lang) orelse return matches;
    defer parser.deinit();

    var tree = parser.parse(pattern_source) orelse return matches;
    defer tree.deinit();

    const pattern_root = tree.rootNode();
    searchMatches(pattern_root, source_root, &matches, 0);

    return matches;
}

// ── Tests ─────────────────────────────────────────────────────

test "isMetavar basic" {
    try std.testing.expect(isMetavar("$X"));
    try std.testing.expect(isMetavar("$FUNC"));
    try std.testing.expect(isMetavar("$MY_VAR_2"));
    try std.testing.expect(!isMetavar("x"));
    try std.testing.expect(!isMetavar("$"));
    try std.testing.expect(!isMetavar("$abc")); // lowercase
    try std.testing.expect(!isMetavar("$...ARGS")); // ellipsis metavar
}

test "isEllipsis" {
    try std.testing.expect(isEllipsis("..."));
    try std.testing.expect(!isEllipsis(".."));
    try std.testing.expect(!isEllipsis("...."));
    try std.testing.expect(!isEllipsis("$...X"));
}

test "isEllipsisMetavar" {
    try std.testing.expect(isEllipsisMetavar("$...ARGS"));
    try std.testing.expect(isEllipsisMetavar("$...X"));
    try std.testing.expect(!isEllipsisMetavar("$X"));
    try std.testing.expect(!isEllipsisMetavar("..."));
}

test "Bindings bind and get" {
    var b = Bindings{};
    try std.testing.expect(b.bind("X", "hello", 0, 5));
    try std.testing.expectEqualStrings("hello", b.get("X").?);
    try std.testing.expect(b.get("Y") == null);
}

test "Bindings unification succeeds" {
    var b = Bindings{};
    try std.testing.expect(b.bind("X", "hello", 0, 5));
    try std.testing.expect(b.bind("X", "hello", 0, 5)); // same value = ok
}

test "Bindings unification fails" {
    var b = Bindings{};
    try std.testing.expect(b.bind("X", "hello", 0, 5));
    try std.testing.expect(!b.bind("X", "world", 0, 5)); // different value = fail
}

test "Bindings clone" {
    var b = Bindings{};
    try std.testing.expect(b.bind("X", "hello", 0, 5));
    const c = b.clone();
    try std.testing.expectEqualStrings("hello", c.get("X").?);
}

test "Range contains" {
    const outer = Range{ .start_byte = 0, .end_byte = 100 };
    const inner = Range{ .start_byte = 10, .end_byte = 50 };
    try std.testing.expect(outer.contains(inner));
    try std.testing.expect(!inner.contains(outer));
}

test "Range overlaps" {
    const a = Range{ .start_byte = 0, .end_byte = 50 };
    const b = Range{ .start_byte = 25, .end_byte = 75 };
    const c = Range{ .start_byte = 60, .end_byte = 80 };
    try std.testing.expect(a.overlaps(b));
    try std.testing.expect(!a.overlaps(c));
}

test "isDuplicate SIMD" {
    var list = MatchList{};
    list.add(.{ .start_byte = 10, .end_byte = 20, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 0, .bindings = .{} });
    list.add(.{ .start_byte = 30, .end_byte = 40, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 0, .bindings = .{} });
    list.add(.{ .start_byte = 50, .end_byte = 60, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 0, .bindings = .{} });
    try std.testing.expect(isDuplicate(list.slice(), 10, 20));
    try std.testing.expect(isDuplicate(list.slice(), 30, 40));
    try std.testing.expect(isDuplicate(list.slice(), 50, 60));
    try std.testing.expect(!isDuplicate(list.slice(), 0, 5));
    try std.testing.expect(!isDuplicate(list.slice(), 10, 21));
}

test "isInsideAny SIMD" {
    var contexts = MatchList{};
    contexts.add(.{ .start_byte = 0, .end_byte = 30, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 0, .bindings = .{} });
    contexts.add(.{ .start_byte = 50, .end_byte = 80, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 0, .bindings = .{} });
    try std.testing.expect(isInsideAny(contexts.slice(), 5, 10));    // inside first
    try std.testing.expect(isInsideAny(contexts.slice(), 55, 70));   // inside second
    try std.testing.expect(!isInsideAny(contexts.slice(), 35, 45));  // between
    try std.testing.expect(!isInsideAny(contexts.slice(), 0, 50));   // spans beyond
}

test "overlapsAny SIMD" {
    var list = MatchList{};
    list.add(.{ .start_byte = 10, .end_byte = 20, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 0, .bindings = .{} });
    list.add(.{ .start_byte = 30, .end_byte = 40, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 0, .bindings = .{} });
    try std.testing.expect(overlapsAny(list.slice(), 15, 25));   // overlaps first
    try std.testing.expect(overlapsAny(list.slice(), 25, 35));   // overlaps second
    try std.testing.expect(!overlapsAny(list.slice(), 20, 30));  // gap between
    try std.testing.expect(!overlapsAny(list.slice(), 0, 10));   // before first
}

test "matchNode metavar matches any identifier" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();
    var source_tree = parser.parse("eval(x)") orelse return;
    defer source_tree.deinit();
    const source_root = source_tree.rootNode();

    var pat_tree = parser.parse("$FUNC($ARG)") orelse return;
    defer pat_tree.deinit();
    const pat_root = pat_tree.rootNode();

    var matches = MatchList{};
    searchMatches(pat_root, source_root, &matches, 0);
    try std.testing.expect(matches.count > 0);

    const m = matches.items[0];
    try std.testing.expectEqualStrings("eval", m.bindings.get("FUNC").?);
    try std.testing.expectEqualStrings("x", m.bindings.get("ARG").?);
}

test "matchNode exact text no match" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();
    var source_tree = parser.parse("console.log(x)") orelse return;
    defer source_tree.deinit();
    const source_root = source_tree.rootNode();

    var pat_tree = parser.parse("eval($X)") orelse return;
    defer pat_tree.deinit();
    const pat_root = pat_tree.rootNode();

    var matches = MatchList{};
    searchMatches(pat_root, source_root, &matches, 0);
    try std.testing.expectEqual(@as(u32, 0), matches.count);
}

test "searchMatches finds nested match" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    const source_code = "function foo() { eval(userInput); }";
    var source_tree = parser.parse(source_code) orelse return;
    defer source_tree.deinit();
    const source_root = source_tree.rootNode();

    var pat_tree = parser.parse("eval($X)") orelse return;
    defer pat_tree.deinit();
    const pat_root = pat_tree.rootNode();

    var matches = MatchList{};
    searchMatches(pat_root, source_root, &matches, 0);
    try std.testing.expect(matches.count > 0);
    try std.testing.expectEqualStrings("userInput", matches.items[0].bindings.get("X").?);
}

test "findMatches convenience function" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    var source_tree = parser.parse("eval(dangerous)") orelse return;
    defer source_tree.deinit();

    const matches = findMatches("eval($X)", source_tree.rootNode(), .javascript);
    try std.testing.expect(matches.count > 0);
}

test "filterNotInside removes matches inside context" {
    var matches = MatchList{};
    matches.add(.{
        .start_byte = 10,
        .end_byte = 20,
        .start_row = 0,
        .start_col = 10,
        .end_row = 0,
        .end_col = 20,
        .bindings = .{},
    });
    matches.add(.{
        .start_byte = 50,
        .end_byte = 60,
        .start_row = 2,
        .start_col = 0,
        .end_row = 2,
        .end_col = 10,
        .bindings = .{},
    });

    var contexts = MatchList{};
    contexts.add(.{
        .start_byte = 0,
        .end_byte = 30,
        .start_row = 0,
        .start_col = 0,
        .end_row = 0,
        .end_col = 30,
        .bindings = .{},
    });

    const result = filterNotInside(&matches, &contexts);
    try std.testing.expectEqual(@as(u32, 1), result.count);
    try std.testing.expectEqual(@as(u32, 50), result.items[0].start_byte);
}

test "matchNode member expression pattern" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    var source_tree = parser.parse("obj.method(arg)") orelse return;
    defer source_tree.deinit();

    const matches = findMatches("$OBJ.$METHOD($ARG)", source_tree.rootNode(), .javascript);
    try std.testing.expect(matches.count > 0);
    try std.testing.expectEqualStrings("obj", matches.items[0].bindings.get("OBJ").?);
    try std.testing.expectEqualStrings("method", matches.items[0].bindings.get("METHOD").?);
    try std.testing.expectEqualStrings("arg", matches.items[0].bindings.get("ARG").?);
}

test "metavar unification: same var must match same text" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    var source_tree = parser.parse("foo(x, x)") orelse return;
    defer source_tree.deinit();

    var pat_tree = parser.parse("foo($X, $X)") orelse return;
    defer pat_tree.deinit();

    var matches = MatchList{};
    searchMatches(pat_tree.rootNode(), source_tree.rootNode(), &matches, 0);
    try std.testing.expect(matches.count > 0);
    try std.testing.expectEqualStrings("x", matches.items[0].bindings.get("X").?);
}

test "metavar unification fails on different values" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    var source_tree = parser.parse("foo(x, y)") orelse return;
    defer source_tree.deinit();

    var pat_tree = parser.parse("foo($X, $X)") orelse return;
    defer pat_tree.deinit();

    var matches = MatchList{};
    searchMatches(pat_tree.rootNode(), source_tree.rootNode(), &matches, 0);
    try std.testing.expectEqual(@as(u32, 0), matches.count);
}

test "multiple matches in source" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    const source = "eval(a); console.log(b); eval(c);";
    var source_tree = parser.parse(source) orelse return;
    defer source_tree.deinit();

    const matches = findMatches("eval($X)", source_tree.rootNode(), .javascript);
    try std.testing.expect(matches.count >= 2);

    var found_a = false;
    var found_c = false;
    for (matches.slice()) |m| {
        if (m.bindings.get("X")) |val| {
            if (std.mem.eql(u8, val, "a")) found_a = true;
            if (std.mem.eql(u8, val, "c")) found_c = true;
        }
    }
    try std.testing.expect(found_a);
    try std.testing.expect(found_c);
}

test "filterNot removes exact matches" {
    var positives = MatchList{};
    positives.add(.{ .start_byte = 0, .end_byte = 10, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 10, .bindings = .{} });
    positives.add(.{ .start_byte = 20, .end_byte = 30, .start_row = 1, .start_col = 0, .end_row = 1, .end_col = 10, .bindings = .{} });

    var negatives = MatchList{};
    negatives.add(.{ .start_byte = 0, .end_byte = 10, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 10, .bindings = .{} });

    const result = filterNot(&positives, &negatives);
    try std.testing.expectEqual(@as(u32, 1), result.count);
    try std.testing.expectEqual(@as(u32, 20), result.items[0].start_byte);
}

test "intersect keeps overlapping matches" {
    var a_list = MatchList{};
    a_list.add(.{ .start_byte = 0, .end_byte = 20, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 20, .bindings = .{} });
    a_list.add(.{ .start_byte = 50, .end_byte = 70, .start_row = 2, .start_col = 0, .end_row = 2, .end_col = 20, .bindings = .{} });

    var b_list = MatchList{};
    b_list.add(.{ .start_byte = 10, .end_byte = 30, .start_row = 0, .start_col = 10, .end_row = 1, .end_col = 0, .bindings = .{} });

    const result = intersect(&a_list, &b_list);
    try std.testing.expectEqual(@as(u32, 1), result.count);
    try std.testing.expectEqual(@as(u32, 0), result.items[0].start_byte);
}

test "TypeScript pattern matching" {
    var parser = ts.Parser.init(.typescript) orelse return;
    defer parser.deinit();

    var source_tree = parser.parse("const x: string = eval(input)") orelse return;
    defer source_tree.deinit();

    const matches = findMatches("eval($X)", source_tree.rootNode(), .typescript);
    try std.testing.expect(matches.count > 0);
}

test "collectByKind finds all if_statements" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    var source_tree = parser.parse("if (a) { } if (b) { } while (c) { }") orelse return;
    defer source_tree.deinit();

    var matches_list = MatchList{};
    collectByKind(source_tree.rootNode(), "if_statement", &matches_list, 0);
    try std.testing.expectEqual(@as(u32, 2), matches_list.count);
}

test "searchMatchesInRange respects byte boundaries" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    const source = "eval(a); eval(b); eval(c);";
    var source_tree = parser.parse(source) orelse return;
    defer source_tree.deinit();

    var pat_tree = parser.parse("eval($X)") orelse return;
    defer pat_tree.deinit();

    var matches_list = MatchList{};
    searchMatchesInRange(pat_tree.rootNode(), source_tree.rootNode(), &matches_list, 0, 0, 9);
    try std.testing.expect(matches_list.count >= 1);
    for (matches_list.slice()) |m| {
        try std.testing.expect(m.start_byte >= 0);
        try std.testing.expect(m.end_byte <= 9);
    }
}

test "collectFollowingSiblings finds siblings after target" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    const source = "const a = 1; const b = 2; const c = 3;";
    var source_tree = parser.parse(source) orelse return;
    defer source_tree.deinit();

    const root = source_tree.rootNode();
    const first_child = root.namedChild(0) orelse return;
    const start = first_child.startByte();
    const end = first_child.endByte();

    var siblings = MatchList{};
    collectFollowingSiblings(root, start, end, &siblings);
    try std.testing.expect(siblings.count >= 2);
}

test "collectPrecedingSiblings finds siblings before target" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    const source = "const a = 1; const b = 2; const c = 3;";
    var source_tree = parser.parse(source) orelse return;
    defer source_tree.deinit();

    const root = source_tree.rootNode();
    const count = root.namedChildCount();
    const last_child = root.namedChild(count - 1) orelse return;
    const start = last_child.startByte();
    const end = last_child.endByte();

    var siblings = MatchList{};
    collectPrecedingSiblings(root, start, end, &siblings);
    try std.testing.expect(siblings.count >= 2);
}

test "collectByNthChild finds nth children" {
    var parser = ts.Parser.init(.javascript) orelse return;
    defer parser.deinit();

    const source = "const a = 1; const b = 2; const c = 3;";
    var source_tree = parser.parse(source) orelse return;
    defer source_tree.deinit();

    var matches_list = MatchList{};
    collectByNthChild(source_tree.rootNode(), 0, &matches_list, 0);
    try std.testing.expect(matches_list.count >= 1);
}

test "unionMatches deduplicates" {
    var a_list = MatchList{};
    a_list.add(.{ .start_byte = 0, .end_byte = 10, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 10, .bindings = .{} });
    a_list.add(.{ .start_byte = 20, .end_byte = 30, .start_row = 1, .start_col = 0, .end_row = 1, .end_col = 10, .bindings = .{} });

    var b_list = MatchList{};
    b_list.add(.{ .start_byte = 0, .end_byte = 10, .start_row = 0, .start_col = 0, .end_row = 0, .end_col = 10, .bindings = .{} }); // duplicate
    b_list.add(.{ .start_byte = 40, .end_byte = 50, .start_row = 2, .start_col = 0, .end_row = 2, .end_col = 10, .bindings = .{} });

    const result = unionMatches(&a_list, &b_list);
    try std.testing.expectEqual(@as(u32, 3), result.count);
}
