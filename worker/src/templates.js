// HTML templates carried over verbatim from the VM gateway (server.mjs),
// except the dashboard's tunnel card, which now shows the fixed Worker endpoint.
export const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CatsApi Gateway — NFT-gated LLM API</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e8ecf3;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.6}code{background:#121826;padding:2px 6px;border-radius:6px;color:#f0b90b}pre{background:#121826;padding:14px;border-radius:10px;overflow:auto}a{color:#f0b90b}</style></head>
<body><h1>CatsApi Gateway</h1>
<p>An OpenAI-compatible LLM API gated by <b>CatsApi NFT</b> ownership on BNB Smart Chain.
Each NFT unlocks a monthly token quota by tier (Common 500K · Rare 1M · Epic 5M · Legendary 20M · Mythic 50M; quotas stack).</p>
<h2>1. Get a key</h2>
<p>Sign EIP-712 typed data with the wallet that holds your CatsApi (no transaction, no gas):
domain <code>{name: "CatsApi Gateway", version: "1", chainId: 56, verifyingContract: "0x39666Ccf900f0213cEF6FaE28537532c9B0E75C9"}</code>,
type <code>KeyRequest {wallet: address, timestamp: uint256}</code>, message = your address + current unix time in milliseconds.</p>
<p>Then POST it:</p>
<pre>curl -X POST ${''}/v1/keys -H 'content-type: application/json' -d '{
  "address": "0x...", "timestamp": 1760000000000, "signature": "0x..."
}'</pre>
<p>Full spec for agents: <a href="/llms.txt">/llms.txt</a> · <a href="/agent-manifest.json">/agent-manifest.json</a>.
Unsure whether a wallet holds a cat? <code>GET /v1/holder/&lt;address&gt;</code> shows what the gateway detects.</p>
<h2>2. Call the API</h2>
<pre>curl /v1/chat/completions -H "Authorization: Bearer sk-cats-..." \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-4-argon","messages":[{"role":"user","content":"Hello"}]}'</pre>
<h2>3. Or plug it into any OpenAI client</h2>
<p>This gateway speaks the OpenAI API format, so any compatible app or SDK works as-is.
Authentication with the upstream provider is handled <b>by the gateway itself</b> —
as a user you configure exactly two things, nothing else:</p>
<pre>from openai import OpenAI

