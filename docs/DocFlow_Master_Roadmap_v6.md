# DocFlow — Master Product Roadmap v6

**Single source of truth for execution**  
**Revision:** v6 — created from the full read-only repository audit completed 2026-09-18  
**Intended repository:** `C:\Users\sunit\Desktop\doc-flow`  
**GitHub:** `https://github.com/prashantgoswami671-ui/doc-flow`  
**Branch:** `main`

---

## 0. Purpose of v6

Roadmap v6 replaces the stale Phase-5 planning assumptions in the previous roadmap and is based on the verified repository state as of the 2026-09-18 audit.

This document is the **execution source of truth** for the next stage of DocFlow.

### Source-of-truth hierarchy

```text
Actual repository state
        ↓
Roadmap v6
        ↓
DOCFLOW_STATUS.md
        ↓
Task-specific implementation / audit reports
        ↓
Agent suggestions and older documents
```

When an older document conflicts with the repository or this roadmap, the older document is considered stale until explicitly reconciled.

### Execution rule

No production implementation should begin from an old report, old roadmap, or agent memory. Before every new task:

1. Read this roadmap.
2. Read `docs/DOCFLOW_STATUS.md`.
3. Check the actual repository state.
4. Work only within the current task boundary.
5. Verify before committing.
6. Update status after the task is genuinely verified.

---

# 1. Verified Repository Baseline

The 2026-09-18 read-only audit established the following baseline.

## 1.1 Git state

- Branch: `main`
- HEAD: `6bcfc0e3e0d5e00c1dc59cc591a6f8a6010a3407`
- Local `main` and existing `origin/main` refs are in sync (`0/0` divergence at audit time).
- Tracked working tree: clean.
- Suspicious zero-byte root-level files remain untracked and untouched.
- `benchmark-docs/` remains ignored and must stay out of normal commits unless a future governance decision explicitly changes that.

## 1.2 Production AI state

### Tier 1 — Browser AI

Implemented and production-integrated:

- `services/ai/types.ts`
- `services/ai/validation.ts`
- `services/ai/extraction.ts`
- `services/ai/chunking.ts`
- `services/ai/pipeline.ts`
- `services/ai/instructions.ts`
- `services/ai/orchestration.ts`
- `services/ai/browser/*`
- `components/SummarizePdfCard.tsx`
- `tests/network-egress.test.ts`

Current production Browser AI characteristics:

- Browser-side inference.
- Qwen2.5-0.5B-Instruct, `q4`.
- WASM backend is currently pinned.
- Production AI context bound is approximately 8,192 extracted characters.
- Production output is bounded to 256 new tokens.
- Lifecycle, cancellation, disposal, and stale-worker protections are tested.
- Summarize PDF is the current production AI feature.
- Real Browser AI E2E coverage exists but was **not re-run during the 2026-09-18 audit**.

## 1.3 Tier 2 — Ollama

A production-grade runtime implementation exists, but it is **not yet reachable from the production UI**.

Existing production runtime:

- `services/ai/ollama/runtime.ts`
- `services/ai/ollama/client.ts`
- `services/ai/ollama/types.ts`

Current fixed configuration:

```text
Endpoint: http://127.0.0.1:11434
Model:    qwen3:4b
```

The runtime is:

- capability-compatible with the generic `AiRuntime` contract;
- locally loopback-bound;
- unit-tested;
- covered by the existing egress guard;
- not wired into a production UI;
- missing the production consent/disclosure flow required before user-facing Tier-2 use.

## 1.4 Tier 3 / BYOK

Not implemented.

The type union and policy text mention BYOK, but there is currently no production BYOK provider, key-management flow, provider allowlist, or UI.

## 1.5 Future Cloud AI

Not implemented.

The cloud runtime name exists at the type level only; no cloud provider integration exists.

---

# 2. Research Baseline: T2-02 → T2-09

