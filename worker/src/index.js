// CatsApi Gateway — Cloudflare Worker port of the VM gateway (server.mjs).
// Same behavior: wallet-signed key issuance gated by CatsApi NFT ownership on
// BSC, per-tier monthly quotas (UTC), keys stored only as SHA-256 hashes,
// OpenAI-compatible chat endpoint translating to the upstream Responses API.
// State lives in KV (binding DB): key:<sha256> records, usage:<sha256> monthly
// counters, one global counters record, session:<token> admin sessions (24h TTL).
// Secrets (UPSTREAM_API_KEY, UPSTREAM_API_KEY_SOL, UPSTREAM_API_KEY_ASTRA,
// AGENT_ADMIN_TOKEN) are Worker secrets, never in code.
// Xingchi split its models into per-model groups (2026-11-20): the sol key's
// group serves only gpt-6.1-sol, the astra key's group serves gpt-6-astra
// (+others). The gateway therefore picks the upstream key per requested
// model — see upstreamKey(). UPSTREAM_API_KEY remains the legacy fallback.

import { createPublicClient, http as viemHttp, recoverMessageAddress, recoverTypedDataAddress, parseAbi } from 'viem';
import { bsc } from 'viem/chains';
import { LANDING, ADMIN_HTML } from './templates.js';
import { TIER_PACKED, TIER_QUOTA, TIER_NAME } from './tiermap.js';

// ---------- config (env) ----------
const cfg = (env) => ({
  CONTRACT: (env.CATSAPI_CONTRACT || '0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9').toLowerCase(),
  GLOBAL_MONTHLY_CAP: Number(env.GLOBAL_MONTHLY_CAP_TOKENS || 5_000_000),
  UPSTREAM: {
    base: (env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    key: env.UPSTREAM_API_KEY || '',
    keys: {
      'gemini-4-argon': env.UPSTREAM_API_KEY || '',
      // legacy Xingchi keys kept as fallback vars only, no longer routed
      'gpt-6.1-sol': env.UPSTREAM_API_KEY_SOL || '',
      'gpt-6-astra': env.UPSTREAM_API_KEY_ASTRA || '',
    },
    ua: env.UPSTREAM_UA || 'catsapi-gateway/0.1',
    models: (env.UPSTREAM_MODELS || 'gemini-4-argon').split(','),
    defaultModel: env.UPSTREAM_DEFAULT_MODEL || 'gemini-4-argon',
    style: env.UPSTREAM_API_STYLE || 'chat',
  },
  RPCS: env.BSC_RPC_URL ? [env.BSC_RPC_URL] : [
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-dataseed1.defibit.io',
    'https://bsc-dataseed1.ninicoin.io',
    'https://bsc-dataseed1.binance.org',
    'https://bsc-dataseed2.binance.org',
    'https://bsc-dataseed.bnbchain.org',
    'https://bsc-mainnet.public.blastapi.io',
  ],
});
// ---------- upstream key routing + chat<->responses translation ----------
// Adapted from the user-supplied xingchi responses-shim pack (2026-11-20).
// Pick the Xingchi key whose group serves the requested model; unknown
// models fall back to the legacy single key and upstream decides.
const upstreamKey = (U, model) => (U.keys && U.keys[model]) || U.key || '';
// Upstream auto-injects a huge Codex preamble as `instructions` when none is
// given; sending our own keeps prompt tokens sane for plain chat use.
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant. Answer directly and concisely.';

function contentParts(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  const parts = [];
  for (const p of content || []) {
    if (!p || typeof p !== 'object') { parts.push({ type: 'input_text', text: String(p) }); continue; }
    const t = p.type;
    if (t === 'text' || t === 'input_text') parts.push({ type: 'input_text', text: p.text || '' });
    else if (t === 'image_url' || t === 'input_image') {
      const iu = p.image_url;
      parts.push({ type: 'input_image', image_url: (iu && typeof iu === 'object') ? iu.url : iu });
    } else if ('text' in p) parts.push({ type: 'input_text', text: p.text });
  }
  return parts.length ? parts : [{ type: 'input_text', text: '' }];
}

function chatToResponses(body) {
  const instructions = [];
  const items = [];
  for (const m of body.messages || []) {
    const role = String(m.role || 'user').toLowerCase();
    const content = m.content;
    if (role === 'system' || role === 'developer') {
      const txt = typeof content === 'string' ? content
        : (Array.isArray(content) ? content.map((p) => (p && p.text) || '').join(' ') : '');
      if (txt) instructions.push(txt);
      continue;
    }
    if (role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id || m.id || 'call_0',
                   output: typeof content === 'string' ? content : JSON.stringify(content ?? '') });
      continue;
    }
    if (role === 'assistant') {
      if (content) items.push({ role: 'assistant', content: contentParts(content) });
      for (const tc of m.tool_calls || []) {
        const fn = tc.function || {};
        items.push({ type: 'function_call', call_id: tc.id || 'call_0', name: fn.name || '', arguments: fn.arguments || '{}' });
      }
      continue;
    }
    items.push({ role: 'user', content: contentParts(content) });
  }
  const out = {
    model: body.model,
    input: items.length ? items : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }],
    instructions: instructions.length ? instructions.join('\n\n') : DEFAULT_INSTRUCTIONS,
    stream: false,
  };
  const maxTok = body.max_completion_tokens ?? body.max_tokens;
  if (maxTok != null) out.max_output_tokens = Number(maxTok);
  for (const k of ['temperature', 'top_p', 'user', 'metadata', 'parallel_tool_calls']) {
    if (body[k] !== undefined && body[k] !== null) out[k] = body[k];
  }
  if (body.stop != null) out.stop = body.stop;
  if (body.reasoning_effort) out.reasoning = { effort: body.reasoning_effort };
  if (Array.isArray(body.tools) && body.tools.length) {
    const rt = [];
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue;
      const fn = (t.function && typeof t.function === 'object') ? t.function : t;
      if (!fn.name) continue;
      const item = { type: 'function', name: fn.name, parameters: fn.parameters || { type: 'object', properties: {} } };
      if (fn.description) item.description = fn.description;
      rt.push(item);
    }
    if (rt.length) {
      out.tools = rt;
      const tc = body.tool_choice;
      if (typeof tc === 'string') out.tool_choice = tc;
      else if (tc && tc.function && tc.function.name) out.tool_choice = { type: 'function', name: tc.function.name };
    }
  }
  return out;
}

