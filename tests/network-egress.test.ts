import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

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
 * fails if a new network-primitive call site appears anywhere, or if
 * `fetch(` appears anywhere other than the one already-reviewed location.
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
 * - It intentionally does NOT yet encode any AI-provider-specific rules
 *   (allowed request shape, Ollama URL allowlisting, consent-gating, etc.)
 *   from docs/SEC-06-AI-DATA-POLICY.md — those require AI-01/AI-02 to
 *   exist first and are out of scope for this guard.
 */

const SCAN_ROOT_DIRS = ["app", "components", "services", "lib"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const EXCLUDED_DIR_NAMES = new Set(["__fixtures__", "node_modules"]);

// The one already-reviewed fetch() call site (SEC-02). Any other file
// containing `fetch(` fails this test — see the file-level doc comment for
// why this is intentionally strict rather than allowlisting a keyword.
const ALLOWED_FETCH_FILES = new Set(["services/pdf/rasterize.ts"]);

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

  it("contains fetch() only in the one already-reviewed local-data-URL call site", () => {
    const filesWithFetch: string[] = [];

    for (const filePath of sourceFiles) {
      const content = stripComments(readFileSync(filePath, "utf-8"));

      if (/\bfetch\s*\(/.test(content)) {
        filesWithFetch.push(toRepoRelativePath(filePath));
      }
    }

    const unexpectedFiles = filesWithFetch.filter(
      (file) => !ALLOWED_FETCH_FILES.has(file),
    );

    expect(
      unexpectedFiles,
      `Found a new fetch() call site outside the allowlist: ${unexpectedFiles.join(", ")}. ` +
        `Only ${[...ALLOWED_FETCH_FILES].join(", ")} is permitted to call fetch() today (a local data: URL, per SEC-02). ` +
        `A new fetch() call site is exactly the kind of change SEC-06 (docs/SEC-06-AI-DATA-POLICY.md) requires review for before it lands.`,
    ).toEqual([]);

    // Also confirm the one allowed site is still actually present — if it
    // ever disappears (e.g. rasterize.ts is refactored to drop the
    // toDataURL/fetch path entirely), that's worth noticing too, since it
    // means this allowlist entry is stale and should be removed.
    expect(filesWithFetch).toEqual(expect.arrayContaining([...ALLOWED_FETCH_FILES]));
  });
});
