/** Shared benchmark utilities. */

export interface BenchResult {
  name: string;
  opsPerSec: number;
  avgNs: number;
}

export function bench(name: string, fn: () => void, iterations = 1_000): BenchResult {
  // Warmup — run enough iterations to let JIT/WASM optimize
  const warmup = Math.min(iterations, 500);
  for (let i = 0; i < warmup; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const avgMs = elapsed / iterations;
  const avgNs = avgMs * 1_000_000;
  const opsPerSec = 1000 / avgMs;

  return { name, opsPerSec, avgNs };
}

export function formatOps(ops: number): string {
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(2)}K`;
  return ops.toFixed(2);
}

export function formatNs(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}
