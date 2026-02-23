/*
 * Minimal <assert.h> for wasm32-freestanding.
 * Asserts are no-ops in release/freestanding builds.
 */

#ifndef _ASSERT_H
#define _ASSERT_H

#ifdef NDEBUG
#define assert(x) ((void)0)
#else
#define assert(x) ((void)((x) || (__builtin_trap(), 0)))
#endif

/* C11 static_assert */
#ifndef __cplusplus
#define static_assert _Static_assert
#endif

#endif /* _ASSERT_H */
