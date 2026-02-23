/*
 * Minimal <stdio.h> stub for wasm32-freestanding.
 * Provides no-op implementations for fprintf, printf, etc.
 * I/O is not available in WASM freestanding mode.
 */

#ifndef _STDIO_H
#define _STDIO_H

#include <stddef.h>
#include <stdarg.h>

typedef struct FILE FILE;
#define stderr ((FILE *)0)

static inline int fprintf(FILE *f, const char *fmt, ...) {
    (void)f;
    (void)fmt;
    return 0;
}

static inline int printf(const char *fmt, ...) {
    (void)fmt;
    return 0;
}

static inline int fputc(int c, FILE *f) {
    (void)c;
    (void)f;
    return c;
}

static inline int fputs(const char *s, FILE *f) {
    (void)s;
    (void)f;
    return 0;
}

static inline int snprintf(char *buf, size_t size, const char *fmt, ...) {
    (void)buf;
    (void)size;
    (void)fmt;
    return 0;
}

static inline int vsnprintf(char *buf, size_t size, const char *fmt, va_list ap) {
    (void)buf;
    (void)size;
    (void)fmt;
    (void)ap;
    return 0;
}

static inline int vfprintf(FILE *f, const char *fmt, va_list ap) {
    (void)f;
    (void)fmt;
    (void)ap;
    return 0;
}

static inline int fclose(FILE *f) {
    (void)f;
    return 0;
}

static inline FILE *fdopen(int fd, const char *mode) {
    (void)fd;
    (void)mode;
    return (FILE *)0;
}

static inline FILE *fopen(const char *path, const char *mode) {
    (void)path;
    (void)mode;
    return (FILE *)0;
}

#define EOF (-1)
#define stdin  ((FILE *)0)
#define stdout ((FILE *)0)

#endif /* _STDIO_H */
