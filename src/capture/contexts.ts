import type { ContextDraft, ExtractionResult, HookInput, MemoryType, ToolAction, Trigger } from "../types.js";

type BuildOptions = {
  captureId: string;
  projectName: string;
  sessionId: string;
  trigger: Trigger;
  hookInput?: Partial<HookInput>;
  toolActions?: ToolAction[];
  nctxVersion: string;
};

type BuildContextDraftsInput = Omit<BuildOptions, "nctxVersion"> & {
  extraction: ExtractionResult;
  nctxVersion?: string;
  sessionEndReason?: string;
};

const AGENT_SOURCE = "nctx-claude-code";
const MIN_NIA_CONTENT_CHARS = 50;

export function buildContextDrafts(extraction: ExtractionResult, options: BuildOptions): ContextDraft[];
export function buildContextDrafts(input: BuildContextDraftsInput): ContextDraft[];
export function buildContextDrafts(
  extractionOrInput: ExtractionResult | BuildContextDraftsInput,
  maybeOptions?: BuildOptions
): ContextDraft[] {
  const hasInlineExtraction = "extraction" in extractionOrInput;
  const extraction = hasInlineExtraction ? extractionOrInput.extraction : extractionOrInput;
  const options = (hasInlineExtraction ? extractionOrInput : maybeOptions) as BuildContextDraftsInput & BuildOptions;
  if (!options) throw new Error("buildContextDrafts requires options.");
  const tags = normalizeTags([
    ...(extraction.tags ?? []),
    `project:${options.projectName}`,
    options.trigger,
    "nctx"
  ]);
  const metadata = {
    nctx_version: options.nctxVersion ?? "0.1.0",
    session_id: options.sessionId,
    project_name: options.projectName,
    trigger: options.trigger,
    session_end_reason: options.hookInput?.reason ?? options.sessionEndReason,
    capture_id: options.captureId,
    files_touched: extraction.files_touched
  };
  const editedFiles = filesFromExtraction(extraction, options.toolActions ?? []);
  const drafts: ContextDraft[] = [];

  const factContent = renderFactContent(extraction, options);
  if (factContent) {
    drafts.push({
      title: titleFor(extraction.summary, "decisions and gotchas"),
      summary: summaryFor(extraction.summary, "Session decisions and gotchas"),
      content: factContent,
      tags: normalizeTags([...tags, "decisions", "gotchas"]),
      agent_source: AGENT_SOURCE,
      memory_type: "fact",
      metadata,
      edited_files: editedFiles
    });
  }

  const proceduralContent = renderProceduralContent(extraction, options);
  if (proceduralContent) {
    drafts.push({
      title: titleFor(extraction.summary, "patterns"),
      summary: summaryFor(extraction.summary, "Session-derived project patterns"),
      content: proceduralContent,
      tags: normalizeTags([...tags, "patterns"]),
      agent_source: AGENT_SOURCE,
      memory_type: "procedural",
      metadata,
      edited_files: editedFiles
    });
  }

  const episodicContent = renderEpisodicContent(extraction, options);
  if (episodicContent) {
    drafts.push({
      title: titleFor(extraction.summary, "current state"),
      summary: summaryFor(extraction.summary, "Current work-in-progress and next steps"),
      content: episodicContent,
      tags: normalizeTags([...tags, "state", "next-steps"]),
      agent_source: AGENT_SOURCE,
      memory_type: "episodic",
      metadata,
      edited_files: editedFiles
    });
  }

  return drafts;
}

export function memoryTypeFromDraft(draft: ContextDraft): Exclude<MemoryType, "scratchpad"> {
  return draft.memory_type;
}

function renderFactContent(extraction: ExtractionResult, options: BuildOptions): string {
  const parts: string[] = [];
  for (const decision of extraction.decisions) {
    parts.push(`## Decision: ${decision.title}\n\n${decision.rationale}${filesLine(decision.files)}`);
  }
  for (const gotcha of extraction.gotchas) {
    parts.push(`## Gotcha: ${gotcha.problem}\n\nCause: ${gotcha.cause}\n\nFix: ${gotcha.fix}${filesLine(gotcha.files)}`);
  }
  return ensureMinimumContent(parts.join("\n\n"), semanticDetails(extraction, options, "decisions and gotchas"));
}

function renderProceduralContent(extraction: ExtractionResult, options: BuildOptions): string {
  return ensureMinimumContent(
    extraction.patterns
      .map((pattern) => `## Pattern: ${pattern.pattern}\n\nRationale: ${pattern.rationale}${filesLine(pattern.files)}`)
      .join("\n\n"),
    semanticDetails(extraction, options, "project patterns")
  );
}

function renderEpisodicContent(extraction: ExtractionResult, options: BuildOptions): string {
  const parts: string[] = [];
  if (extraction.state.in_progress) parts.push(`In progress: ${extraction.state.in_progress}`);
  if (extraction.state.next_steps?.length) {
    parts.push(["Next steps:", ...extraction.state.next_steps.map((step) => `- ${step}`)].join("\n"));
  }
  if (extraction.state.files?.length) parts.push(`Files:\n${extraction.state.files.map((file) => `- ${file}`).join("\n")}`);
  return ensureMinimumContent(
    parts.length ? `## State\n\n${parts.join("\n\n")}` : "",
    semanticDetails(extraction, options, "current state and next steps")
  );
}

function ensureMinimumContent(content: string, details: string[]): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (trimmed.length >= MIN_NIA_CONTENT_CHARS) return trimmed;
  return [trimmed, ...details.filter((detail) => !trimmed.includes(detail))]
    .join("\n\n")
    .trim();
}

function semanticDetails(extraction: ExtractionResult, options: BuildOptions, focus: string): string[] {
  const details = [
    extraction.summary.trim() ? `Session summary: ${extraction.summary.trim()}` : "",
    `Project: ${options.projectName}`,
    `Memory focus: ${focus}`
  ];
  const files = [...new Set([...extraction.files_touched, ...(extraction.state.files ?? [])].filter(Boolean))];
  if (files.length) details.push(`Related files: ${files.join(", ")}`);
  const tags = normalizeTags(extraction.tags ?? []);
  if (tags.length) details.push(`Tags: ${tags.join(", ")}`);
  return details.filter(Boolean);
}

function filesLine(files?: string[]): string {
  const clean = [...new Set((files ?? []).filter(Boolean))];
  return clean.length ? `\n\nFiles: ${clean.map((file) => `\`${file}\``).join(", ")}` : "";
}

function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter(Boolean)
        .filter((tag) => !tag.startsWith("install:"))
    )
  ].slice(0, 30);
}

function titleFor(summary: string, suffix: string): string {
  const base = summary.trim() || "NCtx session memory";
  const title = `${base} - ${suffix}`;
  return title.length > 200 ? title.slice(0, 197).trimEnd() + "..." : title;
}

function summaryFor(summary: string, fallback: string): string {
  const value = summary.trim() || fallback;
  return value.length >= 10 ? value.slice(0, 1000) : fallback;
}

function filesFromExtraction(extraction: ExtractionResult, toolActions: ToolAction[]): ContextDraft["edited_files"] {
  const edited = new Set<string>();
  for (const action of toolActions) {
    if (action.operation === "edit" && action.file_path) edited.add(action.file_path);
  }
  for (const file of extraction.files_touched) edited.add(file);
  return [...edited].map((file_path) => ({
    file_path,
    operation: "edited",
    changes_description: "Touched during the captured Claude Code session."
  }));
}
