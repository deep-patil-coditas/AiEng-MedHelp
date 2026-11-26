# AiEng-MedHelp

## What we are building

AiEng-MedHelp is a clinical knowledge assistant for **doctors**, exposed as a REST API.

- **Disease search:** a doctor searches a disease (e.g. "Dengue") and gets back its **mortality rate** and the **research/facts** that other doctors uploaded. Every figure cites the document it came from.
- **Diagnosis assistant (agent):** a doctor describes the current patient's symptoms in free text (e.g. "58M, fever, night sweats, weight loss 3 wks"). A Claude tool-calling agent searches the knowledge base and returns a ranked list of possible diseases (differential diagnosis), with citations. The symptom text is **never stored**.
- **Knowledge base:** doctors upload new research or facts as PDF, TXT or MD files. Each file is chunked and embedded, and it becomes searchable immediately.
- **Registry:** every search or diagnosis request is recorded in an audit log (who, when, what kind of query, which documents were cited).
- **No patient records:** the database holds no patient table. Patient information exists only inside uploaded research/facts files (e.g. published case reports).

## Development approach: SDD (Spec-Driven Development)

Docs come before code. The order is:

`CLAUDE.md` → `docs/requirements.md` → for each module, `docs/modules/<module>/spec.md` → `test.md` → `plan.md` → implementation (tests first).

Rules:
- Each doc gets its own commit.
- No code is written without an approved spec. If a spec gap shows up while coding, stop, update spec.md/test.md, commit, then go back to the code.
- Every test references its `test.md` ID (e.g. `SEARCH-T03`) in its name or a comment.
- Don't invent requirements. Ask the user one question at a time, with 4 options and the recommended one first.
- Requirement IDs: `FR-<area>-NN`, `NFR-NN`, `EC-NN`, `AC-NN`. Spec rules: `<MODULE>-SNN`. Tests: `<MODULE>-TNN`.
- Every doc ends with a **Decision log** table.

## Modules (build in this order)

| # | Module | Responsibility |
|---|--------|----------------|
| 1 | `auth` | JWT login (`/api/auth/login`), seeded users, roles DOCTOR and ADMIN, securing every other endpoint |
| 2 | `document` | Upload research/facts (PDF/TXT/MD + metadata), text extraction, chunking, embedding into pgvector, list/get/delete (ADMIN deletes) |
| 3 | `registry` | Search audit log: doctor, timestamp, query type, disease, cited document ids; doctors see their own entries, ADMIN sees all |
| 4 | `search` | Disease search: mortality rate extracted from the documents plus research/facts summaries, each with citations; "not available" when no source has it |
| 5 | `diagnosis` | Spring AI tool-calling agent (Claude): free-text symptoms → ranked differential with citations; input not saved; writes a registry entry |

## Tech stack

- Java 21 (the machine has JDK 25 installed, and the build targets release 21)
- Spring Boot 3.5.x, Maven wrapper (`mvnw`); no global Maven is installed
- Spring Web, Spring Security + JWT, Spring Data JPA, Bean Validation
- Spring AI:
  - Anthropic chat model `claude-sonnet-5-5`, key from the env var `ANTHROPIC_API_KEY`
  - Local ONNX embeddings (Transformers, all-MiniLM-L6-v2)
  - `PgVectorStore`
  - PDF document reader
- PostgreSQL 16 + pgvector, run via `docker-compose.yml`
- Tests: JUnit 5, Spring Boot Test, MockMvc, spring-security-test, Testcontainers (pgvector image). Unit and slice tests mock the chat model, so no real LLM calls happen in tests.
- Build/test command: `./mvnw test` (Windows: `mvnw.cmd test`) from the repo root
- **Open item:** Docker is not installed on this machine yet. It's needed for docker-compose and Testcontainers.

## Domain decisions

- **Diagnosis input (session 01):** free-text symptoms, used only for that request and never persisted (not in the registry, not in logs).
- **Mortality rate (session 01):** extracted from the uploaded documents only, with a citation for every figure. If no document has a figure, the answer says "not available". The LLM never fills it in from its general knowledge.
- **Registry (session 01):** a search audit log. Each entry holds the doctor id, timestamp, query type (`DISEASE_SEARCH` | `DIAGNOSIS`), disease (for searches) and cited document ids. The symptom text is never stored.
- **Uploads (session 01):** PDF/TXT/MD with metadata (title, disease(s), type `RESEARCH` | `FACT`, source/year). Files are live as soon as they're uploaded (no approval step), and the uploader is recorded.
- **Auth (session 01):** JWT, seeded users, no self-registration. DOCTOR can search, diagnose and upload. ADMIN can also delete documents and view the whole registry.
- **Interface (session 01):** REST API only, no UI.

## Git workflow

- Committing directly to `main`. Remote `origin` is the public GitHub repo https://github.com/deep-patil-coditas/AiEng-MedHelp. Push after each commit.
- Conventional commits: `docs:`, `docs(<module>):`, `test(<module>):`, `feat(<module>):`, `chore:`.
- Never commit `.idea/`, `target/`, `*.iml`, `.env`, API keys or secrets.

## Sessions and conversation logs

- Each working session is numbered (`session-NN-<topic>`). At the end of a session:
  `node tools/export-session.mjs session-NN-<topic>`, then commit `chore(sessions): add session NN conversation log`.
- Session 01: SDD project setup.

## Working with the user

- Ask gap questions one at a time, with exactly 4 options and the recommended one first.
- List conventions you decided without asking, so the user can veto them.
