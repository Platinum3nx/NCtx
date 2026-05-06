import type { ExtractionResult } from "../types.js";

export const EXTRACTION_SCHEMA = {
  type: "object",
  required: ["summary", "tags", "files_touched", "decisions", "gotchas", "patterns", "state"],
  properties: {
    summary: { type: "string", maxLength: 200 },
    tags: { type: "array", items: { type: "string" } },
    files_touched: { type: "array", items: { type: "string" } },
    decisions: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "rationale"],
        properties: {
          title: { type: "string" },
          rationale: { type: "string" },
          files: { type: "array", items: { type: "string" } }
        }
      }
    },
    gotchas: {
      type: "array",
      items: {
        type: "object",
        required: ["problem", "cause", "fix"],
        properties: {
          problem: { type: "string" },
          cause: { type: "string" },
          fix: { type: "string" },
          files: { type: "array", items: { type: "string" } }
        }
      }
    },
    patterns: {
      type: "array",
      items: {
        type: "object",
        required: ["pattern", "rationale"],
        properties: {
          pattern: { type: "string" },
          rationale: { type: "string" },
          files: { type: "array", items: { type: "string" } }
        }
      }
    },
    state: {
      type: "object",
      properties: {
        in_progress: { type: ["string", "null"] },
        next_steps: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } }
      }
    }
  }
} satisfies Record<string, unknown>;

export function buildExtractionPrompt(input: string | { transcriptText: string; claudeMd?: string; priorCaptures?: string[] }, claudeMdArg = ""): string {
  const transcript = typeof input === "string" ? input : input.transcriptText;
  const claudeMd = typeof input === "string" ? claudeMdArg : input.claudeMd ?? "";
  const priorCaptures = typeof input === "string" ? [] : input.priorCaptures ?? [];

  const priorCapturesSection = priorCaptures.length > 0
    ? `\nPreviously captured from this same session (do not re-extract these):\n${priorCaptures.slice(0, 5).map(s => `- ${s}`).join("\n")}\n`
    : "";

  return `You are analyzing a Claude Code session to extract durable knowledge that should
survive into future sessions on this project.

Existing project memory from CLAUDE.md is provided below. Do not duplicate this
content verbatim in the extracted memories. Only extract new, session-derived
knowledge or project-specific refinements not already captured there.

<CLAUDE_MD>
${claudeMd}
</CLAUDE_MD>
${priorCapturesSection}
The transcript below contains user messages and assistant responses. Tool
outputs have been omitted. A compact tool action ledger is included at the end
so you can cite files touched without seeing their full contents.

Extract ONLY things a future session on this same codebase would benefit from
knowing. Skip generic AI advice.

Categories to extract:
- DECISIONS: Architectural or design choices made, with rationale
- GOTCHAS: Bugs encountered, root causes, fixes
- PATTERNS: Conventions established, code patterns adopted
- STATE: Current work-in-progress and immediate next steps

Rules:
- Empty arrays are fine - only include real durable knowledge.
- Prefer specificity ("we use Zod for runtime validation of API payloads")
  over generality ("we validate things").
- Cite filenames where applicable.
- Do not copy sentences from CLAUDE.md into the output.
- If the session was purely exploratory with no durable outcomes, return all
  empty arrays and a summary noting the exploration.

Output ONLY valid JSON matching the provided schema.

Transcript:
${transcript}`;
}

export function emptyExtraction(summary = "No durable session memory extracted."): ExtractionResult {
  return {
    summary,
    tags: [],
    files_touched: [],
    decisions: [],
    gotchas: [],
    patterns: [],
    state: {
      in_progress: null,
      next_steps: [],
      files: []
    }
  };
}
