/*
 * Minimal <stdlib.h> for wasm32-freestanding.
 * Declares malloc/free/calloc/realloc (implemented in dlmalloc.c).
 */

#ifndef _STDLIB_H
#define _STDLIB_H

#include <stddef.h>

void *malloc(size_t size);
void free(void *ptr);
void *calloc(size_t nmemb, size_t size);
void *realloc(void *ptr, size_t size);

_Noreturn void abort(void);

int atoi(const char *nptr);
long strtol(const char *nptr, char **endptr, int base);

#define EXIT_FAILURE 1
#define EXIT_SUCCESS 0

#endif /* _STDLIB_H */
