///! rule_engine.zig — Bytecode-compiled rule engine.
///!
///! Rules are compiled to a flat bytecode format on the JS side, passed to
///! WASM as a Uint8Array, decoded here into fixed-size structs, and evaluated
///! with zero re-parsing at match time.
///!
///! Bytecode opcodes:
///!   OP_PATTERN=0x01  OP_KIND=0x02  OP_REGEX=0x03  OP_NTH_CHILD=0x04
///!   OP_ALL=0x10  OP_ANY=0x11  OP_NOT=0x12
///!   OP_INSIDE=0x13  OP_HAS=0x14  OP_FOLLOWS=0x15  OP_PRECEDES=0x16
///!   OP_MATCHES=0x17  OP_FIX=0x20
///!   OP_CONSTRAINT=0x30  OP_TRANSFORM=0x31
///!   OP_STOPBY_END=0x40  OP_STOPBY_NEIGHBOR=0x41  OP_STOPBY_RULE=0x42
///!   OP_RULE=0x50  OP_RULESET=0xFF

const std = @import("std");
const matcher = @import("matcher.zig");
const ts = @import("ts_bridge.zig");
const rules_mod = @import("rules.zig");
const regex = @import("regex");

// ── Allocator ─────────────────────────────────────────────

const builtin = @import("builtin");
const gpa: std.mem.Allocator = if (builtin.target.cpu.arch == .wasm32)
    .{ .ptr = undefined, .vtable = &dlmalloc_vtable }
else
    std.heap.page_allocator;

// ── Constants ────────────────────────────────────────────

pub const MAX_RULES = 32;
pub const MAX_RULE_NODES = 128;
pub const MAX_CONSTRAINTS = 16;
pub const MAX_TRANSFORMS = 16;
const MAX_CHILDREN = 64;

// ── Opcodes ──────────────────────────────────────────────

const OP_PATTERN: u8 = 0x01;
const OP_KIND: u8 = 0x02;
const OP_REGEX: u8 = 0x03;
const OP_NTH_CHILD: u8 = 0x04;
const OP_ALL: u8 = 0x10;
const OP_ANY: u8 = 0x11;
const OP_NOT: u8 = 0x12;
const OP_INSIDE: u8 = 0x13;
const OP_HAS: u8 = 0x14;
const OP_FOLLOWS: u8 = 0x15;
const OP_PRECEDES: u8 = 0x16;
const OP_MATCHES: u8 = 0x17;
const OP_FIX: u8 = 0x20;
const OP_CONSTRAINT: u8 = 0x30;
const OP_TRANSFORM: u8 = 0x31;
const OP_STOPBY_END: u8 = 0x40;
const OP_STOPBY_NEIGHBOR: u8 = 0x41;
const OP_STOPBY_RULE: u8 = 0x42;
const OP_RULE: u8 = 0x50;
const OP_RULESET: u8 = 0xFF;

// ── Severity ─────────────────────────────────────────────

const SEV_ERROR: u8 = 0;
const SEV_WARNING: u8 = 1;
const SEV_INFO: u8 = 2;
const SEV_HINT: u8 = 3;

// ── Rule node types ──────────────────────────────────────

pub const RuleNodeTag = enum(u8) {
    pattern,
    kind,
    regex,
    nth_child,
    all,
    any,
    op_not,
    inside,
    has,
    follows,
    precedes,
    matches,
};

pub const StopBy = enum(u8) {
    neighbor,
    end,
    rule,
};

pub const RuleNode = struct {
    tag: RuleNodeTag = .pattern,
    // For pattern/kind/regex: offset into bytecode buffer
    str_offset: u32 = 0,
    str_len: u16 = 0,
    // For nth_child
    index: u32 = 0,
    // For all/any: children indices into node pool
    children_start: u16 = 0,
    children_count: u16 = 0,
    // For not/inside/has/follows/precedes: single child index
    child: u16 = 0,
    // For relational: stopBy
    stop_by: StopBy = .neighbor,
    stop_by_rule: u16 = 0,
    // For matches: rule ref index
    ref_index: u16 = 0,
    // Compiled pattern handle (populated during load for .pattern nodes)
    compiled_handle: u32 = 0,
};

pub const Constraint = struct {
    metavar_offset: u32 = 0,
    metavar_len: u16 = 0,
    // 0 = regex, 1 = not_regex
    constraint_type: u8 = 0,
    pattern_offset: u32 = 0,
    pattern_len: u16 = 0,
    compiled_regex: ?*regex.Regex = null,
};

pub const Transform = struct {
    source_offset: u32 = 0,
    source_len: u16 = 0,
    // 0=substring, 1=replace, 2=convert
    op: u8 = 0,
    arg_offset: u32 = 0,
    arg_len: u16 = 0,
};

pub const Rule = struct {
    id_offset: u32 = 0,
    id_len: u16 = 0,
    severity: u8 = SEV_ERROR,
    message_offset: u32 = 0,
    message_len: u16 = 0,
    language: u8 = 1,
    root_node: u16 = 0,
    fix_offset: u32 = 0,
    fix_len: u16 = 0,
    constraints_start: u16 = 0,
    constraints_count: u16 = 0,
    transforms_start: u16 = 0,
    transforms_count: u16 = 0,
};

// ── Children index pool ──────────────────────────────────
// For all/any nodes, children indices are stored contiguously.

