///! alloc.zig — Shared allocator for WASM and native targets.
///!
///! On wasm32 we wrap the C dlmalloc (compiled from sysroot/dlmalloc.c)
///! so that Zig allocations and tree-sitter's malloc/free share the SAME
///! heap. Using Zig's WasmAllocator would create a second allocator that
///! also calls memory.grow, causing heap region collisions after many
///! alloc/free cycles.
///!
///! On native targets (tests) we use the page allocator.

const std = @import("std");
const builtin = @import("builtin");

extern fn malloc(usize) ?[*]u8;
extern fn free(?[*]u8) void;
extern fn realloc(?[*]u8, usize) ?[*]u8;

const dlmalloc_vtable = std.mem.Allocator.VTable{
    .alloc = dlmallocAlloc,
    .resize = dlmallocResize,
    .free = dlmallocFree,
    .remap = dlmallocRemap,
};

fn dlmallocAlloc(_: *anyopaque, len: usize, _: std.mem.Alignment, _: usize) ?[*]u8 {
    return malloc(len);
}

fn dlmallocResize(_: *anyopaque, _: []u8, _: std.mem.Alignment, _: usize, _: usize) bool {
    return false;
}

fn dlmallocRemap(_: *anyopaque, memory: []u8, _: std.mem.Alignment, new_len: usize, _: usize) ?[*]u8 {
    return realloc(memory.ptr, new_len);
}

fn dlmallocFree(_: *anyopaque, memory: []u8, _: std.mem.Alignment, _: usize) void {
    free(memory.ptr);
}

pub const gpa: std.mem.Allocator = if (builtin.target.cpu.arch == .wasm32)
    .{ .ptr = undefined, .vtable = &dlmalloc_vtable }
else
    std.heap.page_allocator;
