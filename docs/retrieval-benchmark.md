# Materials implementation and evaluation — October 1, 2026

## Current branch

`feature/semantic-materials-retrieval`, built from `468cd75`. The installed launcher and original checkout have not been replaced. Source integration is implemented; this is not a release qualification or six-person beta result.

### Answer paths

- **No files:** the shared answer orchestrator dispatches directly to the selected provider without preparing or querying an index.
- **Prepared files:** before the 90-minute timer starts, read native text/speaker notes and prepare search. Small collections fitting 48 source pages and 64,000 serialized text characters use whole-context text. Larger collections use pinned quantized E5 embeddings plus SQLite FTS5, rank fusion and nearby passages. No rejected MiniLM reranker is enabled.
- On each question, send bounded original excerpts, stable source IDs, and up to four available source images. The model is stateless with respect to the textbook: the application supplies evidence each time. A larger advertised model context window does not replace this index or guarantee recall.
- Only IDs actually cited by the answer become source buttons. Unsupported UUID/coordinate citations trigger a visible warning. This checks identity, not semantic entailment; the live benchmark still found unsupported model additions.
- Missing/corrupt search gives visibly labeled general reasoning; intact partial material remains useful. A local model-load failure offers explicitly labeled keyword-only search. Cancellation, End, expiry and owner changes cancel work instead of invoking fallback.

### Providers and UI

Qwen and DeepSeek use the existing OpenAI-compatible HTTP client; no additional provider SDK is required. Qwen settings include key, model and region/host. Direct Alibaba defaults to Virginia `qwen3.8-flash`; explicit Alibaba workspace regions, OpenRouter and Together hosts are supported. A key must match its issuing host/region. API keys are excluded from general settings broadcasts/log output.

