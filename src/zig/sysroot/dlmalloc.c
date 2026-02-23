/*
 * Minimal malloc/free/calloc/realloc for wasm32-freestanding.
 *
 * Uses WASM linear memory grow (__builtin_wasm_memory_grow) as the
 * backing sbrk. Implements a simple free-list allocator with 8-byte
 * aligned allocations and header-based bookkeeping.
 *
 * This is NOT Doug Lea's full dlmalloc -- it is a minimal allocator
 * sufficient for tree-sitter and other C dependencies in codesift.
 */

#include <stddef.h>
#include <stdint.h>

/* ── Constants ──────────────────────────────────────────── */

#define WASM_PAGE_SIZE   65536
#define ALIGNMENT        8
#define HEADER_SIZE      (sizeof(struct block_header))
#define BLOCK_MAGIC      0xA110CA7E  /* "ALLOCATE" */
#define FREE_MAGIC       0xF4EEB10C  /* "FREEBLOC" */
#define MIN_BLOCK_SIZE   (HEADER_SIZE + ALIGNMENT)

/* ── Block header ───────────────────────────────────────── */

struct block_header {
    size_t size;       /* Usable payload size (excluding header) */
    uint32_t magic;    /* BLOCK_MAGIC if allocated, FREE_MAGIC if free */
    uint32_t _pad;     /* Pad to 16 bytes for 8-byte aligned payload */
    struct block_header *next_free;  /* Next in free list (only used when free) */
};

/* ── Static state ───────────────────────────────────────── */

static unsigned char *heap_ptr = NULL;
static unsigned char *heap_end = NULL;
static struct block_header *free_list = NULL;

/* ── Alignment helpers ──────────────────────────────────── */

static size_t align_up(size_t n, size_t align) {
    return (n + align - 1) & ~(align - 1);
}

/* ── WASM sbrk ──────────────────────────────────────────── */

