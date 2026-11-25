# CatsApi Gateway — Cloudflare Worker (LIVE implementation)

This directory is the **canonical live source** of `https://api.prjktspace.web.id`
since 2026-11-19. The Node gateway in `../gateway/` (`server.mjs`) is the retired
VM/tunnel implementation, kept for reference only — it no longer serves traffic
and still documents the retired `personal_sign` claim path.

- `src/index.js` — the Worker (NFT-gated API keys, EIP-712-only claims,
  per-tier monthly quotas in KV, OpenAI-compatible chat proxy).
- `src/templates.js` — landing + owner dashboard HTML.
- `src/tiermap.js` — packed tier map generated from `../gateway/config/tier-map.json`.
- `wrangler.toml` — Worker config (KV binding `DB`, public vars only).

Secrets are Worker secrets, never in this repo: `UPSTREAM_API_KEY`,
`AGENT_ADMIN_TOKEN` (rotated 2026-11-25).

Deploy (from the operator host, Cloudflare credentials via env):

```bash
wrangler deploy   # in this directory
```

Hardening state (2026-11-25, security review batches 1–3): slim `/health`,
413 on oversized bodies, security headers on all responses, admin per-IP
failure rate limit (10/60s → 429), timing-safe admin token compare,
bounded caches, KV usage pruning (current + 3 months), Cloudflare
rate-limit rule on `/v1/holder/*`.