Qwen has not been called live. Current direct Qwen vision/model/pricing claims are from [Alibaba's compatibility guide](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope), [vision guide](https://www.alibabacloud.com/help/en/model-studio/vision) and [regional price table](https://www.alibabacloud.com/help/en/model-studio/model-pricing). Together's `Qwen/Qwen3.8-Flash` vision capability is not established by its catalog, so this route remains conservatively text-only. No claim that Qwen outperforms DeepSeek is supported by these application tests.

Current DeepSeek Flash supports images; the old application restriction was removed according to its [vision API contract](https://api-docs.deepseek.com/guides/vision/). The source launcher flow exposes optional materials, visible preparation/coverage, consent, Skip, source previews and End. Active Add/Remove are disabled and rejected by the backend.

### Storage, visuals and limits

The workload remains 11 files, 1,000 combined pages, 50 MiB/file, 250 MiB total, and 16 MiB total decoded text. SQLite text/image encryption runs off the main thread, with an OS-wrapped session key. Recovery checks the original owner and deadline before unwrapping. A durable revocation marker prevents a queued save/crash from reviving ended data. Expiry/End immediately revoke reads; physical cleanup can take longer. Closed apps clean expired copies on next launch; original user files are untouched.

PDF pages are rendered locally; PNG/JPEG images embedded in PPTX are retained and can be previewed or supplied as source evidence. Assets are limited to 2 MiB each and 128 MiB per session; answer images are capped at four and 4 MiB combined base64. Rendering has a bounded per-document window; missing/corrupt/over-limit visuals leave text usable and coverage incomplete. PPTX shapes, SmartArt and full slide layout are not rendered; a PDF export gives better page fidelity.

**Image-only facts are not semantically indexed.** Source images can be read once a page is selected, especially in small whole-context collections or explicit page requests. This does not demonstrate finding an unknown diagram among 1,000 pages. There is no automatic visual-description/OCR indexing stage in this build.

The local E5 runtime lives in a separate process that exits with its session. Independent diagnosis reproduced ONNX native-addon reload failure across destroyed worker threads; fresh processes fix that actual failure. Vectors and text indexes stay in process memory. Public model weights remain cached separately; the first download (about 34 MiB) is excluded from warm-cache timing. JS heap limits do not cap native runtime memory.

### Measured evidence

Independent QA owns frozen fixtures, test code and scoring. Current text quality corpus: four real synthetic files, 73 substantive/visual pages, 27 questions. It is separate from the 1,000-page capacity fixture, which contains filler.

| Measurement | Observed result | Limit |
| --- | --- | --- |
| Required evidence recall / all-required evidence | 100% / 100% across 23 answerable cases | Broad selection: precision 3.65%; not proof of semantic superiority |
| Live DeepSeek strict grounding/citation review | 24/27 (88.9%) | Three unsupported additions/malformed citations; core requested content correct in all 27 |
| Missing/visual abstention and conflict cases | 4/4 and 3/3 | Synthetic cases only |
| Reviewed first useful answer content | median 1.128 s; p95 1.970 s; worst 2.062 s | Typed questions, one machine/network; a native smoke overlapped early requests |
| Complete text answer | median 2.099 s; worst 4.762 s | Distinct from first text and first useful content |
| Live ingested-source image answers | 3/3 strict passes; useful content worst 1.760 s | Small known visual files; no unknown-diagram recall claim |
| Two consecutive 1,000-page preparations | 14.97 s / 15.81 s | Cached model; Linux capacity fixture, not a real 1,000-page book |
| Capacity retrieval | 38.2 ms / 40.8 ms | One capacity query per session |
| Peak aggregate process-tree RSS | 400.4 MB / 415.0 MB | Includes child runtime; parent-only memory is not total memory |
| Worst 50 ms heartbeat overshoot | 1.64 ms / 1.33 ms | CLI event loop, not an Electron frame-rate claim |

The first eight live answers scored 6/8 strict; their failures remain intact. General citation instructions were revised, then all 27 cases were run and independently reviewed. No per-question gold was supplied to retrieval or generation. The process-isolation change reproduced exactly the same ordered source names/pages/text for all 27 questions; no additional paid text rerun was necessary.

Final independently owned regression checks passed **94/94**, with **6/6** targeted asset checks and **4/4** current Windows visual-preview checks. Frozen integrity: 32 files across 19 QA manifests unchanged (retrieval manifests are audited separately). Checks cover provider settings/transport, no-files and scoped answers, exact deadline, late extraction/restore/Start/usage, cancellation, encrypted assets, parser bounds and citation warnings. Rendered materials/notices and actual Windows Electron settings/previews were exercised. Native E5 and PDF work in Windows source and a tiny source-ASAR smoke, including two sessions and process cleanup. **A full release package/installer with relocated native dependencies has not been qualified.** Existing packaging tests passed 33/33. A preserved legacy provider/setup run was 71/74: its three failures still assert the superseded Gemini-only image restriction or require both old provider keys; those tests were not edited to hide the contract change. Two fresh isolated Codex reviews identified additional lifecycle/queue defects; their repairs are covered by frozen regressions and recorded in `review-dispositions.json`. Claude timed out, so these reviews are explicitly same-family.

Evaluation spending is recorded in the shared ledger against the authorized $10 total. Across historical and current runs, 120 completed requests totaled $0.16519542 using conservative published rates, not invoice charges. This includes the final three-request source-image integration sample. Qwen has no live usage or performance result.

Evidence directory: `/mnt/c/users/your-user/Documents/NoCatch-session-materials-evidence-20260929/retrieval-v2/build-20261001`.

- `qa/retrieval/results/live-flash-v4-all27.*`: raw stream, independent claims/citation and useful-text timing review.
- `qa/retrieval/results/live-source-vision-first.*`: actual imported/encrypted image reads, matching dispatched bytes and independent image/answer review.
- `qa/retrieval/results/semantic-provenance-review.json`: pinned E5 cache/runtime trace; historical raw default flags were not rewritten.
- `qa/retrieval/results/capacity-v3.json`: preserved second-worker failure; `capacity-v4-after.json` measures repaired process tree.
- `qa/retrieval/results/semantic-restart-{before,after}.json`: independently frozen restart regression.
- `qa/results/native-*`: actual Windows screenshots, runtime and lifecycle evidence with stated scope.
- `review-*-result.json`: fresh isolated review findings; no reviewer verdict substitutes for tests.

## Remaining qualification

Live Qwen comparison awaits the user's key. Real course files, dense equations, degraded scans, multilingual retrieval, screenshot-to-question latency on large collections, six-person beta usage and a full packaged installer remain unqualified. English E5-small-v2 is the current embedding model. Source-image access should not be confused with searchable visual facts or perfect citation entailment.

---

Everything below records the September 30 decision and failed experiment at that time; current behavior is described above.

# Archived research and rejected experiment — September 30, 2026

## Decision so far

Evaluate **Together's `Qwen/Qwen3.8-Flash`** first for vision and grounded answers. Compare it with `zai-org/GLM-5.3-Flash` and `deepseek-ai/DeepSeek-V4.1-Flash` using the same Together account. This is a practical experiment recommendation, **not a claim that Qwen has won our benchmark**. Alibaba's Qwen3.7 Flash is the lowest-price challenger identified for short prompts. Existing API credentials did not determine this shortlist.

Use separate embedding/search components. **Voyage 4-lite and Voyage 4** are the hosted retrieval candidates; a local index preserves document/page identity and the existing session lifetime. DeepInfra's Qwen embedding/reranking endpoints are cheaper alternatives worth testing if quality is comparable. A chat API key does not automatically create a vector index, source database, or deletion policy.

| Current candidate | Input/output USD per million tokens | Why it merits a test |
| --- | --- | --- |
| Together Qwen3.8 Flash | $0.09 / $0.282 | Low price, advertised image input and reasoning, 1M context |
| Alibaba Qwen3.7 Flash, Singapore International | $0.03 / $0.13 for prompts <=32K | Lowest short-prompt price in the shortlist; higher tiers cost more |
| DeepInfra GLM-5.3-Flash | $0.075 / $0.25 promotional; $0.15 / $0.50 list | Different model family, advertised vision; FP4 and promotion require comparison |
| Direct DeepSeek Flash | $0.15 / $0.60 off-peak; $0.30 / $1.20 peak | Existing operational baseline; V4.1 Flash currently supports vision |

Sources: [Together catalog](https://docs.together.ai/docs/serverless/models), [Qwen endpoint](https://www.together.ai/models/qwen3-8-flash), [Alibaba pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing), [DeepInfra endpoint](https://deepinfra.com/zai-org/GLM-5.3-Flash), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/). Together's central vision list and individual newer model pages are inconsistent; actual image requests must pass before claiming verified support. Its catalog presently has no serverless embedding/reranking models. Marketing pages and public leaderboards are not authenticated endpoint tests.

Research also covered OpenRouter, Gemini, Fireworks, Groq, Cerebras, Novita, SiliconFlow, Jina and Cohere. Some advertised prices depend on region, precision, provider routing, promotions or prompt length. Very cheap OpenRouter routes can have much lower advertised throughput. The full source-backed comparison is retained in the external evidence directory below.

## What the app needs to do

1. Extract native text, notes and page/slide identities locally. For scanned or visual content, render pages and use vision to obtain searchable descriptions; keep the original visual evidence available for answering. Text embeddings alone cannot recover an uncaptioned diagram.
2. Split into bounded passages. Compute embeddings that represent meaning, and retain lexical search for exact identifiers and formulas.
3. Retrieve a wider candidate set; select evidence covering every part of the question, including relevant conflicting versions. Similarity scores are not probabilities that an answer exists.
4. Give the answer model bounded original excerpts and, when necessary, the relevant original page images. Validate citations against supplied source IDs. Clearly distinguish general knowledge from supported course claims.
5. Keep material/index access bound to the original 90-minute session. Reject late asynchronous results after expiry, removal, owner changes or shutdown. Local expiry does not promise deletion of provider safety logs.

The answer model does not need all 1,000 pages in every prompt. The index supplies the relevant evidence on each question. A larger context window is a capacity limit, not a recall guarantee.

## Actual retrieval experiment

Independent QA froze the corpus, questions, scorer and source anchors before implementation. It contains **11 actual files: ten 75-slide PPTX decks plus a 250-page PDF**, with 37 questions. Only 30 unique pages contain the substantive evidence core; other pages include distractors and filler. This is an English synthetic scale/quality test, not a 1,000-page real textbook or a six-person beta.

The baseline preserves the existing keyword algorithm, with capacity raised to admit all 11 files. The experimental candidate uses real local quantized E5 embeddings, SQLite FTS5, reciprocal rank fusion, and a MiniLM cross-encoder.

| Metric | Existing keyword search | Local semantic candidate |
| --- | ---: | ---: |
| Mean required-evidence recall in final excerpts | 75.5% | 48.7% |
| All required evidence supplied, 32 answerable questions | 21/32 | 10/32 |
| Mean relevant-source precision | 16.4% | 54.3% |
| Required-evidence recall in wider top-24 pool | Not exposed | 95.8% |
| Questions with all evidence in wider pool | Not exposed | 30/32 |
| Median retrieval time | 3 ms | 252 ms |
| Import + preparation + all 37 queries | 4.17 s | 31.84 s |

Both candidates fail the independently selected retrieval acceptance gates. The local candidate's uncalibrated zero-logit relevance filter discarded useful evidence: nine answerable questions had no final excerpts, and none of the eight multi-evidence questions received all required evidence. A faster or more articulate answer model cannot fix that missing context. The next retrieval experiment must assess evidence selection, not merely swap embedding models.

**The rejected semantic experiment is preserved at Git commit `5fc14c1ec692ee39f1c9ee8e18cb2df27f121f8c` and removed from active application code.** Its `MaterialsManager.search()` and worker exist at that checkpoint for reproduction. Active application routing still uses the historical keyword `retrieve()`. The installed launcher has not been updated. A stronger retrieval implementation remains unfinished.

At the experimental checkpoint, model revisions are pinned in `src/materials/search-worker.js`. Public model weights are cached separately from materials; vectors and searchable passages stay in worker memory. The first model download is excluded from the measured warm-cache run. Transformers/ONNX was a development-only benchmark dependency at that checkpoint; it is absent from the active package manifest. It adds substantial local development size; the observed installed runtime dependencies are roughly 350 MB, separate from about 60 MB of model weights. A hosted embedding API may be the better product tradeoff.

## Actual answer and image checks

Both direct DeepSeek models answered the same 37 questions with the same existing lexical excerpts, temperature zero, thinking disabled and a 2,048-token output ceiling. This isolates answer generation with fixed context; it is not the application's entire UI/provider flow.

| Observed measurement | DeepSeek Flash | DeepSeek V4 Pro |
| --- | ---: | ---: |
| Requests | 37 | 37 |
| Median complete-answer latency | 1.366 s | 2.560 s |
| p95 complete-answer latency | 2.853 s | 7.492 s |
| Conservative peak-rate usage estimate | $0.01638 | $0.06491 |
| Correctly acknowledged the five deliberately absent answers | 5/5 | 5/5 |

Independent QA reviewed every answer against the actual supplied passages. The original strict claim rubric scored 25/37 Flash and 22/37 Pro, but some source-level rubric requirements exceeded what the corresponding question asked. Those raw scores are preserved with case-level caveats; they are **not general model accuracy estimates or a defensible winner ranking**. Both models remain constrained by missing retrieval evidence. Neither comparison establishes performance with a better index or representative real course documents.

Eight additional direct Flash requests supplied actual chart, table, diagram and scanned-page PNGs. Independent QA found **8/8 correct with valid supplied-page citations**, including one deliberately blank field. Median latency was 1.245 s; conservative cost estimate $0.00311. These were five clean, high-contrast images, not handwriting, dense math or degraded scans. This demonstrates supplied-page vision on the API; it does not demonstrate finding an unknown visual page, extracting original PPTX visuals, or visual RAG in NoCatch. The actual run used visual suite v1; QA verified all eight direct DeepSeek request bodies are identical in the corrected v2 adapter. Future experiments use v2.

Total live work so far: **82 requests, $0.08440 conservative token-based estimate**. No Together, Alibaba, DeepInfra or Voyage inference calls have run.

## Engineering checks

- The accepted-file cap is now 11; aggregate pages remain 1,000, including a possible 1,000-page individual PDF. Existing byte/text limits remain enforced.
- Experimental checkpoint only: independent lifecycle suites passed 17/17 after repairing manager validation of source identities, session metadata and context size, prompt cancellation during a shared build, visible query failures, and opt-in candidate diagnostics. Ordinary queries expose only scoped excerpts; developer diagnostics have a separate 24-candidate/64 KiB limit.
- Separate capacity checks: 3/3 passed, including the 4 MiB decoded-text boundary and aggregate page overflow.
- Prior core acceptance suite: 28/30 passed. The two failures assert the superseded ten-file and 250-page limits. The old tests were preserved; they were not edited to hide the changed contract.
- Independent code review additionally found that cancelling an active experimental query closes its shared worker and disrupts other queries. The controlled lifecycle checks do not establish real-worker concurrency safety. The experiment was parked instead of enabled.
- Semantic results are not a shipping gate pass. No new installer, launcher replacement, six-user concurrency result, real-course result or application visual-retrieval result is claimed.

## Budget and next comparison

The evaluation budget is **$10 total**, distinct from a recurring six-user budget. The live DeepSeek baseline uses a durable shared ledger: reserve conservative peak-price input/output cost before each request, bound output, disable automatic retries, retain reservations after failed requests. Ledger-derived dollar amounts are upper estimates using listed rates, not a provider invoice.

Together currently requires a $5 minimum credit purchase; its catalog lists the three model families for comparison. Confirm the exact IDs in the account catalog before funding; actual account access and image requests remain unverified. Acquisition of a new key/account is the outstanding dependency for that comparison. No new account or billing change has been made. The frozen visual suite can now be reused for those models, alongside the text questions.

For context, six users × 12 sessions/month × 30 questions/session, with 8K input and 1.5K billable output tokens per question, implies about **$2.47/month** for Together Qwen generation. Voyage 4-lite indexing/query embeddings add roughly **$0.87** under the separate assumption of 600K indexed tokens per session; optional Voyage lite reranking adds roughly **$0.46**. This ~$3.80 text scenario excludes visual ingestion, additional reasoning, retries, fees, taxes and hosting. It is not a usage forecast or guaranteed cap. [Voyage pricing](https://docs.voyageai.com/docs/pricing)

## Reproducible evidence

Evidence root: `/mnt/c/users/your-user/Documents/NoCatch-session-materials-evidence-20260929/retrieval-v2`.

- `qa/freeze.json`: immutable corpus/scorer hashes; `python3 qa/freeze.py --verify` checks them.
- `qa/results/lexical-run.json`, `lexical-score.json`, `local-run.json`, `local-score.json`, `local-hardened-run.json`, `local-hardened-score.json`: raw retrieval outputs and independent scores.
- `qa/extensions/adapter-v1`: thin wrappers exercising real imports and manager methods; no gold sent to retrieval.
- `qa/extensions/answer-v1`: separately frozen fixed-context answer comparison, no gold sent to providers.
- `qa/results/lifecycle-final.log`: actual new lifecycle checks.
- `qa/results/*-assessments.json`: independent answer/source and visual reviews with limitations.
- `spend/ledger.json`: request reservations and reported token accounting; no API keys.
- `research/`, `provider-survey/`: dated primary-source captures, calculations, provenance and qualified recommendations.

Branch: `feature/semantic-materials-retrieval`, based on the prior session-materials implementation. The original NoCatch checkout and installed application are untouched.
