// GET /api/held?op=board&r=<rule>   -> dipping coins, X-rayed, with verdicts + the signal log
// GET /api/held?op=xray&ca=<mint>   -> one coin's dip X-ray (the check box)
// GET /api/held?op=outcome&pool=..&t=..  -> price 1h / 24h after a signal (for logs kept in the browser)
// Free, keyless: GeckoTerminal + public Solana RPC. The log is shared by every visitor:
// in memory, and in Upstash Redis when KV env vars exist (Vercel > Storage > Upstash, one click, no code change).
const H = require("../lib/held.js");

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const KEY = "held:log:v1";
const CACHE = new Map();                    // pool -> last X-ray
let LOG = null, savedSig = "";              // { since, items: [] }
const BOARD = new Map();                    // rule string -> { at, payload, running }

async function kvGet() {
  if (!KV_URL) return null;
  const r = await fetch(`${KV_URL}/get/${KEY}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json(); return j && j.result ? JSON.parse(j.result) : null;
}
async function kvSet(v) {
  if (!KV_URL) return;
  await fetch(`${KV_URL}/set/${KEY}`, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: JSON.stringify(v) });
}
async function loadLog() {
  if (LOG) return LOG;
  LOG = (await kvGet().catch(() => null)) || { since: Date.now(), items: [] };
  return LOG;
}
function addSignals(coins) {
  let added = 0;
  for (const x of coins) {
    if (x.err || (x.verdict !== "HELD" && x.verdict !== "SOLD")) continue;
    // one signal per coin per 6h (a new verdict on the same coin counts again)
    const prev = LOG.items.find(e => e.mint === x.mint && x.t - e.t < 6 * 3600000);
    if (prev && prev.verdict === x.verdict) continue;
    LOG.items.unshift(H.logEntry(x)); added++;
  }
  if (LOG.items.length > 400) LOG.items.length = 400;
  return added;
}
async function resolveSome(max) {
  const due = LOG.items.filter(e => (e.p1h == null && Date.now() > e.t + 3900000) || (e.p24h == null && Date.now() > e.t + 86700000 && Date.now() - e.t < 3 * 86400000)).slice(0, max);
  let ch = 0;
  for (const e of due) { try { if (await H.outcome(e)) ch++; } catch (err) { break; } }
  return ch;
}
// calls sent in by visitors' browsers. Light checks: real-looking fields, fresh, one call per coin per 6h.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let lastAdds = [];
function mergeLog(items) {
  let n = 0; const now = Date.now();
  lastAdds = lastAdds.filter(t => now - t < 3600000);
  for (const e of items.slice(0, 30)) {
    if (!e || !B58.test(e.mint || "") || !B58.test(e.pool || "") || (e.verdict !== "HELD" && e.verdict !== "SOLD")) continue;
    const price = +e.price, t = +e.t; if (!(price > 0) || !isFinite(t)) continue;
    const o = LOG.items.find(x => x.id === e.id);
    if (o) { // outcomes, only once, only when due
      if (o.p1h == null && +e.p1h > 0 && now > o.t + 3600000) { o.p1h = +e.p1h; n++; }
      if (o.p24h == null && +e.p24h > 0 && now > o.t + 86400000) { o.p24h = +e.p24h; n++; }
      continue;
    }
    if (Math.abs(now - t) > 20 * 60000 || lastAdds.length > 120) continue;
    if (LOG.items.some(x => x.mint === e.mint && x.verdict === e.verdict && Math.abs(x.t - t) < 6 * 3600000)) continue;
    LOG.items.unshift({ id: String(e.id).slice(0, 40), mint: e.mint, pool: e.pool, sym: String(e.sym || "").replace(/[^\w$.-]/g, "").slice(0, 14), verdict: e.verdict, t, price,
      dip: +e.dip || 0, heldPct: +e.heldPct || 0, paperSoldSol: +e.paperSoldSol || 0, whaleSoldSol: +e.whaleSoldSol || 0, reason: String(e.reason || "").slice(0, 120) });
    lastAdds.push(now); n++;
  }
  LOG.items.sort((a, b) => b.t - a.t); if (LOG.items.length > 400) LOG.items.length = 400;
  return n;
}
const sig = () => LOG.items.slice(0, 80).map(e => e.id + (e.p1h ? 1 : 0) + (e.p24h ? 1 : 0)).join("");

async function buildBoard(rs) {
  const R = H.ruleFrom(rs);
  await loadLog();
  const b = await H.board(R, CACHE);
  addSignals(b.coins);
  await resolveSome(4);
  const s = sig();
  if (KV_URL && s !== savedSig) { savedSig = s; await kvSet(LOG).catch(() => {}); }
  return Object.assign(b, { source: "api", storage: KV_URL ? "shared" : "memory", log: { since: LOG.since, items: LOG.items.slice(0, 80), stats: H.logStats(LOG.items) } });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = req.query || {};
  const op = q.op || "board";
  try {
    if (op === "board") {
      const rs = String(q.r || H.ruleStr(H.RULE)).slice(0, 120);
      let B = BOARD.get(rs);
      if (!B) { B = { at: 0, payload: null, running: null }; BOARD.set(rs, B); }
      if (!B.payload || Date.now() - B.at > 40000) {
        if (!B.running) B.running = buildBoard(rs).then(p => { B.payload = p; B.at = Date.now(); }).finally(() => { B.running = null; });
        if (!B.payload) await B.running; else await Promise.race([B.running, new Promise(r => setTimeout(r, 200))]).catch(() => {});
      }
      if (!B.payload) throw new Error("board not ready");
      res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=240");
      return res.status(200).json(B.payload);
    }
    if (op === "xray") {
      const ca = String(q.ca || "").trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return res.status(400).json({ error: "not a Solana address" });
      const R = H.ruleFrom(q.r);
      const { pool, solUsd } = await H.poolsForMint(ca);
      if (!pool) return res.status(404).json({ error: "no SOL or USDC pool found for this coin on GeckoTerminal yet" });
      const cached = CACHE.get(pool.pool);
      const x = cached && Date.now() - cached.t < 60000 ? Object.assign({}, cached, H.verdict(cached, R)) : await H.xray(pool, R, solUsd);
      CACHE.set(pool.pool, x);
      res.setHeader("Cache-Control", "public, s-maxage=50, stale-while-revalidate=120");
      return res.status(200).json(x);
    }
    if (op === "log") {
      await loadLog();
      if (req.method === "POST") {
        let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
        const n = mergeLog((body && body.items) || []);
        if (n && KV_URL) await kvSet(LOG).catch(() => {});
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).json({ ok: true, merged: n });
      }
      res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=60");
      return res.status(200).json({ since: LOG.since, storage: KV_URL ? "shared" : "memory", items: LOG.items.slice(0, 120) });
    }
    if (op === "diag") { res.setHeader("Cache-Control", "no-store"); return res.status(200).json(Object.assign(await H.diag(), { stat: H.STAT })); }
    if (op === "outcome") {
      const pool = String(q.pool || ""), t = parseInt(q.t, 10);
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool) || !isFinite(t)) return res.status(400).json({ error: "pool and t needed" });
      const e = { pool, t }; await H.outcome(e);
      const done = e.p1h != null && e.p24h != null;
      res.setHeader("Cache-Control", done ? "public, s-maxage=86400" : "public, s-maxage=300");
      return res.status(200).json({ pool, t, p1h: e.p1h ?? null, p24h: e.p24h ?? null });
    }
    return res.status(400).json({ error: "unknown op" });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: String((e && e.message) || e), stat: H.STAT });
  }
};