var children_pool: [MAX_CHILDREN]u16 = undefined;
var children_pool_count: u16 = 0;

// ── Compiled ruleset ─────────────────────────────────────

pub const CompiledRuleset = struct {
    rules: [MAX_RULES]Rule = undefined,
    rule_count: u16 = 0,
    nodes: [MAX_RULE_NODES]RuleNode = undefined,
    node_count: u16 = 0,
    constraints: [MAX_CONSTRAINTS]Constraint = undefined,
    constraint_count: u16 = 0,
    transforms: [MAX_TRANSFORMS]Transform = undefined,
    transform_count: u16 = 0,
    // Points into the original bytecode buffer (kept alive by WASM memory)
    bytecode: []const u8 = &.{},
};

// ── Bytecode decoder ─────────────────────────────────────

const Decoder = struct {
    data: []const u8,
    pos: usize,

    fn init(data: []const u8) Decoder {
        return .{ .data = data, .pos = 0 };
    }

    fn readU8(self: *Decoder) ?u8 {
        if (self.pos >= self.data.len) return null;
        const v = self.data[self.pos];
        self.pos += 1;
        return v;
    }

    fn readU16(self: *Decoder) ?u16 {
        if (self.pos + 2 > self.data.len) return null;
        const v = std.mem.readInt(u16, self.data[self.pos..][0..2], .little);
        self.pos += 2;
        return v;
    }

    fn readU32(self: *Decoder) ?u32 {
        if (self.pos + 4 > self.data.len) return null;
        const v = std.mem.readInt(u32, self.data[self.pos..][0..4], .little);
        self.pos += 4;
        return v;
    }

    fn readString(self: *Decoder) ?struct { offset: u32, len: u16 } {
        const len = self.readU16() orelse return null;
        const offset: u32 = @intCast(self.pos);
        if (self.pos + len > self.data.len) return null;
        self.pos += len;
        return .{ .offset = offset, .len = len };
    }

    fn getString(self: *const Decoder, offset: u32, len: u16) []const u8 {
        if (offset + len > self.data.len) return "";
        return self.data[offset..][0..len];
    }
};

/// Decode a bytecode buffer into a CompiledRuleset.
pub fn decode(bytecode: []const u8) ?CompiledRuleset {
    var rs = CompiledRuleset{};
    rs.bytecode = bytecode;
    children_pool_count = 0;

    var dec = Decoder.init(bytecode);

    // Read header
    const header = dec.readU8() orelse return null;
    if (header != OP_RULESET) return null;
    _ = dec.readU16() orelse return null; // version
    const rule_count = dec.readU16() orelse return null;

    // Decode each rule
    var ri: u16 = 0;
    while (ri < rule_count) : (ri += 1) {
        if (ri >= MAX_RULES) return null;
        rs.rules[ri] = decodeRule(&dec, &rs) orelse return null;
        rs.rule_count += 1;
    }

    return rs;
}

fn decodeRule(dec: *Decoder, rs: *CompiledRuleset) ?Rule {
    const op = dec.readU8() orelse return null;
    if (op != OP_RULE) return null;

    var rule = Rule{};

    // id
    const id = dec.readString() orelse return null;
    rule.id_offset = id.offset;
    rule.id_len = id.len;

    // severity
    rule.severity = dec.readU8() orelse return null;

    // message
    const msg = dec.readString() orelse return null;
    rule.message_offset = msg.offset;
    rule.message_len = msg.len;

    // language
    rule.language = dec.readU8() orelse return null;

    // constraint count
    const constraint_count = dec.readU16() orelse return null;
    rule.constraints_start = rs.constraint_count;
    rule.constraints_count = constraint_count;

    // decode constraints
    var ci: u16 = 0;
    while (ci < constraint_count) : (ci += 1) {
        if (rs.constraint_count >= MAX_CONSTRAINTS) return null;
        const c_op = dec.readU8() orelse return null;
        if (c_op != OP_CONSTRAINT) return null;

        var constraint = Constraint{};
        const name = dec.readString() orelse return null;
        constraint.metavar_offset = name.offset;
        constraint.metavar_len = name.len;
        constraint.constraint_type = dec.readU8() orelse return null;
        const pat = dec.readString() orelse return null;
        constraint.pattern_offset = pat.offset;
        constraint.pattern_len = pat.len;

        // Pre-compile the regex (heap-allocated for pyregex)
        const pat_str = dec.getString(pat.offset, pat.len);
        const regex_ptr = gpa.create(regex.Regex) catch null;
        if (regex_ptr) |ptr| {
            ptr.* = regex.Regex.compile(gpa, pat_str) catch {
                gpa.destroy(ptr);
                break;
            };
            constraint.compiled_regex = ptr;
        }

        rs.constraints[rs.constraint_count] = constraint;
        rs.constraint_count += 1;
    }

    // transform count
    const transform_count = dec.readU16() orelse return null;
    rule.transforms_start = rs.transform_count;
    rule.transforms_count = transform_count;

    // decode transforms
    var ti: u16 = 0;
    while (ti < transform_count) : (ti += 1) {
        if (rs.transform_count >= MAX_TRANSFORMS) return null;
        const t_op = dec.readU8() orelse return null;
        if (t_op != OP_TRANSFORM) return null;

        var transform = Transform{};
        const src = dec.readString() orelse return null;
        transform.source_offset = src.offset;
        transform.source_len = src.len;
        transform.op = dec.readU8() orelse return null;
        const arg = dec.readString() orelse return null;
        transform.arg_offset = arg.offset;
        transform.arg_len = arg.len;

        rs.transforms[rs.transform_count] = transform;
        rs.transform_count += 1;
    }

    // fix (optional - indicated by OP_FIX or not)
    const next_byte = dec.readU8() orelse return null;
    if (next_byte == OP_FIX) {
        const fix = dec.readString() orelse return null;
        rule.fix_offset = fix.offset;
        rule.fix_len = fix.len;
    } else {
        // Put back the byte — it's the start of the rule body
        dec.pos -= 1;
    }

    // Rule body (the root rule node)
    rule.root_node = decodeRuleNode(dec, rs) orelse return null;

    return rule;
}

