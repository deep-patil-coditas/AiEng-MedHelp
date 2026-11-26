# AiEng-MedHelp

## What we are building

AiEng-MedHelp is a **diagnosis assistant agent for doctors**. The main goal of this project is **agent design**: what the agent's architecture looks like, which tools it gets, how it reduces the doctor's effort, and how it runs efficiently. The application around it is kept deliberately thin.

- **Diagnosis assistant (the focus):** a doctor describes the current patient's symptoms in free text (e.g. "58M, fever, night sweats, weight loss 3 wks"). The agent:
  - raises red flags
  - builds a ranked differential diagnosis with mortality figures
  - suggests the tests that best tell the candidates apart
  - asks clarifying questions when it can't separate the candidates

  Everything is grounded in, and cited from, the research/facts documents. The symptom text is **never persisted**.
- **Disease search:** the doctor searches a disease and gets back its mortality rate plus research/facts, with citations. It reuses the agent's `get_disease_profile` tool.
- **Knowledge base:** doctors upload research/facts (PDF/TXT/MD). Each file is chunked and embedded, and it is searchable immediately.
- **Registry:** an audit log of every search or diagnosis request.
- **No patient records:** patient information exists only inside uploaded research/facts files (e.g. published case reports).

## Development approach: SDD (Spec-Driven Development)

Docs come before code. The order is:

`CLAUDE.md` → `docs/requirements.md` → for each module, `docs/modules/<module>/spec.md` → `test.md` → `plan.md` → implementation (tests first).

Rules:
- Each doc gets its own commit.
- No code is written without an approved spec. If a spec gap shows up while coding, stop, update spec.md/test.md, commit, then go back to the code.
- Every test references its `test.md` ID (e.g. `TOOLS-T03`) in its name or a comment.
- Don't invent requirements. Ask the user one question at a time, with 4 options and the recommended one first.
- Requirement IDs: `FR-<area>-NN`, `NFR-NN`, `EC-NN`, `AC-NN`. Spec rules: `<MODULE>-SNN`. Tests: `<MODULE>-TNN`.
- Every doc ends with a **Decision log** table.
- Agent docs give the most detail to tool contracts, prompts, guardrails and evaluation. Platform docs stay short.

## Modules (build in this order)

| # | Module | Responsibility |
|---|--------|----------------|
| 1 | `platform` | Thin shell: HTTP Basic (seeded users), H2, seeded research/facts files loaded at startup, upload (PDF/TXT/MD), chunking + embeddings into SimpleVectorStore, registry audit log, disease-search endpoint |
| 2 | `agent-tools` | The 6 agent tools with precise contracts (input, output, limits, citations), each testable on its own |
| 3 | `agent-orchestrator` | Pipeline: symptom structuring → ReAct reasoning agent → critic/verifier. Also in-memory session memory, the structured output schema, model routing, the token/tool budget and usage metrics |
| 4 | `agent-eval` | Golden case set and a runnable eval (real Claude calls, separate Maven profile) reporting quality and cost metrics |

## Agent design (session 02)

**Architecture: orchestrator + critic loop**
1. **Structure** (Haiku 5.5): free-text symptoms → structured findings (age band, sex, symptoms, duration, vitals, negatives).
2. **Reason** (Sonnet 5.5): a ReAct tool-calling agent gathers evidence and drafts the differential.
3. **Verify** (Haiku 5.5): a critic checks every claim and mortality figure against the cited chunks, and drops or flags anything unsupported.

**Tools**

| Tool | Purpose |
|------|---------|
| `search_knowledge_base` | Semantic search over chunks, filterable by disease, type (`RESEARCH`/`FACT`) and year. Returns text + doc id + title |
| `get_disease_profile` | Mortality figures, key symptoms, risk factors and diagnostic criteria for one disease, from the docs |
| `find_similar_cases` | Searches case-report documents for presentations that match the current findings |
| `check_red_flags` | Matches findings to urgent patterns in the docs, producing the URGENT banner |
| `suggest_next_tests` | Investigations that best tell the top candidates apart, grounded in the docs |
| `ask_clarifying_question` | Pauses and returns 1–3 targeted questions to the doctor when the candidates can't be told apart |

