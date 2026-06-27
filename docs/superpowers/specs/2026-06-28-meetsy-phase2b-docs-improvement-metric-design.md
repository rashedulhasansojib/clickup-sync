# Meetsy Phase 2b — Document Upload + Honest KB-Improvement Metric (Design Spec)

**Date:** 2026-06-28
**Status:** Draft — **awaiting product-owner approval before build**
**Phase:** Meetsy 2b (after 2a KB slice ✅, 2a.1 summary card ✅, onboarding-robustness fixes ✅; before 2c pipeline integration)
**Plan:** `docs/superpowers/plans/2026-06-27-meetsy-integration-plan.md` (Phase 2 table, row 2b)
**Depends on:** 2a (KbChunk + embed + hybrid search + `meetsy-kb` worker); reuses `AzureEmbeddingService`, `KbSearchService`, `vtt.ts` transcript normalization.

---

## Summary

Let a user **upload project/client context documents** (SOPs, scopes, spec PDFs) into a
workspace's KB so future meeting→task analysis is grounded in more than ClickUp history.
Parse → chunk → embed each doc into the existing `KbChunk` table (`sourceType=document`).
Then answer the honest question the user keeps asking: **"did adding this actually make the KB
better?"** — with two **separately-reported, never-blended** signals:

1. **Corpus novelty** (the solid headline) — how much genuinely new information each doc adds
   vs what the KB already knows (per-chunk max cosine to existing chunks; novel = low similarity).
2. **Answerability-lift** (a question-answering proxy) — over a set of questions, how many the KB
   can answer **before** vs **after** the doc is added. Honest only when the questions are
   **held-out** and derived from **real transcripts**; at first onboarding (no transcripts) it runs
   on a **task-derived, explicitly-provisional** question set and is labelled as such.

**"No improvement" is a valid, honestly-reported result.** Novelty and answerability-lift are
shown as two numbers with their basis, never fused into one "X% better" score.

**Done when:** a user can upload a PDF/text doc, see it embedded into the KB, see a per-doc
**novelty** figure + (where questions exist) an **answerability-lift** figure with the questions and
their before/after verdicts shown, and see **doc↔task links** (which existing tasks each doc relates
to). Verified on real Nifty data.

## Goals / Non-goals

**Goals:** doc upload + parse + chunk + embed (reusing the 2a embed/search infra); an honest,
decomposed improvement metric (novelty + provisional answerability); doc↔task auto-linking; a thin
UI surface (upload + per-doc result card). All additive; no writes to `public`.

**Non-goals (deferred to 2c / later):** injecting doc context into the analyze/critic/enrich pipeline
(that's 2c); field prediction / dedup / HITL push (2c); OCR of scanned/image PDFs (v1 is
text-extractable PDFs + plain text/markdown only); per-chunk re-ranking; multi-doc "what changed
across uploads" trends. No new ClickUp writes.

---

## 1. Data model (meetsy schema only)

**`KbDocument`** — one row per uploaded doc:
- `id` (cuid), `workspaceId`, `filename`, `mimeType`, `sha256` (idempotency / dedup key),
  `byteSize`, `pageCount` (nullable), `charCount`, `chunkCount`,
- `status`: `pending | parsing | embedding | ready | error` + `error` text,
- `uploadedBy` (session user id — soft ref to `public.users`, no FK), `createdAt`, `updatedAt`,
- `@@unique([workspaceId, sha256])` — re-uploading the same bytes is a no-op (returns the existing doc).

**Storage decision (recommended):** persist the **extracted plain text** (`KbDocument.extractedText
@db.Text`) so a future model/dim bump can re-chunk + re-embed without the original file; **discard the
raw uploaded bytes** after extraction (no blob store in scope). `sha256` is computed over the raw
bytes for idempotency.

**Reuse `KbChunk`** for doc chunks — no schema change needed: `sourceType=document` (enum value
already exists), `sourceId=KbDocument.id`, `chunkIndex 0..N`, `content`=chunk text,
`contentHash`=sha256(chunk). The existing `@@unique([workspaceId, sourceType, sourceId, chunkIndex])`
and HNSW/tsv indexes already cover documents. Doc chunks are excluded from the 2a.1 summary facts
(those filter `sourceType='clickup_task'` already — verified).

**`KbDocTaskLink`** — doc↔task auto-links (the "what does this doc relate to" signal):
- `id`, `workspaceId`, `documentId` (FK within meetsy → KbDocument), `taskId` (plain String — soft
  ref to `public.clickup_tasks.task_id`, **no FK, no public write**), `score` (float, the cosine that
  produced the link), `createdAt`,