These experiments are **research evidence only**. They are not production implementations and must remain clearly separated from production code.

## T2-02 — Real-document Ollama benchmark

Purpose: establish runtime behavior, context limits, throughput, and benchmark characteristics of local `qwen3:4b`.

Observed in the audited evidence:

- Real six-page document runs completed.
- Dense long-document controls demonstrated the 32,768-character Ollama context boundary.
- Sparse long-document controls could remain under the same boundary.
- Approximate throughput observed around 10 tokens/second on the audited machine.
- Output frequently reached configured generation ceilings.

Interpretation rule: these are machine/document/run observations, not universal performance guarantees.

## T2-03 — Fact Card / evidence fidelity

Key finding:

- Asking the model to simultaneously locate evidence, preserve wording, classify data, compare, conclude, and reason over causality produced poor first-attempt acceptance.
- Evidence-only extraction was substantially more faithful.

This is a primary architectural input for v6.

## T2-04 — Evidence handoff design

Established the research design for:

```text
PDF
→ extracted chunks
→ evidence extraction
→ deterministic validation
→ immutable Evidence Store
→ evidence-ID reasoning
→ deterministic output validation
```

This remains a **design/research artifact**, not production code.

## T2-05 — Evidence-ID reasoning

Research showed that deterministic local IDs can provide a strong grounding mechanism without asking the model to invent IDs.

## T2-06 — Numeric promotion

Research evidence showed deterministic numeric promotion greatly reduced observed numeric failures in the recorded experiment.

This supports keeping exact numeric interpretation under deterministic/local control rather than depending entirely on model typing.

## T2-07 — Comparison reasoning

Negative finding:

- The tested comparison-reasoning appendix caused truncation pressure.
- The pre-registered comparisons remained missing in the recorded run.

Comparison reasoning is therefore an **unresolved architecture problem**.

## T2-08 — Provenance enrichment

Negative finding:

- Compact post-hoc provenance enrichment did not recover the recorded comparison targets.

Post-hoc provenance cannot currently be treated as a solved route to reliable comparison reasoning.

## T2-09 — Attribution-aware extraction

Negative finding:

- Attribution-aware extraction had substantially lower validated evidence yield in the recorded run.
- The recorded Variant B result included an invented-ID invariant violation.
- Comparisons remained missing.

Attribution remains unresolved and must not be represented as solved in production.

---

# 3. What v6 Is Trying to Build

The architectural target is:

```text
PDF
 ↓
AI-02 browser extraction + bounded chunking
 ↓
Evidence acquisition
 ↓
Deterministic evidence validation
 ↓
Immutable Evidence Store
 ↓
Bounded/reviewable LLM reasoning
 ↓
Deterministic output validation
 ↓
User-facing result
```

The core rule is:

> **The model may reason over trusted evidence, but the model does not become the source of truth for exact document data.**

Exact evidence text, numeric values, IDs, allowed metadata, and claim references should have deterministic validation around them.

---

# 4. v6 Execution Gates

The project now moves through these gates in order.

```text
Gate 0 — Baseline reconciliation
        ↓
Gate 1 — Production evidence architecture
        ↓
Gate 2 — Production Stage-2 reasoning + validation
        ↓
Gate 3 — Tier-2 provider selection / consent / wiring
        ↓
Gate 4 — Tier-2 user-facing capability
        ↓
Gate 5 — Tier-2 E2E / performance / regression verification
        ↓
Gate 6 — Tier-2 closure decision
```

A later gate must not be treated as complete merely because an earlier prototype or research fixture exists.

---

# 5. Phase V6-A — Baseline & Documentation Reconciliation

## V6-A01 — Reconcile status tracker with audited repository

Update `docs/DOCFLOW_STATUS.md` so its current state matches the verified repository.

Must capture at minimum:

