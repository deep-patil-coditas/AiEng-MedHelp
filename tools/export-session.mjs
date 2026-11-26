#!/usr/bin/env node
// Export a Claude Code session transcript (JSONL) to a readable conversation.txt.
//
// Usage (run from the repo root):
//   node tools/export-session.mjs <session-folder-name> [--session <session-id>]
//
// Example:
//   node tools/export-session.mjs session-01-project-setup
//   -> writes sessions/session-01-project-setup/conversation.txt
//
// Without --session, the most recently modified transcript for this project is used
// (i.e. the session you are currently in).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_TOOL_RESULT_CHARS = 2000;
const MAX_TOOL_INPUT_CHARS = 1500;

function parseArgs(argv) {
  const args = { folder: null, session: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") args.session = argv[++i];
    else if (!args.folder) args.folder = argv[i];
  }
  if (!args.folder) {
    console.error("Usage: node tools/export-session.mjs <session-folder-name> [--session <id>]");
    process.exit(1);
  }
  return args;
}

function projectTranscriptDir(repoRoot) {
  // Claude Code stores transcripts under ~/.claude/projects/<cwd with every non-alphanumeric char replaced by '-'>
  const slug = repoRoot.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug);
}

function pickTranscript(dir, sessionId) {
  if (sessionId) return path.join(dir, `${sessionId}.jsonl`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error(`No transcripts found in ${dir}`);
  return path.join(dir, files[0].f);
}

function stripSystemNoise(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<pasted_content[^>]*>/g, "<pasted>")
    .replace(/<\/pasted_content[^>]*>/g, "</pasted>")
    .trim();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} chars]` : s;
}

function blockToText(block) {
  if (typeof block === "string") return block;
  if (Array.isArray(block)) return block.map(blockToText).join("\n");
  if (block?.type === "text") return block.text ?? "";
  return "";
}

function render(entry) {
  const msg = entry.message;
  if (!msg || entry.isMeta) return null;
  const role = entry.type; // "user" | "assistant"
  const content = msg.content;
  const out = [];

  if (typeof content === "string") {
    const t = stripSystemNoise(content);
    if (t) out.push(`${role.toUpperCase()}:\n${t}`);
    return out.join("\n\n") || null;
  }

  for (const block of content ?? []) {
    switch (block.type) {
      case "text": {
        const t = stripSystemNoise(block.text ?? "");
        if (t) out.push(`${role.toUpperCase()}:\n${t}`);
        break;
      }
      case "tool_use":
        out.push(`[TOOL CALL: ${block.name}]\n${truncate(JSON.stringify(block.input, null, 2), MAX_TOOL_INPUT_CHARS)}`);
        break;
      case "tool_result": {
        const t = stripSystemNoise(blockToText(block.content));
        out.push(`[TOOL RESULT${block.is_error ? " (error)" : ""}]\n${truncate(t, MAX_TOOL_RESULT_CHARS)}`);
        break;
      }
      default:
        break; // thinking, images, etc. are omitted
    }
  }
  return out.length ? out.join("\n\n") : null;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const transcript = pickTranscript(projectTranscriptDir(repoRoot), args.session);

const lines = fs.readFileSync(transcript, "utf8").split(/\r?\n/).filter(Boolean);
const sections = [];
let first = null;
for (const line of lines) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.type !== "user" && entry.type !== "assistant") continue;
  if (entry.isSidechain) continue;
  first ??= entry;
  const text = render(entry);
  if (text) sections.push(text);
}

const header = [
  `Session folder : ${args.folder}`,
  `Session id     : ${path.basename(transcript, ".jsonl")}`,
  `Started        : ${first?.timestamp ?? "unknown"}`,
  `Exported       : ${new Date().toISOString()}`,
  "=".repeat(80),
].join("\n");

const outDir = path.join(repoRoot, "sessions", args.folder);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "conversation.txt");
fs.writeFileSync(outFile, header + "\n\n" + sections.join("\n\n" + "-".repeat(80) + "\n\n") + "\n", "utf8");
console.log(`Wrote ${outFile} (${sections.length} messages)`);
