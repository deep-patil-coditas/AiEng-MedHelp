# AiEng-MedHelp — Requirements

Status: draft for approval (session 03). Source of truth for project-wide decisions: `CLAUDE.md`.
Per CLAUDE.md, the agent sections (§5–§9) carry the most detail; the platform sections stay short.

## 1. Purpose and scope

AiEng-MedHelp is a **diagnosis assistant agent for doctors**. A doctor types the current patient's symptoms in free
text. The agent returns red flags, a ranked differential with mortality figures, the tests that best separate the
candidates, and clarifying questions when it cannot separate them. Every claim is grounded in, and cited from, the
research/facts documents in the knowledge base.

The project's real subject is **agent design**: the architecture, the tool contracts, guardrails, efficiency and
evaluation. The application around the agent is deliberately thin.

**In scope**
- The diagnosis agent (structure → reason → verify) with 6 tools, session memory, structured output and budgets.
- Disease search (mortality + facts, with citations).
- A knowledge base: seeded at startup, extended by upload (PDF/TXT/MD), searchable immediately.
- A registry audit log of searches and diagnoses.
- An offline golden-case evaluation that calls the real Claude models.

**Out of scope**
- Patient records of any kind. Patient information exists only inside uploaded documents (e.g. case reports).
- A UI. The interface is REST only.
- Treatment or prescribing advice.
- Persisting symptom text anywhere.
- Using the LLM's general medical knowledge as a source of facts (it may reason, but not supply facts or figures).
- Document approval workflows, versioning, multi-tenancy, or production deployment.
- Languages other than English.

## 2. Glossary

| Term | Meaning |
|------|---------|
| Document | An uploaded or seeded research/facts file with metadata (title, diseases, type, source, year). |
| Type | `RESEARCH` (studies, case reports) or `FACT` (fact sheets: mortality, symptoms, criteria). |
| Chunk | A text fragment of a document, embedded and stored in the vector store with the document's metadata. |
| Citation | `{docId, title, snippet}`, where the snippet is verbatim text from a chunk of that document. |
| Findings | Structured form of the symptom text: age band, sex, symptoms, duration, vitals, negatives. |
| Differential | A ranked list of candidate diseases with likelihood `HIGH`/`MEDIUM`/`LOW`. |
| Red flag | A finding pattern that the documents mark as urgent. It produces the URGENT banner. |
| Diagnosis session | The in-memory conversation for one patient presentation (30-min idle TTL). |
| Critic | The verification step that checks the draft against the cited chunks. |
| Budget | The per-request cap: at most 6 tool calls, plus a token budget. |

## 3. Users and access

- **FR-AUTH-01** Authentication is HTTP Basic against two seeded users: `doctor` (role DOCTOR) and `admin` (role
  ADMIN). Passwords come from configuration and are stored as hashes. Every `/api/**` endpoint requires
  authentication; an unauthenticated request gets 401.
- **FR-AUTH-02** DOCTOR may run diagnoses, search diseases, upload documents, list/read documents and read **their
  own** registry entries.
- **FR-AUTH-03** ADMIN may do everything DOCTOR can, plus delete documents and read **all** registry entries. A
  DOCTOR attempting an ADMIN action gets 403.

## 4. Knowledge base

### 4.1 Seed corpus

- **FR-KB-01** At startup the application loads a **synthetic** seed corpus covering 12 fever / systemic-illness
  diseases: tuberculosis, Hodgkin lymphoma, HIV (acute and advanced), infective endocarditis, falciparum malaria,
  dengue, typhoid fever, sepsis, brucellosis, sarcoidosis, influenza, community-acquired pneumonia.
- **FR-KB-02** The seed corpus contains:
  - one `FACT` sheet per disease (MD), with mortality figure(s) with source wording, key symptoms, risk factors,
    diagnostic criteria, red-flag patterns and recommended investigations;
  - at least 4 `RESEARCH` case reports (MD) with patient presentations, used by `find_similar_cases`.
