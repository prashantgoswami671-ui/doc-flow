# OLLAMA T2-04 — Evidence → Fact Card Handoff Design

Status: DESIGN + OFFLINE POC ONLY. No production integration. No live Ollama runs in this task.

## 1. Findings from T2-03 (experimentally established only)

Full Fact Card generation with `qwen3:4b` (same PDF — `Economic_Growth_vs_Development_WB_Jharkhand.pdf`,
same six AI-02 chunks, `temperature=0`, `think=false`, first-attempt `num_predict=2048`) accepted **1/6**
cards. First-attempt failure categories:

- chunks 0, 1: numeric excerpts not verbatim (evidence fidelity).
- chunk-2: `causal` not boolean — 12 errors (structure).
- chunk-4: `definitions`/`numbers`/`claims` emitted as string arrays instead of object arrays (structure).
- chunk-5: too many excerpts (count limit).

A prompt-only experiment with more explicit structural instructions fixed the structural classes
(`causal`-type errors 12 → 0; object-array errors eliminated on first attempt for chunks 2 and 4;
required fields preserved) but acceptance stayed **1/6**: verbatim-evidence failures persisted, and
the longer prompt pushed chunk-0 to an 8479-character truncated (unparseable) response. Lesson:
prompt-stacking has diminishing returns and consumes the fixed 2048-token output budget.

An evidence-only extraction task (same PDF, chunks, model, temperature, `think:false`,
`num_predict=2048`; output restricted to `{excerpts: string[], numbers: [{value, excerpt}]}`,
single attempt, no repair, strict exact-substring checks with no normalization) produced:

- 6/6 parseable, 0 failures
- 23/23 exact excerpts (100%)
- 31/31 exact number values (100%)
- 30/31 exact number excerpts (~97%)
- 0 malformed evidence entries
- runtime ~140s vs ~610–810s for full Fact Card runs

Notable anomaly (chunk-2): the model found numeric evidence but placed 18 numeric spans into the
generic `excerpts` array and returned zero `numbers[]` entries — evidence located, but not correctly
typed. Expected-number recall for that chunk via `numbers[]` was therefore 0/4 despite 100% fidelity
on what was returned.

Conclusion: **Hypothesis B is strongly supported** — qwen3:4b copies evidence reliably when
extraction is separated from semantic reasoning; fidelity degrades when the model must
simultaneously find, copy, classify, compare, conclude, and judge causality.

## 2. Proposed two-stage architecture

```
PDF
 ↓
PDF.js extraction (unchanged)
 ↓
AI-02 chunks (unchanged, same chunking/ordering)
 ↓
Stage 1 — Evidence Extraction (qwen3:4b, temp 0, think:false, num_predict 2048, single attempt, no repair)
 ↓
deterministic evidence validation (exact-substring, IDs, pages, value-in-excerpt)
 ↓
Evidence Store (validated, immutable items only)
 ↓
Stage 2 — Fact Card Reasoning (references evidence IDs; never copies source text)
 ↓
deterministic Fact Card validation (ID existence, types, comparison sufficiency, causal boolean, no free-text excerpts)
 ↓
final grounded summary (from validated cards only, unchanged contract)
```

Responsibilities:

- **Stage 1 — Evidence Acquisition:** locate source spans, copy them byte-exact, identify exact
  numeric values with their containing spans, preserve source pages, emit a shape from which
  deterministic IDs are assigned. No interpretation, no claims, no causality, no conclusions,
  no summaries.
- **Evidence validation (deterministic, local):** gate between stages. Only items passing
  exact-substring checks enter the store. Fail-closed: invalid items are dropped (or the chunk is
  marked evidence-failed); never repaired by the model.
- **Evidence Store:** the only source of evidence text Stage 2 may use. Immutable after validation.
- **Stage 2 — Semantic Reasoning:** definitions, facts, comparisons, conclusions, causal
  classification. Operates over validated evidence objects/IDs. Produces no new source text.
- **Fact Card validation (deterministic, local):** checks references and types, never evidence
  wording (wording is already guaranteed by Stage 1 validation + immutability).

## 3. Evidence object design

