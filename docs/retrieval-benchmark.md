# Retrieval and model selection — September 30, 2026

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

**The semantic candidate is not connected to application answering or the installed launcher.** `MaterialsManager.search()` and its worker are an experimental benchmark path. Existing application routing still calls the historical `retrieve()`. Do not market the candidate as an upgrade until it passes retrieval and answer-quality checks.

Model revisions are pinned in `src/materials/search-worker.js`. Public model weights are cached separately from materials; vectors and searchable passages stay in worker memory. The first model download is excluded from the measured warm-cache run. Transformers/ONNX is a development-only benchmark dependency, excluded from production dependencies. It adds substantial local development size; the observed installed runtime dependencies are roughly 350 MB, separate from about 60 MB of model weights. A hosted embedding API may be the better product tradeoff.

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
- Independent new lifecycle suites: 17/17 passed after repairing manager validation of source identities, session metadata and context size, prompt cancellation during a shared build, visible query failures, and opt-in candidate diagnostics. Ordinary queries expose only scoped excerpts; developer diagnostics have a separate 24-candidate/64 KiB limit.
- Separate capacity checks: 3/3 passed, including the 4 MiB decoded-text boundary and aggregate page overflow.
- Prior core acceptance suite: 28/30 passed. The two failures assert the superseded ten-file and 250-page limits. The old tests were preserved; they were not edited to hide the changed contract.
- Semantic results are not a shipping gate pass. No new installer, launcher replacement, six-user concurrency result, real-course result or visual understanding result is claimed.

## Budget and next comparison

The evaluation budget is **$10 total**, distinct from a recurring six-user budget. The live DeepSeek baseline uses a durable shared ledger: reserve conservative peak-price input/output cost before each request, bound output, disable automatic retries, retain reservations after failed requests. Ledger-derived dollar amounts are upper estimates using listed rates, not a provider invoice.

Together currently requires a $5 minimum credit purchase; its catalog lists the three model families for comparison. Confirm the exact IDs in the account catalog before funding; actual account access and image requests remain unverified. Acquisition of a new key/account is the outstanding dependency for that comparison. No new account or billing change has been made. The frozen visual suite can now be reused for those models, alongside the text questions.

For context, six users × 12 sessions/month × 30 questions/session, with 8K input and 1.5K billable output tokens per question, implies about **$2.47/month** for Together Qwen generation. Voyage 4-lite indexing/query embeddings add roughly **$0.87** under the separate assumption of 600K indexed tokens per session; optional Voyage lite reranking adds roughly **$0.46**. This ~$3.80 text scenario excludes visual ingestion, additional reasoning, retries, fees, taxes and hosting. It is not a usage forecast or guaranteed cap. [Voyage pricing](https://docs.voyageai.com/docs/pricing)

## Reproducible evidence

Evidence root: `/mnt/c/users/your-user/Documents/NoCatch-session-materials-evidence-20260929/retrieval-v2`.

- `qa/freeze.json`: immutable corpus/scorer hashes; `python3 qa/freeze.py --verify` checks them.
- `qa/results/lexical-run.json`, `lexical-score.json`, `local-run.json`, `local-score.json`: raw retrieval outputs and independent scores.
- `qa/extensions/adapter-v1`: thin wrappers exercising real imports and manager methods; no gold sent to retrieval.
- `qa/extensions/answer-v1`: separately frozen fixed-context answer comparison, no gold sent to providers.
- `qa/results/lifecycle-final.log`: actual new lifecycle checks.
- `qa/results/*-assessments.json`: independent answer/source and visual reviews with limitations.
- `spend/ledger.json`: request reservations and reported token accounting; no API keys.
- `research/`, `provider-survey/`: dated primary-source captures, calculations, provenance and qualified recommendations.

Branch: `feature/semantic-materials-retrieval`, based on the prior session-materials implementation. The original NoCatch checkout and installed application are untouched.
