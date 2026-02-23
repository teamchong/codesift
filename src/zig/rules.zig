///! codesift — Language enum for WASM pattern matching engine.

// ── Language ──────────────────────────────────────────────

pub const Language = enum(u8) {
    javascript = 1,
    typescript = 2,
    tsx = 3,
};
