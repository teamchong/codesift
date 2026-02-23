///! ts_bridge.zig — Zig-friendly wrapper over the tree-sitter C API.
///!
///! Uses @cImport to pull in the tree-sitter header, then exposes Parser,
///! Tree, Node, and Cursor types that carry the source slice alongside
///! every node so callers can extract text without threading extra state.

const std = @import("std");

pub const c = @cImport({
    @cInclude("tree_sitter/api.h");
});

// ── Language selection ──────────────────────────────────────

pub const Language = enum { javascript, typescript, tsx };

// External symbols provided by the compiled grammar C objects.
// tree_sitter_javascript() and tree_sitter_typescript() both return
// `const TSLanguage *`.  TSX reuses the TypeScript grammar (the TS
// grammar already includes JSX/TSX syntax).
extern fn tree_sitter_javascript() ?*const c.TSLanguage;
extern fn tree_sitter_typescript() ?*const c.TSLanguage;

// ── Parser ──────────────────────────────────────────────────

pub const Parser = struct {
    parser: *c.TSParser,

    pub fn init(lang: Language) ?Parser {
        const p = c.ts_parser_new() orelse return null;
        const language: ?*const c.TSLanguage = switch (lang) {
            .javascript => tree_sitter_javascript(),
            .typescript, .tsx => tree_sitter_typescript(),
        };
        if (language == null) {
            c.ts_parser_delete(p);
            return null;
        }
        if (!c.ts_parser_set_language(p, language.?)) {
            c.ts_parser_delete(p);
            return null;
        }
        return .{ .parser = p };
    }

    pub fn parse(self: *Parser, source: []const u8) ?Tree {
        const tree = c.ts_parser_parse_string(
            self.parser,
            null,
            source.ptr,
            @intCast(source.len),
        ) orelse return null;
        return .{ .tree = tree, .source = source };
    }

    /// Reset parser state, clearing any retained internal caches.
    /// Call this between sequential parses to reduce memory pressure.
    pub fn reset(self: *Parser) void {
        c.ts_parser_reset(self.parser);
    }

    pub fn deinit(self: *Parser) void {
        c.ts_parser_delete(self.parser);
    }
};

// ── Tree ────────────────────────────────────────────────────

pub const Tree = struct {
    tree: *c.TSTree,
    source: []const u8,

    pub fn rootNode(self: *const Tree) Node {
        return .{
            .node = c.ts_tree_root_node(self.tree),
            .source = self.source,
        };
    }

    pub fn deinit(self: *Tree) void {
        c.ts_tree_delete(self.tree);
    }
};

// ── Node ────────────────────────────────────────────────────

pub const Point = struct { row: u32, col: u32 };