static void *wasm_sbrk(size_t increment) {
    if (increment == 0) {
        if (heap_ptr == NULL) {
            /* Initialize heap pointer to current memory end */
            size_t pages = __builtin_wasm_memory_size(0);
            heap_ptr = (unsigned char *)(pages * WASM_PAGE_SIZE);
            heap_end = heap_ptr;
        }
        return heap_ptr;
    }

    /* Ensure heap is initialized */
    if (heap_ptr == NULL) {
        size_t pages = __builtin_wasm_memory_size(0);
        heap_ptr = (unsigned char *)(pages * WASM_PAGE_SIZE);
        heap_end = heap_ptr;
    }

    unsigned char *old_end = heap_end;
    unsigned char *new_end = old_end + increment;

    /* Check if we need to grow memory */
    size_t current_size = __builtin_wasm_memory_size(0) * WASM_PAGE_SIZE;
    if ((size_t)new_end > current_size) {
        size_t needed = (size_t)new_end - current_size;
        size_t pages_needed = (needed + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;
        /* Grow at least 1 page, or more if needed */
        if (pages_needed < 1) pages_needed = 1;
        size_t result = __builtin_wasm_memory_grow(0, pages_needed);
        if (result == (size_t)-1) {
            return (void *)-1;  /* Out of memory */
        }
    }

    heap_end = new_end;
    return old_end;
}

/* ── Free list management ───────────────────────────────── */

/*
 * Remove a block from the free list.
 */
static void remove_from_free_list(struct block_header *block) {
    if (free_list == block) {
        free_list = block->next_free;
        return;
    }

    struct block_header *prev = free_list;
    while (prev != NULL && prev->next_free != block) {
        prev = prev->next_free;
    }
    if (prev != NULL) {
        prev->next_free = block->next_free;
    }
}

/*
 * Insert a block at the head of the free list.
 */
static void insert_into_free_list(struct block_header *block) {
    block->next_free = free_list;
    block->magic = FREE_MAGIC;
    free_list = block;
}

/*
 * Try to find a free block that fits the requested size.
 * Uses first-fit strategy.
 */
static struct block_header *find_free_block(size_t size) {
    struct block_header *current = free_list;
    while (current != NULL) {
        if (current->size >= size) {
            return current;
        }
        current = current->next_free;
    }
    return NULL;
}

/*
 * Split a block if it is large enough to hold the requested size
 * plus a new free block.
 */
static void maybe_split(struct block_header *block, size_t size) {
    if (block->size >= size + MIN_BLOCK_SIZE + ALIGNMENT) {
        /* Create a new free block after the allocated region */
        struct block_header *new_block =
            (struct block_header *)((unsigned char *)block + HEADER_SIZE + size);
        new_block->size = block->size - size - HEADER_SIZE;
        new_block->magic = FREE_MAGIC;
        new_block->next_free = NULL;
        insert_into_free_list(new_block);

        block->size = size;
    }
}

/* ── Public API ─────────────────────────────────────────── */

void *malloc(size_t size) {
    if (size == 0) {
        return NULL;
    }

    /* Align size to ALIGNMENT boundary */
    size = align_up(size, ALIGNMENT);

    /* Try to reuse a free block */
    struct block_header *block = find_free_block(size);
    if (block != NULL) {
        remove_from_free_list(block);
        maybe_split(block, size);
        block->magic = BLOCK_MAGIC;
        block->next_free = NULL;
        return (void *)((unsigned char *)block + HEADER_SIZE);
    }

    /* Allocate from sbrk */
    size_t total = HEADER_SIZE + size;
    void *ptr = wasm_sbrk(total);
    if (ptr == (void *)-1) {
        return NULL;
    }

    block = (struct block_header *)ptr;
    block->size = size;
    block->magic = BLOCK_MAGIC;
    block->_pad = 0;
    block->next_free = NULL;

    return (void *)((unsigned char *)block + HEADER_SIZE);
}

void free(void *ptr) {
    if (ptr == NULL) {
        return;
    }

    struct block_header *block =
        (struct block_header *)((unsigned char *)ptr - HEADER_SIZE);

    /* Validate the block */
    if (block->magic != BLOCK_MAGIC) {
        /* Invalid free -- corrupted or double-free. Silently ignore in
         * WASM context (no stderr to report to). */
        return;
    }

    /* Forward coalescing: merge with next adjacent block if free.
     * Critical for tree-sitter which allocates many small blocks per parse. */
    unsigned char *next_addr = (unsigned char *)block + HEADER_SIZE + block->size;
    if (next_addr < heap_ptr) {
        struct block_header *next = (struct block_header *)next_addr;
        if (next->magic == FREE_MAGIC) {
            remove_from_free_list(next);
            block->size += HEADER_SIZE + next->size;
            next->magic = 0;
        }
    }

    insert_into_free_list(block);
}

void *calloc(size_t nmemb, size_t size) {
    /* Check for overflow */
    if (nmemb != 0 && size > (size_t)-1 / nmemb) {
        return NULL;
    }

    size_t total = nmemb * size;
    void *ptr = malloc(total);
    if (ptr == NULL) {
        return NULL;
    }

    /* Zero the memory */
    unsigned char *p = (unsigned char *)ptr;
    for (size_t i = 0; i < total; i++) {
        p[i] = 0;
    }

    return ptr;
}

void *realloc(void *ptr, size_t size) {
    if (ptr == NULL) {
        return malloc(size);
    }

    if (size == 0) {
        free(ptr);
        return NULL;
    }

    struct block_header *block =
        (struct block_header *)((unsigned char *)ptr - HEADER_SIZE);

    if (block->magic != BLOCK_MAGIC) {
        return NULL;
    }

    /* If the existing block is big enough, keep it */
    size_t aligned_size = align_up(size, ALIGNMENT);
    if (block->size >= aligned_size) {
        /* Optionally split if much larger */
        maybe_split(block, aligned_size);
        return ptr;
    }

    /* Allocate new block, copy, free old */
    void *new_ptr = malloc(size);
    if (new_ptr == NULL) {
        return NULL;
    }

    /* Copy old data */
    unsigned char *src = (unsigned char *)ptr;
    unsigned char *dst = (unsigned char *)new_ptr;
    size_t copy_size = block->size < size ? block->size : size;
    for (size_t i = 0; i < copy_size; i++) {
        dst[i] = src[i];
    }

    free(ptr);
    return new_ptr;
}

/* ── Required C runtime stubs ───────────────────────────── */

/*
 * abort() -- required by some C code paths.
 * In WASM freestanding we trap via unreachable.
 */
_Noreturn void abort(void) {
    __builtin_trap();
}

/*
 * memset -- needed by calloc and general C code.
 * Provided here in case the compiler doesn't inline it.
 */
void *memset(void *s, int c, size_t n) {
    unsigned char *p = (unsigned char *)s;
    for (size_t i = 0; i < n; i++) {
        p[i] = (unsigned char)c;
    }
    return s;
}

/*
 * memcpy -- byte-by-byte copy.
 */
void *memcpy(void *dest, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dest;
    const unsigned char *s = (const unsigned char *)src;
    for (size_t i = 0; i < n; i++) {
        d[i] = s[i];
    }
    return dest;
}

/*
 * memmove -- safe overlapping copy.
 */
void *memmove(void *dest, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dest;
    const unsigned char *s = (const unsigned char *)src;
    if (d < s) {
        for (size_t i = 0; i < n; i++) {
            d[i] = s[i];
        }
    } else if (d > s) {
        for (size_t i = n; i > 0; i--) {
            d[i - 1] = s[i - 1];
        }
    }
    return dest;
}

/*
 * memcmp -- byte comparison.
 */
int memcmp(const void *s1, const void *s2, size_t n) {
    const unsigned char *a = (const unsigned char *)s1;
    const unsigned char *b = (const unsigned char *)s2;
    for (size_t i = 0; i < n; i++) {
        if (a[i] != b[i]) {
            return (int)a[i] - (int)b[i];
        }
    }
    return 0;
}

/*
 * strlen -- string length.
 */
size_t strlen(const char *s) {
    size_t len = 0;
    while (s[len] != '\0') {
        len++;
    }
    return len;
}

/*
 * strncpy -- bounded string copy.
 */
char *strncpy(char *dest, const char *src, size_t n) {
    size_t i;
    for (i = 0; i < n && src[i] != '\0'; i++) {
        dest[i] = src[i];
    }
    for (; i < n; i++) {
        dest[i] = '\0';
    }
    return dest;
}

/*
 * strncmp -- bounded string comparison.
 */
int strncmp(const char *s1, const char *s2, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (s1[i] != s2[i]) {
            return (unsigned char)s1[i] - (unsigned char)s2[i];
        }
        if (s1[i] == '\0') {
            return 0;
        }
    }
    return 0;
}

