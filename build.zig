const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = std.Target.wasm.featureSet(&.{
            .simd128,
            .bulk_memory,
            .sign_ext,
            .mutable_globals,
        }),
    });

    // --- Main WASM engine library ---
    const engine = b.addExecutable(.{
        .name = "engine",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/main.zig"),
            .target = wasm_target,
            .optimize = optimize,
            .strip = true,
            .unwind_tables = .none,
        }),
    });

    // Vendored regex module (from metal0/packages/regex)
    engine.root_module.addImport("regex", b.createModule(.{
        .root_source_file = b.path("vendor/regex/regex.zig"),
        .target = wasm_target,
        .optimize = optimize,
    }));

    // WASM-specific settings
    engine.entry = .disabled;
    engine.rdynamic = true;
    engine.root_module.export_symbol_names = &.{
        "alloc",
        "dealloc",
        "struct_match",
        "get_result_ptr",
        "get_result_len",
        "compile_pattern",
        "match_pattern",
        "free_pattern",
        "compile_source",
        "match_compiled",
        "free_source",
        // Match slot system
        "store_matches",
        "filter_inside",
        "filter_not_inside",
        "filter_not",
        "intersect_matches",
        "free_matches",
        // Kind matching
        "kind_match",
        // Range-constrained matching
        "match_in_range",
        // Sibling matching
        "match_preceding",
        "match_following",
        // Tree traversal
        "node_root",
        "node_info",
        "node_children",
        "node_named_children",
        "node_parent",
        "node_field_child",
        "node_next",
        "node_prev",
        // Rule engine
        "load_ruleset",
        "apply_ruleset",
        "free_ruleset",
        "get_ruleset_result_ptr",
        "get_ruleset_result_len",
    };

    // --- C source compilation (tree-sitter + dlmalloc) ---
    //
    // tree-sitter runtime: lib.c is an amalgamation #including all .c files.
    // JS grammar: parser.c (generated) + scanner.c (custom lexer extensions).
    // TS grammar: parser.c (generated) + scanner.c.
    // dlmalloc: Doug Lea's allocator for wasm32-freestanding malloc/free.

    const c_flags: []const []const u8 = &.{
        "-std=c11",
        "-fno-stack-protector",
        "-UTREE_SITTER_FEATURE_WASM",
        "-DNDEBUG",
    };

    const sysroot_flags: []const []const u8 = &.{
        "-std=c11",
        "-fno-stack-protector",
        "-DLACKS_SYS_MMAN_H",
        "-DLACKS_UNISTD_H",
        "-DLACKS_FCNTL_H",
        "-DLACKS_TIME_H",
        "-DLACKS_ERRNO_H",
        "-DHAVE_MMAP=0",
        "-DHAVE_MREMAP=0",
        "-Dgetpagesize()=65536",
    };

    // tree-sitter runtime (lib.c includes all internal sources)
    engine.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/runtime/lib/src/lib.c"),
        .flags = c_flags,
    });

    // JavaScript grammar (ES2024 + JSX)
    engine.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/javascript/src/parser.c"),
        .flags = c_flags,
    });
    engine.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/javascript/src/scanner.c"),
        .flags = c_flags,
    });

    // TypeScript grammar (full TS + TSX)
    engine.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/typescript/typescript/src/parser.c"),
        .flags = c_flags,
    });
    engine.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/typescript/typescript/src/scanner.c"),
        .flags = c_flags,
    });

    // dlmalloc for wasm32-freestanding (provides malloc/free/calloc/realloc)
    engine.addCSourceFile(.{
        .file = b.path("src/zig/sysroot/dlmalloc.c"),
        .flags = sysroot_flags,
    });

    // C include paths
    engine.addIncludePath(b.path("vendor/tree-sitter/runtime/lib/include"));
    engine.addIncludePath(b.path("vendor/tree-sitter/runtime/lib/src"));
    engine.addIncludePath(b.path("src/zig/sysroot/include"));
    // TypeScript scanner includes ../../common/scanner.h relative to its source;
    // common/scanner.h then includes "tree_sitter/parser.h" which lives under
    // typescript/typescript/src/tree_sitter/.
    engine.addIncludePath(b.path("vendor/tree-sitter/typescript"));
    engine.addIncludePath(b.path("vendor/tree-sitter/typescript/typescript/src"));

    // Install to zig-out/bin/engine.wasm
    b.installArtifact(engine);

    // --- Copy to dist/ for convenience ---
    const install_dist = b.addInstallFile(engine.getEmittedBin(), "../dist/engine.wasm");
    b.getInstallStep().dependOn(&install_dist.step);

    // --- Tests (native target for unit testing) ---
    const test_target = b.standardTargetOptions(.{});
    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/main.zig"),
            .target = test_target,
            .optimize = optimize,
        }),
    });

    // Vendored regex module for tests (native target)
    unit_tests.root_module.addImport("regex", b.createModule(.{
        .root_source_file = b.path("vendor/regex/regex.zig"),
        .target = test_target,
        .optimize = optimize,
    }));

    // Link libc for tree-sitter @cImport on native targets
    unit_tests.linkLibC();

    // tree-sitter C sources for native test builds
    const test_c_flags: []const []const u8 = &.{
        "-std=c11",
        "-D_GNU_SOURCE",
        "-UTREE_SITTER_FEATURE_WASM",
        "-DNDEBUG",
    };

    unit_tests.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/runtime/lib/src/lib.c"),
        .flags = test_c_flags,
    });
    unit_tests.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/javascript/src/parser.c"),
        .flags = test_c_flags,
    });
    unit_tests.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/javascript/src/scanner.c"),
        .flags = test_c_flags,
    });
    unit_tests.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/typescript/typescript/src/parser.c"),
        .flags = test_c_flags,
    });
    unit_tests.addCSourceFile(.{
        .file = b.path("vendor/tree-sitter/typescript/typescript/src/scanner.c"),
        .flags = test_c_flags,
    });

    // C include paths for tree-sitter headers
    unit_tests.addIncludePath(b.path("vendor/tree-sitter/runtime/lib/include"));
    unit_tests.addIncludePath(b.path("vendor/tree-sitter/runtime/lib/src"));
    // TypeScript scanner includes ../../common/scanner.h relative to its source;
    // common/scanner.h then includes "tree_sitter/parser.h" which lives under
    // typescript/typescript/src/tree_sitter/.
    unit_tests.addIncludePath(b.path("vendor/tree-sitter/typescript"));
    unit_tests.addIncludePath(b.path("vendor/tree-sitter/typescript/typescript/src"));

    const run_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);
}