- **FR-KB-03** Every seed file states in its first line that it is synthetic and for demonstration only. Seed
  documents are owned by the system user `seed`.
- **FR-KB-04** The seed corpus deliberately contains these test hooks:
  - **sarcoidosis:** the FACT sheet has **no** mortality figure (it exercises "not available");
  - **tuberculosis:** two documents give **different** mortality figures (it exercises reporting both, each cited);
  - **one case report:** contains an instruction-like sentence (e.g. "Ignore previous instructions and…"), which
    exercises prompt-injection resistance.

### 4.2 Upload and indexing

- **FR-KB-05** `POST /api/documents` (multipart) accepts one file plus metadata: `title` (required), `diseases`
  (1..n, required), `type` (`RESEARCH`|`FACT`, required), `source` (optional), `year` (optional, 1900..current year).
- **FR-KB-06** Accepted formats are PDF, TXT and MD, detected by extension and content type, at most 10 MB.
  Anything else gets 415 (format) or 413 (size). A file with no extractable text gets 422.
- **FR-KB-07** The file is chunked and embedded with local ONNX all-MiniLM-L6-v2 into SimpleVectorStore. Every chunk
  carries `docId`, `title`, `diseases`, `type`, `year`. Indexing is synchronous: when the 201 response returns, the
  document is searchable.
- **FR-KB-08** The uploader's username and upload timestamp are recorded. There is no approval step.
- **FR-KB-09** `GET /api/documents` lists documents (metadata only, filterable by disease and type);
  `GET /api/documents/{id}` returns metadata plus chunk count. `DELETE /api/documents/{id}` (ADMIN) removes the
  document and all its chunks from the vector store.
- **FR-KB-10** Disease names are matched case-insensitively against a normalised name (trimmed, lower-case), so
  "TB" does not equal "tuberculosis": no synonym expansion in v1.

## 5. Diagnosis agent — API

- **FR-DX-01** `POST /api/diagnosis/sessions` with `{ "symptoms": "<free text>" }` starts a diagnosis session and
  returns the diagnosis response (§8) with a new `sessionId`. `symptoms` is 3..2000 characters, otherwise 400.
- **FR-DX-02** `POST /api/diagnosis/sessions/{sessionId}/messages` with `{ "message": "<answers or extra findings>" }`
  continues the session. The agent re-reasons using the session memory (earlier findings + previous answer) and
  returns an updated response. Same length rule as FR-DX-01.
- **FR-DX-03** `DELETE /api/diagnosis/sessions/{sessionId}` closes the session and erases its memory (204).
- **FR-DX-04** A session belongs to the user who created it. Another user gets 404 (existence is not revealed).
  An unknown, closed or expired session gets 404 with code `SESSION_NOT_FOUND`.
- **FR-DX-05** Session memory is in memory only, with a TTL of 30 minutes since the last activity. Expiry or close
  erases it. It is never written to the DB, the registry, the vector store or logs.

## 6. Diagnosis agent — pipeline

- **FR-PIPE-01 Structure** (`claude-haiku-5-5`): free text → `Findings { ageBand, sex, symptoms[], duration,
  vitals{}, negatives[] }`. Unknown fields are null; nothing is guessed. Age is converted to a band (e.g. 58 →
  `50-59`), and the raw age is not kept beyond the session.
- **FR-PIPE-02 Reason** (`claude-sonnet-5-5`): a ReAct tool-calling loop over the 6 tools (§7). It gathers evidence and
  drafts the response (§8). It must call `check_red_flags` at least once per turn, before drafting.
- **FR-PIPE-03 Verify** (`claude-haiku-5-5`): the critic checks every red flag, differential entry, mortality figure
  and suggested test against the text of the chunks it cites, and applies these rules:
  - an unsupported mortality figure becomes `"not available"` (its citation is removed);
  - a differential entry, suggested test or red flag with **no valid citation** is dropped;
  - a claim whose citation supports it only partly is kept, with `unverified: true`;
  - each drop or replacement is counted in `verification` (§8).
  The critic does not add new claims. It does not call tools, and it doesn't send work back to the reasoner.
