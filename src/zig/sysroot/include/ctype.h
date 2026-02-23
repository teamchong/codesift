/*
 * Minimal <ctype.h> stub for wasm32-freestanding.
 * Provides basic character classification for ASCII.
 */

#ifndef _CTYPE_H
#define _CTYPE_H

static inline int isalpha(int c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

static inline int isdigit(int c) {
    return c >= '0' && c <= '9';
}

static inline int isalnum(int c) {
    return isalpha(c) || isdigit(c);
}

static inline int isspace(int c) {
    return c == ' ' || c == '\t' || c == '\n' ||
           c == '\r' || c == '\f' || c == '\v';
}

static inline int isupper(int c) {
    return c >= 'A' && c <= 'Z';
}

static inline int islower(int c) {
    return c >= 'a' && c <= 'z';
}

static inline int isprint(int c) {
    return c >= 0x20 && c <= 0x7E;
}

static inline int isxdigit(int c) {
    return isdigit(c) || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
}

static inline int toupper(int c) {
    if (islower(c)) return c - ('a' - 'A');
    return c;
}

static inline int tolower(int c) {
    if (isupper(c)) return c + ('a' - 'A');
    return c;
}

#endif /* _CTYPE_H */
