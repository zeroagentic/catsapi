// CatsApi Gateway (MVP)
// OpenAI-compatible LLM gateway gated by CatsApi NFT ownership on BNB Smart Chain.
// Flow: wallet signs a message -> gateway verifies signature + on-chain CatsApi
// ownership -> issues an API key -> key's monthly token quota = sum of the
// quotas of the tiers of the NFTs the wallet holds (provenance-committed tier map).
// Usage is metered per key per calendar month (UTC). Keys are stored only as
// SHA-256 hashes. Upstream credentials never leave this server and are never logged.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { createPublicClient, http as viemHttp, recoverMessageAddress, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

// ---------- config ----------
const PORT = Number(process.env.GATEWAY_PORT || 8787);
const CONTRACT = (process.env.CATSAPI_CONTRACT || '0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9').toLowerCase();
const GLOBAL_MONTHLY_CAP = Number(process.env.GLOBAL_MONTHLY_CAP_TOKENS || 5_000_000);
const SIG_WINDOW_MS = 10 * 60 * 1000;
const OWNER_CACHE_MS = 120 * 1000;
const DATA_DIR = new URL('./data/', import.meta.url).pathname;
const DB_PATH = DATA_DIR + 'db.json';
const TIERMAP_PATH = new URL('./config/tier-map.json', import.meta.url).pathname;

// Upstream (OpenAI-compatible). Default: the operator's Xingchi account.
let UPSTREAM = null;
function loadUpstream() {
  if (process.env.UPSTREAM_BASE_URL && process.env.UPSTREAM_API_KEY) {
    UPSTREAM = {
      base: process.env.UPSTREAM_BASE_URL.replace(/\/$/, ''),
      key: process.env.UPSTREAM_API_KEY,
      ua: process.env.UPSTREAM_UA || 'catsapi-gateway/0.1',
      models: (process.env.UPSTREAM_MODELS || 'gpt-6-astra').split(','),
      defaultModel: process.env.UPSTREAM_DEFAULT_MODEL || 'gpt-6-astra',
      style: process.env.UPSTREAM_API_STYLE || 'chat', // 'chat' passthrough or 'responses' translation
    };
    return;
  }
  const credPath = process.env.XINGCHI_CREDENTIALS || '/home/hatch/workspace/xingchi/credentials.json';
  const c = JSON.parse(readFileSync(credPath, 'utf8'));
  UPSTREAM = {
    base: c.base_url.replace(/\/$/, ''),
    key: c.api_key,
    ua: c.user_agent_required || 'catsapi-gateway/0.1',
    models: c.models && c.models.length ? c.models : ['gpt-6.1-sol'],
    defaultModel: (c.models || ['gpt-6.1-sol'])[0],
    style: process.env.UPSTREAM_API_STYLE || 'responses', // Xingchi disabled /chat/completions; it serves the Responses API
  };
}
loadUpstream();

// Tier map: tokenId -> { tier, quotaPerMonth } (provenance sha256 committed in project README)
const TIERMAP = JSON.parse(readFileSync(TIERMAP_PATH, 'utf8'));

