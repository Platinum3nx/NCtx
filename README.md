# NCtx

Persistent Claude Code session memory powered by Nia Context Sharing.

NCtx captures durable session knowledge from Claude Code, stores typed memories directly in the user's Nia account, and exposes a local MCP tool (`nctx_memory`) so future Claude Code sessions can recall prior decisions, gotchas, patterns, and current state.

## Status

This repo contains the working beta implementation described in `NCTX_PRD_v4.md`, plus the hardening work tracked in `betaIssues.md` and `betaImprovements.md`.

Current repo and npm package version: `0.1.4`.

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
- BYOK direct Nia mode for normal plugin and CLI use.
- Project-scoped retrieval through `project:<name>` tags.
- Legacy hosted Worker compatibility for installs that have not migrated yet.
- Local MCP server exposing `nctx_memory`.
- Sanitized MCP metadata and remote error details.
- Local `nctx status` and `nctx doctor` diagnostics.

Launch readiness notes as of May 8, 2026:

- `@platinum3nx/nctx@0.1.4` is published on npm and matches the marketplace manifest.
- BYOK direct Nia mode is the normal install path.
- The hosted Worker remains available only as a legacy migration path.

## BYOK Direct Nia Model

Users provide their own Nia API key. NCtx stores and searches memories directly against Nia from the local CLI and MCP server; the hosted Worker is not used for normal plugin operation.

Flow:

1. The user creates or copies a Nia API key from their Nia account.
2. Project init (`nctx init --plugin` for plugin users, or `nctx init` for standalone CLI users) writes a project-local `.nctx/config.json`.
3. The config stores the user's Nia API key with owner-only file permissions.
4. Saves/searches call the Nia API directly with `Authorization: Bearer <NIA_API_KEY>`.
5. NCtx scopes saved and retrieved memories with `project:<project-name>` tags.

The hosted Worker no longer holds the enterprise Nia key for normal users. Existing hosted installs can migrate by re-running init with their own Nia key.

Treat `.nctx/config.json` as a secret because it contains the user's Nia API key. NCtx writes it as `0600`, adds `.nctx/` to `.gitignore`, and rejects direct-mode configs that still contain hosted Worker credentials.

## Quick Start

Prerequisites:

- Claude Code with plugin support.
- Node.js `>=20.18.0` for `npx`.
- A Nia API key.

Install the Claude Code plugin once per machine/user:

```bash
claude plugin marketplace add Platinum3nx/NCtx
claude plugin install nctx@nctx-marketplace
```

Initialize NCtx once per project:

```bash
cd /path/to/your/project
NIA_API_KEY="nia_..." npx -y @platinum3nx/nctx@0.1.4 init --plugin
```

You can also pass the key explicitly with `--nia-api-key`, but using `NIA_API_KEY` keeps it out of shell history more easily.

The plugin install does not need to put a global `nctx` command on your shell `PATH`; the `npx` command above is the intended project init path.

Then use Claude Code normally:

```bash
claude
```

NCtx runs automatically through the plugin hooks and `nctx_memory` MCP server. It captures durable project memory on `PreCompact` and `SessionEnd`, stores it directly in Nia, and makes it available to future Claude Code sessions through the `nctx_memory` tool.

Verify the installed plugin version:

```bash
claude plugin list
```

You should see `nctx@nctx-marketplace` at version `0.1.4`.

If you previously installed `0.1.2` and Claude Code keeps reusing a stale cache:

```bash
claude plugin uninstall nctx@nctx-marketplace
rm -rf ~/.claude/plugins/npm-cache/node_modules/@platinum3nx/nctx
rm -rf ~/.claude/plugins/cache/nctx-marketplace/nctx/0.1.2
claude plugin marketplace update nctx-marketplace
claude plugin install nctx@nctx-marketplace
claude plugin list
```

## Install From This Repo

```bash
git clone https://github.com/Platinum3nx/NCtx.git
cd NCtx
npm install
npm run build
```

## Claude Code Plugin Details

The public marketplace manifest lives in `.claude-plugin/marketplace.json`. The plugin itself is distributed through npm as `@platinum3nx/nctx`.

To refresh the marketplace later:

```bash
claude plugin marketplace update nctx-marketplace
```

Verify npm publication with:

```bash
npm view @platinum3nx/nctx versions --json
```

For local plugin development from this checkout:

```bash
claude plugin validate .
```

## Direct CLI Use

The plugin flow above is recommended. If you want a global `nctx` command for standalone CLI use:

```bash
npm install -g @platinum3nx/nctx@0.1.4
NIA_API_KEY="nia_..." nctx init
```

If you do not install globally, prefix commands with `npx`. For plugin-mode project init:

```bash
NIA_API_KEY="nia_..." npx -y @platinum3nx/nctx@0.1.4 init --plugin
```

For standalone project init without the Claude Code plugin:

```bash
NIA_API_KEY="nia_..." npx -y @platinum3nx/nctx@0.1.4 init
```