fn decodeRuleNode(dec: *Decoder, rs: *CompiledRuleset) ?u16 {
    if (rs.node_count >= MAX_RULE_NODES) return null;

    const node_idx = rs.node_count;
    rs.node_count += 1;

    const op = dec.readU8() orelse return null;
    var node = RuleNode{};

    switch (op) {
        OP_PATTERN => {
            node.tag = .pattern;
            const s = dec.readString() orelse return null;
            node.str_offset = s.offset;
            node.str_len = s.len;
        },
        OP_KIND => {
            node.tag = .kind;
            const s = dec.readString() orelse return null;
            node.str_offset = s.offset;
            node.str_len = s.len;
        },
        OP_REGEX => {
            node.tag = .regex;
            const s = dec.readString() orelse return null;
            node.str_offset = s.offset;
            node.str_len = s.len;
        },
        OP_NTH_CHILD => {
            node.tag = .nth_child;
            node.index = dec.readU32() orelse return null;
        },
        OP_ALL => {
            node.tag = .all;
            const count = dec.readU16() orelse return null;
            node.children_start = children_pool_count;
            node.children_count = count;

            var ci: u16 = 0;
            while (ci < count) : (ci += 1) {
                if (children_pool_count >= MAX_CHILDREN) return null;
                const child_idx = decodeRuleNode(dec, rs) orelse return null;
                children_pool[children_pool_count] = child_idx;
                children_pool_count += 1;
            }
        },
        OP_ANY => {
            node.tag = .any;
            const count = dec.readU16() orelse return null;
            node.children_start = children_pool_count;
            node.children_count = count;

            var ci: u16 = 0;
            while (ci < count) : (ci += 1) {
                if (children_pool_count >= MAX_CHILDREN) return null;
                const child_idx = decodeRuleNode(dec, rs) orelse return null;
                children_pool[children_pool_count] = child_idx;
                children_pool_count += 1;
            }
        },
        OP_NOT => {
            node.tag = .op_not;
            node.child = decodeRuleNode(dec, rs) orelse return null;
        },
        OP_INSIDE, OP_HAS, OP_FOLLOWS, OP_PRECEDES => {
            node.tag = switch (op) {
                OP_INSIDE => .inside,
                OP_HAS => .has,
                OP_FOLLOWS => .follows,
                OP_PRECEDES => .precedes,
                else => unreachable,
            };

            // Read optional stopBy modifier
            const stopby_byte = dec.readU8() orelse return null;
            switch (stopby_byte) {
                OP_STOPBY_END => node.stop_by = .end,
                OP_STOPBY_NEIGHBOR => node.stop_by = .neighbor,
                OP_STOPBY_RULE => {
                    node.stop_by = .rule;
                    node.stop_by_rule = decodeRuleNode(dec, rs) orelse return null;
                },
                else => {
                    // Not a stopBy modifier; it's the child opcode — put it back
                    dec.pos -= 1;
                    node.stop_by = .neighbor;
                },
            }

            node.child = decodeRuleNode(dec, rs) orelse return null;
        },
        OP_MATCHES => {
            node.tag = .matches;
            node.ref_index = dec.readU16() orelse return null;
        },
        else => return null,
    }

    rs.nodes[node_idx] = node;
    return node_idx;
}

// ── Pattern compilation ──────────────────────────────────

/// Compile all pattern strings in the ruleset into cached pattern handles.
/// `compiled_slots` uses the same CompiledPattern type from main.zig (passed as anytype).
pub fn compilePatterns(
    rs: *CompiledRuleset,
    compiled_slots: anytype,
    getOrInitParser: anytype,
) ?void {
    var ni: u16 = 0;
    while (ni < rs.node_count) : (ni += 1) {
        if (rs.nodes[ni].tag == .pattern) {
            const pat_str = rs.bytecode[rs.nodes[ni].str_offset..][0..rs.nodes[ni].str_len];

            // Find a free compiled slot
            var slot_idx: ?u32 = null;
            for (0..64) |i| {
                if (compiled_slots[i] == null) {
                    slot_idx = @intCast(i);
                    break;
                }
            }
            const si = slot_idx orelse return null;

            // For now, use the language from the first rule
            const lang_byte = if (rs.rule_count > 0) rs.rules[0].language else 1;
            const ts_lang: ts.Language = switch (lang_byte) {
                1 => .javascript,
                2 => .typescript,
                3 => .tsx,
                else => .javascript,
            };

            const parser = getOrInitParser(ts_lang) orelse return null;
            var tree = parser.parse(pat_str) orelse {
                parser.reset();
                return null;
            };

            // Copy pattern source into stable memory
            const owned = gpa.alloc(u8, pat_str.len) catch {
                tree.deinit();
                parser.reset();
                return null;
            };
            @memcpy(owned, pat_str);
            tree.source = owned;

            parser.reset();

            compiled_slots[si] = .{
                .tree = tree,
                .lang = ts_lang,
                .active = true,
            };

            rs.nodes[ni].compiled_handle = si + 1; // 1-based
        }
    }
}

