# NCtx

Persistent Claude Code session memory powered by Nia Context Sharing.

NCtx captures durable session knowledge from Claude Code, stores typed memories in Nia through a hosted Cloudflare Worker, and exposes a local MCP tool (`nctx_memory`) so future Claude Code sessions can recall prior decisions, gotchas, patterns, and current state.

## Status

This repo contains the working beta implementation described in `NCTX_PRD_v4.md`, plus the hardening work tracked in `betaIssues.md` and `betaImprovements.md`.

Current repo and npm package version: `0.1.3`.

Implemented:

- Claude Code `SessionEnd` and `PreCompact` hook registration.
- `NCTX_INTERNAL=1` recursion guard.
- Fast detached `SessionEnd` capture handoff for Claude Code plugin hook budgets.
- Self-contained bundled CLI artifact for Claude Code plugin installs.
- Robust JSONL transcript parsing with tool-output stripping and a compact tool action ledger.
- `CLAUDE.md` dedupe preamble for extraction.
- `claude -p` extraction with feature-detected safe flags.
- Runtime validation for Claude extraction envelopes, so wrapper metadata is not saved as memory.
- UTF-8-safe `CLAUDE.md` byte capping for prompt budgeting.
- Memory splitting into `fact`, `procedural`, and `episodic` Nia contexts.
- Durable-evidence dedupe, so orphaned local captures do not block retry extraction.
- Pending write durability: pending files are marked saved and removed only after local context-id backfill.
- Hosted Worker proxy with per-install bearer tokens and tag-based isolation.
- Worker semantic retrieval post-filtering plus safe text-search supplement/fallback paths.
- Durable Object per-install daily caps and Cloudflare Rate Limiting binding.
- Local MCP server exposing `nctx_memory`.
- Sanitized MCP metadata and remote error details.
- Local `nctx status` and `nctx doctor` diagnostics.

Launch readiness notes as of May 6, 2026:

- `@platinum3nx/nctx@0.1.3` is published on npm and matches the marketplace manifest.
- Complete Worker deployment and fresh-install smoke tests before public launch posting.

## Hosted Beta Model

The beta is hosted-only. Users do not need a Nia account or Nia key.

Flow:

1. `nctx init` registers an install with the NCtx Worker.
2. The Worker mints a high-entropy `install_token` and a server-side `install_id`.
3. The CLI stores only `install_token` in `.nctx/config.json`.
4. Saves/searches go through the Worker with `Authorization: Bearer <install_token>`.
5. The Worker injects `install:<install_id>` tags and the enterprise Nia key.

The Worker stores no user content. It stores only token-hash to install-id mappings in KV and request counters in Durable Objects.

If an `install_token` leaks, only that one install's memories are exposed. Other installs and the enterprise Nia account remain isolated.

## Install From This Repo

```bash
git clone https://github.com/Platinum3nx/NCtx.git
cd NCtx
npm install
npm run build
```

## Install As A Claude Code Plugin

For most users:

```bash
claude plugin marketplace add Platinum3nx/NCtx
claude plugin install nctx@nctx-marketplace
```

This installs the plugin from the public marketplace manifest in this GitHub repo. The plugin itself is distributed through npm as `@platinum3nx/nctx`.

Verify npm publication with:

```bash
npm view @platinum3nx/nctx versions --json
```

For direct CLI use from npm:

```bash
npm install -g @platinum3nx/nctx@0.1.3
nctx init
```

For local plugin development from this checkout:

```bash
claude plugin validate .
```

Once the plugin is installed in a project, initialize NCtx project state:

```bash
/nctx
```

or run the plugin CLI directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" init --plugin
```

Plugin mode writes `.nctx/config.json` only. Hooks and MCP are supplied by the plugin package.

Initialize a project against the deployed beta Worker:

```bash
cd /path/to/your/project
node /path/to/NCtx/dist/cli/index.js init \
  --proxy-url https://nctx.amalghan70.workers.dev \
  --package-secret "$PACKAGE_SHARED_SECRET"
```

For local development, load secrets first:

```bash
set -a
source "$HOME/.config/nctx/build-secrets.env"
set +a
```

Then initialize:

```bash
node /path/to/NCtx/dist/cli/index.js init \
  --proxy-url https://nctx.amalghan70.workers.dev \
  --package-secret "$PACKAGE_SHARED_SECRET"
```

## What `init` Writes

```text
.nctx/
  config.json
  memories/
  pending/
  spool/
  sessions/
  errors.log
