import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { OLLAMA_BASE_URL } from "../services/ai/ollama/types";

/**
 * Pre-Phase-5 hardening — static network-egress regression guard.
 *
 * SEC-02 (re-verified 2026-08-29, see docs/DOCFLOW_STATUS.md) established
 * by direct code reading that current production DocFlow has exactly one
 * `fetch()` call anywhere in `app/`, `components/`, `services/`, `lib/` —
 * `services/pdf/rasterize.ts`, fetching a *local* `data:` URL built from
 * `canvas.toDataURL(...)` — and no `XMLHttpRequest`, `sendBeacon`,
 * `WebSocket`, or `FormData` usage at all. That finding was a point-in-time
 * manual read, not a standing guard: nothing would have failed if a later
 * change (including early Phase 5 work) introduced a new network call that
 * sent PDF-derived content off-device.
 *
 * This test converts that finding into a static, dependency-free regression
 * guard: it scans production source files as text (comments stripped) and
 * fails if a new network-primitive call site appears anywhere, or if a
 * `fetch()`/`fetchImpl()` call appears anywhere other than the allowlisted,
 * already-reviewed locations.
 *
 * Deliberate scope limits (see the SEC-06/pre-Phase-5 hardening note in
 * docs/DOCFLOW_STATUS.md for the full discussion):
 * - This is textual analysis, not an AST parse or a real network mock. It
 *   cannot catch obfuscated/indirect calls (e.g. `window['fe' + 'tch']`),
 *   and comment-stripping is a best-effort regex, not a real parser.
 * - It intentionally does not inspect `node_modules` — tesseract.js's own
 *   internal jsDelivr asset requests are a known, disclosed, third-party
 *   dependency behavior (SEC-05), not a DocFlow-authored egress path, and
 *   are out of this guard's scope by design.
 * - T2-01 (2026-09-13) — the production Ollama provider added the second
 *   and only other egress path: services/ai/ollama/client.ts, talking to a
 *   local Ollama server. Its boundary is pinned by this guard: the fetch
 *   allowlist covers exactly that file, and the loopback-only test asserts
 *   the module can only target http://127.0.0.1:11434 (a single URL literal
 *   in types.ts, no environment-driven endpoint). Any new egress
 *   destination still needs SEC-06 policy review
 *   (docs/SEC-06-AI-DATA-POLICY.md) before landing.
 *
 * Checkpoint 2A (Browser AI prototype) investigation note, added
 * 2026-08-31 — findings per checkpoint spec §16 before any test change:
 *   1. The prototype's own source (services/ai-prototype/*) contains no
 *      literal fetch()/XMLHttpRequest/sendBeacon/WebSocket/FormData call
 *      — model-asset downloads are performed internally by the
 *      `@huggingface/transformers` package (a node_modules dependency),
 *      not by any DocFlow-authored file under app/components/services/lib.
 *   2. Their destination is the model repo configured by
 *      services/ai-prototype/constants.ts (PILOT_MODEL_ID /
 *      BENCHMARK_CANDIDATE_MODEL_ID) via the Hugging Face Hub/CDN — a
 *      fixed, known static-asset source, not an arbitrary/user-supplied
 *      destination.
 *   3. The request bodies are plain GET asset fetches for model weight
 *      files; no document-derived content (extracted text, chunks, the
 *      original PDF, or any AI request payload) is attached to them —
 *      services/ai-prototype/browserAiWorker.ts only ever sends the
 *      plain-text chat messages built by promptBuilder.ts *to the model
 *      itself* (in-process inference calls, not network requests).
 *   4. Conclusion: this mirrors the already-accepted tesseract.js/jsDelivr
 *      precedent (SEC-05) — a disclosed, third-party dependency's own
 *      internal asset-fetching behavior, out of this guard's scope by
 *      design (see "It intentionally does not inspect node_modules"
 *      above). No amendment to SCAN_ROOT_DIRS, ALLOWED_FETCH_FILES, or
 *      the assertions below was needed or made: this guard would still
 *      correctly fail if a future change added a literal fetch() call
 *      inside services/ai-prototype/* itself (e.g. a hand-rolled
 *      download/proxy layer), which is exactly the case that would
 *      warrant SEC-06 review.
 */