// dlmalloc vtable for rule_engine (same as main.zig)
extern fn malloc(usize) ?[*]u8;
extern fn free(?[*]u8) void;
extern fn realloc(?[*]u8, usize) ?[*]u8;

const dlmalloc_vtable = std.mem.Allocator.VTable{
    .alloc = struct {
        fn f(_: *anyopaque, len: usize, _: std.mem.Alignment, _: usize) ?[*]u8 {
            return malloc(len);
        }
    }.f,
    .resize = struct {
        fn f(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) bool {
            return false;
        }
    }.f,
    .free = struct {
        fn f(_: *anyopaque, memory: []u8, _: std.mem.Alignment, _: usize) void {
            free(memory.ptr);
        }
    }.f,
    .remap = struct {
        fn f(_: *anyopaque, memory: []u8, _: std.mem.Alignment, new_len: usize, _: usize) ?[*]u8 {
            return realloc(memory.ptr, new_len);
        }
    }.f,
};

/// Free all compiled pattern handles owned by this ruleset.
pub fn freePatterns(rs: *CompiledRuleset, compiled_slots: anytype) void {
    var ni: u16 = 0;
    while (ni < rs.node_count) : (ni += 1) {
        if (rs.nodes[ni].tag == .pattern and rs.nodes[ni].compiled_handle > 0) {
            const handle = rs.nodes[ni].compiled_handle;
            const idx = handle - 1;
            if (compiled_slots[idx]) |*slot| {
                gpa.free(slot.tree.source);
                slot.tree.deinit();
                compiled_slots[idx] = null;
            }
            rs.nodes[ni].compiled_handle = 0;
        }
    }
}

/// Free all compiled constraint regexes owned by this ruleset.
pub fn freeConstraintRegexes(rs: *CompiledRuleset) void {
    for (rs.constraints[0..rs.constraint_count]) |*c| {
        if (c.compiled_regex) |ptr| {
            ptr.deinit();
            gpa.destroy(ptr);
            c.compiled_regex = null;
        }
    }
}

// ── Rule evaluator ───────────────────────────────────────
//
// IMPORTANT: evaluate() writes to caller-provided *MatchList (output param)
// instead of returning MatchList by value. This avoids 338KB stack
// allocations per call frame, which would blow the WASM stack (~1MB).
// A small static pool (eval_temp) is used for intermediate results
// during all/any/not composition.

// Static temp buffers for rule evaluation. Avoids putting 338KB MatchList
// on the WASM stack (~1MB limit). Single-threaded, so no races.
//   eval_child_temp: child results inside all/any evaluate loops
//   eval_merge_temp: top-level rule output from applyAndSerialize
var eval_child_temp: matcher.MatchList = .{};
var eval_merge_temp: matcher.MatchList = .{};
var eval_relational_temp: matcher.MatchList = .{};

/// Classify whether a rule node tag is a relational operator (filter semantics).
fn isRelationalTag(tag: RuleNodeTag) bool {
    return switch (tag) {
        .inside, .has, .follows, .precedes, .op_not => true,
        else => false,
    };
}

/// In-place filter: keep matches inside any context.
fn filterInsideInPlace(out: *matcher.MatchList, contexts: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        for (contexts.items[0..contexts.count]) |ctx| {
            if (ctx.start_byte <= m.start_byte and ctx.end_byte >= m.end_byte) {
                out.items[keep] = m;
                keep += 1;
                break;
            }
        }
    }
    out.count = keep;
}

/// In-place filter: keep matches NOT inside any context.
fn filterNotInsideInPlace(out: *matcher.MatchList, contexts: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        var is_inside = false;
        for (contexts.items[0..contexts.count]) |ctx| {
            if (ctx.start_byte <= m.start_byte and ctx.end_byte >= m.end_byte) {
                is_inside = true;
                break;
            }
        }
        if (!is_inside) {
            out.items[keep] = m;
            keep += 1;
        }
    }
    out.count = keep;
}

/// In-place filter: keep matches that contain at least one sub-match.
fn filterHasInPlace(out: *matcher.MatchList, subs: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        for (subs.items[0..subs.count]) |sub| {
            if (m.start_byte <= sub.start_byte and m.end_byte >= sub.end_byte) {
                out.items[keep] = m;
                keep += 1;
                break;
            }
        }
    }
    out.count = keep;
}

/// In-place filter: keep matches that do NOT contain any sub-match.
fn filterNotHasInPlace(out: *matcher.MatchList, subs: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        var has_sub = false;
        for (subs.items[0..subs.count]) |sub| {
            if (m.start_byte <= sub.start_byte and m.end_byte >= sub.end_byte) {
                has_sub = true;
                break;
            }
        }
        if (!has_sub) {
            out.items[keep] = m;
            keep += 1;
        }
    }
    out.count = keep;
}