- Tier-1 Browser AI is implemented and production-integrated.
- Tier-2 Ollama runtime exists but is not production-wired.
- T2-02 through T2-09 are research-only.
- Evidence Store is not yet production code.
- Deterministic output validation is not yet production code.
- Tier-2 consent/UI wiring is not yet implemented.
- CI remains absent.
- E2E current pass state remains unverified unless freshly run.

## V6-A02 — Reconcile SEC-06 current-reality text

Update stale "no provider implemented" wording so it reflects the audited production state without weakening the existing privacy policy.

## V6-A03 — Reconcile roadmap/status references

Remove or explicitly mark stale Checkpoint-1 descriptions that say Browser AI or Ollama do not exist.

## V6-A04 — Resolve undefined task IDs

Do not invent AI-19, AI-20, T2-10, or T2-11 definitions.

Record them as undefined/not verifiable unless new repository evidence establishes their intended meaning.

### Gate condition

V6-A closes only when the documentation accurately describes the audited repository state.

---

# 6. Phase V6-B — Production Evidence Architecture

This is the primary engineering phase.

## V6-B01 — Freeze Evidence Store contract

Define a production, provider-agnostic contract for validated evidence.

Initial design should preserve the useful concepts proven in research without importing the research harness wholesale.

Candidate baseline:

```ts
interface EvidenceItem {
  evidenceId: string;
  chunkIndex: number;
  sourcePages: number[];
  exactText: string;
  kind: "span" | "number";
  value?: string;
  unit?: string | null;
}
```

The final contract must be explicitly reviewed before implementation.

## V6-B02 — Deterministic evidence IDs

IDs are assigned locally after validation.

The model must not generate evidence IDs.

## V6-B03 — Deterministic evidence validation

At minimum validate:

- exact source containment;
- valid chunk/page ownership;
- deterministic ID format and uniqueness;
- numeric value containment where applicable;
- allowed optional metadata;
- malformed input rejection;
- fail-closed behavior.

## V6-B04 — Immutable Evidence Store

Implement a production store whose contents cannot be silently rewritten by the reasoning stage.

## V6-B05 — Evidence-resolution helpers

Provide deterministic resolution:

```text
claim → evidenceId → immutable EvidenceItem → source chunk
```

### Gate condition

No Tier-2 production reasoning integration until the Evidence Store contract and validation behavior have tests covering both valid and invalid cases.

---

# 7. Phase V6-C — Production Stage-2 Reasoning & Output Validation

## V6-C01 — Define bounded Stage-2 input contract

Stage 2 should reason over validated evidence rather than rediscovering exact source text.

The production contract must state:

- permitted evidence fields;
- permitted claim fields;
- permitted evidence references;
- whether raw chunk text is available;
- what counts as citable evidence;
- what the model is forbidden to emit as source evidence.

## V6-C02 — Deterministic Stage-2 validator

Validate at minimum:

- evidence IDs exist;
- referenced evidence belongs to the permitted scope;
- claim type is allowed;
- claim text is non-empty;
- comparison claims have sufficient references;
- unsupported source-excerpt fields are rejected;
- causal flags follow explicit rules if retained;
- malformed JSON/schema is rejected.

## V6-C03 — Grounded result projection

Final displayed evidence must be resolved locally from the Evidence Store rather than copied from the model's answer.

## V6-C04 — Explicit unresolved-capability policy

Comparison and attribution are currently unresolved by research evidence.

Before shipping them as guaranteed behaviors, define one of:

- a validated production strategy;
- a bounded fallback behavior;
- or an explicit unsupported/limited behavior.

Do not hide the unresolved state.

### Gate condition

Production Stage 2 is not considered complete until deterministic post-generation validation exists and failure behavior is covered by tests.

---

# 8. Phase V6-D — Tier-2 Provider Selection, Consent & Wiring

## V6-D01 — Provider/runtime selection layer

Move production UI/runtime choice away from a hardcoded Browser AI runtime.

Selection must use the capability contract rather than hardcoding tier names into business logic.

