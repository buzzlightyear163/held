/* HELD core: finds Solana coins that are dipping, reads who sold the dip, and decides.
   Runs in the Vercel function (api/held.js) and in the browser (fallback when the API is down).
   Free, keyless sources only: GeckoTerminal (pools, trades, candles) and public Solana RPC (holders). */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m; else root.HELDCORE = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const GT = "https://api.geckoterminal.com/api/v2";
  const RPCS = ["https://solana-rpc.publicnode.com", "https://public.rpc.solanavibestation.com", "https://api.mainnet-beta.solana.com"];
  const SOL = "So11111111111111111111111111111111111111112";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const SYS = "11111111111111111111111111111111";
  const QUOTES = new Set([SOL, USDC, USDT]);
  // majors, wrapped assets and LSTs: never "dips" we care about
  const SKIP = new Set([SOL, USDC, USDT,
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb"]);
  // owners of pool vaults that are plain system accounts (PDAs with lamports): never "whales"
  const POOL_AUTH = new Set(["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", "1nc1nerator11111111111111111111111111111111", "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"]);

  // the rule. index.html CONFIG.rule overrides these and sends them along (?r=...)
  const RULE = {
    dip: 30,       // % drop in the last hour that triggers a check
    watch: 12,     // smaller drops still show on the board as WATCH
    held: 95,      // top 10 must still hold this % of what they held before the dip -> WOULD BUY
    sold: 85,      // below this the whales sold -> SKIP
    dump: 50,      // one whale (1%+ of supply) selling this % of its bag -> SKIP
    paper: 60,     // at least this % of the dip's selling came from outside the top 10
    windowMin: 60, // how far back the dip is read
    minLiq: 8000,  // pool liquidity floor, $
    minVol: 4000,  // 1h volume floor, $
    boardMax: 7,   // coins X-rayed per scan
  };
  const RULE_KEYS = ["dip", "watch", "held", "sold", "dump", "paper", "windowMin", "minLiq", "minVol", "boardMax"];
  const ruleFrom = s => { const R = Object.assign({}, RULE); if (s) String(s).split(",").forEach((v, i) => { const n = parseFloat(v); if (RULE_KEYS[i] && isFinite(n)) R[RULE_KEYS[i]] = n; }); return R; };
  const ruleStr = R => RULE_KEYS.map(k => R[k]).join(",");

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const nowS = () => Date.now();

  // polite queues: GeckoTerminal allows ~30 calls/min per IP
  function queue(gap, conc) {
    const q = []; let running = 0, last = 0, timer = null;
    function pump() {
      timer = null;
      while (running < conc && q.length) {
        const wait = last + gap - Date.now(); if (wait > 0) { if (!timer) timer = setTimeout(pump, wait); return; }
        last = Date.now(); const job = q.shift(); running++;
        Promise.resolve().then(job.fn).then(job.res, job.rej).finally(() => { running--; pump(); });
      }
    }
    return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); });
  }
  const gq = queue(260, 2), rq = queue(40, 6);
  const STAT = { gt: 0, gtErr: 0, rpc: 0, rpcErr: 0, last429: 0 };

  async function getJSON(url, opt, ms) {
    const c = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = c ? setTimeout(() => c.abort(), ms || 9000) : null;
    try {
      const r = await fetch(url, Object.assign({ headers: { accept: "application/json" } }, opt || {}, c ? { signal: c.signal } : {}));
      if (!r.ok) { const e = new Error("http " + r.status); e.status = r.status; throw e; }
      return await r.json();
    } finally { if (t) clearTimeout(t); }
  }
  async function gt(path) {
    for (let i = 0; i < 3; i++) {
      try { const j = await gq(() => getJSON(GT + path)); STAT.gt++; return j; }
      catch (e) { STAT.gtErr++; if (e.status === 429) { STAT.last429 = Date.now(); await sleep(1600 * (i + 1)); continue; } if (i === 2 || (e.status && e.status !== 502 && e.status !== 503)) throw e; await sleep(500); }
    }
    throw new Error("geckoterminal busy");
  }
  let rpcAt = 0;
  async function rpc(method, params) {
    let last;
    for (let i = 0; i < RPCS.length; i++) {
      const at = (rpcAt + i) % RPCS.length;
      try {
        const j = await rq(() => getJSON(RPCS[at], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, 8000));
        if (j.error) throw new Error(j.error.message || "rpc error");
        rpcAt = at; STAT.rpc++; return j.result;
      } catch (e) { last = e; STAT.rpcErr++; }
    }
    throw last || new Error("rpc down");
  }

  // ---------- pools ----------
  function poolOf(p, tokens) {
    const a = p.attributes || {}, rel = p.relationships || {};
    const base = ((rel.base_token || {}).data || {}).id || "", quote = ((rel.quote_token || {}).data || {}).id || "";
    const mint = base.replace(/^solana_/, ""), qm = quote.replace(/^solana_/, "");
    const ch = a.price_change_percentage || {}, tx = (a.transactions || {}).h1 || {}, v = a.volume_usd || {};
    const name = String(a.name || ""), sym = (name.split(" / ")[0] || "").trim().slice(0, 14);
    const C = k => ch[k] == null || ch[k] === "" ? null : num(ch[k]);
    const o = {
      pool: a.address, mint, quote: qm, sym, name: (tokens && tokens[mint]) || "", dex: ((rel.dex || {}).data || {}).id || "",
      price: num(a.base_token_price_usd), quoteUsd: num(a.quote_token_price_usd), fdv: num(a.market_cap_usd) || num(a.fdv_usd), liq: num(a.reserve_in_usd),
      vol1h: num(v.h1), vol24h: num(v.h24), tx1h: (tx.buys || 0) + (tx.sells || 0), sells1h: tx.sells || 0, sellers1h: tx.sellers || 0,
      ch: { m5: C("m5"), m15: C("m15"), m30: C("m30"), h1: C("h1"), h6: C("h6"), h24: C("h24") }, created: a.pool_created_at || null,
    };
    o.dip = Math.min(o.ch.h1 ?? 0, o.ch.m30 ?? 0);
    return o;
  }
  const solUsdOf = pools => { const v = pools.filter(p => p.quote === SOL && p.quoteUsd > 5).map(p => p.quoteUsd).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; };

  async function scanList() {
    const paths = ["/networks/solana/trending_pools?duration=1h&page=1", "/networks/solana/trending_pools?duration=1h&page=2",
      "/networks/solana/trending_pools?duration=6h&page=1", "/networks/solana/pools?page=1&sort=h24_tx_count_desc"];
    const res = await Promise.allSettled(paths.map(p => gt(p)));
    const all = [];
    for (const r of res) if (r.status === "fulfilled" && r.value && r.value.data) for (const p of r.value.data) all.push(poolOf(p));
    if (!all.length) throw new Error("no pools (" + res.map(r => r.status === "rejected" ? r.reason.message : "ok").join(",") + ")");
    const best = new Map();
    for (const p of all) {
      if (!p.mint || !p.pool || SKIP.has(p.mint) || !QUOTES.has(p.quote)) continue;
      const b = best.get(p.mint); if (!b || p.liq > b.liq) best.set(p.mint, p);
    }
    return { pools: [...best.values()], solUsd: solUsdOf(all), scanned: all.length };
  }

  async function poolsForMint(mint) {
    const j = await gt("/networks/solana/tokens/" + mint + "/pools?page=1");
    const ps = (j.data || []).map(p => poolOf(p)).filter(p => p.mint === mint && QUOTES.has(p.quote));
    ps.sort((a, b) => b.liq - a.liq);
    return { pool: ps[0] || null, solUsd: solUsdOf((j.data || []).map(p => poolOf(p))) };
  }

  // ---------- trades in the dip ----------
  function parseTrades(j, mint) {
    const out = [];
    for (const d of (j && j.data) || []) {
      const a = d.attributes || {}; if (a.is_anomalous) continue;
      const sell = a.kind === "sell";
      const tok = sell ? num(a.from_token_amount) : num(a.to_token_amount);
      const other = sell ? a.to_token_address : a.from_token_address, otherAmt = sell ? num(a.to_token_amount) : num(a.from_token_amount);
      if ((sell ? a.from_token_address : a.to_token_address) !== mint) continue;
      out.push({ tx: a.tx_hash, w: a.tx_from_address, sell, tok, usd: num(a.volume_in_usd), sol: other === SOL ? otherAmt : null, t: Date.parse(a.block_timestamp) || 0 });
    }
    return out;
  }
  async function tradesFor(p, R) {
    const since = nowS() - R.windowMin * 60000;
    const all = parseTrades(await gt("/networks/solana/pools/" + p.pool + "/trades"), p.mint);
    let oldest = all.length ? Math.min(...all.map(t => t.t)) : nowS();
    const full = all.length < 290 || oldest <= since; // every trade in the window is here
    let big = [], bigMin = 0, bigOldest = oldest;
    if (!full) { // busy coin: pull the big trades over the whole window, where whale exits live
      bigMin = Math.round(Math.min(5000, Math.max(150, (p.fdv || 0) * 0.0004)));
      big = parseTrades(await gt("/networks/solana/pools/" + p.pool + "/trades?trade_volume_in_usd_greater_than=" + bigMin), p.mint);
      bigOldest = big.length ? Math.min(...big.map(t => t.t)) : nowS();
    }
    const seen = new Set(), trades = [];
    for (const t of all.concat(big)) if (!seen.has(t.tx + t.w + t.sell + t.tok) && t.t >= since) { seen.add(t.tx + t.w + t.sell + t.tok); trades.push(t); }
    const allMin = Math.min(R.windowMin, Math.round((nowS() - Math.max(oldest, since)) / 60000));
    const bigCov = full ? R.windowMin : Math.min(R.windowMin, Math.round((nowS() - Math.max(bigOldest, since)) / 60000));
    return { trades, cover: { all: full ? R.windowMin : allMin, big: bigCov, bigMin, full } };
  }

  // ---------- holders (public RPC) ----------
  async function holdersFor(p) {
    const [largest, supply] = await Promise.all([rpc("getTokenLargestAccounts", [p.mint, { commitment: "confirmed" }]), rpc("getTokenSupply", [p.mint]).catch(() => null)]);
    const accs = ((largest && largest.value) || []).filter(a => num(a.uiAmountString || a.uiAmount) > 0);
    if (!accs.length) throw new Error("no holders");
    const info = await rpc("getMultipleAccounts", [accs.map(a => a.address), { encoding: "jsonParsed" }]);
    const rows = accs.map((a, i) => { const v = info && info.value && info.value[i]; const pi = v && v.data && v.data.parsed && v.data.parsed.info; return { acc: a.address, owner: pi ? pi.owner : null, amt: num(a.uiAmountString || a.uiAmount) }; }).filter(r => r.owner);
    const owners = [...new Set(rows.map(r => r.owner))];
    const oi = await rpc("getMultipleAccounts", [owners, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    const prog = {}; owners.forEach((o, i) => { const v = oi && oi.value && oi.value[i]; prog[o] = v ? v.owner : SYS; });
    const isPool = o => o === p.pool || POOL_AUTH.has(o) || (prog[o] && prog[o] !== SYS);
    const by = new Map();
    for (const r of rows) {
      const k = r.owner, cur = by.get(k) || { owner: k, now: 0, accs: [], pool: isPool(k) };
      cur.now += r.amt; cur.accs.push(r.acc); by.set(k, cur);
    }
    const sup = supply && supply.value ? num(supply.value.uiAmountString || supply.value.uiAmount) : 0;
    const list = [...by.values()].sort((a, b) => b.now - a.now);
    return { list, supply: sup, poolTok: list.filter(h => h.pool).reduce((s, h) => s + h.now, 0), minListed: list.length ? list[list.length - 1].now : 0 };
  }
  async function balanceOf(owner, mint) {
    const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
    return ((r && r.value) || []).reduce((s, a) => s + num(a.account.data.parsed.info.tokenAmount.uiAmountString || a.account.data.parsed.info.tokenAmount.uiAmount), 0);
  }
  // a whale whose token account moved inside the window but has no matching trade: read the real change on-chain
  async function movedFor(h, mint, since) {
    let delta = 0, touched = false;
    for (const acc of h.accs.slice(0, 2)) {
      const sigs = await rpc("getSignaturesForAddress", [acc, { limit: 6 }]).catch(() => []);
      const inWin = (sigs || []).filter(s => !s.err && s.blockTime && s.blockTime * 1000 >= since);
      if (!inWin.length) continue;
      touched = true;
      for (const s of inWin.slice(0, 3)) {
        const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => null);
        if (!tx || !tx.meta) continue;
        const bal = arr => (arr || []).filter(b => b.mint === mint && b.owner === h.owner).reduce((s2, b) => s2 + num(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount), 0);
        delta += bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
      }
    }
    return { touched, delta };
  }

  // ---------- the X-ray ----------
  async function xray(p, R, solUsd) {
    R = R || RULE;
    const since = nowS() - R.windowMin * 60000;
    const solPx = p.quote === SOL && p.quoteUsd > 5 ? p.quoteUsd : (solUsd || 0);
    const [T, H] = await Promise.all([tradesFor(p, R), holdersFor(p)]);
    const solOf = t => t.sol != null ? t.sol : solPx ? t.usd / solPx : 0;
    // per wallet flow inside the window
    const flow = new Map();
    for (const t of T.trades) {
      const f = flow.get(t.w) || { sold: 0, bought: 0, soldSol: 0, boughtSol: 0, n: 0 };
      if (t.sell) { f.sold += t.tok; f.soldSol += solOf(t); } else { f.bought += t.tok; f.boughtSol += solOf(t); }
      f.n++; flow.set(t.w, f);
    }
    // candidates: today's top holders + the biggest sellers of the dip (a whale that sold out has left the top list)
    const cand = new Map();
    for (const h of H.list) if (!h.pool) cand.set(h.owner, { owner: h.owner, now: h.now, accs: h.accs, listed: true });
    const sellers = [...flow.entries()].filter(([w, f]) => f.sold > 0 && !cand.has(w)).sort((a, b) => b[1].sold - a[1].sold).slice(0, 6);
    const pre0 = H.list.filter(h => !h.pool).map(h => h.now).sort((a, b) => b - a)[9] || 0;
    await Promise.all(sellers.map(async ([w, f]) => {
      if (f.sold + H.minListed < pre0 * 0.6) return; // too small to have been a top 10 bag
      let now = 0; try { now = await balanceOf(w, p.mint); } catch (e) { now = 0; }
      cand.set(w, { owner: w, now, accs: [], listed: false });
    }));
    for (const c of cand.values()) {
      const f = flow.get(c.owner) || { sold: 0, bought: 0, soldSol: 0, boughtSol: 0, n: 0 };
      c.f = f; c.pre = Math.max(0, c.now + f.sold - f.bought);
    }
    let ranked = [...cand.values()].filter(c => c.pre > 0).sort((a, b) => b.pre - a.pre).slice(0, 10);
    // RPC check: did a whale's bag move in the window without a trade we saw (transfers, small sells, other pools)?
    let verified = 0;
    await Promise.all(ranked.map(async c => {
      if (!c.listed || c.f.n) return;
      try { const m = await movedFor(c, p.mint, since); verified++; if (m.touched && m.delta) { c.moved = m.delta; c.pre = Math.max(c.pre, c.now - m.delta); } } catch (e) { /* keep trade-based read */ }
    }));
    ranked = ranked.sort((a, b) => b.pre - a.pre).slice(0, 10);
    const whaleSet = new Set(ranked.map(c => c.owner));
    let preSum = 0, keptSum = 0, whaleSoldSol = 0, whaleBoughtSol = 0, paperSoldSol = 0, sellSol = 0, paperSellers = 0;
    const whales = ranked.map((c, i) => {
      const kept = Math.min(c.now, c.pre); preSum += c.pre; keptSum += kept;
      whaleSoldSol += c.f.soldSol; whaleBoughtSol += c.f.boughtSol;
      return { rank: i + 1, owner: c.owner, pre: c.pre, now: c.now, held: c.pre ? kept / c.pre : 1, supplyPct: H.supply ? c.pre / H.supply * 100 : null, soldSol: c.f.soldSol, boughtSol: c.f.boughtSol, moved: c.moved || 0, left: !c.listed };
    });
    for (const [w, f] of flow) { sellSol += f.soldSol; if (!whaleSet.has(w) && f.soldSol > 0) { paperSoldSol += f.soldSol; paperSellers++; } }
    const heldPct = preSum ? keptSum / preSum * 100 : 100;
    const x = {
      mint: p.mint, pool: p.pool, sym: p.sym, dex: p.dex, price: p.price, fdv: p.fdv, liq: p.liq, vol1h: p.vol1h, ch: p.ch, dip: p.dip, t: nowS(),
      cover: Object.assign({ trades: T.trades.length, verified }, T.cover), supply: H.supply,
      whales, heldPct, whaleSoldSol, whaleBoughtSol, paperSoldSol, paperSellers, sellSol,
      paperShare: sellSol > 0 ? paperSoldSol / sellSol * 100 : 100, poolPct: H.supply ? H.poolTok / H.supply * 100 : null,
    };
    Object.assign(x, verdict(x, R));
    return x;
  }

  const f0 = v => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  const solTxt = v => (v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100) + " SOL";
  function verdict(x, R) {
    const drop = -Math.min(0, x.dip || 0);
    const dumper = (x.whales || []).find(w => (w.supplyPct == null || w.supplyPct >= 1) && (1 - w.held) * 100 >= R.dump);
    const heldTxt = "top 10 held " + Math.floor(x.heldPct) + "%";
    if (x.heldPct < R.sold || dumper) {
      return { verdict: "SOLD", engine: "skip", reason: dumper ? "whale #" + dumper.rank + " sold " + Math.round((1 - dumper.held) * 100) + "% of its bag" + (dumper.soldSol >= 0.05 ? " (" + solTxt(dumper.soldSol) + ")" : "") : heldTxt + " · whales sold " + solTxt(x.whaleSoldSol) };
    }
    if (drop < R.watch) return { verdict: "NODIP", engine: "skip", reason: "no dip: " + (x.dip >= 0 ? "+" : "−") + f0(Math.abs(x.dip)) + "% in the last hour" };
    if (drop < R.dip) return { verdict: "WATCH", engine: "watch", reason: "dip −" + f0(drop) + "% · triggers at −" + R.dip + "%" };
    if (x.heldPct >= R.held && x.paperShare >= R.paper) return { verdict: "HELD", engine: "would buy", reason: heldTxt + " · paper hands sold " + solTxt(x.paperSoldSol) };
    if (x.heldPct < R.held) return { verdict: "WATCH", engine: "watch", reason: heldTxt + " · needs " + R.held + "%" };
    return { verdict: "WATCH", engine: "watch", reason: "whales are " + Math.round(100 - x.paperShare) + "% of the selling" };
  }

  // ---------- the board ----------
  async function board(R, cache) {
    R = R || RULE; cache = cache || new Map();
    const L = await scanList();
    const dipping = L.pools.filter(p => -p.dip >= R.watch && p.liq >= R.minLiq && p.vol1h >= R.minVol).sort((a, b) => a.dip - b.dip);
    const pick = dipping.slice(0, R.boardMax);
    const coins = [];
    for (const p of pick) {
      const k = p.pool, c = cache.get(k);
      if (c && nowS() - c.t < 150000) { coins.push(Object.assign({}, c, { price: p.price, ch: p.ch, dip: p.dip, fdv: p.fdv, liq: p.liq }, verdict(Object.assign({}, c, { dip: p.dip }), R))); continue; }
      try { const x = await xray(p, R, L.solUsd); cache.set(k, x); coins.push(x); }
      catch (e) { coins.push({ mint: p.mint, pool: p.pool, sym: p.sym, price: p.price, fdv: p.fdv, liq: p.liq, ch: p.ch, dip: p.dip, t: nowS(), err: String(e.message || e), verdict: "WATCH", engine: "watch", reason: "holder read failed, retrying" }); }
    }
    for (const [k, v] of cache) if (nowS() - v.t > 900000) cache.delete(k);
    return { t: nowS(), solUsd: L.solUsd, scanned: L.scanned, watched: L.pools.length, dipping: dipping.length, deep: dipping.filter(p => -p.dip >= R.dip).length, rule: R, coins };
  }

  // ---------- price after a signal (for the log) ----------
  async function priceAt(pool, ts) { // close of the 5-minute candle right before ts
    const j = await gt("/networks/solana/pools/" + pool + "/ohlcv/minute?aggregate=5&limit=1&currency=usd&before_timestamp=" + Math.floor(ts / 1000));
    const l = (((j || {}).data || {}).attributes || {}).ohlcv_list || [];
    return l.length ? num(l[0][4]) : null;
  }
  async function outcome(e) { // fills p1h / p24h when they are due
    const n = nowS(); let changed = false;
    if (e.p1h == null && n > e.t + 3600000 + 300000) { const v = await priceAt(e.pool, e.t + 3600000); if (v) { e.p1h = v; changed = true; } }
    if (e.p24h == null && n > e.t + 86400000 + 300000) { const v = await priceAt(e.pool, e.t + 86400000); if (v) { e.p24h = v; changed = true; } }
    return changed;
  }
  function logStats(items) {
    const S = { HELD: { n: 0, r1: 0, w1: 0, sum1: 0, r24: 0, w24: 0, sum24: 0 }, SOLD: { n: 0, r1: 0, w1: 0, sum1: 0, r24: 0, w24: 0, sum24: 0 } };
    for (const e of items) {
      const s = S[e.verdict]; if (!s) continue; s.n++;
      const up = e.verdict === "HELD";
      if (e.p1h != null && e.price) { const c = (e.p1h / e.price - 1) * 100; s.r1++; s.sum1 += c; if (up ? c > 0 : c < 0) s.w1++; }
      if (e.p24h != null && e.price) { const c = (e.p24h / e.price - 1) * 100; s.r24++; s.sum24 += c; if (up ? c > 0 : c < 0) s.w24++; }
    }
    return S;
  }
  function logEntry(x) {
    return { id: x.mint.slice(0, 8) + "-" + Math.floor(x.t / 60000), mint: x.mint, pool: x.pool, sym: x.sym, verdict: x.verdict, t: x.t, price: x.price, dip: x.dip, heldPct: x.heldPct, paperSoldSol: x.paperSoldSol, whaleSoldSol: x.whaleSoldSol, reason: x.reason };
  }

  return { RULE, RULE_KEYS, ruleFrom, ruleStr, SOL, gt, rpc, scanList, poolsForMint, xray, verdict, board, priceAt, outcome, logStats, logEntry, STAT };
});