/// In-place filter: remove matches with exact byte range match in exclusion set.
fn filterNotInPlace(out: *matcher.MatchList, excl: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        var excluded = false;
        for (excl.items[0..excl.count]) |ex| {
            if (m.start_byte == ex.start_byte and m.end_byte == ex.end_byte) {
                excluded = true;
                break;
            }
        }
        if (!excluded) {
            out.items[keep] = m;
            keep += 1;
        }
    }
    out.count = keep;
}

/// In-place filter: keep matches where some ref ends before match starts.
fn filterFollowsInPlace(out: *matcher.MatchList, refs: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        for (refs.items[0..refs.count]) |ref_m| {
            if (ref_m.end_byte <= m.start_byte) {
                out.items[keep] = m;
                keep += 1;
                break;
            }
        }
    }
    out.count = keep;
}

/// In-place filter: keep matches that do NOT follow any ref.
fn filterNotFollowsInPlace(out: *matcher.MatchList, refs: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        var has_preceding = false;
        for (refs.items[0..refs.count]) |ref_m| {
            if (ref_m.end_byte <= m.start_byte) {
                has_preceding = true;
                break;
            }
        }
        if (!has_preceding) {
            out.items[keep] = m;
            keep += 1;
        }
    }
    out.count = keep;
}

/// In-place filter: keep matches where some ref starts after match ends.
fn filterPrecedesInPlace(out: *matcher.MatchList, refs: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        for (refs.items[0..refs.count]) |ref_m| {
            if (ref_m.start_byte >= m.end_byte) {
                out.items[keep] = m;
                keep += 1;
                break;
            }
        }
    }
    out.count = keep;
}

/// In-place filter: keep matches that do NOT precede any ref.
fn filterNotPrecedesInPlace(out: *matcher.MatchList, refs: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |m| {
        var has_following = false;
        for (refs.items[0..refs.count]) |ref_m| {
            if (ref_m.start_byte >= m.end_byte) {
                has_following = true;
                break;
            }
        }
        if (!has_following) {
            out.items[keep] = m;
            keep += 1;
        }
    }
    out.count = keep;
}

/// In-place intersect: keep only items in `out` that overlap with `other`.
/// No extra MatchList allocation needed.
fn intersectInPlace(out: *matcher.MatchList, other: *const matcher.MatchList) void {
    var keep: u32 = 0;
    for (out.items[0..out.count]) |ma| {
        for (other.items[0..other.count]) |mb| {
            if (ma.start_byte < mb.end_byte and mb.start_byte < ma.end_byte) {
                out.items[keep] = ma;
                keep += 1;
                break;
            }
        }
    }
    out.count = keep;
}

/// In-place union: append items from `other` to `out` (deduplicated by byte range).
fn unionInPlace(out: *matcher.MatchList, other: *const matcher.MatchList) void {
    for (other.items[0..other.count]) |mb| {
        var dupe = false;
        for (out.items[0..out.count]) |ma| {
            if (ma.start_byte == mb.start_byte and ma.end_byte == mb.end_byte) {
                dupe = true;
                break;
            }
        }
        if (!dupe) out.add(mb);
    }
}