client = OpenAI(
    base_url="https://api.prjktspace.web.id/v1",
    api_key="sk-cats-...",                            # your key from step 1
)
client.chat.completions.create(
    model="gemini-4-argon",
    messages=[{"role": "user", "content": "Hello"}],
)</pre>
<p>Same recipe in ChatBox, LobeChat, LibreChat and other OpenAI-compatible apps:
Base URL = <code>https://api.prjktspace.web.id/v1</code>, API Key = your <code>sk-cats-</code> key, Model = <code>gemini-4-argon</code>.</p>
<p>Check usage any time at <code>GET /v1/me</code> with your key. Keys rotate: asking for a new key revokes the old one.
Mint a cat at <a href="https://gateway.prjktspace.web.id/">gateway.prjktspace.web.id</a> — Agent ID holders mint their first one free.</p>
</body></html>`;

export const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CatsApi Gateway — Owner Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js"></script>
<style>
body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e8ecf3;max-width:1060px;margin:0 auto;padding:28px 18px;line-height:1.55}
h1{font-size:24px} h2{font-size:16px;color:#f0b90b;margin:0 0 8px}
a{color:#f0b90b} code{background:#121826;padding:2px 6px;border-radius:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:16px 0}
.card{background:#121826;border:1px solid #1e293b;border-radius:12px;padding:16px}
.big{font-size:22px;font-weight:700}
.mut{color:#8b98ad;font-size:13px}
.bar{height:8px;background:#1e293b;border-radius:99px;overflow:hidden;margin-top:8px}
.bar>i{display:block;height:100%;background:#f0b90b}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border-bottom:1px solid #1e293b;padding:7px 6px;text-align:left;vertical-align:top}
button{background:#f0b90b;color:#111;border:0;padding:9px 14px;border-radius:9px;font-weight:700;cursor:pointer}
button.ghost{background:#1e293b;color:#e8ecf3}
button:disabled{opacity:.45;cursor:default}
.ok{color:#4ade80}.bad{color:#f87171}
input{background:#0b0e14;border:1px solid #1e293b;color:#e8ecf3;border-radius:8px;padding:8px}
</style></head>
<body>
<h1>CatsApi Gateway — Owner Dashboard</h1>
<div id="loginView">
  <p>Owner-only. Sign in by signing a message with the <b>contract owner wallet</b> (checked on-chain against the CatsApi contract). No transaction, no gas. The session lasts 24 hours in this browser.</p>
  <button id="loginBtn">Sign in with owner wallet</button>
  <p id="loginMsg" class="mut"></p>
</div>
<div id="dashView" style="display:none">
  <p><button class="ghost" id="refreshBtn">Refresh</button> <button class="ghost" id="logoutBtn">Log out</button> <span id="dashMsg" class="mut"></span></p>
  <div class="grid">
    <div class="card"><h2>Contract</h2><div id="cContract"></div></div>
    <div class="card"><h2>Usage this month</h2><div id="cUsage"></div></div>
    <div class="card"><h2>Provider</h2><div id="cProvider"></div></div>
    <div class="card"><h2>Public endpoint</h2><div id="cTunnel"></div></div>
  </div>
  <div class="card"><h2>API keys</h2><div id="cKeys"></div></div>
</div>
<script>
var S = localStorage.getItem("catsAdminSession") || null;
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;");}
function short(a){return a? a.slice(0,6)+"…"+a.slice(-4) : "—";}
async function api(path, opts){
  opts = opts || {}; opts.headers = opts.headers || {};
  opts.headers["authorization"] = "Bearer " + S;
  var r = await fetch(path, opts); var j = await r.json();
  if(!r.ok) throw new Error((j.error && j.error.message) || ("HTTP "+r.status));
  return j;
}
document.getElementById("loginBtn").onclick = async function(){
  var msg = document.getElementById("loginMsg");
  try{
    if(!window.ethereum) throw new Error("No wallet found — open this page in your wallet browser.");
    var p = new ethers.BrowserProvider(window.ethereum);
    var s = await p.getSigner(); var address = await s.getAddress();
    msg.textContent = "Sign the admin login in your wallet…";
    var message = "CatsApi Gateway admin login\nAddress: " + address + "\nTimestamp: " + Date.now();
    var signature = await s.signMessage(message);
    var r = await fetch("/admin/login", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({address:address, message:message, signature:signature})});
    var j = await r.json();
    if(!r.ok) throw new Error((j.error && j.error.message) || "login failed");
    S = j.session; localStorage.setItem("catsAdminSession", S);
    msg.textContent = "";
    showDash(); load();
  }catch(e){ msg.textContent = "Error: " + (e.shortMessage || e.message); }
};
function showDash(){
  document.getElementById("loginView").style.display = "none";
  document.getElementById("dashView").style.display = "block";
}
document.getElementById("logoutBtn").onclick = function(){ localStorage.removeItem("catsAdminSession"); location.reload(); };
document.getElementById("refreshBtn").onclick = function(){ load(); };
async function load(){
  var dm = document.getElementById("dashMsg");
  try{
    var o = await api("/admin/overview");
    var k = await api("/admin/keys");
    document.getElementById("cContract").innerHTML =
      "Contract <code>" + short(o.contract) + "</code><br>Owner <code>" + short(o.owner) + "</code><br>" +
      "<span class='big'>" + (o.mint ? o.mint.totalMinted : "?") + "</span> minted · " + (o.mint ? o.mint.freeMinted : "?") + " free";
    var pct = o.global_monthly_cap ? Math.min(100, Math.round(100 * o.global_used_this_month / o.global_monthly_cap)) : 0;
    document.getElementById("cUsage").innerHTML =
      "<span class='big'>" + o.global_used_this_month.toLocaleString() + "</span> / " + o.global_monthly_cap.toLocaleString() + " tokens<br>" +
      "<span class='mut'>Period " + esc(o.period) + " · keys: " + o.keys_active + " active, " + o.keys_revoked + " revoked</span>" +
      "<div class='bar'><i style='width:" + pct + "%'></i></div>";
    var pr = o.provider || {};
    document.getElementById("cProvider").innerHTML =
      "<b>" + esc(pr.name || "—") + "</b> " + (pr.ok ? "<span class='ok'>● up</span>" : "<span class='bad'>● down</span>") + "<br>" +
      "<span class='mut'>" + esc(pr.base || "") + " · style " + esc(pr.style || "") + "<br>Models: " + esc((pr.models || []).join(", ")) + "<br>Probed " + esc(pr.probed_at || "") + (pr.error ? "<br>" + esc(pr.error) : "") + "</span>";
    document.getElementById("cTunnel").innerHTML =
      "<a href='https://api.prjktspace.web.id/health' target='_blank'>api.prjktspace.web.id</a><br><span class='mut'>Served by a Cloudflare Worker — fixed domain, no tunnel.</span>";
    var rows = k.keys.map(function(x){
      var toks = (x.tokens || []).map(function(t){ return "#" + t.tokenId + " " + t.tier; }).join(", ") || "—";
      var rem = x.quota_per_month != null ? Math.max(0, x.quota_per_month - x.used_this_month).toLocaleString() : "—";
      return "<tr><td><code>" + short(x.address) + "</code><br><span class='mut'>" + esc(x.id) + "</span></td>" +
        "<td>" + esc(toks) + "</td>" +
        "<td>" + (x.quota_per_month != null ? x.quota_per_month.toLocaleString() : "—") + "</td>" +
        "<td>" + x.used_this_month.toLocaleString() + "</td><td>" + rem + "</td>" +
        "<td>" + x.requests + "</td><td>" + esc(x.last_used_at || "—") + "</td>" +
        "<td>" + (x.revoked ? "<span class='bad'>revoked</span>" : "<span class='ok'>active</span>") + "</td>" +
        "<td>" + (x.revoked ? "" : "<button class='ghost' data-revoke='" + esc(x.id) + "'>Revoke</button>") + "</td></tr>";
    }).join("");
    document.getElementById("cKeys").innerHTML = k.keys.length
      ? "<table><tr><th>Wallet / key</th><th>Tokens</th><th>Quota/mo</th><th>Used</th><th>Left</th><th>Req</th><th>Last used</th><th>Status</th><th></th></tr>" + rows + "</table>"
      : "<span class='mut'>No keys issued yet.</span>";
    var btns = document.querySelectorAll("[data-revoke]");
    for(var i=0;i<btns.length;i++){ btns[i].onclick = async function(){
      var hp = this.getAttribute("data-revoke");
      if(!confirm("Revoke key " + hp + "? The holder loses API access immediately.")) return;
      await api("/admin/revoke", {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({hash_prefix: hp})});
      load();
    }; }
    dm.textContent = "Updated " + new Date().toLocaleTimeString();
  }catch(e){
    dm.textContent = "Error: " + e.message;
    if(/invalid|session/i.test(e.message)){ localStorage.removeItem("catsAdminSession"); }
  }
}
if(S){ showDash(); load(); setInterval(function(){ if(S) load(); }, 30000); }
</script>
</body></html>`;