// responses body -> { text, tool_calls, finish_reason } (chat shape)
function extractResponses(resp) {
  const textParts = [];
  const toolCalls = [];
  for (const it of resp.output || []) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'message') {
      for (const c of it.content || []) {
        if ((c.type === 'output_text' || c.type === 'text') && c.text) textParts.push(c.text);
      }
    } else if (it.type === 'function_call') {
      toolCalls.push({ id: it.call_id || it.id || ('call_' + Math.random().toString(16).slice(2, 10)),
                       type: 'function',
                       function: { name: it.name || '', arguments: it.arguments || '{}' } });
    }
  }
  let reason = toolCalls.length ? 'tool_calls' : 'stop';
  if (resp.status === 'incomplete') {
    const d = (resp.incomplete_details || {}).reason;
    reason = d === 'max_output_tokens' ? 'length' : (d ? 'content_filter' : reason);
  }
  return { text: textParts.join(''), tool_calls: toolCalls, finish_reason: reason };
}

const SIG_WINDOW_MS = 10 * 60 * 1000;
// EIP-712 key-request typed data (alternative claim path for wallets that
// cannot personal_sign, e.g. Binance Agentic Wallet — its backend signs
// EIP-712 only). Domain binds the request to this gateway + contract + BSC.
const keyRequestTypedData = (contract, wallet, timestamp) => ({
  domain: { name: 'CatsApi Gateway', version: '1', chainId: 56, verifyingContract: contract },
  types: {
    KeyRequest: [
      { name: 'wallet', type: 'address' },
      { name: 'timestamp', type: 'uint256' },
    ],
  },
  primaryType: 'KeyRequest',
  message: { wallet, timestamp: BigInt(timestamp) },
});
// Tolerant EIP-712 verification for external agents, whose signers vary:
// - 65-byte signature with v as 0/1 instead of 27/28
// - baw-style split result: 64-byte signature + separate signatureRecovery
// - typed data signed with a domain that omits verifyingContract
function normalizeSignature(signature, signatureRecovery) {
  let s = String(signature || '').trim();
  if (!s.startsWith('0x')) s = '0x' + s;
  const hex = s.slice(2);
  if (/^[0-9a-fA-F]{128}$/.test(hex)) {
    let rec = signatureRecovery == null ? null : parseInt(String(signatureRecovery), 16);
    if (rec == null || Number.isNaN(rec)) return s; // cannot fix; recovery will fail as invalid
    const v = rec >= 27 ? rec : 27 + rec;
    return s + v.toString(16).padStart(2, '0');
  }
  if (/^[0-9a-fA-F]{130}$/.test(hex)) {
    const v = parseInt(hex.slice(128), 16);
    if (v === 0 || v === 1) return s.slice(0, -2) + (27 + v).toString(16);
  }
  return s;
}
async function verifyEip712Claim(env, addr, ts, signature, signatureRecovery) {
  const sig = normalizeSignature(signature, signatureRecovery);
  const { CONTRACT } = cfg(env);
  const domains = [
    { name: 'CatsApi Gateway', version: '1', chainId: 56, verifyingContract: CONTRACT },
    { name: 'CatsApi Gateway', version: '1', chainId: 56 },
  ];
  let threw = true;
  for (const domain of domains) {
    try {
      const td = keyRequestTypedData(CONTRACT, addr, ts);
      const recovered = (await recoverTypedDataAddress({ domain, types: td.types, primaryType: td.primaryType, message: td.message, signature: sig })).toLowerCase();
      threw = false;
      if (recovered === addr) return 'ok';
    } catch { /* try next variant */ }
  }
  return threw ? 'invalid' : 'mismatch';
}
// Shared EIP-712 claim flow (used by /v1/keys/eip712 and by the /v1/keys auto-route).
async function claimEip712(env, body) {
  const { address, timestamp, signature, signatureRecovery } = body || {};
  if (!address || timestamp == null || !signature) return { status: 400, body: { error: { message: 'address, timestamp and signature are required', type: 'catsapi_gateway' } } };
  const addr = String(address).toLowerCase();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIG_WINDOW_MS) return { status: 400, body: { error: { message: 'signature timestamp expired (10 minute window)', type: 'catsapi_gateway' } } };
  const v = await verifyEip712Claim(env, addr, ts, signature, signatureRecovery);
  if (v === 'invalid') return { status: 400, body: { error: { message: 'invalid signature', type: 'catsapi_gateway' } } };
  if (v !== 'ok') return { status: 403, body: { error: { message: 'signature does not match address', type: 'catsapi_gateway' } } };
  return issueKey(env, addr);
}
const LLMS_TXT = `# CatsApi Gateway — instructions for AI agents

Base URL: https://api.prjktspace.web.id/v1
Contract (BSC): 0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9
Full machine-readable spec: GET https://api.prjktspace.web.id/agent-manifest.json

You hold a CatsApi NFT in your wallet. Claim an API key by proving wallet
ownership with an EIP-712 typed-data signature (no transaction, no gas).
There is exactly ONE claim path. (personal_sign claims were retired —
a request carrying a "message" field gets HTTP 410 with this guidance.)

CLAIM — EIP-712 typed data
domain: {"name":"CatsApi Gateway","version":"1","chainId":56,
         "verifyingContract":"0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9"}
types:  {"KeyRequest":[{"name":"wallet","type":"address"},
                       {"name":"timestamp","type":"uint256"}]}
primaryType: "KeyRequest"
message: {"wallet": <your address>, "timestamp": <unix ms as integer>}
POST /v1/keys/eip712  {"address","timestamp","signature"}
Notes: a 65-byte signature with v=27/28 is canonical. Also accepted:
v=0/1, and baw-style split results — send the 64-byte signature plus
"signatureRecovery":"00"|"01" as an extra field. A domain without
verifyingContract is also accepted. For baw CLI: sign-message preview needs
--message as the full JSON-RPC wrapper
{"method":"eth_signTypedData_v4","params":[<address>, <typed data JSON string>]}
with --signType EIP712; the result returns signature + signatureRecovery.

AFTER CLAIMING
- The 200 response carries your key in the JSON body fields "api_key"
  (aliases: "apiKey", "key", "save_this_key", and nested "data.api_key")
  AND in the response header "x-catsapi-key". Save it immediately.
- If your HTTP client saves response bodies as files or you receive
  compressed/unreadable content, send header "Accept: text/plain" with
  the claim — the key then comes back as plain text lines. API responses
  are served uncompressed (Content-Encoding: identity) on purpose.
- LOST THE KEY? Claim again with a fresh signature: the lost key is
  revoked and a NEW key is issued in the new response. Keys are stored
  only as hashes, so an issued key can never be displayed a second time.
- Unsure whether this wallet holds a cat? GET /v1/holder/<address> shows
  exactly what the gateway detects (token ids + quota) — check before claiming.
- GET /v1/me (Authorization: Bearer <key>) — quota and usage.
- POST /v1/chat/completions — OpenAI-compatible. Model: gemini-4-argon.
- The key is shown once; requesting a new key revokes the old one.
- Monthly quota (sums across all tokens held):
  Common 500K, Rare 1M, Epic 5M, Legendary 20M, Mythic 50M tokens.
- No CatsApi NFT yet? Agent ID holders mint their first cat free at
  https://gateway.prjktspace.web.id/
`;
const AGENT_MANIFEST = {
  name: 'CatsApi Gateway',
  base_url: 'https://api.prjktspace.web.id/v1',
  contract: '0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9',
  chain: 'BSC (chainId 56)',
  auth: 'wallet signature (no transaction, no gas); 10-minute timestamp window',
  claim_paths: {
    eip712: {
      endpoint: 'POST /v1/keys (alias: POST /v1/keys/eip712)',
      when: 'the only claim path — personal_sign claims retired (a body with a "message" field returns HTTP 410)',
      typed_data: {
        domain: { name: 'CatsApi Gateway', version: '1', chainId: 56, verifyingContract: '0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9' },
        types: { KeyRequest: [{ name: 'wallet', type: 'address' }, { name: 'timestamp', type: 'uint256' }] },
        primaryType: 'KeyRequest',
        message: { wallet: '<address>', timestamp: '<unix ms integer>' },
      },
      body: { address: '0x...', timestamp: 0, signature: '0x...', signatureRecovery: 'optional, for 64-byte split signatures ("00"|"01")' },
      accepted_variants: ['v=27/28', 'v=0/1', '64-byte signature + signatureRecovery field', 'domain without verifyingContract'],
    },
  },
  after_claim: {
    key_delivery: 'the claim 200 response returns the key in body fields api_key / apiKey / key / save_this_key / data.api_key and in the x-catsapi-key response header; save it immediately — only its hash is stored',
    lost_key: 'claim again with a fresh signature: the lost key is revoked and a fresh key is issued in the new response',
    holder_check: 'GET /v1/holder/<address> shows what the gateway detects for a wallet',
    me: 'GET /v1/me with Authorization: Bearer <key>',
    chat: 'POST /v1/chat/completions (OpenAI-compatible), model gemini-4-argon',
    key_rotation: 'requesting a new key revokes the previous one',
    quotas_tokens_per_month: { Common: 500000, Rare: 1000000, Epic: 5000000, Legendary: 20000000, Mythic: 50000000 },
  },
};
const OWNER_CACHE_MS = 120 * 1000;
const PUBLIC_API_URL = 'https://api.prjktspace.web.id';