`nctx init --plugin` writes `.nctx/config.json` only. Hooks and MCP are supplied by the Claude Code plugin package. Plain `nctx init` is for standalone CLI mode and writes project `.claude/settings.json` hooks plus MCP registration.

## Hosted Migration

Older beta installs may have a hosted config with `mode: "hosted"`, an `install_token`, and a `proxy_url`. To migrate the project to BYOK direct Nia:

```bash
cd /path/to/your/project
NIA_API_KEY="nia_..." npx -y @platinum3nx/nctx@0.1.4 init --plugin
npx -y @platinum3nx/nctx@0.1.4 reindex
```

Migration preserves local `.nctx/memories/`, `.nctx/pending/`, `.nctx/spool/`, and `.nctx/sessions/` files. `init` rewrites `.nctx/config.json` into direct mode and removes hosted Worker credentials. `reindex` drains the pending queue and pushes any local memories that do not yet have Nia `context_ids` into the user's own Nia account.

Memories that exist only in the old hosted Nia account are not copied automatically. Only local memory files and pending drafts can be migrated. After successful migration, old pending files are removed only after NCtx backfills the returned direct Nia context IDs into the local memory frontmatter.

## Legacy Worker Development

Normal users should not use a Worker. The current CLI initializes direct BYOK mode only. The `worker/` package remains in this repo for legacy hosted-beta migration testing and isolation regression coverage.

If you keep development secrets locally, load them first:

```bash
set -a
source "$HOME/.config/nctx/build-secrets.env"
set +a
```

Then initialize:

```bash
NIA_API_KEY="$NIA_API_KEY" node /path/to/NCtx/dist/cli/index.js init --plugin
```

## Smoke Test

After installing and initializing in a project:

```bash
claude
```

Ask Claude Code to make a concrete project decision or edit, then exit with `/exit`. Wait a few seconds, then run:

```bash
find .nctx -maxdepth 3 -type f
npx -y @platinum3nx/nctx@0.1.4 status
```

Expected signs of life:

- `.nctx/config.json` exists.
- `.nctx/sessions/<session-id>.pos` exists after `/exit`.
- Higher-signal sessions produce `.nctx/memories/*.md` and pushed context counts.

Low-signal sessions may only advance the cursor and skip memory creation; that is expected.

## What `init` Writes

Plugin mode (`nctx init --plugin`) creates `.nctx/config.json` and the working directories NCtx uses under `.nctx/`:

```text
.nctx/
  config.json
  memories/
  pending/
  spool/
  sessions/
  errors.log   # created only when errors are logged
```

Standalone mode (`nctx init`) also writes Claude Code hook configuration and MCP registration for the project. In plugin mode, hooks and MCP are provided by the installed Claude Code plugin, so `.claude/settings.json` is not required.

Both modes add `.nctx/` to `.gitignore` when it is not already ignored.

`.nctx/config.json` stores:

```json
{
  "mode": "direct",
  "nia_api_key": "nia_...",
  "nia_base_url": "https://apigcp.trynia.ai/v2",
  "project_name": "your-project",
  "version": "0.2.0"
}
```

`version` is the current config schema marker, not the npm package version. Direct configs must not store `install_token`, `proxy_url`, `install_id`, or `shared_secret`.

## Commands

The examples below assume a global install. Without one, replace `nctx` with `npx -y @platinum3nx/nctx@0.1.4`.

```bash
nctx init       # standalone: initialize config, hooks, and MCP registration
nctx init --nia-api-key "$NIA_API_KEY" # standalone direct BYOK init
nctx init --plugin # plugin mode: initialize project config only
nctx capture    # run from Claude Code hook JSON on stdin
nctx capture --trigger=session-end --detach # fast SessionEnd handoff used by hooks
nctx capture --from-spool <path> # internal detached capture worker entrypoint
nctx mcp        # run local MCP server on stdio
nctx doctor # inspect config, hooks, Claude flags, MCP, and direct Nia reachability
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
- Hosted-to-direct migration keeps pending files in place until they are saved to the user's Nia account and backfilled locally.

## Retrieval And Isolation

Direct saves and searches go to Nia from the local CLI/MCP process:

- Saves receive `agent_source: "nctx-claude-code"` and `project:<project-name>` tags.
- Legacy hosted `install:*` tags and `metadata.install_id` are stripped during direct saves/reindex.
- Retrieval is scoped to the configured project and does not use hosted Worker install tokens.
- Semantic and text search normalize current and legacy Nia response shapes before MCP formatting.
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

Live checks should validate:

- Fresh BYOK plugin init writes direct `.nctx/config.json` with owner-only permissions.
- Real `claude -p` capture writes local memory and saves typed Nia contexts directly.
- `nctx reindex` drains any pending hosted-beta queue into the user's Nia account.
- MCP stdio server lists `nctx_memory` and retrieves project-scoped direct Nia memories.