## V6-D02 — Tier-2 availability handling

Use `OllamaRuntime.checkAvailability()` before offering/starting a Tier-2 generation path.

The UI must clearly distinguish:

- Ollama unavailable;
- Ollama available;
- model missing/unavailable;
- generation failure.

## V6-D03 — Consent and disclosure flow

Before a user sends document-derived text to Ollama, implement the SEC-06-consistent user disclosure/consent behavior.

The flow must make clear that:

- the provider is the user's local Ollama service;
- extracted document text is sent to that service;
- the original PDF is not sent to Ollama;
- availability depends on the local Ollama service/model.

Do not use unsupported absolute privacy claims.

## V6-D04 — Ollama production integration

Only after V6-D01 through V6-D03 are complete should `OllamaRuntime` become reachable through production UI.

### Gate condition

Tier 2 must remain inaccessible from production UI until the consent/disclosure path and egress expectations are tested.

---

# 9. Phase V6-E — Tier-2 User-Facing Capability

The exact UI shape should be chosen after the architecture gates above, not before.

Possible production surface:

- provider-aware Summarize;
- generic prompt surface;
- or another single bounded capability surface.

The choice must preserve the architectural boundary rather than creating a second unrelated AI pipeline.

## V6-E01 — One production Tier-2 capability

Implement one user-facing capability through the validated hybrid pipeline.

Do not multiply feature count before the first production Tier-2 path is understood.

## V6-E02 — User-visible grounding behavior

Where evidence is shown, ensure it is derived from validated evidence objects rather than raw model-generated excerpts.

## V6-E03 — Error/fallback UX

Cover:

- no extractable text;
- context truncation;
- invalid evidence;
- malformed model output;
- unavailable Ollama;
- unsupported reasoning request.

---

# 10. Phase V6-F — Tier-2 Verification

## V6-F01 — Unit verification

Run and record:

- AI core tests;
- Evidence Store tests;
- validation tests;
- Ollama runtime tests;
- UI tests.

## V6-F02 — Real Tier-2 integration verification

Run a real local-Ollama integration path, not only mocked `fetch` tests.

Record:

- model;
- endpoint;
- document fixture;
- context size;
- output size;
- latency;
- parseability;
- evidence validation outcomes;
- output validation outcomes;
- failures.

## V6-F03 — Real browser E2E

Run the production Tier-2 flow in a real browser with:

- real upload;
- real production UI;
- real Ollama connection;
- no model/network mocks for the provider path.

## V6-F04 — Regression verification

Re-run the network-egress guard and all affected existing AI/PDF tests.

## V6-F05 — Performance baseline

Establish a reproducible benchmark envelope for the first supported Tier-2 capability.

Do not generalize one machine's measurements into universal performance guarantees.

### Gate condition

Tier-2 is not considered closed until the production path has current unit, integration, E2E, security/egress, and performance evidence.

---

# 11. Phase V6-G — Tier-2 Closure & Next-Tier Decision

After V6-F, perform a dedicated closure review.

The review must state:

- what Tier-2 capability is actually shipped;
- what evidence supports its behavior;
- what limitations remain;
- which research findings remain unresolved;
- whether Tier-2 is ready to be considered stable;
- what work, if any, is needed before Tier 3.

### Tier-3 entry rule

Do **not** begin Tier 3 merely because the Tier-2 runtime exists.

Tier 3 should begin only after the first supported Tier-2 production path has been implemented and verified enough to justify the next provider category.

---

# 12. Explicit Non-Goals for v6

The following are not to be recreated or silently promoted into scope:

- T2-10 / T2-11 without new repository evidence.
- BYOK implementation before the Tier-3 phase.
- Cloud AI implementation.
- Autonomous PDF-modifying agent behavior.
- Semantic search/embeddings.
- Large multi-document agent architecture.
- Automatic redaction execution.
- Browser-AI Map→Reduce prototype promotion without new evidence.
- Reusing `services/ai-prototype/` as production code simply because it contains useful primitives.
- Committing ignored `benchmark-docs/results/` as normal source changes.