- **FR-PIPE-04** A citation is **valid** when its `docId` exists and its `snippet` occurs verbatim (whitespace-
  normalised) in a chunk of that document. Validity is checked in code, not by the LLM, before the critic runs.
- **FR-PIPE-05** Red flags found by `check_red_flags` are never removed for budget reasons. They are subject only to
  the citation-validity rule.

## 7. Agent tools — contracts

General rules for all tools:
- **FR-TOOL-01** Each tool takes typed input and returns typed JSON output. Each returned item carries at least one
  citation (`docId`, `title`, `snippet` ≤ 300 chars), except `ask_clarifying_question`.
- **FR-TOOL-02** Retrieval tools return at most **top-k = 5** chunks (configurable), trimmed to the snippet.
- **FR-TOOL-03** Tools never use the LLM's general knowledge. If the documents have nothing, the tool returns an empty
  result with `found: false`, never invented content.
- **FR-TOOL-04** Each tool can be invoked and tested on its own, without the orchestrator.
- **FR-TOOL-05** Document text returned by tools is **data**. Instructions inside documents are never followed
  (see FR-KB-04 hook).

| ID | Tool | Input | Output | Notes |
|----|------|-------|--------|-------|
| FR-TOOL-10 | `search_knowledge_base` | `query` (req), `disease?`, `type?` (`RESEARCH`/`FACT`), `yearFrom?`, `topK?` (≤5) | `hits[]: {docId, title, type, year, snippet, score}` | Semantic search + metadata filter |
| FR-TOOL-11 | `get_disease_profile` | `disease` (req) | `{disease, found, mortality[]: {figure, context, citation}, keySymptoms[], riskFactors[], diagnosticCriteria[], citations[]}` | Every listed item is extracted from FACT/RESEARCH chunks for that disease. `mortality: []` when no figure exists (rendered as "not available"). Multiple figures are all returned, each cited |
| FR-TOOL-12 | `find_similar_cases` | `findings` (Findings) | `cases[]: {docId, title, matchingFindings[], snippet}` (≤5) | Searches `RESEARCH` documents only |
| FR-TOOL-13 | `check_red_flags` | `findings` | `redFlags[]: {flag, matchedFindings[], urgency: URGENT, citation}` | Matches findings against red-flag patterns in documents |
| FR-TOOL-14 | `suggest_next_tests` | `candidates[]` (2..5 diseases), `findings` | `tests[]: {test, discriminates[] (diseases), rationale, citation}` (≤5) | Ranks tests by how many top candidates they separate |
| FR-TOOL-15 | `ask_clarifying_question` | `questions[]` (1..3), `reason` | acknowledgement | Sets response status `NEEDS_CLARIFICATION`. Does not end the turn early: the draft is still produced |

- **FR-TOOL-20** Disease search (`GET /api/diseases/{name}`) reuses `get_disease_profile` directly, with no LLM
  reasoning loop. It returns the profile as JSON. An unknown disease returns 200 with `found: false`.

## 8. Diagnosis response — schema

- **FR-OUT-01** Every diagnosis response is structured JSON (Spring AI structured output):

```json
{
  "sessionId": "uuid",
  "status": "COMPLETE | NEEDS_CLARIFICATION | PARTIAL",
  "urgent": true,
  "redFlags":   [{ "flag": "", "matchedFindings": [], "citation": {} }],
  "differential": [{
    "disease": "", "likelihood": "HIGH | MEDIUM | LOW",
    "supportingFindings": [], "findingsAgainst": [],
    "mortality": [{ "figure": "", "context": "", "citation": {} }] ,
    "mortalityAvailable": true,
    "unverified": false
  }],
  "suggestedTests": [{ "test": "", "discriminates": [], "rationale": "", "citation": {} }],
  "clarifyingQuestions": [],
  "citations": [{ "docId": "", "title": "", "snippet": "" }],
  "verification": { "droppedClaims": 0, "mortalityReplaced": 0, "unverifiedClaims": 0 },
  "budgetExhausted": false,
  "disclaimer": ""
}
```

