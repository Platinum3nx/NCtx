# NCtx

Persistent Claude Code session memory powered by Nia Context Sharing.

NCtx captures durable session knowledge from Claude Code, stores typed memories in Nia through a hosted Cloudflare Worker, and exposes a local MCP tool (`nctx_memory`) so future Claude Code sessions can recall prior decisions, gotchas, patterns, and current state.

## Status

This repo contains the working beta implementation described in `NCTX_PRD_v4.md`.

Implemented:

- Claude Code `SessionEnd` and `PreCompact` hook registration.
- `NCTX_INTERNAL=1` recursion guard.
- Robust JSONL transcript parsing with tool-output stripping and a compact tool action ledger.
- `CLAUDE.md` dedupe preamble for extraction.
- `claude -p` extraction with feature-detected safe flags.
- Runtime validation for Claude extraction envelopes, so wrapper metadata is not saved as memory.
- UTF-8-safe `CLAUDE.md` byte capping for prompt budgeting.
- Memory splitting into `fact`, `procedural`, and `episodic` Nia contexts.
- Hosted Worker proxy with per-install bearer tokens and tag-based isolation.
- Durable Object per-install daily caps and Cloudflare Rate Limiting binding.
- Local MCP server exposing `nctx_memory`.
- Pending queue for failed context writes.

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
cd /Users/arjunmalghan/NCtx
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

For direct CLI use:

```bash
npm install -g @platinum3nx/nctx
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
node /Users/arjunmalghan/NCtx/dist/cli/index.js init \
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
node /Users/arjunmalghan/NCtx/dist/cli/index.js init \
  --proxy-url https://nctx.amalghan70.workers.dev \
  --package-secret "$PACKAGE_SHARED_SECRET"
```

## What `init` Writes

```text
.nctx/
  config.json
  memories/
  pending/
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

It must not store `install_id`, `shared_secret`, or a Nia API key.

## Commands

```bash
nctx init       # initialize hooks, config, and MCP registration
nctx init --rotate-token # mint a fresh install token instead of reusing config
nctx init --plugin # initialize config only when installed as a Claude Code plugin
nctx capture    # run from Claude Code hook JSON on stdin
nctx mcp        # run local MCP server on stdio
nctx doctor [--no-worker-live] # inspect config, hooks, Claude flags, MCP, and Worker health
nctx list       # list local memory files
nctx view <id> [--json] # show a local memory file
nctx reindex    # drain pending writes and re-push local memory files
nctx uninstall  # remove NCtx hooks and MCP registration
```

If using the repo build directly, replace `nctx` with:

```bash
node /Users/arjunmalghan/NCtx/dist/cli/index.js
```

## Claude Code Hooks

NCtx registers only:

- `SessionEnd`
- `PreCompact`

Both are async and guarded:

```sh
if [ "$NCTX_INTERNAL" = "1" ]; then exit 0; fi; npx -y @platinum3nx/nctx capture --trigger=session-end
```

`Stop` is intentionally not used because it fires after every assistant turn.

Capture has two safety ceilings:

- `NCTX_CAPTURE_STDIN_TIMEOUT_MS` controls how long capture waits for hook JSON on stdin. Default: `10000`.
- `NCTX_TRANSCRIPT_TEXT_MAX_CHARS` caps Claude-bound transcript text while preserving recent text and a compact tool ledger. Default: `80000`.

## Memory Types

Each capture can emit up to three Nia contexts:

| Extracted category | Nia memory type |
|---|---|
| decisions + gotchas | `fact` |
| patterns | `procedural` |
| current state + next steps | `episodic` |

Empty categories produce no placeholder contexts.

Short real memories are expanded only with memory-specific details such as session summary, project, files, and tags so they satisfy Nia content minimums without generic semantic-search filler.

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