pub const Node = struct {
    node: c.TSNode,
    source: []const u8,

    /// Node type string (e.g. "call_expression", "import_statement").
    pub fn nodeType(self: Node) []const u8 {
        const t = c.ts_node_type(self.node);
        if (t == null) return "";
        return std.mem.span(t);
    }

    /// 0-based start position (row, column).
    pub fn startPoint(self: Node) Point {
        const p = c.ts_node_start_point(self.node);
        return .{ .row = p.row, .col = p.column };
    }

    /// 0-based end position (row, column).
    pub fn endPoint(self: Node) Point {
        const p = c.ts_node_end_point(self.node);
        return .{ .row = p.row, .col = p.column };
    }

    /// Extract the source text spanned by this node.
    pub fn text(self: Node) []const u8 {
        const start = c.ts_node_start_byte(self.node);
        const end = c.ts_node_end_byte(self.node);
        if (start >= self.source.len or end > self.source.len or start > end) return "";
        return self.source[start..end];
    }

    pub fn startByte(self: Node) u32 {
        return c.ts_node_start_byte(self.node);
    }

    pub fn endByte(self: Node) u32 {
        return c.ts_node_end_byte(self.node);
    }

    /// Number of *named* children (skips anonymous tokens like punctuation).
    pub fn namedChildCount(self: Node) u32 {
        return c.ts_node_named_child_count(self.node);
    }

    /// Get the i-th named child, or null if it is a null node.
    pub fn namedChild(self: Node, i: u32) ?Node {
        const named_ch = c.ts_node_named_child(self.node, i);
        if (c.ts_node_is_null(named_ch)) return null;
        return .{ .node = named_ch, .source = self.source };
    }

    /// Total child count (named + anonymous).
    pub fn childCount(self: Node) u32 {
        return c.ts_node_child_count(self.node);
    }

    /// Get the i-th child (named or anonymous).
    pub fn child(self: Node, i: u32) ?Node {
        const ch = c.ts_node_child(self.node, i);
        if (c.ts_node_is_null(ch)) return null;
        return .{ .node = ch, .source = self.source };
    }

    /// Look up a child by its grammar field name (e.g. "function", "arguments").
    pub fn childByFieldName(self: Node, name: []const u8) ?Node {
        const ch = c.ts_node_child_by_field_name(
            self.node,
            name.ptr,
            @intCast(name.len),
        );
        if (c.ts_node_is_null(ch)) return null;
        return .{ .node = ch, .source = self.source };
    }

    pub fn parent(self: Node) ?Node {
        const p = c.ts_node_parent(self.node);
        if (c.ts_node_is_null(p)) return null;
        return .{ .node = p, .source = self.source };
    }

    pub fn isNull(self: Node) bool {
        return c.ts_node_is_null(self.node);
    }

    pub fn isNamed(self: Node) bool {
        return c.ts_node_is_named(self.node);
    }

    pub fn nextNamedSibling(self: Node) ?Node {
        const sib = c.ts_node_next_named_sibling(self.node);
        if (c.ts_node_is_null(sib)) return null;
        return .{ .node = sib, .source = self.source };
    }

    pub fn nextSibling(self: Node) ?Node {
        const sib = c.ts_node_next_sibling(self.node);
        if (c.ts_node_is_null(sib)) return null;
        return .{ .node = sib, .source = self.source };
    }

    pub fn prevNamedSibling(self: Node) ?Node {
        const sib = c.ts_node_prev_named_sibling(self.node);
        if (c.ts_node_is_null(sib)) return null;
        return .{ .node = sib, .source = self.source };
    }

    pub fn prevSibling(self: Node) ?Node {
        const sib = c.ts_node_prev_sibling(self.node);
        if (c.ts_node_is_null(sib)) return null;
        return .{ .node = sib, .source = self.source };
    }

    /// Find the smallest named descendant covering the given byte range.
    pub fn descendantForByteRange(self: Node, start: u32, end: u32) ?Node {
        const d = c.ts_node_descendant_for_byte_range(self.node, start, end);
        if (c.ts_node_is_null(d)) return null;
        return .{ .node = d, .source = self.source };
    }

    /// Find the smallest named descendant covering the given byte range.
    pub fn namedDescendantForByteRange(self: Node, start: u32, end: u32) ?Node {
        const d = c.ts_node_named_descendant_for_byte_range(self.node, start, end);
        if (c.ts_node_is_null(d)) return null;
        return .{ .node = d, .source = self.source };
    }
};

// ── Cursor (efficient tree-walking) ─────────────────────────

pub const Cursor = struct {
    cursor: c.TSTreeCursor,
    source: []const u8,

    pub fn init(node: Node) Cursor {
        return .{
            .cursor = c.ts_tree_cursor_new(node.node),
            .source = node.source,
        };
    }

    pub fn currentNode(self: *const Cursor) Node {
        return .{
            .node = c.ts_tree_cursor_current_node(&self.cursor),
            .source = self.source,
        };
    }

    pub fn gotoFirstChild(self: *Cursor) bool {
        return c.ts_tree_cursor_goto_first_child(&self.cursor);
    }

    pub fn gotoNextSibling(self: *Cursor) bool {
        return c.ts_tree_cursor_goto_next_sibling(&self.cursor);
    }

    pub fn gotoParent(self: *Cursor) bool {
        return c.ts_tree_cursor_goto_parent(&self.cursor);
    }

    pub fn deinit(self: *Cursor) void {
        c.ts_tree_cursor_delete(&self.cursor);
    }
};
