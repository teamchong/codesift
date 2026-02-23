/*
 * Minimal <endian.h> stub for wasm32-freestanding.
 * WASM is always little-endian, so le*toh / htole* are identity,
 * and be*toh / htobe* perform byte-swaps.
 */

#ifndef _ENDIAN_H
#define _ENDIAN_H

#include <stdint.h>

/* ── Byte-order constants ─────────────────────────────── */
#define __LITTLE_ENDIAN 1234
#define __BIG_ENDIAN    4321
#define __BYTE_ORDER    __LITTLE_ENDIAN

/* ── 16-bit byte-swap ─────────────────────────────────── */
static inline uint16_t __bswap16(uint16_t x) {
    return (uint16_t)((x >> 8) | (x << 8));
}

/* ── 32-bit byte-swap ─────────────────────────────────── */
static inline uint32_t __bswap32(uint32_t x) {
    return ((x >> 24) & 0x000000FFU) |
           ((x >>  8) & 0x0000FF00U) |
           ((x <<  8) & 0x00FF0000U) |
           ((x << 24) & 0xFF000000U);
}

/* ── Little-endian to host (identity on WASM) ─────────── */
#define le16toh(x) ((uint16_t)(x))
#define le32toh(x) ((uint32_t)(x))

/* ── Big-endian to host (byte-swap on WASM) ───────────── */
#define be16toh(x) __bswap16((uint16_t)(x))
#define be32toh(x) __bswap32((uint32_t)(x))

/* ── Host to little-endian (identity on WASM) ─────────── */
#define htole16(x) ((uint16_t)(x))
#define htole32(x) ((uint32_t)(x))

/* ── Host to big-endian (byte-swap on WASM) ───────────── */
#define htobe16(x) __bswap16((uint16_t)(x))
#define htobe32(x) __bswap32((uint32_t)(x))

#endif /* _ENDIAN_H */