/// Evaluate a rule node against a source tree, writing matches to `out`.
pub fn evaluate(
    rs: *const CompiledRuleset,
    node_idx: u16,
    source_root: ts.Node,
    compiled_slots: anytype,
    out: *matcher.MatchList,
) void {
    out.* = .{};
    if (node_idx >= rs.node_count) return;
    const node = rs.nodes[node_idx];

    switch (node.tag) {
        .pattern => {
            if (node.compiled_handle > 0) {
                const handle = node.compiled_handle;
                if (handle > 0 and handle <= 64) {
                    if (compiled_slots[handle - 1]) |slot| {
                        matcher.searchMatches(slot.tree.rootNode(), source_root, out, 0);
                    }
                }
            }
        },
        .kind => {
            const kind_str = rs.bytecode[node.str_offset..][0..node.str_len];
            // Use collectByKindAll for comment types (extras invisible to namedChild)
            if (std.mem.eql(u8, kind_str, "comment") or std.mem.eql(u8, kind_str, "html_comment")) {
                matcher.collectByKindAll(source_root, kind_str, out, 0);
            } else {
                matcher.collectByKind(source_root, kind_str, out, 0);
            }
        },
        .regex => {
            const regex_str = rs.bytecode[node.str_offset..][0..node.str_len];
            var compiled = regex.Regex.compile(gpa, regex_str) catch return;
            defer compiled.deinit();
            collectByRegex(source_root, &compiled, out, 0);
        },
        .nth_child => {
            matcher.collectByNthChild(source_root, node.index, out, 0);
        },
        .all => {
            if (node.children_count == 0) return;

            // Phase 1: Evaluate primary children (non-relational) with intersection.
            var primary_initialized = false;
            var ci: u16 = 0;
            while (ci < node.children_count) : (ci += 1) {
                const child_idx = children_pool[node.children_start + ci];
                const child_node = rs.nodes[child_idx];
                if (isRelationalTag(child_node.tag)) continue;

                evaluate(rs, child_idx, source_root, compiled_slots, &eval_child_temp);
                if (!primary_initialized) {
                    out.* = eval_child_temp;
                    primary_initialized = true;
                } else {
                    intersectInPlace(out, &eval_child_temp);
                }
            }

            // If no primary children, nothing to filter
            if (!primary_initialized) return;

            // Phase 2: Apply relational children as filters on primary matches.
            ci = 0;
            while (ci < node.children_count) : (ci += 1) {
                const child_idx = children_pool[node.children_start + ci];
                const child_node = rs.nodes[child_idx];
                if (!isRelationalTag(child_node.tag)) continue;

                switch (child_node.tag) {
                    .inside => {
                        // Evaluate sub-rule → context ranges, filter: keep matches inside contexts
                        evaluate(rs, child_node.child, source_root, compiled_slots, &eval_relational_temp);
                        filterInsideInPlace(out, &eval_relational_temp);
                    },
                    .has => {
                        // Evaluate sub-rule → sub-matches, filter: keep matches containing a sub-match
                        evaluate(rs, child_node.child, source_root, compiled_slots, &eval_relational_temp);
                        filterHasInPlace(out, &eval_relational_temp);
                    },
                    .follows => {
                        // Evaluate sub-rule → refs, filter: keep matches preceded by a ref
                        evaluate(rs, child_node.child, source_root, compiled_slots, &eval_relational_temp);
                        filterFollowsInPlace(out, &eval_relational_temp);
                    },
                    .precedes => {
                        // Evaluate sub-rule → refs, filter: keep matches followed by a ref
                        evaluate(rs, child_node.child, source_root, compiled_slots, &eval_relational_temp);
                        filterPrecedesInPlace(out, &eval_relational_temp);
                    },
                    .op_not => {
                        // NOT inverts a sub-rule. Handle not+relational combos:
                        const not_child = rs.nodes[child_node.child];
                        switch (not_child.tag) {
                            .inside => {
                                // not { inside { ... } } → keep matches NOT inside contexts
                                evaluate(rs, not_child.child, source_root, compiled_slots, &eval_relational_temp);
                                filterNotInsideInPlace(out, &eval_relational_temp);
                            },
                            .has => {
                                // not { has { ... } } → keep matches NOT containing sub-matches
                                evaluate(rs, not_child.child, source_root, compiled_slots, &eval_relational_temp);
                                filterNotHasInPlace(out, &eval_relational_temp);
                            },
                            .follows => {
                                // not { follows { ... } } → keep matches NOT following refs
                                evaluate(rs, not_child.child, source_root, compiled_slots, &eval_relational_temp);
                                filterNotFollowsInPlace(out, &eval_relational_temp);
                            },
                            .precedes => {
                                // not { precedes { ... } } → keep matches NOT preceding refs
                                evaluate(rs, not_child.child, source_root, compiled_slots, &eval_relational_temp);
                                filterNotPrecedesInPlace(out, &eval_relational_temp);
                            },
                            else => {
                                // not { pattern/kind/etc } → remove exact byte matches
                                evaluate(rs, child_node.child, source_root, compiled_slots, &eval_relational_temp);
                                filterNotInPlace(out, &eval_relational_temp);
                            },
                        }
                    },
                    else => {},
                }
            }
        },
        .any => {
            var ci: u16 = 0;
            while (ci < node.children_count) : (ci += 1) {
                const child_idx = children_pool[node.children_start + ci];
                evaluate(rs, child_idx, source_root, compiled_slots, &eval_child_temp);
                unionInPlace(out, &eval_child_temp);
            }
        },
        .op_not => {
            // Standalone NOT: no primary matches to filter, returns empty.
            // Meaningful only inside `all` where the two-phase handler processes it.
        },
        .inside => {
            // Standalone: evaluate child to get context matches (pass-through).
            evaluate(rs, node.child, source_root, compiled_slots, out);
        },
        .has => {
            // Standalone: evaluate child to get sub-matches (pass-through).
            evaluate(rs, node.child, source_root, compiled_slots, out);
        },
        .follows => {
            // Standalone: evaluate child to get reference matches (pass-through).
            evaluate(rs, node.child, source_root, compiled_slots, out);
        },
        .precedes => {
            // Standalone: evaluate child to get reference matches (pass-through).
            evaluate(rs, node.child, source_root, compiled_slots, out);
        },
        .matches => {
            if (node.ref_index < rs.rule_count) {
                const ref_rule = rs.rules[node.ref_index];
                evaluate(rs, ref_rule.root_node, source_root, compiled_slots, out);
            }
        },
    }
}

