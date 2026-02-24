/** Shared benchmark utilities and fixtures. */

// ── Source fixtures ──────────────────────────────────────

export const SMALL_SOURCE = `const x = eval(input);`;

export const MEDIUM_SOURCE = `
import { readFile } from 'fs';
import fetch from 'node-fetch';

function processData(input) {
  const result = eval(input);
  console.log(result);
  return result;
}

async function fetchData(url) {
  const response = await fetch(url);
  const data = await response.json();
  setTimeout(() => console.log(data), 1000);
  return data;
}

export function main() {
  const rawData = readFile('data.json');
  processData(rawData);
  fetchData('https://api.example.com/data');
}
`.trim();

export const LARGE_SOURCE = Array.from({ length: 50 }, (_, i) => `
function fn${i}(arg${i}) {
  const val${i} = eval(arg${i});
  console.log("result:", val${i});
  setTimeout(() => process(val${i}), ${i * 100});
  if (val${i} > 0) {
    return fetch("https://api.example.com/" + val${i});
  }
  return null;
}
`).join("\n").trim();

// ── Bench runner ─────────────────────────────────────────

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
