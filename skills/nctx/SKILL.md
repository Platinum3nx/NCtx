---
name: nctx
description: Initialize, diagnose, and use NCtx project memory in Claude Code.
---

# NCtx

NCtx gives this Claude Code project persistent memory through a hosted Nia-backed service.

## Initialize

When the user asks to enable, set up, initialize, or repair NCtx for the current project, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" init --plugin
```

The `--plugin` flag writes only the project-local `.nctx/config.json` and support directories. Do not manually register hooks or MCP when NCtx is installed as a Claude Code plugin; those are provided by the plugin itself.

## Diagnose

When the user asks whether NCtx is healthy, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" doctor
```

## Recall Memory

Use the `nctx_memory` MCP tool when the user references prior sessions, asks where work left off, or when past decisions, gotchas, project patterns, or current state would help.

Never ask the user for a Nia API key. Hosted NCtx uses an install token stored in `.nctx/config.json`; the enterprise Nia key lives only in the hosted Worker.