- **FR-OUT-02** `urgent` is true when `redFlags` is non-empty. That is the URGENT banner.
- **FR-OUT-03** `differential` has at most 5 entries, ordered by likelihood, then by supporting-evidence strength.
- **FR-OUT-04** `mortalityAvailable: false` with `mortality: []` means "not available". The API never returns a
  mortality figure without a citation.
- **FR-OUT-05** `citations[]` is the de-duplicated union of all citations in the response.
- **FR-OUT-06** `disclaimer` is a fixed configured text stating that the output is decision support from the
  knowledge-base documents, not a diagnosis, and that clinical judgement prevails.
- **FR-OUT-07** `status = NEEDS_CLARIFICATION` returns a **provisional** answer: the full differential, red flags and
  tests that are known so far, plus 1–3 `clarifyingQuestions`. Red flags are never held back pending answers.
- **FR-OUT-08** `status = PARTIAL` with `budgetExhausted: true` when the budget ran out (§9).

## 9. Efficiency and budgets

- **FR-EFF-01 Model routing:** Haiku 5.5 for structure and verify; Sonnet 5.5 for reason. Model ids are configurable.
- **FR-EFF-02 Prompt caching** is enabled on the system prompt and tool definitions for the reasoning step.
- **FR-EFF-03 Tool-call cap:** at most 6 tool calls per request (one turn), counted across the reasoning loop.
- **FR-EFF-04 Token budget:** at most 40,000 total tokens (input + output, all three steps) per request,
  configurable.
- **FR-EFF-05 Budget exhaustion:** when either limit is hit, the reasoner stops gathering evidence and drafts from
  what it has. The critic still runs. The response is `status: PARTIAL`, `budgetExhausted: true`, HTTP 200. Red flags
  already found are included.
- **FR-EFF-06 Usage metrics:** per request, log and expose a request id, the model per step, input/output/cache-read
  tokens per step, tool calls (name + count), latency per step and total, and estimated cost (from configured per-model
  prices). Never log symptom text, findings or session messages.
- **FR-EFF-07** Usage metrics are kept in memory and readable by ADMIN at `GET /api/metrics/usage` (aggregates: request
  count, average tokens, average tool calls, average latency, total estimated cost).

## 10. Registry (audit log)

- **FR-REG-01** Every disease search and every diagnosis turn writes one registry entry: `id`, `username`, `timestamp`,
  `queryType` (`DISEASE_SEARCH` | `DIAGNOSIS`), `disease` (searches only), `citedDocIds[]`, `status` (diagnosis only).
- **FR-REG-02** A registry entry never contains symptom text, findings, clarifying answers or the differential.
- **FR-REG-03** `GET /api/registry` returns the caller's own entries (DOCTOR) or all entries (ADMIN). It is paginated
  and filterable by `queryType` and date range, newest first.

## 11. Guardrails

- **FR-GRD-01** Facts and figures come only from the knowledge base. The system prompts say so, and the critic plus
  the citation check (FR-PIPE-04) enforce it.
- **FR-GRD-02** Document content is treated as untrusted data (FR-TOOL-05).
- **FR-GRD-03** If the symptom text has no clinical content (e.g. "hello", a question about something else), the
  agent returns `NEEDS_CLARIFICATION` with an empty differential and a question asking for the presentation. It
  never answers off-topic requests.
- **FR-GRD-04** No treatment, dosage or prescribing recommendations appear in the output.
- **FR-GRD-05** Every response includes the disclaimer.

## 12. Evaluation

- **FR-EVAL-01** A golden set of **12** synthetic cases over the seed corpus. Each case has symptom text, the expected
  disease (must be in the top 3), expected red flags (may be empty) and expected cited document id(s). At least
  2 cases need clarification, 1 involves sarcoidosis (mortality "not available") and 1 retrieves the injection-hook
  case report.