.claude/settings.json
```

`.nctx/config.json` stores:

```json
{
  "mode": "hosted",
  "install_token": "nctx_it_...",
  "proxy_url": "https://nctx.amalghan70.workers.dev",
  "project_name": "your-project",
  "version": "0.1.0"
}
```

`version` is the current config schema marker, not the npm package version. It must not store `install_id`, `shared_secret`, or a Nia API key.

## Commands

```bash
nctx init       # initialize hooks, config, and MCP registration
nctx init --rotate-token # mint a fresh install token instead of reusing config
nctx init --plugin # initialize config only when installed as a Claude Code plugin
nctx capture    # run from Claude Code hook JSON on stdin
nctx capture --trigger=session-end --detach # fast SessionEnd handoff used by hooks
nctx capture --from-spool <path> # internal detached capture worker entrypoint
nctx mcp        # run local MCP server on stdio
nctx doctor [--no-worker-live] # inspect config, hooks, Claude flags, MCP, and Worker health
nctx doctor --claude-flags # inspect only locally supported claude -p flags
nctx status     # show capture status, pending queue, pushed contexts, and config permissions
nctx list       # list local memory files
nctx view <id> [--json] # show a local memory file
nctx reindex    # drain pending writes and re-push local memory files
nctx uninstall [--remove-data] # remove NCtx hooks and MCP registration
```

If using the repo build directly, replace `nctx` with:

```bash
node /path/to/NCtx/dist/cli/index.js
```

## Claude Code Hooks

NCtx registers only:

- `SessionEnd`
- `PreCompact`

Standalone `nctx init` writes guarded hooks to `.claude/settings.json`. `SessionEnd` uses a fast synchronous handoff, and `PreCompact` remains async:

```sh
if [ "$NCTX_INTERNAL" = "1" ]; then exit 0; fi; npx -y @platinum3nx/nctx capture --trigger=session-end --detach
```

The packaged plugin supplies equivalent guarded hooks from `hooks/hooks.json`:

```sh
if [ "$NCTX_INTERNAL" = "1" ]; then exit 0; fi; node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" capture --trigger=session-end --detach
```

`Stop` is intentionally not used because it fires after every assistant turn.

Capture has two safety ceilings:

- `NCTX_CAPTURE_STDIN_TIMEOUT_MS` controls how long capture waits for hook JSON on stdin. Default: `10000`.
- `NCTX_DETACH_STDIN_TIMEOUT_MS` controls how long detached handoff waits for hook JSON on stdin before spooling. Default: `1000`.
- `NCTX_TRANSCRIPT_TEXT_MAX_CHARS` caps Claude-bound transcript text while preserving recent text and a compact tool ledger. Default: `80000`.

Detached `SessionEnd` capture writes a 0600 spool file under `.nctx/spool/`, spawns a background worker, exits quickly, and removes the spool file after successful processing.

## Memory Types

Each capture can emit up to three Nia contexts:

| Extracted category | Nia memory type |
|---|---|
| decisions + gotchas | `fact` |
| patterns | `procedural` |
| current state + next steps | `episodic` |

Empty categories produce no placeholder contexts.

Short real memories are expanded only with memory-specific details such as session summary, project, files, and tags so they satisfy Nia content minimums without generic semantic-search filler.

## Capture Durability

Capture is designed so a local file alone does not falsely prove that memory reached Nia:

- The session cursor advances only after extracted drafts are saved or queued.
- Same-session dedupe and prior-capture summaries use only durable evidence: `context_ids` in local memory frontmatter or matching files in `.nctx/pending/`.
- Pending drains mark files with `saved_context_id` and `saved_at`; callers remove them only after backfilling the local memory file.
- `nctx reindex` drains pending writes, backfills context IDs, and re-queues local memories that still lack durable evidence.
- `nctx init` mints a fresh token when the configured proxy URL changes, even without `--rotate-token`.

## Retrieval And Isolation

All hosted saves and searches go through the Worker:

- Saves always receive a server-side `install:<install_id>` tag, forced `agent_source: "nctx-claude-code"`, and `metadata.install_id`.
- Spoofed `install:*` tags and spoofed `agent_source` values from clients are rewritten.
- Text search is upstream-filtered by install tag and then project-filtered defensively.
- Semantic search over-fetches, post-filters by install tag/project/agent source, and supplements with text search when it returns fewer results than requested.
- If semantic search fails or returns non-JSON, the Worker attempts text fallback before reporting an upstream error.
- MCP output sanitizes metadata and remote error strings before returning them as Claude-facing tool text.

## Development Checks

```bash
npm run typecheck
npm test
npm run build
npm --prefix worker run typecheck
npm --prefix worker test
npm --prefix worker run deploy:dry
```

Live checks already validated:

- Cloudflare Worker deployed at `https://nctx.amalghan70.workers.dev`.
- Cross-install text search isolation.
- Cross-install semantic search isolation.
- Spoofed `install:*` tags and `agent_source` are rewritten.
- `GET /contexts` returns `404`.
- Real `claude -p` capture writes local memory and saves typed Nia contexts.
- MCP stdio server lists `nctx_memory` and retrieves live Worker-scoped memories.
