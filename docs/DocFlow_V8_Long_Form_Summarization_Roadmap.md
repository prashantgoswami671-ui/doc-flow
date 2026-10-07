# DocFlow V8 — Long-Form Grounded Summarization

## 1. Purpose

DocFlow V8 solves one specific unresolved product problem left open after V6 and V7:

> When a user uploads a long text-bearing PDF, DocFlow should be able to produce concise, detailed, and very detailed summaries that are substantially comprehensive, accurate, grounded, and usable across approximately 20–50 page documents.

V6 established a production-integrated Tier-2 local Ollama summarization path. V7 hardened long-document evidence acquisition and coverage (from about 12 grounded pages to 15 grounded pages on the 22-page local benchmark). But improved evidence coverage has NOT yet been shown to produce a long, comprehensive, detailed summary of a 20–50 page document.

The current summary can still be too short and insufficiently comprehensive for long PDFs: a user uploading a long document expects a useful summary that is sufficiently detailed and comprehensive, rather than a small collection of short summary points.

V8 must therefore solve, in order:

1. Long-document coverage: important parts of a 20–50 page document should be represented.
2. Summary completeness: the final output should contain enough substantive information to be genuinely useful as a summary of a long document, rather than merely a small list of headline claims.
3. Three useful detail modes: Concise, Detailed, and Very Detailed (defined behaviorally below, not by word count).
4. Grounding: every factual claim must remain traceable through the existing deterministic grounding architecture.
5. Long-document scalability across approximately 20 pages, 30–40 pages, and 50 pages.
6. Mode reuse: switching from Concise → Detailed → Very Detailed should not unnecessarily repeat expensive PDF extraction/evidence work.

Do NOT define success purely by word count. Document complexity varies, so exact lengths must remain adaptive rather than rigid.

## 2. Relationship to V6/V7

- V6 established the production Tier-2 architecture: PDF extraction/chunking → Stage-1 exact-span evidence acquisition → deterministic Evidence Store (B03/B04) → Stage-2 structured claims → C02 deterministic validation → C03 grounding → grounded summary UI.
- V7 hardened long-document evidence acquisition and coverage: V7-A10 RED3 Stage-1 evidence redundancy, V7-A02 balanced evidence selection (24-item cap), and V7-A04.2 source-page/chunk/sourcePageCount context.
- V8 addresses the remaining problem: turning available grounded evidence into comprehensive long-form summaries.

In short: V6 built the grounded pipeline. V7 improved what evidence reaches Stage-2. V8 must solve comprehensive summary generation from that evidence.

V8 must reuse and preserve:

- B03 exact-substring evidence admission
- B04 immutable Evidence Store
- V7-A02 balanced selection
- V7-A04.2 locator context
- C02 validation
- C03 grounding
- structured Ollama transport
- existing egress/security controls

Do not redesign those components without evidence.

## 3. Non-goals

Explicitly deferred — out of scope for V8 closure:

- Q&A
- translation
- comparison reasoning
- attribution reasoning
- multi-document reasoning
- BYOK/cloud
- AI Agent
- OCR expansion
- unrelated UI/SaaS work

These may eventually use V8 infrastructure but are not the V8 objective. V8 stays focused on the long-form grounded summarization problem defined in section 1.

## 4. Success / Exit Criteria

V8 may only be marked CLOSED when the project demonstrates, on representative long-document fixtures, all of the following:

### Coverage

Concise, Detailed, and Very Detailed provide materially different and useful coverage of the document. The three modes must differ in information density and section coverage, not merely in wording or word count.

### Comprehensive summary

Very Detailed represents essentially all major evidence-bearing sections/topics, with explicit disclosure for textless/uncoverable portions. The output must be usable as a comprehensive summary of a long document, not a small list of headline claims.

### Grounding

Factual claims remain traceable through:

`final claim → evidenceId → immutable exactText → source chunk/page`

No weakening of B03/B04/C02/C03 is permitted to achieve longer output. Any architecture that produces longer but less-grounded summaries is NOT a successful solution.

### Long-document ranges

Validation exists for approximately:

- 20 pages
- 30–40 pages
- 50 pages

### Mode reuse

Switching detail levels does not repeat expensive extraction/Stage-1 work unnecessarily. Expensive intermediate work (extraction, chunking, evidence, section results where applicable) is reusable/cached across Concise → Detailed → Very Detailed.

### Reliability

No unacceptable increase in:

- malformed outputs
- unknown IDs
- C02 rejects
- grounding failures
- unexplained missing sections

### Performance disclosure

Actual wall-clock behavior is measured and documented. No SLA claim unless separately justified. Local `qwen3:4b` runs already take several minutes; V8 must report measured latency honestly and label estimates versus measured facts.

