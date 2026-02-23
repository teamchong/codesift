/*
 * Minimal <stddef.h> for wasm32-freestanding.
 * Defines NULL, size_t, ptrdiff_t, and offsetof.
 */

#ifndef _STDDEF_H
#define _STDDEF_H

#ifndef NULL
#define NULL ((void *)0)
#endif

typedef unsigned int  size_t;
typedef int           ptrdiff_t;

typedef int           wchar_t;

#define offsetof(type, member) __builtin_offsetof(type, member)

/* max_align_t: the type with the strictest alignment */
typedef long long     max_align_t;

#endif /* _STDDEF_H */
