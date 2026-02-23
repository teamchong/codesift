/*
 * Minimal <limits.h> for wasm32-freestanding.
 * Defines integer limits for a 32-bit WASM target (ILP32).
 */

#ifndef _LIMITS_H
#define _LIMITS_H

/* ── char ─────────────────────────────────────────────── */
#define CHAR_BIT   8
#define SCHAR_MIN  (-128)
#define SCHAR_MAX  127
#define UCHAR_MAX  255
#define CHAR_MIN   0
#define CHAR_MAX   UCHAR_MAX

/* ── short ────────────────────────────────────────────── */
#define SHRT_MIN   (-32768)
#define SHRT_MAX   32767
#define USHRT_MAX  65535

/* ── int ──────────────────────────────────────────────── */
#define INT_MIN    (-2147483647 - 1)
#define INT_MAX    2147483647
#define UINT_MAX   4294967295U

/* ── long (32-bit on wasm32) ──────────────────────────── */
#define LONG_MIN   (-2147483647L - 1)
#define LONG_MAX   2147483647L
#define ULONG_MAX  4294967295UL

/* ── long long ────────────────────────────────────────── */
#define LLONG_MIN  (-9223372036854775807LL - 1)
#define LLONG_MAX  9223372036854775807LL
#define ULLONG_MAX 18446744073709551615ULL

/* ── size_t max (32-bit) ──────────────────────────────── */
#ifndef SIZE_MAX
#define SIZE_MAX   4294967295U
#endif

/* ── MB_LEN_MAX ───────────────────────────────────────── */
#define MB_LEN_MAX 4

#endif /* _LIMITS_H */
