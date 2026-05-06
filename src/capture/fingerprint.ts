import { createHash } from "node:crypto";
import type { ContextDraft } from "../types.js";

/**
 * Compute a stable fingerprint for a context draft.
 * Used to detect near-duplicate memories when PreCompact fires multiple times.
 *
 * Fingerprint is based on: memory_type + sorted heading identifiers with full body content + project tag.
 * Each section includes the full normalized body content to distinguish
 * memories with the same headings but different rationale/content.
 * Episodic memories should still be fingerprinted (caller decides whether to deduplicate).
 */
export function computeDraftFingerprint(draft: ContextDraft): string {
  const parts: string[] = [draft.memory_type];

  // Extract identity signals from content: headings + full body of each section
  const sections = draft.content.split(/^## /m).filter(Boolean);
  for (const section of sections) {
    const [headingLine, ...bodyLines] = section.split("\n");
    const heading = headingLine.replace(/^\w+:\s*/, "").trim().toLowerCase();
    const body = bodyLines.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    parts.push(`${heading}::${body}`);
  }
  parts.sort(); // Sort for stability regardless of section order

  // Include project from tags
  const projectTag = draft.tags.find((t) => t.startsWith("project:"));
  if (projectTag) parts.push(projectTag);

  return createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** Types that are eligible for deduplication. Episodic memories are always pushed. */
export const DEDUP_ELIGIBLE_TYPES: ReadonlySet<ContextDraft["memory_type"]> = new Set([
  "fact",
  "procedural"
]);

/**
 * Given new drafts and a set of already-pushed fingerprints, return the drafts
 * that should be pushed (filtering out duplicates for eligible types).
 */
export function filterDuplicateDrafts(
  drafts: ContextDraft[],
  existingFingerprints: Set<string>
): { toPublish: ContextDraft[]; skipped: Array<{ draft: ContextDraft; fingerprint: string }> } {
  const toPublish: ContextDraft[] = [];
  const skipped: Array<{ draft: ContextDraft; fingerprint: string }> = [];

  for (const draft of drafts) {
    if (!DEDUP_ELIGIBLE_TYPES.has(draft.memory_type)) {
      // Episodic memories always go through
      toPublish.push(draft);
      continue;
    }
    const fp = computeDraftFingerprint(draft);
    if (existingFingerprints.has(fp)) {
      skipped.push({ draft, fingerprint: fp });
    } else {
      toPublish.push(draft);
    }
  }

  return { toPublish, skipped };
}
