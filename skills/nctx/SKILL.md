---
name: nctx
description: Initialize, diagnose, and use NCtx project memory in Claude Code.
---

# NCtx

NCtx gives this Claude Code project persistent memory by saving directly to the user's Nia account.

## Initialize

When the user asks to enable, set up, initialize, or repair NCtx for the current project, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" init --plugin
```

Run it with the existing `NIA_API_KEY` environment variable when it is available. If it is missing, ask the user to provide their own Nia API key through `NIA_API_KEY` or rerun init with `--nia-api-key`; NCtx normal plugin use is BYOK direct Nia mode.

The `--plugin` flag writes only the project-local `.nctx/config.json` and support directories. Do not manually register hooks or MCP when NCtx is installed as a Claude Code plugin; those are provided by the plugin itself.

## Diagnose

When the user asks whether NCtx is healthy, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" doctor
```

## Recall Memory

Use the `nctx_memory` MCP tool proactively for nontrivial work when resuming a task, touching unfamiliar files, debugging a previously seen failure, or before making architecture/design decisions. Prefer focused queries tied to the current task. Do not call for tiny one-off edits where prior context is unlikely to matter.

Do not initialize hosted Worker mode for normal plugin use. If an old project has `.nctx/pending/` files from the hosted beta, run `reindex` after BYOK init so those local pending drafts are saved into the user's Nia account.