// ---------- crypto helpers ----------
async function hashKey(k) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- chain ----------
const ABI = parseAbi([
  'function totalMinted() view returns (uint256)',
  'function freeMinted() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function owner() view returns (address)',
]);
async function readChain(env, fn) {
  const { RPCS } = cfg(env);
  let lastErr;
  for (const rpc of RPCS) {
    try { return await fn(createPublicClient({ chain: bsc, transport: viemHttp(rpc, { timeout: 4000 }) })); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPC endpoints failed');
}
const ownerCache = new Map();
async function getOwnedTokens(env, address) {
  const hit = ownerCache.get(address);
  if (hit && Date.now() - hit.at < OWNER_CACHE_MS) return hit.tokenIds;
  const { CONTRACT } = cfg(env);
  // Ownership scan must be COMPLETE or fail loudly: a silently partial scan
  // (rate-limited RPC swallowing ownerOf errors) made real holders look like
  // non-holders ("no CatsApi NFT found"). Incomplete -> throw -> readChain
  // retries the whole scan on the next RPC endpoint.
  const tokenIds = await readChain(env, async (client) => {
    const bal = Number(await client.readContract({ address: CONTRACT, abi: ABI, functionName: 'balanceOf', args: [address] }));
    if (bal === 0) return [];
    const total = Number(await client.readContract({ address: CONTRACT, abi: ABI, functionName: 'totalMinted' }));
    const ids = [];
    // Path 1: Multicall3 batches (few HTTP requests, rate-limit friendly).
    try {
      const CHUNK = 60;
      for (let start = 1; start <= total && ids.length < bal; start += CHUNK) {
        const end = Math.min(start + CHUNK, total + 1);
        const contracts = [];
        for (let id = start; id < end; id++) contracts.push({ address: CONTRACT, abi: ABI, functionName: 'ownerOf', args: [BigInt(id)] });
        const results = await client.multicall({ contracts, allowFailure: true });
        results.forEach((r, i) => {
          if (r.status !== 'success') throw new Error('ownerOf multicall item failed');
          if (String(r.result).toLowerCase() === address) ids.push(start + i);
        });
      }
    } catch (e) {
      // Path 2: chunked plain calls with per-call retry (also the path on
      // chains without Multicall3, e.g. local test chains).
      if (ids.length) throw e; // partial multicall progress cannot be trusted
      const CHUNK = 10;
      for (let start = 1; start <= total && ids.length < bal; start += CHUNK) {
        const end = Math.min(start + CHUNK, total + 1);
        const batch = [];
        for (let id = start; id < end; id++) {
          batch.push((async () => {
            let lastErr;
            for (let attempt = 0; attempt < 3; attempt++) {
              try { return { id, owner: String(await client.readContract({ address: CONTRACT, abi: ABI, functionName: 'ownerOf', args: [BigInt(id)] })).toLowerCase() }; }
              catch (err) { lastErr = err; }
            }
            throw lastErr || new Error('ownerOf failed');
          })());
        }
        for (const v of await Promise.all(batch)) if (v.owner === address) ids.push(v.id);
      }
    }
    if (ids.length < bal) throw new Error(`ownership scan incomplete: found ${ids.length} of ${bal} tokens`);
    return ids;
  });
  ownerCache.set(address, { at: Date.now(), tokenIds });
  if (ownerCache.size > 500) ownerCache.delete(ownerCache.keys().next().value); // LRU-ish bound
  return tokenIds;
}
function quotaFor(tokenIds) {
  let quota = 0; const tiers = [];
  for (const id of tokenIds) {
    const code = TIER_PACKED[id - 1];
    if (code) {
      const tier = TIER_NAME[code];
      quota += TIER_QUOTA[tier];
      tiers.push({ tokenId: id, tier, quotaPerMonth: TIER_QUOTA[tier] });
    }
  }
  return { quota, tiers };
}
// Shared issuance for both claim paths (personal_sign + EIP-712).
// Returns { status, body } — body is the success payload or { error } shape.
async function issueKey(env, addr) {
  const tokenIds = await getOwnedTokens(env, addr);
  if (!tokenIds.length) return { status: 403, body: { error: { message: 'no CatsApi NFT found for this wallet — mint one first (Agent ID holders mint free)', type: 'catsapi_gateway' } } };
  const { quota, tiers } = quotaFor(tokenIds);
  for (const [kh, rec] of await allKeyRecs(env)) {
    if (rec.address === addr && !rec.revoked) { rec.revoked = true; await env.DB.put('key:' + kh, JSON.stringify(rec)); }
  }
  const apiKey = 'sk-cats-' + randomHex(24);
  await env.DB.put('key:' + (await hashKey(apiKey)), JSON.stringify({ address: addr, createdAt: new Date().toISOString(), revoked: false, tokens: tiers, quotaPerMonth: quota, requests: 0, lastUsedAt: null }));
  // Deliberately redundant delivery: agents parse different shapes, so the
  // key is returned under several field names, nested, and (at the route) in
  // a response header. Losing it is still recoverable: claim again and the
  // old key is revoked while a fresh one is issued in the new response.
  const payload = { api_key: apiKey, address: addr, tokens: tiers, quota_per_month: quota, period: monthKey() };
  return { status: 200, body: { ...payload, apiKey, key: apiKey, data: payload, save_this_key: apiKey, note: 'STORE THIS KEY NOW — it is shown once and only its hash is kept server-side, so it cannot be shown again. If you lose it, simply claim again: the lost key is revoked and a fresh key is issued in the new response.' } };
}
let ownerAddrCache = { at: 0, addr: null };
async function getContractOwner(env) {
  if (ownerAddrCache.addr && Date.now() - ownerAddrCache.at < 300_000) return ownerAddrCache.addr;
  const { CONTRACT } = cfg(env);
  const addr = await readChain(env, (c) => c.readContract({ address: CONTRACT, abi: ABI, functionName: 'owner' }));
  ownerAddrCache = { at: Date.now(), addr: String(addr).toLowerCase() };
  return ownerAddrCache.addr;
}
async function getMintStats(env) {
  const { CONTRACT } = cfg(env);
  return readChain(env, async (c) => {
    const total = await c.readContract({ address: CONTRACT, abi: ABI, functionName: 'totalMinted' });
    const free = await c.readContract({ address: CONTRACT, abi: ABI, functionName: 'freeMinted' });
    return { totalMinted: Number(total), freeMinted: Number(free) };
  });
}

// ---------- KV data layer (mirrors db.json semantics) ----------
const monthKey = () => new Date().toISOString().slice(0, 7);
const getKeyRec = async (env, kh) => env.DB.get('key:' + kh, 'json');
async function allKeyRecs(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'key:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const rec = await env.DB.get(k.name, 'json');
      if (rec) out.push([k.name.slice(4), rec]);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
const usedBy = async (env, kh) => {
  const u = await env.DB.get('usage:' + kh, 'json');
  return (u && u[monthKey()]) || 0;
};
const globalUsed = async (env) => {
  const g = await env.DB.get('global', 'json');
  return (g && g[monthKey()]) || 0;
};
// Keep only the current month + 3 previous months in usage counters
// (hardening 2026-11-25, batch 2: prune unbounded month-key growth).
function pruneMonths(obj) {
  const keep = new Set();
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keep.add(d.toISOString().slice(0, 7));
  }
  for (const k of Object.keys(obj)) if (!keep.has(k)) delete obj[k];
  return obj;
}
async function recordUsage(env, kh, tokens) {
  const m = monthKey();
  const u = pruneMonths((await env.DB.get('usage:' + kh, 'json')) || {});
  u[m] = (u[m] || 0) + tokens;
  await env.DB.put('usage:' + kh, JSON.stringify(u));
  const g = pruneMonths((await env.DB.get('global', 'json')) || {});
  g[m] = (g[m] || 0) + tokens;
  await env.DB.put('global', JSON.stringify(g));
  const rec = await getKeyRec(env, kh);
  if (rec) {
    rec.requests = (rec.requests || 0) + 1;
    rec.lastUsedAt = new Date().toISOString();
    await env.DB.put('key:' + kh, JSON.stringify(rec));
  }
}

// ---------- admin auth ----------
// Per-IP admin failure limiter (hardening 2026-11-25, batch 2): after 10
// failed admin attempts in 60s from one IP, admin routes answer 429 for
// that IP until the window clears. In-memory per isolate, size-bounded.
const adminFail = new Map(); // ip -> [timestamps]
function adminIp(req) { return req.headers.get('cf-connecting-ip') || 'unknown'; }
function adminLimited(req) {
  const arr = (adminFail.get(adminIp(req)) || []).filter((t) => Date.now() - t < 60_000);
  return arr.length >= 10;
}
function noteAdminFail(req) {
  const ip = adminIp(req);
  const arr = (adminFail.get(ip) || []).filter((t) => Date.now() - t < 60_000);
  arr.push(Date.now());
  adminFail.set(ip, arr);
  if (adminFail.size > 1000) { // sweep stale entries to bound memory
    for (const [k, v] of adminFail) if (!v.some((t) => Date.now() - t < 60_000)) adminFail.delete(k);
  }
}
// Constant-time compare via SHA-256 digests (both sides always 64 hex chars).
async function tokenEq(a, b) {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([hashKey(a), hashKey(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}
async function isAdmin(env, req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const exp = await env.DB.get('session:' + m[1].trim());
    if (exp && Number(exp) > Date.now()) return true;
  }
  if (env.AGENT_ADMIN_TOKEN && await tokenEq(req.headers.get('x-agent-token') || '', env.AGENT_ADMIN_TOKEN)) return true;
  noteAdminFail(req);
  return false;
}

// ---------- upstream probe (cached 60s per isolate) ----------
let probeCache = { at: 0, data: null };
async function probeUpstream(env) {
  if (probeCache.data && Date.now() - probeCache.at < 60_000) return probeCache.data;
  const { UPSTREAM } = cfg(env);
  // Per-group probe: models are split across Xingchi groups/keys, so probe
  // /models once per distinct key and report each group's health separately.
  const byKey = new Map();
  for (const m of UPSTREAM.models) {
    const k = upstreamKey(UPSTREAM, m);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }
  const groups = [];
  for (const [key, models] of byKey) {
    try {
      const r = await fetch(UPSTREAM.base + '/models', {
        headers: { 'authorization': `Bearer ${key}`, 'user-agent': UPSTREAM.ua },
        signal: AbortSignal.timeout(8000),
      });
      let listed = null;
      try { const j = await r.json(); if (Array.isArray(j.data)) listed = j.data.map((x) => x.id); } catch { /* keep null */ }
      groups.push({ models, ok: r.ok, status: r.status, listed });
    } catch (e) {
      groups.push({ models, ok: false, status: 0, error: String(e && e.message || e).slice(0, 120) });
    }
  }
  const allOk = groups.length > 0 && groups.every((g) => g.ok);
  const firstBad = groups.find((g) => !g.ok);
  const data = { name: 'VSLLM', base: UPSTREAM.base, style: UPSTREAM.style,
                 ok: allOk, status: allOk ? 200 : (firstBad ? firstBad.status : 0),
                 models: UPSTREAM.models, groups, default_model: UPSTREAM.defaultModel,
                 probed_at: new Date().toISOString() };
  probeCache = { at: Date.now(), data };
  return data;
}

// ---------- http helpers ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
// NO_COMPRESS: Cloudflare edge gzip/brotli-compresses JSON responses, and
// agent HTTP clients that save the raw body then hold an unreadable binary
// ".json" file. no-transform + identity encoding keep bodies plain bytes.
const NO_COMPRESS = { 'cache-control': 'no-transform, no-store', 'content-encoding': 'identity' };
// Security headers (hardening 2026-11-25, quick wins batch 1).
const SEC = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const send = (obj, code = 200) => new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json', ...CORS, ...NO_COMPRESS, ...SEC } });
const sendHtml = (html) => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...CORS, ...SEC } });
const err = (code, message) => send({ error: { message, type: 'catsapi_gateway' } }, code);
async function readBody(req) {
  const text = await req.text();
  if (text.length > 1_000_000) { const e = new Error('body too large'); e.status = 413; throw e; }
  if (!text) return {};
  try { return JSON.parse(text); } catch { const e = new Error('invalid JSON'); e.status = 400; throw e; }
}
async function authKey(env, req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const kh = await hashKey(m[1].trim());
  const rec = await getKeyRec(env, kh);
  return rec && !rec.revoked ? { kh, ...rec } : null;
}
const rl = new Map();
function rateLimited(kh) {
  const now = Date.now();
  const arr = (rl.get(kh) || []).filter((t) => now - t < 60_000);
  arr.push(now); rl.set(kh, arr);
  if (rl.size > 1000) { // sweep stale entries to bound memory
    for (const [k, v] of rl) if (!v.some((t) => now - t < 60_000)) rl.delete(k);
  }
  return arr.length > 60;
}

// ---------- routes ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const C = cfg(env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname.startsWith('/admin') && url.pathname !== '/admin' && adminLimited(req)) return err(429, 'too many failed admin attempts — try again in a minute');
      if (req.method === 'GET' && url.pathname === '/') return sendHtml(LANDING);
      if (req.method === 'GET' && url.pathname === '/health') {
        const recs = await allKeyRecs(env);
        return send({ ok: true, active_keys: recs.filter(([, r]) => !r.revoked).length, global_used_this_month: await globalUsed(env), global_monthly_cap: C.GLOBAL_MONTHLY_CAP, period: monthKey() });
      }

      // Key claim is EIP-712 ONLY (personal_sign claims retired 2026-11-19 at
      // the owner's instruction — one path, no routing confusion for agents).
      // Both /v1/keys and /v1/keys/eip712 accept the same EIP-712 body.
      if (req.method === 'POST' && (url.pathname === '/v1/keys' || url.pathname === '/v1/keys/eip712')) {
        const body = await readBody(req);
        if (body.message) return err(410, 'personal_sign claims are retired — claim with EIP-712 typed data instead: POST /v1/keys with {address, timestamp, signature} (typed data spec: GET /llms.txt or /agent-manifest.json)');
        const r = await claimEip712(env, body);
        if (r.status === 200 && r.body.api_key) {
          // Plain-text variant for clients that mishandle JSON bodies/files.
          if ((req.headers.get('accept') || '').includes('text/plain')) {
            const text = `CATSAPI API KEY — save it now, it is shown once\napi_key: ${r.body.api_key}\naddress: ${r.body.address}\nquota_per_month: ${r.body.quota_per_month}\nperiod: ${r.body.period}\nUse as: Authorization: Bearer ${r.body.api_key}\nIf you lose it, claim again — the lost key is revoked and a fresh one is issued.\n`;
            return new Response(text, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS, ...NO_COMPRESS, ...SEC, 'x-catsapi-key': r.body.api_key } });
          }
          return new Response(JSON.stringify(r.body), { status: 200, headers: { 'content-type': 'application/json', ...CORS, ...NO_COMPRESS, ...SEC, 'x-catsapi-key': r.body.api_key } });
        }
        return send(r.body, r.status);
      }

      if (req.method === 'GET' && url.pathname === '/llms.txt') {
        return new Response(LLMS_TXT, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS, ...NO_COMPRESS, ...SEC } });
      }
      if (req.method === 'GET' && url.pathname === '/agent-manifest.json') return send(AGENT_MANIFEST);

      // Public read-only diagnostic: what the gateway sees for an address.
      if (req.method === 'GET' && url.pathname.startsWith('/v1/holder/')) {
        const address = url.pathname.slice('/v1/holder/'.length).toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return err(400, 'invalid address');
        try {
          const tokenIds = await getOwnedTokens(env, address);
          const { quota, tiers } = quotaFor(tokenIds);
          return send({ address, is_holder: tokenIds.length > 0, tokenIds, tokens: tiers, quota_per_month: quota });
        } catch { return err(502, 'chain read failed — try again in a moment'); }
      }

      if (url.pathname === '/v1/me' && req.method === 'GET') {
        const k = await authKey(env, req); if (!k) return err(401, 'invalid or revoked API key');
        const tokenIds = await getOwnedTokens(env, k.address);
        const { quota, tiers } = quotaFor(tokenIds);
        const used = await usedBy(env, k.kh);
        return send({ address: k.address, tokens: tiers, quota_per_month: quota, used_this_month: used, remaining_this_month: Math.max(0, quota - used), period: monthKey() });
      }

      if (url.pathname === '/v1/models' && req.method === 'GET') {
        const k = await authKey(env, req); if (!k) return err(401, 'invalid or revoked API key');
        return send({ object: 'list', data: C.UPSTREAM.models.map((id) => ({ id, object: 'model', owned_by: 'catsapi-gateway' })) });
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const k = await authKey(env, req); if (!k) return err(401, 'invalid or revoked API key');
        if (rateLimited(k.kh)) return err(429, 'rate limit: 60 requests/minute per key');
        const body = await readBody(req);
        if (body.stream) return err(400, 'streaming is not supported by the MVP gateway — send stream:false');
        const tokenIds = await getOwnedTokens(env, k.address);
        if (!tokenIds.length) return err(403, 'CatsApi NFT no longer held by this wallet');
        const { quota } = quotaFor(tokenIds);
        const used = await usedBy(env, k.kh);
        if (used >= quota) return err(402, `monthly quota exhausted (${used}/${quota} tokens in ${monthKey()})`);
        if ((await globalUsed(env)) >= C.GLOBAL_MONTHLY_CAP) return err(503, 'gateway global monthly cap reached — try next month');
        const UPSTREAM = C.UPSTREAM;
        const model = body.model || UPSTREAM.defaultModel;
        const modelKey = upstreamKey(UPSTREAM, model);
        let json;
        if (UPSTREAM.style === 'responses') {
          const rPayload = chatToResponses({ ...body, model });
          const up = await fetch(UPSTREAM.base + '/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': `Bearer ${modelKey}`, 'user-agent': UPSTREAM.ua },
            body: JSON.stringify(rPayload),
          });
          const text = await up.text();
          if (!up.ok) {
            let msg = 'upstream error';
            try { const ej = JSON.parse(text); msg = (ej.error && ej.error.message) || msg; } catch { /* keep generic */ }
            return send({ error: { message: msg.slice(0, 300), type: 'catsapi_gateway', upstream_status: up.status } }, up.status);
          }
          let respObj = null;
          try { respObj = JSON.parse(text); } catch {
            for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'response.completed' && ev.response) respObj = ev.response; } catch { /* skip */ }
            }
          }
          if (!respObj) return send({ error: { message: 'upstream returned an unreadable response', type: 'catsapi_gateway' } }, 502);
          const ex = extractResponses(respObj);
          const outText = ex.text || respObj.output_text || '';
          const msg = { role: 'assistant', content: outText ? outText : (ex.tool_calls.length ? null : '') };
          if (ex.tool_calls.length) msg.tool_calls = ex.tool_calls;
          const u = respObj.usage || {};
          json = {
            id: respObj.id || ('chatcmpl-' + Date.now()),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: respObj.model || model,
            choices: [{ index: 0, message: msg, finish_reason: ex.finish_reason }],
            usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)) },
          };
        } else {
          const payload = { ...body, model, stream: false };
          const up = await fetch(UPSTREAM.base + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': `Bearer ${modelKey}`, 'user-agent': UPSTREAM.ua },
            body: JSON.stringify(payload),
          });
          const text = await up.text();
          if (!up.ok) return send({ error: { message: 'upstream error', type: 'catsapi_gateway', upstream_status: up.status } }, up.status);
          try { json = JSON.parse(text); } catch { return send({ error: { message: 'upstream returned non-JSON', type: 'catsapi_gateway' } }, 502); }
        }
        let tokens = json.usage && json.usage.total_tokens;
        if (!tokens) {
          const inChars = JSON.stringify(body.messages || '').length;
          const outChars = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').length;
          tokens = Math.ceil(inChars / 4) + Math.ceil(outChars / 4);
        }
        await recordUsage(env, k.kh, tokens);
        return send(json);
      }

      // ---------- admin (owner dashboard) ----------
      if (req.method === 'GET' && url.pathname === '/admin') return sendHtml(ADMIN_HTML);

      if (req.method === 'POST' && url.pathname === '/admin/login') {
        const { address, message, signature } = await readBody(req);
        if (!address || !message || !signature) return err(400, 'address, message and signature are required');
        const addr = String(address).toLowerCase();
        const m = String(message).match(/Timestamp:\s*(\d{10,13})/);
        if (!m) return err(400, 'message must contain "Timestamp: <unix ms>"');
        if (Math.abs(Date.now() - Number(m[1])) > SIG_WINDOW_MS) return err(400, 'signature timestamp expired (10 minute window)');
        if (!String(message).includes('CatsApi Gateway admin login')) return err(400, 'message must be the CatsApi Gateway admin login text');
        let recovered;
        try { recovered = (await recoverMessageAddress({ message: String(message), signature })).toLowerCase(); }
        catch { noteAdminFail(req); return err(400, 'invalid signature'); }
        if (recovered !== addr) { noteAdminFail(req); return err(403, 'signature does not match address'); }
        const owner = await getContractOwner(env);
        if (addr !== owner) { noteAdminFail(req); return err(403, 'this wallet is not the CatsApi contract owner'); }
        const session = randomHex(32);
        await env.DB.put('session:' + session, String(Date.now() + 24 * 3600 * 1000), { expirationTtl: 24 * 3600 });
        return send({ session, expires_in_hours: 24 });
      }

      if (req.method === 'GET' && url.pathname === '/admin/overview') {
        if (!(await isAdmin(env, req))) return err(401, 'invalid or expired admin session');
        let mint = null; try { mint = await getMintStats(env); } catch { /* RPC hiccup: show nulls */ }
        let owner = null; try { owner = await getContractOwner(env); } catch { /* same */ }
        const provider = await probeUpstream(env);
        const recs = (await allKeyRecs(env)).map(([, r]) => r);
        return send({
          contract: C.CONTRACT, owner, mint,
          period: monthKey(), global_used_this_month: await globalUsed(env), global_monthly_cap: C.GLOBAL_MONTHLY_CAP,
          keys_active: recs.filter((r) => !r.revoked).length, keys_revoked: recs.filter((r) => r.revoked).length,
          provider, tunnel_url: PUBLIC_API_URL,
        });
      }

      if (req.method === 'GET' && url.pathname === '/admin/keys') {
        if (!(await isAdmin(env, req))) return err(401, 'invalid or expired admin session');
        const keys = [];
        for (const [kh, r] of await allKeyRecs(env)) {
          keys.push({
            id: kh.slice(0, 10), address: r.address, created_at: r.createdAt, revoked: !!r.revoked,
            tokens: r.tokens || [], quota_per_month: r.quotaPerMonth != null ? r.quotaPerMonth : null,
            used_this_month: await usedBy(env, kh), requests: r.requests || 0, last_used_at: r.lastUsedAt || null,
          });
        }
        keys.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return send({ keys, period: monthKey() });
      }

      if (req.method === 'POST' && url.pathname === '/admin/revoke') {
        if (!(await isAdmin(env, req))) return err(401, 'invalid or expired admin session');
        const { hash_prefix, address } = await readBody(req);
        let n = 0;
        for (const [kh, rec] of await allKeyRecs(env)) {
          if (rec.revoked) continue;
          if ((hash_prefix && kh.startsWith(String(hash_prefix))) || (address && rec.address === String(address).toLowerCase())) {
            rec.revoked = true; await env.DB.put('key:' + kh, JSON.stringify(rec)); n++;
          }
        }
        return send({ revoked: n });
      }

      return err(404, 'not found');
    } catch (e) {
      if (e && e.status) return err(e.status, e.message);
      return err(500, 'gateway error: ' + (e && e.message ? e.message.slice(0, 200) : 'unknown'));
    }
  },
};