- `@@unique([documentId, taskId])`, `@@index([workspaceId, taskId])`.

Migration via the operator flow (grants.sql already grants what's needed; the new meetsy tables are
created by the meetsy role). No `public` change.

## 2. Upload → parse → chunk → embed pipeline

Mirrors the 2a worker shape (HTTP responds fast; a BullMQ job does the heavy work).

- **`POST /workspaces/:id/kb/documents`** (multipart or base64 body; Owner/Admin) → computes `sha256`,
  upserts `KbDocument` (status `pending`), enqueues a `meetsy-kb-docs` job, returns the doc row. Re-upload
  of an identical sha256 short-circuits to the existing doc.
- **Parse** (`status=parsing`): extract text by mime —
  - `application/pdf` → **`pdf-parse`** (one library, text PDFs only; the single new runtime dep).
    Scanned/image PDFs that yield ~empty text → `status=error` with a clear "no extractable text
    (scanned PDF?)" message. **OCR is explicitly out of v1 scope.**
  - `text/plain`, `text/markdown` → used as-is.
  - everything else → rejected at the endpoint (415) with the allowed list.
- **Chunk** (`status=embedding`): a new pure `chunkText(text, { targetTokens≈400, overlap≈15% })`
  helper (paragraph-aware splitter, approximate token budget; unit-tested). Distinct from the array
  `chunk()` in `kb.processor.ts`.
- **Embed**: reuse `AzureEmbeddingService.embed` (dimensions 1024, batched ≤256 via the existing
  `embedInBatches`) and the same raw `KbChunk` upsert as 2a. Then compute novelty + links (§3, §4),
  set `status=ready`.
- **Queue:** a dedicated `meetsy-kb-docs` queue/worker (separate from `meetsy-kb` onboarding) with the
  **same robustness as the just-landed fixes** — short `lockDuration`, `stalledInterval`,
  `maxStalledCount:1`, authoritative `failed` handler. (jobId = documentId; idempotent.)

## 3. ⭐ The improvement metric — the crux of this phase

Two signals, **reported separately, never blended**.

### 3a. Corpus novelty (the solid headline — no LLM, exact)
For each new doc chunk, `maxSim = max cosine(chunk, existing KB chunk)` over the workspace's chunks
(the same pgvector `<=>` the search uses, top-1). `novelty = 1 − maxSim`. The doc's headline =
distribution over its chunks: **% of chunks that are "novel"** (novelty above a cutoff, e.g. maxSim <
0.6) + median novelty. Interpretation shown plainly: "62% of this document is information the KB did
not already contain." A near-duplicate doc honestly scores low ("this mostly repeats what the KB
knows"). Cheap, exact, hallucination-free.

### 3b. Answerability-lift (a question-answering proxy — honest only with held-out questions)
**The centerpiece decision is: what does "answerable" mean?** Options:

| Option | Mechanic | Pro | Con |
|---|---|---|---|
| **A. Retrieval-threshold** | A question is "answerable" if hybrid search returns ≥1 chunk above a cosine cutoff. | Cheap, deterministic, no LLM, no generate-and-grade circularity. | Threshold is arbitrary; "retrieved something similar" ≠ "actually answers". |
| **B. LLM-judge** | Retrieve top-k, ask gpt-5.4-mini "is this context sufficient to answer Q? yes/no + why". | Closer to real "can we answer". | Cost; judge variance; risk of theater if the same model both benefits and grades. |
| **C. Hybrid (recommended)** | Retrieve top-k (the lift comes from retrieval changing); a **single** gpt-5.4-mini judge verdict per question, **same judge prompt before & after**, comparing only whether the *retrieved context* now suffices. | Measures the thing we care about (did the doc make a previously-unanswerable question answerable) while keeping the judge identical across the A/B so the delta is attributable to retrieval, not the model. | Some cost (N questions × 2); must hold questions out. |

**Recommendation: C**, with these honesty guardrails baked into the spec:
- **Questions are held-out** — they are NOT generated from the doc being scored. They come from **real
  meeting transcripts** (`Meeting.normalizedTranscript`, via the existing `vtt.ts` normalization): we
  extract the implicit questions/asks a meeting raised. The doc is scored on whether it newly answers
  *those independent* questions.
