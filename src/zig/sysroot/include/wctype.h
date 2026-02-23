/*
 * Minimal <wctype.h> stub for wasm32-freestanding.
 *
 * tree-sitter's scanner uses iswspace, iswdigit, iswalpha, iswalnum.
 * These stubs handle ASCII-range wide characters only, which is
 * sufficient for JavaScript/TypeScript token scanning.
 */

#ifndef _WCTYPE_H
#define _WCTYPE_H

#ifndef __WINT_TYPE__
typedef unsigned int wint_t;
#else
typedef __WINT_TYPE__ wint_t;
#endif

typedef int wctrans_t;
typedef int wctype_t;

#ifndef WEOF
#define WEOF ((wint_t)-1)
#endif

static inline int iswspace(wint_t c) {
    return (c == ' ' || c == '\t' || c == '\n' ||
            c == '\r' || c == '\f' || c == '\v');
}

static inline int iswdigit(wint_t c) {
    return (c >= '0' && c <= '9');
}

static inline int iswalpha(wint_t c) {
    return ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
}

static inline int iswalnum(wint_t c) {
    return iswalpha(c) || iswdigit(c);
}

static inline int iswupper(wint_t c) {
    return (c >= 'A' && c <= 'Z');
}

static inline int iswlower(wint_t c) {
    return (c >= 'a' && c <= 'z');
}

static inline wint_t towupper(wint_t c) {
    if (c >= 'a' && c <= 'z') return c - ('a' - 'A');
    return c;
}

static inline wint_t towlower(wint_t c) {
    if (c >= 'A' && c <= 'Z') return c + ('a' - 'A');
    return c;
}

#endif /* _WCTYPE_H */