/// Walk tree and collect nodes whose text matches a regex.
/// Uses childCount()/child() to see ALL nodes including extras (comments).
fn collectByRegex(source_root: ts.Node, compiled: *regex.Regex, matches: *matcher.MatchList, depth: u32) void {
    if (depth > 200) return;

    // Check if this node's text matches (leaf = no children at all)
    if (source_root.childCount() == 0) {
        const node_text = source_root.text();
        const find_result: ?regex.Match = compiled.find(node_text) catch null;
        if (find_result) |m_val| {
            var m_copy = m_val;
            m_copy.deinit(gpa);
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

    // Walk ALL children (including extras like comments)
    var i: u32 = 0;
    while (i < source_root.childCount()) : (i += 1) {
        if (source_root.child(i)) |child_node| {
            collectByRegex(child_node, compiled, matches, depth + 1);
        }
    }
}

/// Evaluate all rules in a ruleset and check constraints.
fn evaluateRuleWithConstraints(
    rs: *const CompiledRuleset,
    rule: *const Rule,
    source_root: ts.Node,
    compiled_slots: anytype,
    out: *matcher.MatchList,
) void {
    evaluate(rs, rule.root_node, source_root, compiled_slots, out);

    // Apply constraints (filter matches by metavariable regex).
    // Reuses eval_child_temp as scratch space (safe: evaluate is done).
    if (rule.constraints_count > 0) {
        eval_child_temp = .{};
        for (out.slice()) |m| {
            var passes = true;
            var ci: u16 = rule.constraints_start;
            while (ci < rule.constraints_start + rule.constraints_count) : (ci += 1) {
                const constraint = rs.constraints[ci];
                const metavar_name = rs.bytecode[constraint.metavar_offset..][0..constraint.metavar_len];

                if (m.bindings.get(metavar_name)) |value| {
                    if (constraint.compiled_regex) |re| {
                        const find_res: ?regex.Match = re.find(value) catch null;
                        const matched = if (find_res) |f_val| blk: {
                            var f_copy = f_val;
                            f_copy.deinit(gpa);
                            break :blk true;
                        } else false;
                        if (constraint.constraint_type == 0 and !matched) {
                            passes = false;
                            break;
                        }
                        if (constraint.constraint_type == 1 and matched) {
                            passes = false;
                            break;
                        }
                    }
                }
            }
            if (passes) eval_child_temp.add(m);
        }
        out.* = eval_child_temp;
    }
}

// ── Serialization ────────────────────────────────────────

const MAX_OUTPUT = 64 * 1024;

/// Apply all rules and serialize results to JSON buffer.
pub fn applyAndSerialize(
    rs: *const CompiledRuleset,
    src_slot: anytype,
    compiled_slots: anytype,
    _source_slots: anytype,
    buf: *[MAX_OUTPUT]u8,
) u32 {
    _ = _source_slots;
    var stream = std.io.fixedBufferStream(buf);
    var w = stream.writer();

    w.writeByte('[') catch return 0;

    var first_rule = true;
    var ri: u16 = 0;
    while (ri < rs.rule_count) : (ri += 1) {
        const rule = &rs.rules[ri];
        evaluateRuleWithConstraints(rs, rule, src_slot.tree.rootNode(), compiled_slots, &eval_merge_temp);

        if (eval_merge_temp.count == 0) {
            continue;
        }

        if (!first_rule) w.writeByte(',') catch return 0;
        first_rule = false;

        // Write rule finding (camelCase to match TS Finding interface)
        w.writeAll("{\"ruleId\":\"") catch return 0;
        w.writeAll(rs.bytecode[rule.id_offset..][0..rule.id_len]) catch return 0;
        w.writeAll("\",\"severity\":\"") catch return 0;
        const sev_str = switch (rule.severity) {
            SEV_ERROR => "error",
            SEV_WARNING => "warning",
            SEV_INFO => "info",
            SEV_HINT => "hint",
            else => "error",
        };
        w.writeAll(sev_str) catch return 0;
        w.writeAll("\",\"message\":\"") catch return 0;
        writeJsonEscaped(w, rs.bytecode[rule.message_offset..][0..rule.message_len]) catch return 0;
        w.writeAll("\",\"matches\":[") catch return 0;

        for (eval_merge_temp.slice(), 0..) |m, mi| {
            if (mi > 0) w.writeByte(',') catch return 0;
            w.writeAll("{\"start_row\":") catch return 0;
            w.print("{d}", .{m.start_row}) catch return 0;
            w.writeAll(",\"start_col\":") catch return 0;
            w.print("{d}", .{m.start_col}) catch return 0;
            w.writeAll(",\"end_row\":") catch return 0;
            w.print("{d}", .{m.end_row}) catch return 0;
            w.writeAll(",\"end_col\":") catch return 0;
            w.print("{d}", .{m.end_col}) catch return 0;
            w.writeAll(",\"start_byte\":") catch return 0;
            w.print("{d}", .{m.start_byte}) catch return 0;
            w.writeAll(",\"end_byte\":") catch return 0;
            w.print("{d}", .{m.end_byte}) catch return 0;
            w.writeAll(",\"bindings\":{") catch return 0;
            var first_b = true;
            for (m.bindings.items[0..m.bindings.count]) |b| {
                if (!first_b) w.writeByte(',') catch return 0;
                first_b = false;
                w.writeByte('"') catch return 0;
                w.writeAll(b.name[0..b.name_len]) catch return 0;
                w.writeAll("\":\"") catch return 0;
                writeJsonEscaped(w, b.text[0..b.text_len]) catch return 0;
                w.writeByte('"') catch return 0;
            }
            w.writeAll("}}") catch return 0;
        }

        w.writeByte(']') catch return 0;

        // Fix template
        if (rule.fix_len > 0) {
            w.writeAll(",\"fix\":\"") catch return 0;
            writeJsonEscaped(w, rs.bytecode[rule.fix_offset..][0..rule.fix_len]) catch return 0;
            w.writeByte('"') catch return 0;
        }

        w.writeByte('}') catch return 0;
    }

    w.writeByte(']') catch return 0;
    return @intCast(stream.pos);
}

fn writeJsonEscaped(w: anytype, s: []const u8) !void {
    for (s) |c_byte| {
        switch (c_byte) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            else => {
                if (c_byte < 0x20) {
                    try w.writeAll("\\u00");
                    try w.print("{x:0>2}", .{c_byte});
                } else {
                    try w.writeByte(c_byte);
                }
            },
        }
    }
}

// ── Tests ────────────────────────────────────────────────

test "rule_engine decode empty ruleset" {
    // Minimal ruleset: header + 0 rules
    const bytecode = [_]u8{
        OP_RULESET,
        0x01, 0x00, // version 1
        0x00, 0x00, // 0 rules
    };
    const rs = decode(&bytecode) orelse {
        try std.testing.expect(false);
        return;
    };
    try std.testing.expectEqual(@as(u16, 0), rs.rule_count);
}

test "rule_engine decode single pattern rule" {
    // Ruleset with one rule: pattern "eval($X)"
    var buf: [256]u8 = undefined;
    var pos: usize = 0;

    // Header
    buf[pos] = OP_RULESET;
    pos += 1;
    std.mem.writeInt(u16, buf[pos..][0..2], 1, .little); // version
    pos += 2;
    std.mem.writeInt(u16, buf[pos..][0..2], 1, .little); // 1 rule
    pos += 2;

    // Rule header
    buf[pos] = OP_RULE;
    pos += 1;

    // id: "no-eval"
    const id = "no-eval";
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(id.len), .little);
    pos += 2;
    @memcpy(buf[pos..][0..id.len], id);
    pos += id.len;

    // severity: error (0)
    buf[pos] = SEV_ERROR;
    pos += 1;

    // message
    const msg = "eval is dangerous";
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(msg.len), .little);
    pos += 2;
    @memcpy(buf[pos..][0..msg.len], msg);
    pos += msg.len;

    // language: javascript (1)
    buf[pos] = 1;
    pos += 1;

    // 0 constraints
    std.mem.writeInt(u16, buf[pos..][0..2], 0, .little);
    pos += 2;

    // 0 transforms
    std.mem.writeInt(u16, buf[pos..][0..2], 0, .little);
    pos += 2;

    // Rule body: OP_PATTERN "eval($X)"
    buf[pos] = OP_PATTERN;
    pos += 1;
    const pat = "eval($X)";
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(pat.len), .little);
    pos += 2;
    @memcpy(buf[pos..][0..pat.len], pat);
    pos += pat.len;

    const rs = decode(buf[0..pos]) orelse {
        try std.testing.expect(false);
        return;
    };
    try std.testing.expectEqual(@as(u16, 1), rs.rule_count);
    try std.testing.expectEqual(@as(u16, 1), rs.node_count);
    try std.testing.expectEqual(RuleNodeTag.pattern, rs.nodes[0].tag);
}