- **The judge is blind and identical** before vs after: same prompt, same k; only the retrieved
  context differs (before = KB without the doc's chunks; after = with). The reported number is **#
  newly-answerable** (was no → now yes) minus any regressions, with the full question list + both
  verdicts shown. No aggregate hidden.
- **First-onboarding provisional baseline:** when a workspace has **no transcripts yet**, there are no
  honest held-out questions, so answerability-lift runs on a **task-derived** question set (questions
  synthesized from task titles/descriptions) and is **labelled "provisional — derived from your own
  tasks, not independent; a true measure needs real meeting transcripts"**. The spec states plainly:
  *true* answerability-lift becomes meaningful in 2c once transcripts flow. **2b ships novelty as the
  headline and answerability as a clearly-provisional secondary.**

### 3c. Honest reporting contract
The result card shows **both numbers with their basis**, and **"no improvement"** is a first-class
outcome ("This document is 90% redundant with the KB and made 0 of 14 questions newly answerable").
Never a single fused score. The questions and per-question verdicts are always inspectable.

## 4. Doc↔task auto-linking
After embedding a doc, for each doc chunk run the existing hybrid search restricted to
`sourceType=clickup_task`; collect tasks above a link cutoff (e.g. cosine ≥ 0.75), aggregate to the
doc level (best score per task), write the top-N (e.g. 20) into `KbDocTaskLink`. Surfaces "this SOP
relates to these existing tasks" — the seed for 2c context injection. Plain `task_id` strings; no
public write.

## 5. Endpoints + UI
- `POST /workspaces/:id/kb/documents` — upload (Owner/Admin); returns the doc row + job queued.
- `GET /workspaces/:id/kb/documents` — list docs with status + metric summary.
- `GET /workspaces/:id/kb/documents/:docId` — one doc: status, novelty, answerability-lift (with
  questions + verdicts), linked tasks.
- `DELETE /workspaces/:id/kb/documents/:docId` — remove a doc + its chunks + links (Owner/Admin).
- **meetsy-web:** a thin "Knowledge / Documents" surface — drag-drop upload, a per-doc result card
  (novelty bar, answerability-lift with the question list, linked-tasks chips, status/errors). Can land
  behind the endpoints first (UI is additive).

## 6. Testing
- **Unit:** `chunkText` (boundaries, overlap, token budget, empty/huge input); PDF parse adapter
  (mocked `pdf-parse`; the scanned-PDF empty-text → error branch); novelty math (mocked vectors);
  the answerability judge builder (mocked LLM — asserts identical before/after prompt, held-out
  questions, returns the validated verdict shape); doc↔task link aggregation; the `meetsy-kb-docs`
  worker robustness (reuse the Fix-2 patterns + tests).
- **Live (real Nifty):** upload a real Nifty SOP/scope PDF into `ws_nifty` (now 1198 task chunks) →
  embeds; **novelty** is sane (a Nifty doc scores meaningfully novel; re-uploading a task export scores
  low); **doc↔task links** point at plausibly-related real tasks; answerability-lift runs provisional
  (no transcripts yet) and is **labelled provisional**; "no improvement" reproduces on a near-duplicate
  upload. **Verified end-to-end before marking 2b done.**

## 7. Risks
| Risk | Mitigation |
|---|---|
| Answerability metric becomes theater (model grades its own benefit) | Held-out, transcript-derived questions; identical blind judge before/after; provisional clearly labelled; novelty is the non-LLM headline |
| PDF parsing rabbit hole | One lib (`pdf-parse`), text PDFs only, OCR explicitly out; scanned PDFs → clear error |
| Doc chunks polluting the 2a.1 summary card | Summary facts already filter `sourceType='clickup_task'` (verified) |
| Big docs / cost | Chunk + batch embed (existing budget); novelty is pgvector-only; answerability is N questions not N chunks; one judge call per question |
| Duplicate uploads | `sha256` unique key → no-op re-upload |
| Worker crash mid-embed | `meetsy-kb-docs` worker reuses the Fix-2 robustness (short lock + stalled-recovery + authoritative failed handler) |

## 8. Open questions (for the approval discussion)
1. **"Answerable" definition** — approve **C (hybrid, held-out, blind-identical judge)**? Or prefer
   the cheaper **A (retrieval-threshold only)** for v1 and defer the judge to 2c?
2. **Provisional answerability at first onboarding** — show it (labelled provisional) or **hide it
   until real transcripts exist** and ship 2b with **novelty + doc↔task links only**? (Leaning: show,
   clearly labelled — but this is your call on honesty.)
3. **Upload limits** — max file size / pages for v1 (e.g. 25 MB / 300 pages)?
4. **Doc deletion** — hard-delete doc+chunks+links (recommended) vs soft-delete?

---

**Build gate:** this spec stops here. **No code until the product owner approves** (especially the
answerability definition + the provisional-baseline call — the opinion-heavy parts). On approval:
build sub-agent-driven → live-verify on real Nifty data → commit/push → update the journal + RESUME.
