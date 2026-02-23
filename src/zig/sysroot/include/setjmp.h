/*
 * Minimal <setjmp.h> stub for wasm32-freestanding.
 *
 * tree-sitter needs setjmp/longjmp declarations. On WASM freestanding
 * there is no true setjmp support, so we provide stubs that trap on
 * longjmp (since tree-sitter only uses it for error recovery that
 * should not occur in normal operation).
 */

#ifndef _SETJMP_H
#define _SETJMP_H

/*
 * jmp_buf is defined as an array large enough for minimal context.
 * On wasm32, there are no callee-saved registers to preserve in the
 * traditional sense, but we need a type that compiles.
 */
typedef int jmp_buf[6];

/*
 * setjmp -- returns 0 on direct call.
 * In WASM freestanding we stub this to always return 0 (the "set" path).
 */
static inline int setjmp(jmp_buf env) {
    (void)env;
    return 0;
}

/*
 * longjmp -- should never be called in normal operation.
 * Traps if reached.
 */
static inline _Noreturn void longjmp(jmp_buf env, int val) {
    (void)env;
    (void)val;
    __builtin_trap();
}

#endif /* _SETJMP_H */