/*
 * strcmp -- string comparison.
 */
int strcmp(const char *s1, const char *s2) {
    while (*s1 && (*s1 == *s2)) {
        s1++;
        s2++;
    }
    return (unsigned char)*s1 - (unsigned char)*s2;
}

/*
 * strchr -- find character in string.
 */
char *strchr(const char *s, int c) {
    while (*s != '\0') {
        if (*s == (char)c) {
            return (char *)s;
        }
        s++;
    }
    if (c == '\0') {
        return (char *)s;
    }
    return NULL;
}

/*
 * atoi -- string to integer.
 */
int atoi(const char *nptr) {
    int result = 0;
    int sign = 1;

    /* Skip whitespace */
    while (*nptr == ' ' || *nptr == '\t' || *nptr == '\n' ||
           *nptr == '\r' || *nptr == '\f' || *nptr == '\v') {
        nptr++;
    }

    if (*nptr == '-') {
        sign = -1;
        nptr++;
    } else if (*nptr == '+') {
        nptr++;
    }

    while (*nptr >= '0' && *nptr <= '9') {
        result = result * 10 + (*nptr - '0');
        nptr++;
    }

    return sign * result;
}

/*
 * strtol -- string to long with base.
 */
long strtol(const char *nptr, char **endptr, int base) {
    long result = 0;
    int sign = 1;

    /* Skip whitespace */
    while (*nptr == ' ' || *nptr == '\t' || *nptr == '\n' ||
           *nptr == '\r' || *nptr == '\f' || *nptr == '\v') {
        nptr++;
    }

    if (*nptr == '-') {
        sign = -1;
        nptr++;
    } else if (*nptr == '+') {
        nptr++;
    }

    /* Auto-detect base */
    if (base == 0) {
        if (*nptr == '0') {
            nptr++;
            if (*nptr == 'x' || *nptr == 'X') {
                base = 16;
                nptr++;
            } else {
                base = 8;
            }
        } else {
            base = 10;
        }
    } else if (base == 16) {
        if (nptr[0] == '0' && (nptr[1] == 'x' || nptr[1] == 'X')) {
            nptr += 2;
        }
    }

    while (1) {
        int digit;
        if (*nptr >= '0' && *nptr <= '9') {
            digit = *nptr - '0';
        } else if (*nptr >= 'a' && *nptr <= 'z') {
            digit = *nptr - 'a' + 10;
        } else if (*nptr >= 'A' && *nptr <= 'Z') {
            digit = *nptr - 'A' + 10;
        } else {
            break;
        }
        if (digit >= base) {
            break;
        }
        result = result * base + digit;
        nptr++;
    }

    if (endptr != NULL) {
        *endptr = (char *)nptr;
    }

    return sign * result;
}