---

# 13. Repository Safety Rules

These rules remain active during all v6 work.

### Never touch the suspicious root files

```text
attributes
doc-flow@0.1.0
embeds
git
instructs
never
npm
npx
only
orders
produces
prohibits
still
surfaces
throws
uses
wraps
```

### Keep research isolated

The following are research/prototype material and should not be promoted accidentally:

- `services/ai-prototype/`
- `tests/ollama-benchmark/`
- `tests/ollama-t2-03/` … `tests/ollama-t2-09/`
- `benchmark-docs/`

### Commit discipline

- One logical task per commit where practical.
- No broad `git add .` for unrelated work.
- Review changed-file scope before every commit.
- Do not mix documentation reconciliation with unrelated production implementation unless a task explicitly requires both.
- Do not modify unrelated root artifacts.

---

# 14. Verification Standard

A task is not `Done` merely because source code exists.

Use these distinctions:

```text
IMPLEMENTED
→ code exists

IMPLEMENTED + VERIFIED
→ code + relevant tests/verification passed

IMPLEMENTED + PRODUCTION-INTEGRATED
→ real production path reaches it

PRODUCTION-INTEGRATED + VERIFIED
→ production path + current verification evidence

RESEARCH-ONLY
→ experiment/design/benchmark, not production

PARTIAL
→ meaningful implementation exists but an explicit gap remains

NOT IMPLEMENTED
→ no implementation exists

NOT VERIFIABLE
→ repository evidence is insufficient
```

No claim should be stronger than its evidence.

---

# 15. Current v6 Starting Point

At the moment this roadmap is created:

```text
Repository baseline                         ✅ audited
Working tree                                ✅ clean
Tier-1 Browser AI runtime                   ✅
Tier-1 production Summarize                ✅
Tier-1 egress guard                         ✅
Tier-2 Ollama runtime                      ✅
Tier-2 Ollama production UI                ❌
T2-02 → T2-09 research                      ✅ evidence collected
Production Evidence Store                   ❌
Production Stage-2 validation               ❌
Tier-2 consent/disclosure                   ❌
Tier-2 real browser E2E current evidence    ❌ not freshly verified
CI pipeline                                 ❌
Tier-3/BYOK                                  ❌
Cloud AI                                    ❌
```

## Immediate next task

**V6-A01 — Reconcile `docs/DOCFLOW_STATUS.md` with this audited repository state.**

No production AI architecture work should begin until this documentation baseline is synchronized.

After V6-A01, proceed to the Evidence Store design/implementation gates in Phase V6-B.

---

# 16. Roadmap Change Control

This document becomes the execution source of truth until a new roadmap revision is deliberately created.

A roadmap revision should happen only when there is a genuine change in:

- repository architecture;
- phase ordering;
- task scope;
- provider strategy;
- production constraints;
- or verified evidence that invalidates a current assumption.

When revising:

1. Record the reason.
2. Preserve the old roadmap as historical context.
3. Re-audit the relevant repository state.
4. Publish the new roadmap.
5. Update `DOCFLOW_STATUS.md` to point to the new source of truth.

---

# 17. v6 Revision History

| Revision | Date | Change |
|---|---|---|
| v6.0 | 2026-09-18 | Created from the full read-only repository audit. Corrected the repository baseline, recognized the existing Tier-2 Ollama runtime and T2 research sequence, separated production architecture gaps from research findings, and established the new Evidence Store → validated reasoning → consent/wiring → Tier-2 verification execution order. |

---

## Final operating principle

> **Research tells us what failed and what appears useful. The production architecture must turn those lessons into deterministic boundaries, bounded AI reasoning, explicit consent, and verifiable behavior.**
