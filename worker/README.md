# NCtx Worker

Cloudflare Worker proxy for the legacy NCtx hosted beta.

Normal NCtx plugin use is now BYOK direct Nia mode and does not call this Worker. Keep this package only for legacy hosted-beta installs, migration testing, and isolation regression coverage.

The Worker owns:

- Install token minting.
- Token-hash to install-id lookup in KV.
- Bearer token auth for all context/search routes.
- Server-side install tag injection.
- Forced `agent_source: "nctx-claude-code"`.
- `metadata.install_id` audit field injection.
- Text-search `tags=install:<install_id>` rewriting.
- Semantic-search over-fetch and post-filtering by install tag and agent source.
- Durable Object daily counters.
- Cloudflare Rate Limiting binding for short-window abuse control.

It does not store user content. It does store token-hash to install-id mappings for legacy hosted installs.

## Setup

From repo root:

```bash
set -a
source "$HOME/.config/nctx/build-secrets.env"
set +a
```

Create KV:

```bash
npx wrangler kv namespace create INSTALLS
```

Copy the returned namespace ID into `worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "INSTALLS"
id = "..."
```

Set secrets:

```bash
cd worker
printf '%s' "$NIA_API_KEY" | npx wrangler secret put NIA_API_KEY
printf '%s' "$PACKAGE_SHARED_SECRET" | npx wrangler secret put PACKAGE_SHARED_SECRET
```

Deploy:

```bash
npx wrangler deploy
```

Current beta deployment:

```text
https://nctx.amalghan70.workers.dev
```

## Verify

```bash
npm run typecheck
npm test
npm run deploy:dry
```

Live isolation smoke:

```bash
WORKER=https://nctx.amalghan70.workers.dev

A=$(curl -sS -X POST "$WORKER/installs" \
  -H "x-nctx-package-secret: $PACKAGE_SHARED_SECRET" | jq -r .install_token)

B=$(curl -sS -X POST "$WORKER/installs" \
  -H "x-nctx-package-secret: $PACKAGE_SHARED_SECRET" | jq -r .install_token)

curl -X POST "$WORKER/contexts" \
  -H "Authorization: Bearer $A" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Worker isolation test",
    "summary": "Worker isolation test memory",
    "content": "This is a Worker isolation test body long enough for Nia validation.",
    "agent_source": "malicious-agent",
    "tags": ["project:nctx-live", "install:attacker-controlled"],
    "memory_type": "fact"
  }'

curl -G "$WORKER/contexts/search" \
  -H "Authorization: Bearer $A" \
  --data-urlencode "q=Worker isolation test"

curl -G "$WORKER/contexts/search" \
  -H "Authorization: Bearer $B" \
  --data-urlencode "q=Worker isolation test"
```

Install A should find the memory. Install B should not.