**Memory:** an in-memory diagnosis session (Spring AI ChatMemory) with a 30-min TTL, or until the doctor closes it. It is never written to the DB or logs.

**Output:** structured JSON (Spring AI structured output) with these fields:
- `redFlags[]`
- `differential[]`, each with `disease`, `likelihood` (`HIGH`/`MEDIUM`/`LOW`), `supportingFindings`, `findingsAgainst` and `mortality` (with citation)
- `suggestedTests[]`
- `clarifyingQuestions[]`
- `citations[]`, each with doc id, title and snippet
- `disclaimer`

**Efficiency:**
- Haiku for the cheap steps, Sonnet for reasoning.
- Prompt caching on the system prompt and tool definitions.
- At most 6 tool calls per request, plus a token budget.
- Tool results trimmed to the top-k chunks.
- Tokens, tool calls and latency logged per request.

**Evaluation:** 10–15 synthetic golden cases (symptoms → expected disease in the top 3, expected red flag, expected citation). The eval reports top-3 accuracy, citation validity, red-flag recall, average tool calls and cost. It runs only under its own Maven profile. Plain `mvnw test` stays mocked and free.

## Tech stack

- Java 21 (the machine has JDK 25 installed, and the build targets release 21)
- Spring Boot 3.5.x, Maven wrapper (`mvnw`); no global Maven is installed
- Spring Web, Spring Security (HTTP Basic), Spring Data JPA + H2 (in-memory), Bean Validation
- Spring AI:
  - Anthropic chat models `claude-sonnet-5-5` (reasoning) and `claude-haiku-5-5` (structuring/critic), key from the env var `ANTHROPIC_API_KEY`
  - Local ONNX embeddings (Transformers, all-MiniLM-L6-v2)
  - `SimpleVectorStore`, saved to a JSON file
  - PDF document reader
  - In-memory ChatMemory
- No Docker needed.
- Tests: JUnit 5, Spring Boot Test, MockMvc, spring-security-test. The chat models are mocked in `mvnw test`.
- Build/test command: `./mvnw test` (Windows: `mvnw.cmd test`) from the repo root. Eval: `./mvnw verify -Peval` (needs `ANTHROPIC_API_KEY`).

## Domain decisions

- **Diagnosis input (session 01):** free-text symptoms, kept only in the in-memory session (30-min TTL). They are never persisted: not in the registry, the DB or logs.
- **Mortality rate (session 01):** extracted from the uploaded documents only, with a citation for every figure. If no document has a figure, the answer says "not available". The LLM never fills it in from its general knowledge.
- **Registry (session 01):** a search audit log. Each entry holds the doctor id, timestamp, query type (`DISEASE_SEARCH` | `DIAGNOSIS`), disease (for searches) and cited document ids. The symptom text is never stored.
- **Uploads (session 01):** PDF/TXT/MD with metadata (title, disease(s), type `RESEARCH` | `FACT`, source/year). Files are live as soon as they're uploaded (no approval step), and the uploader is recorded.
- **Auth (session 02, replaces JWT):** HTTP Basic with 2 seeded users, `doctor` (DOCTOR) and `admin` (ADMIN). ADMIN can also delete documents and view the whole registry.
- **Storage (session 02, replaces Postgres/pgvector):** H2 in-memory plus SimpleVectorStore. Seed research/facts files are loaded at startup.
- **Interface (session 01):** REST API only, no UI.

## Git workflow

- Committing directly to `main`. Remote `origin` is the public GitHub repo https://github.com/deep-patil-coditas/AiEng-MedHelp. Push after each commit.
- Conventional commits: `docs:`, `docs(<module>):`, `test(<module>):`, `feat(<module>):`, `chore:`.
- Never commit `.idea/`, `target/`, `*.iml`, `.env`, API keys or secrets.

## Sessions and conversation logs

- Each working session is numbered (`session-NN-<topic>`). At the end of a session:
  `node tools/export-session.mjs session-NN-<topic>`, then commit `chore(sessions): add session NN conversation log`.
- Session 01: SDD project setup.
- Session 02: refocus on agent design; simplified the platform.

## Working with the user

- Ask gap questions one at a time, with exactly 4 options and the recommended one first.
- List conventions you decided without asking, so the user can veto them.