const SCAN_ROOT_DIRS = ["app", "components", "services", "lib"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const EXCLUDED_DIR_NAMES = new Set(["__fixtures__", "node_modules"]);

// The already-reviewed fetch() call sites. Any other file containing a
// fetch()/fetchImpl() call fails this test — see the file-level doc comment
// for why this is intentionally strict rather than allowlisting a keyword.
//
// - services/pdf/rasterize.ts: local data: URL only (SEC-02).
// - services/ai/ollama/client.ts: the T2-01 Ollama provider — loopback-only
//   endpoint, enforced by the dedicated test below.
const ALLOWED_FETCH_FILES = new Set([
  "services/pdf/rasterize.ts",
  "services/ai/ollama/client.ts",
]);

const PROJECT_ROOT = process.cwd();

function isTestFile(fileName: string): boolean {
  return /\.test\.(ts|tsx)$/.test(fileName);
}

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) {
      continue;
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (
      entry.isFile() &&
      SCAN_EXTENSIONS.has(extname(entry.name)) &&
      !isTestFile(entry.name)
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Best-effort comment stripper so that explanatory prose (e.g. a docstring
 * that mentions "canvas.toDataURL()+fetch()" while describing behavior, as
 * services/pdf/rasterize.ts's own comments do) doesn't trigger a false
 * positive. Not a real parser — see the file-level doc comment for the
 * accepted trade-off.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function toRepoRelativePath(absolutePath: string): string {
  return relative(PROJECT_ROOT, absolutePath).split("\\").join("/");
}

describe("network egress regression guard (pre-Phase-5 hardening)", () => {
  const sourceFiles = SCAN_ROOT_DIRS.flatMap((dir) => {
    const absoluteDir = join(PROJECT_ROOT, dir);

    try {
      statSync(absoluteDir);
    } catch {
      return [];
    }

    return collectSourceFiles(absoluteDir);
  });

  // Sanity check on the scan itself — if this ever comes back empty, the
  // test below would pass vacuously and silently stop protecting anything.
  it("actually found source files to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("contains no XMLHttpRequest, sendBeacon, WebSocket, or FormData usage", () => {
    const offenders: string[] = [];

    for (const filePath of sourceFiles) {
      const content = stripComments(readFileSync(filePath, "utf-8"));

      if (
        content.includes("XMLHttpRequest") ||
        content.includes("sendBeacon") ||
        content.includes("new WebSocket(") ||
        content.includes("FormData")
      ) {
        offenders.push(toRepoRelativePath(filePath));
      }
    }

    expect(
      offenders,
      `Found a new network-primitive call site (XMLHttpRequest / sendBeacon / WebSocket / FormData) in: ${offenders.join(", ")}. ` +
        `DocFlow's current architecture is browser-only with no document-content egress path (SEC-02). ` +
        `If this is intentional, it needs SEC-06 policy review (docs/SEC-06-AI-DATA-POLICY.md) before landing, not just a test update.`,
    ).toEqual([]);
  });

  it("contains fetch()/fetchImpl() only in the already-reviewed allowlisted call sites", () => {
    const filesWithFetch: string[] = [];

    for (const filePath of sourceFiles) {
      const content = stripComments(readFileSync(filePath, "utf-8"));

      // Match direct fetch() calls and the fetchImpl(...) alias used by the
      // Ollama client. Without the alias, the allowlisted Ollama site would
      // be invisible to this guard — and new aliases would slip through
      // unreviewed.
      if (/\bfetch(?:Impl)?\s*\(/.test(content)) {
        filesWithFetch.push(toRepoRelativePath(filePath));
      }
    }

    const unexpectedFiles = filesWithFetch.filter(
      (file) => !ALLOWED_FETCH_FILES.has(file),
    );

    expect(
      unexpectedFiles,
      `Found a new fetch()/fetchImpl() call site outside the allowlist: ${unexpectedFiles.join(", ")}. ` +
        `Only ${[...ALLOWED_FETCH_FILES].join(", ")} are permitted to call fetch() today ` +
        `(a local data: URL per SEC-02, and the loopback-only Ollama client per T2-01). ` +
        `A new fetch() call site is exactly the kind of change SEC-06 (docs/SEC-06-AI-DATA-POLICY.md) requires review for before it lands.`,
    ).toEqual([]);

    // Also confirm every allowlisted site is still actually present — if one
    // ever disappears (e.g. rasterize.ts drops the toDataURL/fetch path, or
    // the Ollama client is refactored away), that's a stale allowlist entry
    // that should be removed.
    expect(filesWithFetch).toEqual(expect.arrayContaining([...ALLOWED_FETCH_FILES]));
  });

  // T2-01 — the Ollama provider is the only AI egress path, and it must be
  // loopback-only. This complements the functional tests in
  // services/ai/ollama/runtime.test.ts with a static, whole-module view.
  it("pins the Ollama fetch boundary to the fixed loopback endpoint", () => {
    // The exact constant the production client defaults to.
    expect(OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");

    const ollamaFiles = sourceFiles.filter((filePath) =>
      toRepoRelativePath(filePath).startsWith("services/ai/ollama/"),
    );

    // Guard against the module silently moving or renaming out of the scan.
    expect(ollamaFiles.length).toBeGreaterThan(0);

    const strippedByFile = ollamaFiles.map((filePath) => ({
      file: toRepoRelativePath(filePath),
      content: stripComments(readFileSync(filePath, "utf-8")),
    }));

    // No environment-driven endpoint: process.env must not appear anywhere
    // in the Ollama module, so the base URL cannot be overridden at runtime.
    const filesWithEnv = strippedByFile
      .filter(({ content }) => content.includes("process.env"))
      .map(({ file }) => file);
    expect(filesWithEnv).toEqual([]);

    // Exactly one absolute URL literal exists in the whole module, and it is
    // the fixed loopback constant — so no other egress destination can be
    // introduced without failing this test.
    const urlLiterals = strippedByFile.flatMap(({ file, content }) => {
      const matches = content.match(/https?:\/\/[^\s"'`)+]+/g) ?? [];
      return matches.map((match) => ({ file, match }));
    });
    expect(urlLiterals).toEqual([
      { file: "services/ai/ollama/types.ts", match: "http://127.0.0.1:11434" },
    ]);
  });

  // V6-F04 — the Ollama module must carry no binary document payload:
  // no File/Blob/ArrayBuffer/Uint8Array plumbing, no page images or
  // thumbnails, no passwords, no metadata fields, no FileReader usage.
  // The Tier-2 transport may only send extracted-text prompts plus the
  // structured-output configuration (proven at runtime by the D02/D04
  // unit tests); this static test fails any future change that threads
  // original PDF bytes, images, or document metadata toward Ollama.
  // (Case-sensitive on purpose: the Ollama API's own `modelfile` field
  // must not trip this guard.)
  it("carries no binary document payload identifiers in the Ollama module", () => {
    const ollamaFiles = sourceFiles.filter((filePath) =>
      toRepoRelativePath(filePath).startsWith("services/ai/ollama/"),
    );
    expect(ollamaFiles.length).toBeGreaterThan(0);

    const payloadPatterns = [
      /\bFile\b/,
      /\bBlob\b/,
      /ArrayBuffer/,
      /Uint8Array/,
      /pageImage/,
      /thumbnail/,
      /password/i,
      /metadata/,
      /readAs[A-Z]/,
    ];
    const offenders: string[] = [];
    for (const filePath of ollamaFiles) {
      const content = stripComments(readFileSync(filePath, "utf-8"));
      const hits = payloadPatterns
        .filter((pattern) => pattern.test(content))
        .map((pattern) => String(pattern));
      if (hits.length > 0) {
        offenders.push(`${toRepoRelativePath(filePath)} (${hits.join(", ")})`);
      }
    }
    expect(
      offenders,
      `Binary document payload identifiers found in the Ollama module: ${offenders.join("; ")}. ` +
        `Only extracted-text prompts and structured-output configuration may reach Ollama (SEC-06).`,
    ).toEqual([]);
  });
});
