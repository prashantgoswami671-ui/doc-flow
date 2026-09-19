/**
 * V6-B01/B03 — Production evidence types (provider-agnostic).
 *
 * These types carry validated evidence only. They are independent of
 * Ollama, Browser AI, BYOK, and any future Cloud AI provider: no
 * provider imports, no network, no DOM. Construction of these values
 * is owned exclusively by the deterministic admission gate in
 * `./validation.ts` (V6-B03); storage is a future V6-B04 concern and
 * Stage-2 reasoning a V6-C concern.
 *
 * Deliberately absent: `unit` (dropped per the approved V6-B01 review —
 * weakest research field, adds no grounding), offsets (deferred), and
 * every SEC-06-prohibited field (`File`, PDF bytes, password, page
 * images, thumbnails, arbitrary metadata).
 */

/** Evidence classification. Assigned deterministically, never trusted from model output. */
export type EvidenceKind = "span" | "number";

/**
 * A single validated, immutable evidence item.
 *
 * - `evidenceId`: locally minted `chunk-<chunkIndex>-e<sequence>`
 *   (see `./ids.ts`), unique within the request. MODEL must never supply it.
 * - `chunkIndex`: owning `AiContextChunk` (request context, deterministic).
 * - `sourcePages`: v1 holds exactly the owning chunk's page; typed as an
 *   array so future cross-chunk grounding stays representable.
 * - `exactText`: byte-exact substring of the owning chunk (no normalization).
 * - `kind`: deterministic local decision (`"number"` iff a conservative
 *   numeric surface form was found — see `./validation.ts`).
 * - `value`: exact numeric surface form; present iff `kind === "number"`.
 */
export interface EvidenceItem {
  readonly evidenceId: string;
  readonly chunkIndex: number;
  readonly sourcePages: readonly number[];
  readonly exactText: string;
  readonly kind: EvidenceKind;
  readonly value?: string;
}