```ts
interface EvidenceItem {
  evidenceId: string;      // deterministic, assigned locally (NOT model-generated)
  chunkIndex: number;      // deterministic (request context)
  sourcePages: number[];   // deterministic (request context, normally [pageNumber])
  exactText: string;       // model-copied, must pass exact-substring validation
  kind: "span" | "number"; // determined locally (see §5), NOT trusted from model
  value?: string;          // numeric surface form; required when kind === "number"
  unit?: string | null;    // optional structured unit; see risk note below
}
```

Field rationale:

| field | why | origin | req/opt | hallucination risk |
|---|---|---|---|---|
| `evidenceId` | stable reference for Stage 2 claims; enables ID-existence validation | deterministic (local counter per chunk) | required | none — model never invents it |
| `chunkIndex` | scope check: Stage 2 may only cite allowed chunks | deterministic (request context) | required | none |
| `sourcePages` | page provenance for citations and page-subset checks | deterministic (request context) | required | none |
| `exactText` | the grounded evidence itself; sole carrier of source wording | model-copied, validated exact-substring | required | medium at generation, reduced to ~0 after validation gate (T2-03 measured 100%/97%) |
| `kind` | routes numeric vs generic handling; fixes the chunk-2 typing gap | local decision (§5), never model-trusted | required | none if assigned locally |
| `value` | exact numeric surface form for grounded counts/comparisons | model-copied, validated (in chunk text AND in `exactText`) | required iff `kind==="number"` | low after dual-containment check |
| `unit` | optional display aid (`%`, currency, `lakh crore`) | model-suggested or locally derived; validated as substring of `exactText` when present | optional | low-medium → mitigate by making it optional and substring-validated; droppable without grounding loss |

`exactText` must originate from Stage 1 output and pass deterministic exact-substring validation
against its source chunk **before** Stage 2 sees it. Stage 2 receives only validated items and
cannot modify `exactText` (immutable by contract; validators reject any Stage 2–emitted excerpt).

`unit` is deliberately the weakest field: it adds no grounding (the unit characters already live
inside `exactText`/`value`) and is the most likely to be "helpfully" normalized by the model.
Recommendation: accept it only when it is an exact substring of `exactText`, else store `null`.
Dropping `unit` entirely is an acceptable simplification for the first Stage-2 experiment.

## 4. Evidence IDs

Strategy: `chunk-<chunkIndex>-e<per-chunk-counter>`, e.g. `chunk-0-e0`, `chunk-0-e1`, `chunk-1-e0`.
IDs are assigned **locally after validation**, in the order items appear in the Stage 1 output.
The model is never asked to produce IDs (one fewer invention surface).

- Depend on: chunk index + per-chunk sequence. Not on evidence type (typing is a local decision
  and may change without breaking references) and not on content hashes (unneeded complexity).
- Ordering stability: if extraction ordering changes between runs, IDs shift. This does **not**
  matter for the POC: IDs are session-local references resolved deterministically within one run
  (claim → ID → immutable text). Cross-run stability is a non-goal until persistence/caching of
  evidence stores is required; at that point content-hash suffixes can be considered.

## 5. Stage 1 output

Minimal JSON shape (small by design — the T2-03 long-prompt run proved prompt/output bloat risks
the 2048-token budget):

```json
{
  "excerpts": ["<exact source span>"],
  "numbers": [
    { "value": "<exact number as written>", "excerpt": "<exact source span containing value>" }
  ]
}
```

Stage 1 classifies nothing semantic: no claims, no kinds beyond the span/number split, no causal
flags, no conclusions.

**Chunk-2 finding (numeric span in the wrong field):** the model located the numbers but typed them
as generic excerpts. Two candidate designs:

- (a) *Generic pool first, deterministic numeric typing.* All exact spans enter one validated pool;
  a local deterministic pass promotes spans to `kind: "number"` when they contain a numeric surface
  form (digit/`%`/currency pattern) and splits out `value`. Pros: immune to model mis-typing;
  chunk-2's 18 spans would all be preserved and typed locally. Cons: deterministic value-splitting
  needs care (which substring is the `value`?); risk of over-promotion (years, figure labels like
  "Fig. 2" becoming "numbers").