test "rule_engine decode all/any composition" {
    var buf: [512]u8 = undefined;
    var pos: usize = 0;

    // Header
    buf[pos] = OP_RULESET;
    pos += 1;
    std.mem.writeInt(u16, buf[pos..][0..2], 1, .little);
    pos += 2;
    std.mem.writeInt(u16, buf[pos..][0..2], 1, .little); // 1 rule
    pos += 2;

    // Rule header
    buf[pos] = OP_RULE;
    pos += 1;
    const id = "test";
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(id.len), .little);
    pos += 2;
    @memcpy(buf[pos..][0..id.len], id);
    pos += id.len;
    buf[pos] = SEV_WARNING;
    pos += 1;
    const msg = "test msg";
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(msg.len), .little);
    pos += 2;
    @memcpy(buf[pos..][0..msg.len], msg);
    pos += msg.len;
    buf[pos] = 1; // javascript
    pos += 1;
    std.mem.writeInt(u16, buf[pos..][0..2], 0, .little); // 0 constraints
    pos += 2;
    std.mem.writeInt(u16, buf[pos..][0..2], 0, .little); // 0 transforms
    pos += 2;

    // Rule body: ALL(PATTERN "eval($X)", NOT(KIND "try_statement"))
    buf[pos] = OP_ALL;
    pos += 1;
    std.mem.writeInt(u16, buf[pos..][0..2], 2, .little); // 2 children
    pos += 2;

    // Child 1: PATTERN
    buf[pos] = OP_PATTERN;
    pos += 1;
    const pat = "eval($X)";
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(pat.len), .little);
    pos += 2;
    @memcpy(buf[pos..][0..pat.len], pat);
    pos += pat.len;

    // Child 2: NOT(KIND "try_statement")
    buf[pos] = OP_NOT;
    pos += 1;
    buf[pos] = OP_KIND;
    pos += 1;
    const kind = "try_statement";
    std.mem.writeInt(u16, buf[pos..][0..2], @intCast(kind.len), .little);
    pos += 2;
    @memcpy(buf[pos..][0..kind.len], kind);
    pos += kind.len;

    const rs = decode(buf[0..pos]) orelse {
        try std.testing.expect(false);
        return;
    };
    try std.testing.expectEqual(@as(u16, 1), rs.rule_count);
    try std.testing.expect(rs.node_count >= 3); // ALL + PATTERN + NOT(KIND)
    try std.testing.expectEqual(RuleNodeTag.all, rs.nodes[rs.rules[0].root_node].tag);
}