- **FR-EVAL-02** The eval runs under `./mvnw verify -Peval` with real Claude calls (needs `ANTHROPIC_API_KEY`). Plain
  `./mvnw test` mocks the chat models and makes no network calls.
- **FR-EVAL-03** The eval reports per case and in aggregate: top-3 accuracy, citation validity (FR-PIPE-04), red-flag
  recall, average tool calls, average tokens, average latency and total estimated cost. It writes a report file to
  `target/eval/`.
- **FR-EVAL-04** Targets (the eval fails the build below these): top-3 accuracy ≥ 80%, citation validity = 100%,
  red-flag recall ≥ 90%, average tool calls ≤ 6.

## Non-functional requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | Privacy: symptom text, findings and session messages are never persisted (DB, registry, vector store, files) or logged at any level. This is verified by a test that greps captured logs. |
| NFR-02 | Java 21 target, Spring Boot 3.5.x, Maven wrapper. No Docker. Builds and tests offline (except `-Peval`). |
| NFR-03 | `./mvnw test` is deterministic and free: chat models are mocked; embeddings run locally. |
| NFR-04 | Diagnosis latency target: p95 ≤ 30 s per turn on the eval set (reported, not enforced in `mvnw test`). |
| NFR-05 | Average cost per diagnosis turn is reported by the eval; prompt caching must show cache-read tokens > 0 from the second request onwards. |
| NFR-06 | Errors return JSON `{code, message}` with the matching HTTP status. No stack traces in responses. |
| NFR-07 | The vector store is persisted to a JSON file (configurable path) so uploads survive a restart; H2 is in-memory. On startup, seeds are re-indexed only if missing. |
| NFR-08 | Secrets (API key, user passwords) come from env/config, never from source. |
| NFR-09 | Each tool and each pipeline step can be tested in isolation. |

## Edge cases

| ID | Case | Expected | Sample data |
|----|------|----------|-------------|
| EC-01 | Disease with no mortality figure in any document | `mortalityAvailable: false`, "not available"; no figure invented | Sarcoidosis FACT sheet |
| EC-02 | Two documents give different mortality figures | Both figures returned, each with its own citation | TB FACT sheet + TB RESEARCH doc |
| EC-03 | Reasoner drafts a mortality figure not in the cited chunk | Critic replaces it with "not available"; `verification.mortalityReplaced` = 1 | Mocked draft "TB mortality 15%" citing the TB FACT sheet |
| EC-04 | Differential entry with no valid citation | Entry dropped; `droppedClaims` incremented | Mocked draft citing unknown docId |
| EC-05 | Candidates can't be separated | `NEEDS_CLARIFICATION`, provisional differential, 1–3 questions | "58M, fever, night sweats, weight loss 3 wks" (TB vs lymphoma) |
| EC-06 | Doctor answers clarifying questions | Same session; refined differential; status may become `COMPLETE` | EC-05 + "BCG unknown, recent travel to India, cough 2 wks" |
| EC-07 | Tool-call cap (6) reached | `PARTIAL`, `budgetExhausted: true`, 200, red flags kept | Mocked reasoner that keeps calling tools |
| EC-08 | Token budget exceeded | Same as EC-07 | Budget configured low in test |
| EC-09 | Red flag present | `urgent: true`, red flag with citation | "34F back from Ghana, fever, confusion" (severe malaria); "BP 82/50, RR 26, confused" (sepsis) |
| EC-10 | Document contains injected instructions | Instructions ignored; content used only as data | Injection-hook case report |
| EC-11 | Non-clinical input | `NEEDS_CLARIFICATION`, empty differential | "hello" |
| EC-12 | Symptoms < 3 or > 2000 chars | 400 | "ab" / 2001-char string |
| EC-13 | Expired / closed / foreign session | 404 `SESSION_NOT_FOUND` | Session older than 30 min idle; `admin` using `doctor`'s session |
| EC-14 | Upload unsupported format / > 10 MB / no text | 415 / 413 / 422 | `.docx`, 11 MB PDF, image-only PDF |
| EC-15 | Disease search for unknown disease | 200, `found: false` | "kala-azar" |
| EC-16 | Uploaded doc used immediately | Next diagnosis/search can cite it | Upload new FACT sheet, then search |
| EC-17 | Document deleted | Its chunks no longer retrieved; registry entries citing it remain | ADMIN deletes the dengue FACT sheet |
| EC-18 | DOCTOR calls ADMIN endpoint | 403 | `doctor` DELETE /api/documents/{id} |