- (b) *Trust the model's split, validate each side.* Simpler, but reproduces the chunk-2 failure:
  typed recall depends on model compliance.

Analysis: (a) is safer for grounding because the validated text pool is identical either way —
typing only affects downstream convenience, never evidence content. The over-promotion risk in (a)
is bounded: a wrongly-promoted span still carries exact text, and `value` must still satisfy
dual-containment (in chunk AND in `exactText`). Recommended POC: (a) — accept both arrays, merge
into one pool of validated spans, apply deterministic numeric detection, and measure promotion
precision separately from fidelity. Do not assume this is final; the next experiment should compare
(a) against raw model-typed output on expected-number recall.

## 6. Stage 2 input and claim shape

Stage 2 receives validated evidence objects — never raw chunk text requiring rediscovery:

```json
{
  "chunkIndex": 4,
  "sourcePages": [5],
  "evidence": [
    { "evidenceId": "chunk-4-e0", "exactText": "rural literacy is just 61.11% against 82.26% in urban areas", "kind": "number", "value": "61.11%" }
  ],
  "task": "derive grounded definitions, facts, comparisons, conclusions"
}
```

Minimal claim shape (no free-text evidence fields):

```json
{
  "kind": "comparison",
  "text": "Jharkhand's rural literacy is below its urban literacy",
  "evidenceIds": ["chunk-4-e3", "chunk-4-e4"],
  "pages": [5],
  "causal": false,
  "causalEvidenceId": null
}
```

- `text` is the model's restatement (the only free text Stage 2 may generate besides definitions).
- `evidenceIds` is the grounding mechanism: every claim cites ≥1 validated ID; comparisons cite ≥2
  distinct IDs (replacing the old `excerpt`/`excerpt2` verbatim burden that caused chunk-1/2 failures).
- `causal` stays a boolean evidence-classification flag; when `true`, `causalEvidenceId` cites the
  ID whose text contains the explicit connective (replacing `causalExcerpt` copying).
- Definitions reference one ID each (`evidenceId`), numbers are projected from referenced
  `kind: "number"` items (no re-typing of values).
- What Stage 2 does NOT receive in the minimal design: raw chunk text. Whether comparisons remain
  possible without it is an explicit open question (§12); the fallback is to include raw text as
  *context clearly marked non-citable* (validators still reject any non-ID evidence).

## 7. Deterministic validation rules

Stage 1 validation (per item, local, exact — no normalization):

1. `exactText` is a non-empty exact substring of its source chunk (`String.includes` semantics).
2. `chunkIndex` equals the requesting chunk; `sourcePages` non-empty, ascending, within
   `1..sourcePageCount`, includes the chunk page.
3. `evidenceId` matches `chunk-<i>-e<n>` and is unique within the run.
4. If `kind === "number"`: `value` non-empty, exact substring of chunk text AND of `exactText`;
   `unit`, when present, exact substring of `exactText` (else coerced to `null`).
5. Structural malformation (non-string span, missing fields) → item rejected, counted, never repaired.

Stage 2 validation (per card/claim, local):

1. Every cited `evidenceId` exists in the store; every cited item belongs to the card's chunk
   (1:1 POC mapping preserved).
2. Comparison claims cite ≥2 distinct IDs; all claims cite ≥1.
3. `kind` ∈ `fact|comparison|conclusion`; `text` non-empty string; `pages` non-empty subset of
   card `sourcePages`; `causal` strictly boolean; `causal:true` requires a `causalEvidenceId`
   whose text contains an explicit connective from the frozen list.
4. **No claim may carry its own source excerpt.** Any `excerpt`/`excerpt2`/`causalExcerpt` string
   field emitted by Stage 2 is rejected (fail-closed) — grounding flows only through IDs.
5. Malformed JSON / unknown fields → card rejected.

Stage 2 cannot modify evidence text: it never receives a writable path to the store, and
resolution is ID → immutable `exactText` at summary time (demonstrated offline in
`tests/ollama-t2-04/evidenceHandoff.test.ts`).

## 8. Grounding guarantee

The invariant changes from *model-regurgitated wording* to *reference-to-immutable-text*:

```
final claim → evidenceId → immutable validated exactText → source chunk (exact substring)
```

Numbers, punctuation, units, `%`, currency (`₹`, lakh/crore groupings like `₹ 1,14,271`),
and qualifiers (`(approx.)`, `2nd highest`) cannot drift between Stage 1 and the final card
because:

1. They are copied once (Stage 1), under a task where copying measured 100%/97% exact.
2. Validation freezes the bytes; anything failing exact-containment never enters the store.
3. Stage 2 output contains no wording fields to drift — only IDs plus its own restatement `text`
   (which is explicitly *not* evidence and is never cited as such).
4. Final summaries resolve citations deterministically (ID → text), so displayed evidence is
   always the validated bytes.

The residual risk (one 1/31 inexact span in T2-03) is contained at the gate: it either fails
validation and is dropped, or — if it passes as a generic span — it is still the model's exact
emitted bytes presented as-is, never silently "corrected" downstream.

## 9. Repair strategy (design only — not implemented)

Fail-closed everywhere; no model repair loops (T2-03 showed repair invents schemas, drops fields,
emits error objects, and truncates):

- Stage 1 output invalid/unparseable → chunk marked `evidence-failed`; excluded from Stage 2;
  recorded with raw output for forensics. No retry, no repair prompt.
- Stage 2 references nonexistent evidenceId → card rejected with reason.
- Stage 2 emits its own excerpt fields → card rejected with reason.
- Stage 2 emits malformed JSON → card rejected with reason.
- A chunk with zero validated evidence items yields no card (not an empty card).
- Policy question for later (not decided here): whether a card rejected at Stage 2 may be
  re-derived once from the same frozen evidence store. The store would be unchanged, so this is a
  single-variable retry — but it is out of scope for the next experiment.

## 10. Security / privacy

Unchanged T2 posture: local Ollama at `127.0.0.1:11434`, `qwen3:4b`, no cloud calls, no remote
endpoints, benchmark PDF stays git-ignored under `benchmark-docs/`. This design adds no network
path: both stages are loopback POSTs; validation and the store are in-process.

## 11. Performance considerations (existing evidence only, no new benchmarks)

- **Output tokens:** evidence-only outputs measured 443–1381 chars/chunk vs 1965–8479 for full
  cards. Stage 1 is strictly smaller. Stage 2 output (IDs + short restatements, no copied spans)
  should be smaller than a full card, but that is unmeasured — stated as expectation, not fact.
- **Generation time:** evidence-only run completed 6 chunks in ~140s vs ~610–810s for full-card
  runs. Two stages add a second request per chunk, but each request is shorter; net effect unknown
  until the Stage-2 experiment runs.
- **Context pressure:** Stage 2's input is the validated evidence subset, far smaller than a full
  chunk (chunk-2: 18 spans vs the whole page-3 text). If raw text is included as non-citable
  fallback context, pressure returns — keep it out unless the experiment demands it.
- **Truncation risk:** decreased for Stage 1 (short task + short prompt; chunk-0 went 8479 →
  991 chars). Stage 2 truncation risk is the main unknown and must be measured (balanced/parseable
  rate per chunk) in the next experiment.

## 12. Open questions for the next experiment

1. Can Stage 2 reliably reason over evidence IDs without seeing the original chunk (especially
   comparisons spanning two spans)?
2. How much evidence per chunk can Stage 2 consume before context pressure degrades reasoning
   (chunk-2's 18 spans is the natural stress case)?
3. Should numeric typing be deterministic post-pass (option (a)) or model-typed (option (b)) —
   measured on expected-number recall, separately from fidelity?
4. Should Stage 1 return all salient spans or only likely-useful spans (precision vs recall of the
   evidence pool)?
5. How are multi-chunk evidence sets represented when a claim needs cross-chunk support (out of
   1:1 POC scope, but the ID scheme already namespaces by chunk)?
6. Does `unit` earn its keep, or should it be dropped (it is substring-validated or `null`)?
7. What is Stage 2's balanced/parseable rate under the same 2048 budget with ID-only outputs?
8. If Stage 2 needs raw text as fallback context, can validators still fully prevent free-text
   evidence from leaking into cards?
