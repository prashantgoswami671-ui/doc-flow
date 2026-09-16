/**
 * Benchmark scope guard (PROTOTYPE / BENCHMARK ONLY).
 *
 * Static textual guard ensuring the benchmark/prototype surface stays
 * separated from production and free of throttling workarounds or
 * network egress:
 * - no imports of the production runtime (services/ai/browser/*),
 *   production UI, or tool catalog from prototype/harness sources;
 * - no keep-awake / throttling workarounds (wake lock, silent audio,
 *   periodic ping loops) in the harness page;
 * - no network primitives (fetch/XHR/WebSocket/beacon/FormData) in the
 *   harness page or the new benchmark modules.
 *
 * Mirrors the style of tests/network-egress.test.ts (textual analysis,
 * comments stripped, best-effort).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf-8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Non-test prototype sources plus the harness page. Test files are
// excluded: assertions below necessarily name the forbidden patterns.
const SCOPED_FILES = [
  "services/ai-prototype/benchmarkConfig.ts",
  "services/ai-prototype/mapReduceRunner.ts",
  "services/ai-prototype/promptBuilder.ts",
  "services/ai-prototype/browserAiWorkerClient.ts",
  "services/ai-prototype/workerProtocol.ts",
  "services/ai-prototype/constants.ts",
  "app/test/browser-ai/page.tsx",
];

describe("benchmark scope guard", () => {
  it("prototype/harness sources do not import production runtime or UI", () => {
    const offenders: string[] = [];
    for (const file of SCOPED_FILES) {
      const content = stripComments(readRepoFile(file));
      if (
        /from\s+["'][^"']*services\/ai\/browser/.test(content) ||
        /from\s+["'][^"']*components\/SummarizePdfCard/.test(content) ||
        /from\s+["'][^"']*services\/ai\/orchestration/.test(content) ||
        /from\s+["'][^"']*services\/ai\/instructions/.test(content)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("harness page has no keep-awake or throttling workarounds", () => {
    const content = stripComments(readRepoFile("app/test/browser-ai/page.tsx"));
    const forbidden = ["wakeLock", "Audio(", "setInterval", "requestVideoFrameCallback"];
    const found = forbidden.filter((token) => content.includes(token));
    expect(found).toEqual([]);
  });

  it("harness page and benchmark modules add no network primitives", () => {
    const offenders: string[] = [];
    for (const file of SCOPED_FILES) {
      const content = stripComments(readRepoFile(file));
      if (
        /\bfetch\s*\(/.test(content) ||
        content.includes("XMLHttpRequest") ||
        content.includes("sendBeacon") ||
        content.includes("new WebSocket(") ||
        content.includes("FormData")
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