### Limitations

Image-only/non-extractable pages are explicitly disclosed rather than silently treated as summarized. Pages with very little text, dense pages, tables, and documents without clear headings must be handled by explicit disclosure or graceful degradation — never by invention.

## 5. V8 Execution Stages

### V8-00 — Roadmap establishment

This task. Create this roadmap as the source of truth for V8 until the problem is demonstrably solved.

Status: COMPLETE only after roadmap is reviewed and published.

### V8-A01 — Output-compression diagnosis

Research/instrumentation only.

Measure:

- extracted chunks/pages
- Stage-1 candidates
- admitted evidence
- selected evidence
- Stage-2 input size
- cited evidence
- uncited selected evidence
- generated claims
- C02 accepted/rejected claims
- Stage-2 output size and output-cap utilization
- final grounded pages
- final summary characters/tokens
- section/page coverage
- latency breakdown

Primary question: where does information become compressed?

Candidate bottlenecks to discriminate (do not assume in advance): insufficient evidence reaching Stage-2; Stage-2 citing too little evidence; claim-count/output limits; inability of one Stage-2 call to synthesize a long document; lack of document structure; model/context-window limitations; latency/cost of local Ollama; or a combination.

No production architecture changes.

### V8-A02 — Larger-flat experiment

Research only.

Test whether one larger Stage-2 call can materially improve long-summary completeness.

Potential dimensions:

- larger evidence cap
- larger Stage-2 output allowance
- comprehensive vs concise instruction

Prefer a controlled experiment rather than changing many variables blindly. Compare against the V7 published baseline using the same underlying evidence where possible.

Do not assume larger-flat is sufficient.

### V8-A03 — Conditional prompt/claim-utilization experiment

Only if V8-A01 shows substantial selected-but-uncited evidence.

Test whether Stage-2 under-utilization is primarily a prompt/claim-budget problem (e.g., Stage-2 citing too little of what it receives, or claim-count/output limits binding before the evidence pool is exhausted).

No production change until evidence supports it.

### V8-A04 — Hierarchical/section prototype

Only if V8-A02 demonstrates that flat generation is insufficient.

Research-only prototype:

- document structure
- → section groups
- → section grounded summaries
- → final synthesis

Section boundaries should reflect document structure rather than simply dividing every N pages. Detail-level controls should govern information density/coverage rather than merely asking the model to "write more."

Do NOT publish immediately. Prototype grounding must preserve claim → evidenceId → immutable exact source text at every layer (see section 7).

### V8-A05 — Controlled architecture comparison

Compare best flat and best hierarchical/hybrid approaches using the same underlying Evidence Store where possible.

Measure:

- grounded-page coverage
- claims
- claims/page
- summary length
- section coverage
- evidence utilization
- C02/C03 failures
- latency
- reproducibility
- human usefulness

Candidate architectures: current flat Stage-2; larger flat Stage-2; section-level/hierarchical summarization; hybrid adaptive architecture.

### V8-A06 — Architecture decision

Select:

- current flat
- larger-flat
- hierarchical
- hybrid

Decision must be evidence-based and recorded, with explicit justification from V8-A01 through V8-A05 results — not from the assumption that hierarchical "sounds scalable."

If the hypothesis changes, amend later roadmap stages rather than silently replacing them (see section 6).

### V8-A07 — Production implementation

Implement only the architecture justified by V8-A06. Preserve all non-negotiable grounding rules (section 7).

### V8-A08 — Detail-mode implementation

Implement:

- Concise
- Detailed
- Very Detailed

Per the V8 mode definitions:

- Concise: main ideas, important facts/data, major conclusions, relatively low information density.
- Detailed: major ideas, supporting facts, important numbers/data, important examples/explanations, broader section coverage.
- Very Detailed: section-by-section coverage, important facts/data, important examples, important conclusions, substantially greater information density, explicit disclosure of sections/pages that cannot be grounded or extracted.

Modes must represent different information density/coverage, not merely word counts.

### V8-A09 — Caching/reuse

Ensure expensive work such as:

- extraction
- chunking
- Stage-1 evidence
- Evidence Store
- section-level results if applicable

can be reused across detail modes where safe, so that switching from Concise → Detailed → Very Detailed does not repeat extraction/evidence work unnecessarily. Define what is cached safely versus what is regenerated per mode.

### V8-A10 — 20/30–40/50 page validation

Validate the production architecture against representative long-document fixtures in the target ranges (approximately 20 pages, 30–40 pages, 50 pages), with adaptive segmentation rather than fixed section counts.

### V8-A11 — Final reliability/performance/UX validation

Validate:

- grounding
- failure handling
- mode switching
- long-document progress
- latency
- image-only-page disclosure
- E2E behavior

### V8-A12 — V8 closure review

Declare V8:

- CLOSED only if the exit criteria in section 4 are demonstrated.

Otherwise:

- extend/amend the roadmap with evidence,
- do not falsely close V8.

## 6. Roadmap Amendment Rules

The roadmap is a living source of truth.

It may be changed when new evidence shows that:

- a planned experiment is unnecessary;
- a hypothesis is false;
- a simpler architecture solves the problem;
- a new failure mode requires a new task;
- a proposed architecture introduces unacceptable grounding/performance risk.

Every amendment MUST record:

- date
- reason
- evidence
- affected task(s)
- old plan
- new plan

Never silently rewrite completed research history.

## 7. Non-Negotiable Grounding Rules

V8 must not:

- weaken exact-substring evidence admission;
- allow model-created evidence;
- bypass EvidenceStore;
- bypass C02;
- bypass C03;
- introduce raw model-authored source evidence;
- use repair loops to manufacture evidence;
- trade grounding for output length.

Any architecture that produces longer but less-grounded summaries is NOT considered a successful solution. Hierarchical designs in particular must keep every factual claim traceable through `claim → evidenceId → immutable exactText` at every layer, including section summaries and final synthesis.

## 8. Long-Document Strategy

Do not hard-code a fixed section count.

If hierarchy is ultimately chosen, sectioning should be adaptive using:

- document headings where available;
- page/chunk structure;
- size limits;
- safe paragraph boundaries;
- fallback positional segmentation where headings are unavailable.

Approximate historical examples (NOT fixed requirements): 20 pages → 4–6 logical sections; 30–40 pages → 6–10 sections; 50 pages → 8–12 sections. Actual segmentation must follow document structure.

Image-only pages and low-text pages must be explicitly represented as coverage gaps rather than silently invented. The same applies to very dense pages, tables/numerical-heavy documents, documents without clear headings, and very long sections — each needs an explicit strategy (disclosure, graceful degradation, or bounded splitting), never silent invention.

## 9. Performance / Caching Principles

Recognize that local qwen3:4b Stage-1 processing is already expensive (current runs take several minutes).

Therefore V8 should favor:

- reuse/caching of extraction, chunking, evidence, and section-level results where safe;
- controlled Stage-2 calls;
- adaptive sections;
- measured parallelism where safe (e.g., parallel section processing);
- progressive UI feedback;
- no unnecessary regeneration when changing detail mode;
- controlling section-summary detail and limiting unnecessary regeneration.

Do not claim performance improvements before measuring them. Major added-latency sources in any hierarchical design (additional Stage-2 calls, synthesis calls, segmentation) must be estimated honestly and then measured.

## 10. Current Hypothesis — explicitly NOT a decision

The likely long-term architecture may be:

Evidence → adaptive sections → grounded section summaries → final synthesis → detail-level projection

But this is only a hypothesis.

V8-A01 and V8-A02 must happen before this becomes a production decision. Do NOT assume hierarchical summarization is automatically correct. The simpler larger-flat alternative (Alternative A) must be tested against hierarchical (Alternative B) and hybrid (Alternative C) alternatives with evidence from V8-A01 through V8-A05 before any production commitment.

## 11. Current Status Table

| Task | Status |
| ---- | ------ |
| V8-00 | ✅ Roadmap establishment (`4012903`) |
| V8-A01 | ✅ Output-compression diagnosis |
| V8-A02 | ✅ Larger-flat capacity experiment |
| V8-A03 | ✅ Prompt / evidence-utilization experiment |
| V8-A04 | ✅ Hierarchical prototype |
| V8-A05 | ✅ Controlled flat-vs-hierarchical comparison (hierarchical: 17–19 grounded pages vs flat 13–14 on the 22-page fixture; 0 C02/C03 failures) |
| V8-A06 | ✅ Architecture decision (hierarchical, evidence-based) |
| V8-A07 | ✅ Production hierarchical implementation (`f1eb683`) |
| V8-A08 | ✅ Concise / Detailed / Very Detailed modes (`921118c`) |
| V8-A09 | ✅ Caching/reuse (`93ffa92`) |
| V8-A10 | ✅ 20 / 30 / 49-page validation (incl. 49-page fixture `DTIC_AD1042291.pdf`, qualified outside the repo) |
| V8-A11 | ✅ Final reliability/performance/UX validation + failed-section disclosure fix (`60c370e`) |
| V8-A12 | ✅ Closure review (this section) |

Do not mark later tasks complete merely because the roadmap exists.

## 12. Current V8 Baseline

Record:

- V7 published architecture is the starting baseline: PDF extraction/chunking → Stage-1 RED3 exact-span acquisition → B03/B04 Evidence Store → V7-A02 balanced 24-item selection → V7-A04.2 page/chunk/sourcePageCount context → Stage-2 → C02 → C03 → grounded UI.
- Latest published commit: `5c402f7`.
- 22-page local-only benchmark:
  - 20 text-bearing pages
  - 2 image-only pages
  - 27,122 extracted chars
  - 20 chunks
  - 15 final grounded pages in committed V7 validation
- This is descriptive benchmark evidence, not a universal claim. It reflects a single-document/single-model/single-machine measurement with no universal-coverage, model-quality, or SLA implication.

## 13. V8 Closure Rule

> V8 remains OPEN until the original user problem — obtaining useful Concise, Detailed, and Very Detailed grounded summaries for approximately 20–50 page text-bearing PDFs — is demonstrated as solved by the validation gates above. If the current architecture is insufficient, V8 remains open and is amended rather than prematurely closed.

## 14. V8 Closure (A12) — V8 COMPLETE WITH POST-V8 HARDENING ITEMS

Closed on the published chain `4012903` (roadmap) → `f1eb683` (A07) → `921118c` (A08) → `93ffa92` (A09) → `60c370e` (A11 fix). No production diff remains open against this roadmap.

This V8 closure is scoped to long-form grounded summarization. It does not govern the later dedicated AI-05 Translate, AI-06 Key Points, or AI-07 Ask PDF capabilities, which were published after the V8 work under the current dedicated-tool architecture. The old v5 generic AI-03 prompt-box design is not required by the current production scope.

### Final architecture

PDF → AI-02 extraction/chunking → RED3 Stage-1 → Evidence Store → V7-A02 selection (64-item default) → deterministic hierarchical section partition → per-section grounded Stage-2 → C02 → C03 → grounded section assembly → A08 Concise / Detailed / Very Detailed deterministic projection → A09 local in-memory reuse → user-facing summary. No second synthesis LLM call; root evidence IDs stay authoritative; section failures stay explicit; modes are synchronous projections; the cache persists no raw PDF bytes.

### Validation bands (fixture measurements, qwen3:4b local Ollama — not universal claims)

- ~20 pages (`Delimitation-Booklet-8.pdf`, 22pp/20 text): 18–19 grounded pages across runs; 9 sections; modes 18–41 claims by run; warm reuse byte-identical in 96ms–45s depending on environment load; one transient failed section observed and correctly gap-recorded.
- 30–40 pages (`5_Fourth_Sem_Economics_June_2021.pdf`, exam paper — conditional fixture): 25/30 grounded pages; 8 sections; 0 C02/C03 failures; pages 17/30 lost to acquisition/admission (budget diagnostics to 256 did not recover them).
- ~50 pages (`DTIC_AD1042291.pdf`, GAO-17-351, 49/49 text, 94,774 chars — kept outside the repo): 36/49 grounded pages; 18 sections; 0 failures in every category; 64-item selection reached the full admitted page range including late pages 40–49; modes 31/60/68 claims; cold ~1470s; warm hit 45s in that run; switches 1–6ms with zero acquisition.

### Exit criteria

Detail modes PASS; Coverage PASS WITH LIMITATION (Very Detailed retains all grounded claims; unevidenced pages remain uncovered); Gaps PASS (source gaps vs intentional omissions distinguishable, incl. the A11 failed-section disclosure); Grounding PASS (claim → evidenceId → immutable exactText → page/chunk intact); 20-page PASS; 30–40 CONDITIONAL (one exam fixture); ~50 PASS FOR TESTED FIXTURE; Cache PASS; Reliability PASS (no unacceptable failures); Performance PASS (measured, no SLA); UX PASS.

### Limitations

Fixture-based evidence only (one fixture per band; 30-page fixture is an exam paper); no universal model-quality, coverage, budget-sufficiency, or SLA claims; no guarantee for arbitrary PDFs. Selected-but-uncited evidence grows with length (0–1 → 3 → 12 pages) — utilization observation for later work, not a V8 blocker. Live-model run-to-run variance confirmed (temperature-0 is not run-deterministic).

### Post-V8 hardening (separate scope, not started)

1. SHA-256 + byte-length document identity; 2. extraction-code/generation-settings cache fingerprint versions; 3. deeper cache immutability; 4. remaining warm-abort branch tests; 5. `partitionExact` orchestrator-throw test; 6. A08 projection-error test; 7. selected-but-uncited utilization trend; 8. performance work only on evidence. This roadmap specifies no V9 plan; post-hardening items stay separate and next-phase work proceeds independently.