// ---------- chain ----------
const RPCS = process.env.BSC_RPC_URL ? [process.env.BSC_RPC_URL] : [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-mainnet.public.blastapi.io',
];
const ABI = parseAbi([
  'function totalMinted() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
]);
function clientFor(rpc) {
  return createPublicClient({ chain: bsc, transport: viemHttp(rpc, { timeout: 4000 }) });
}
async function readChain(fn) {
  let lastErr;
  for (const rpc of RPCS) {
    try { return await fn(clientFor(rpc)); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPC endpoints failed');
}
const ownerCache = new Map(); // address -> { at, tokenIds }
async function getOwnedTokens(address) {
  const hit = ownerCache.get(address);
  if (hit && Date.now() - hit.at < OWNER_CACHE_MS) return hit.tokenIds;
  const tokenIds = await readChain(async (client) => {
    const bal = await client.readContract({ address: CONTRACT, abi: ABI, functionName: 'balanceOf', args: [address] });
    if (bal === 0n) return [];
    const total = Number(await client.readContract({ address: CONTRACT, abi: ABI, functionName: 'totalMinted' }));
    const ids = [];
    const CHUNK = 25;
    for (let start = 1; start <= total; start += CHUNK) {
      const batch = [];
      for (let id = start; id < Math.min(start + CHUNK, total + 1); id++) {
        batch.push(client.readContract({ address: CONTRACT, abi: ABI, functionName: 'ownerOf', args: [BigInt(id)] })
          .then((o) => (o.toLowerCase() === address ? id : null)).catch(() => null));
      }
      for (const v of await Promise.all(batch)) if (v !== null) ids.push(v);
      if (ids.length >= Number(bal)) break;
    }
    return ids;
  });
  ownerCache.set(address, { at: Date.now(), tokenIds });
  return tokenIds;
}
function quotaFor(tokenIds) {
  let quota = 0; const tiers = [];
  for (const id of tokenIds) {
    const t = TIERMAP[String(id)];
    if (t) { quota += t.quotaPerMonth; tiers.push({ tokenId: id, tier: t.tier, quotaPerMonth: t.quotaPerMonth }); }
  }
  return { quota, tiers };
}

// ---------- db ----------
mkdirSync(DATA_DIR, { recursive: true });
let db = { keys: {}, usage: {}, global: {} };
if (existsSync(DB_PATH)) { try { db = JSON.parse(readFileSync(DB_PATH, 'utf8')); } catch { /* start fresh */ } }
function saveDb() {
  const tmp = DB_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(db, null, 1));
  renameSync(tmp, DB_PATH);
}
const monthKey = () => new Date().toISOString().slice(0, 7); // UTC YYYY-MM
const hashKey = (k) => createHash('sha256').update(k).digest('hex');
const usedBy = (kh) => (db.usage[kh] && db.usage[kh][monthKey()]) || 0;
const globalUsed = () => db.global[monthKey()] || 0;
function recordUsage(kh, tokens) {
  const m = monthKey();
  db.usage[kh] = db.usage[kh] || {};
  db.usage[kh][m] = (db.usage[kh][m] || 0) + tokens;
  db.global[m] = (db.global[m] || 0) + tokens;
  saveDb();
}

// ---------- http helpers ----------
function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
const err = (res, code, message) => send(res, code, { error: { message, type: 'catsapi_gateway' } });
function authKey(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const kh = hashKey(m[1].trim());
  const rec = db.keys[kh];
  return rec && !rec.revoked ? { kh, ...rec } : null;
}
// simple per-key rate limit: 60 req / minute
const rl = new Map();
function rateLimited(kh) {
  const now = Date.now();
  const arr = (rl.get(kh) || []).filter((t) => now - t < 60_000);
  arr.push(now); rl.set(kh, arr);
  return arr.length > 60;
}

// ---------- routes ----------
const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CatsApi Gateway — NFT-gated LLM API</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e8ecf3;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.6}code{background:#121826;padding:2px 6px;border-radius:6px;color:#f0b90b}pre{background:#121826;padding:14px;border-radius:10px;overflow:auto}a{color:#f0b90b}</style></head>
<body><h1>CatsApi Gateway</h1>
<p>An OpenAI-compatible LLM API gated by <b>CatsApi NFT</b> ownership on BNB Smart Chain.
Each NFT unlocks a monthly token quota by tier (Common 500K · Rare 1M · Epic 5M · Legendary 20M · Mythic 50M; quotas stack).</p>
<h2>1. Get a key</h2>
<p>Sign this message with the wallet that holds your CatsApi (no transaction, no gas):</p>
<pre>CatsApi Gateway key request
Address: &lt;your address&gt;
Timestamp: &lt;unix time in milliseconds&gt;</pre>
<p>Then POST it:</p>
<pre>curl -X POST ${''}/v1/keys -H 'content-type: application/json' -d '{
  "address": "0x...", "message": "...", "signature": "0x..."
}'</pre>
<h2>2. Call the API</h2>
<pre>curl /v1/chat/completions -H "Authorization: Bearer sk-cats-..." \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"Hello"}]}'</pre>
<p>Check usage any time at <code>GET /v1/me</code> with your key. Keys rotate: asking for a new key revokes the old one.
Mint a cat at <a href="https://zeroagentic.github.io/catsapi/">zeroagentic.github.io/catsapi</a> — Agent ID holders mint their first one free.</p>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, LANDING);
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, contract: CONTRACT, upstream_models: UPSTREAM.models, active_keys: Object.values(db.keys).filter((k) => !k.revoked).length, global_used_this_month: globalUsed(), global_monthly_cap: GLOBAL_MONTHLY_CAP, period: monthKey() });
    }

    if (req.method === 'POST' && url.pathname === '/v1/keys') {
      const { address, message, signature } = await readBody(req);
      if (!address || !message || !signature) return err(res, 400, 'address, message and signature are required');
      const addr = String(address).toLowerCase();
      const m = String(message).match(/Timestamp:\s*(\d{10,13})/);
      if (!m) return err(res, 400, 'message must contain "Timestamp: <unix ms>"');
      if (Math.abs(Date.now() - Number(m[1])) > SIG_WINDOW_MS) return err(res, 400, 'signature timestamp expired (10 minute window)');
      if (!String(message).includes('CatsApi Gateway key request')) return err(res, 400, 'message must be the CatsApi Gateway key request text');
      let recovered;
      try { recovered = (await recoverMessageAddress({ message: String(message), signature })).toLowerCase(); }
      catch { return err(res, 400, 'invalid signature'); }
      if (recovered !== addr) return err(res, 403, 'signature does not match address');
      const tokenIds = await getOwnedTokens(addr);
      if (!tokenIds.length) return err(res, 403, 'no CatsApi NFT found for this wallet — mint one first (Agent ID holders mint free)');
      const { quota, tiers } = quotaFor(tokenIds);
      // rotate: revoke previous keys of this address
      for (const [kh, rec] of Object.entries(db.keys)) if (rec.address === addr) rec.revoked = true;
      const apiKey = 'sk-cats-' + randomBytes(24).toString('hex');
      db.keys[hashKey(apiKey)] = { address: addr, createdAt: new Date().toISOString(), revoked: false };
      saveDb();
      return send(res, 200, { api_key: apiKey, address: addr, tokens: tiers, quota_per_month: quota, period: monthKey(), note: 'Store this key now — it is shown once and only its hash is kept. Requesting a new key revokes this one.' });
    }

    if (url.pathname === '/v1/me' && req.method === 'GET') {
      const k = authKey(req); if (!k) return err(res, 401, 'invalid or revoked API key');
      const tokenIds = await getOwnedTokens(k.address);
      const { quota, tiers } = quotaFor(tokenIds);
      return send(res, 200, { address: k.address, tokens: tiers, quota_per_month: quota, used_this_month: usedBy(k.kh), remaining_this_month: Math.max(0, quota - usedBy(k.kh)), period: monthKey() });
    }

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const k = authKey(req); if (!k) return err(res, 401, 'invalid or revoked API key');
      return send(res, 200, { object: 'list', data: UPSTREAM.models.map((id) => ({ id, object: 'model', owned_by: 'catsapi-gateway' })) });
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const k = authKey(req); if (!k) return err(res, 401, 'invalid or revoked API key');
      if (rateLimited(k.kh)) return err(res, 429, 'rate limit: 60 requests/minute per key');
      const body = await readBody(req);
      if (body.stream) return err(res, 400, 'streaming is not supported by the MVP gateway — send stream:false');
      const tokenIds = await getOwnedTokens(k.address);
      if (!tokenIds.length) return err(res, 403, 'CatsApi NFT no longer held by this wallet');
      const { quota } = quotaFor(tokenIds);
      const used = usedBy(k.kh);
      if (used >= quota) return err(res, 402, `monthly quota exhausted (${used}/${quota} tokens in ${monthKey()})`);
      if (globalUsed() >= GLOBAL_MONTHLY_CAP) return err(res, 503, 'gateway global monthly cap reached — try next month');
      const model = body.model || UPSTREAM.defaultModel;
      let json;
      if (UPSTREAM.style === 'responses') {
        // Translate OpenAI chat/completions -> upstream Responses API and back.
        const input = (body.messages || []).map((mm) => ({
          role: mm.role || 'user',
          content: typeof mm.content === 'string' ? mm.content : (Array.isArray(mm.content) ? mm.content.map((p) => p.text || '').join('') : ''),
        }));
        const rPayload = { model, input, stream: false };
        const maxTok = body.max_tokens || body.max_completion_tokens;
        if (maxTok) rPayload.max_output_tokens = maxTok;
        if (body.temperature !== undefined) rPayload.temperature = body.temperature;
        const up = await fetch(UPSTREAM.base + '/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${UPSTREAM.key}`, 'user-agent': UPSTREAM.ua },
          body: JSON.stringify(rPayload),
        });
        const text = await up.text();
        if (!up.ok) {
          let msg = 'upstream error';
          try { const ej = JSON.parse(text); msg = (ej.error && ej.error.message) || msg; } catch { /* keep generic */ }
          return send(res, up.status, { error: { message: msg.slice(0, 300), type: 'catsapi_gateway', upstream_status: up.status } });
        }
        let respObj = null;
        try { respObj = JSON.parse(text); } catch {
          // SSE fallback: find the response.completed event
          for (const line of text.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'response.completed' && ev.response) respObj = ev.response; } catch { /* skip */ }
          }
        }
        if (!respObj) return send(res, 502, { error: { message: 'upstream returned an unreadable response', type: 'catsapi_gateway' } });
        let outText = respObj.output_text || '';
        if (!outText && Array.isArray(respObj.output)) {
          for (const item of respObj.output) {
            if (item && item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) if (part && part.type === 'output_text') outText += part.text || '';
            }
          }
        }
        const u = respObj.usage || {};
        json = {
          id: respObj.id || ('chatcmpl-' + Date.now()),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: respObj.model || model,
          choices: [{ index: 0, message: { role: 'assistant', content: outText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)) },
        };
      } else {
        const payload = { ...body, model, stream: false };
        const up = await fetch(UPSTREAM.base + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${UPSTREAM.key}`, 'user-agent': UPSTREAM.ua },
          body: JSON.stringify(payload),
        });
        const text = await up.text();
        if (!up.ok) return send(res, up.status, { error: { message: 'upstream error', type: 'catsapi_gateway', upstream_status: up.status } });
        try { json = JSON.parse(text); } catch { return send(res, 502, { error: { message: 'upstream returned non-JSON', type: 'catsapi_gateway' } }); }
      }
      let tokens = json.usage && json.usage.total_tokens;
      if (!tokens) { // fallback estimate: ~4 chars per token
        const inChars = JSON.stringify(body.messages || '').length;
        const outChars = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || '').length;
        tokens = Math.ceil(inChars / 4) + Math.ceil(outChars / 4);
      }
      recordUsage(k.kh, tokens);
      return send(res, 200, json);
    }

    return err(res, 404, 'not found');
  } catch (e) {
    return err(res, 500, 'gateway error: ' + (e && e.message ? e.message.slice(0, 200) : 'unknown'));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`catsapi-gateway listening on 127.0.0.1:${PORT} contract=${CONTRACT} models=${UPSTREAM.models.join(',')}`);
});