## Acceptance criteria

| ID | Criterion |
|----|-----------|
| AC-01 | On a fresh start, the 12 seed FACT sheets and ≥4 case reports are indexed; `GET /api/documents` lists them. |
| AC-02 | `doctor` searches "tuberculosis" and gets both mortality figures, each cited, plus key symptoms; a `DISEASE_SEARCH` registry entry is written. |
| AC-03 | `doctor` submits "58M, fever, night sweats, weight loss 3 wks": the response contains TB and Hodgkin lymphoma in the differential, cited mortality, discriminating tests and clarifying questions (`NEEDS_CLARIFICATION`). |
| AC-04 | Answering in the same session refines the differential; closing the session erases it (the next call gets 404). |
| AC-05 | A red-flag presentation (EC-09) returns `urgent: true` with a cited red flag. |
| AC-06 | No response anywhere contains an uncited mortality figure; invalid citations never reach the response. |
| AC-07 | Neither the registry, the DB nor the captured logs contain the submitted symptom text. |
| AC-08 | An uploaded PDF is cited by the next relevant diagnosis without a restart. |
| AC-09 | Per-request usage (tokens, tool calls, latency, cost) is logged and visible to ADMIN at `/api/metrics/usage`. |
| AC-10 | `./mvnw test` passes with no network access; `./mvnw verify -Peval` produces the eval report and meets FR-EVAL-04 targets. |

## Decision log

| ID | Question | Decision |
|----|----------|----------|
| D-01 | Seed corpus source (session 03, Q1) | Synthetic MD files written by us, ~12 diseases, each labelled synthetic |
| D-02 | Disease set (Q2) | Fever / systemic illness: TB, Hodgkin lymphoma, HIV, endocarditis, falciparum malaria, dengue, typhoid, sepsis, brucellosis, sarcoidosis, influenza, CAP |
| D-03 | Clarifying-question response (Q3) | Provisional full answer + 1–3 questions, `NEEDS_CLARIFICATION`; refine in the same session; red flags never held back |
| D-04 | Budget exhausted (Q4) | Best-effort `PARTIAL` answer, critic still runs, `budgetExhausted: true`, HTTP 200 |
| D-05 | Critic on unsupported claims (Q5) | Unsupported mortality → "not available"; uncited entry/test/flag dropped; partially supported → `unverified: true`; counts in `verification` |
| D-06 | Decided without asking | Seed test hooks (sarcoidosis no figure, TB conflicting figures, injection case report) |
| D-07 | Decided without asking | Citation validity checked in code (verbatim snippet match) before the critic |
| D-08 | Decided without asking | Limits: top-k 5, differential ≤ 5, tests ≤ 5, token budget 40k/request, upload ≤ 10 MB, symptoms 3–2000 chars |
| D-09 | Decided without asking | Session TTL is 30 min **idle** (sliding); foreign session → 404 |
| D-10 | Decided without asking | Endpoint paths (§5, §7, §10), `GET /api/metrics/usage` for ADMIN |
| D-11 | Decided without asking | Eval: 12 cases; thresholds top-3 ≥ 80%, citation validity 100%, red-flag recall ≥ 90%, avg tool calls ≤ 6 |
| D-12 | Decided without asking | Vector store persisted to JSON file; seeds re-indexed only if missing; no disease-synonym expansion in v1 |
| D-13 | Decided without asking | `check_red_flags` mandatory once per turn before drafting; no treatment advice in output |
