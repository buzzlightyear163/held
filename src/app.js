// ================= CONFIG (fill in at launch) =================
const CONFIG = {
  ca: "",                       // $HELD mint. empty = "posted here and on X at launch"
  x: "https://x.com/HeldEngine",
  site: "whalesheld.fun",       // the domain printed on share cards and links
  dexscreener: "",              // chart link, e.g. https://dexscreener.com/solana/<pair>. empty = built from the CA
  engineWallet: "",             // the engine's public wallet. empty = "posted here at launch"
  // the rule. The board, the X-ray and the log all use these numbers.
  rule: {
    dip: 30,        // % drop in the last hour that triggers a check
    watch: 12,      // smaller drops show on the board as WATCH
    held: 95,       // top 10 must still hold this % of their pre-dip bags -> WOULD BUY
    sold: 85,       // top 10 below this -> SOLD, skip
    dump: 50,       // one whale (1%+ of supply) selling this % of its bag -> SOLD, skip
    paper: 60,      // at least this % of the selling came from outside the top 10
    windowMin: 60,  // how far back the dip is read, minutes
    minLiq: 8000,   // pool liquidity floor, $
    minVol: 4000,   // 1h volume floor, $
    boardMax: 7,    // coins X-rayed per scan
  },
  refreshSec: 45,
  api: "/api/held",
};

// ================= utils =================
const C = HELDCORE, R = Object.assign({}, C.RULE, CONFIG.rule), RS = C.ruleStr(R);
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const short = a => a ? a.slice(0, 4) + "…" + a.slice(-4) : "—";
const now = () => Date.now();
const Q = new URLSearchParams(location.search), DEBUG = Q.has("debug");
let PREVIEW = Q.has("preview");
const ls = { get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const f1 = v => !isFinite(v) ? "—" : Math.abs(v) >= 100 ? Math.round(v).toString() : Math.abs(v) >= 10 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
const pctS = v => v == null || !isFinite(v) ? "—" : (v >= 10 || v <= -10 ? Math.round(v) : Math.round(v * 10) / 10) + "%";
const dipS = v => v == null || !isFinite(v) ? "—" : (v < 0 ? "−" : "+") + pctS(Math.abs(v));
const heldS = v => v == null || !isFinite(v) ? "—" : (v >= 99.95 ? "100" : v >= 10 ? Math.floor(v) : v.toFixed(1)) + "%";
const solS = v => !v || !isFinite(v) ? "0 SOL" : (v >= 100 ? Math.round(v).toLocaleString("en-US") : v >= 1 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2)) + " SOL";
const usd = v => !v || !isFinite(v) ? "—" : "$" + (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0));
const px = v => !v ? "—" : v >= 1 ? "$" + v.toFixed(3) : "$" + v.toPrecision(3);
const tok = v => !v ? "0" : v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0);
const ago = t => { const s = Math.max(0, (now() - t) / 1000); return s < 60 ? Math.round(s) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? (s / 3600).toFixed(1).replace(/\.0$/, "") + "h ago" : Math.round(s / 86400) + "d ago"; };
const hm = t => { const d = new Date(t); return d.toUTCString().slice(17, 22); };
const dm = t => { const d = new Date(t); return d.getUTCDate() + " " + d.toUTCString().slice(8, 11); };
const cap = t => t ? t[0].toUpperCase() + t.slice(1) : t;
const siteHost = () => CONFIG.site || location.host;
const isMint = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const buyUrl = ca => ca.endsWith("pump") ? "https://pump.fun/coin/" + ca : "https://raydium.io/launchpad/token/?mint=" + ca;
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 1800); }
function parseCa(raw) {
  raw = String(raw || "").trim(); const m = raw.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  return m ? m.sort((a, b) => b.length - a.length)[0] : "";
}
async function getJ(url, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 30000);
  try { const r = await fetch(url, { signal: c.signal }); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || "http " + r.status); e.status = r.status; throw e; } return j; }
  finally { clearTimeout(t); }
}
const ST = { mode: "connecting", fails: 0, last: 0, err: "" };
const CACHE = new Map();

// ================= the board =================
let BOARD = null, FILTER = "all", OPEN = null, HERO_I = 0, HERO_LIST = [], NEXT = 0;
async function loadBoard() {
  if (PREVIEW) { BOARD = sample(); ST.mode = "preview"; return afterBoard(); }
  let b = null;
  // 1) in this browser: GeckoTerminal + Jupiter + Solana RPC from the visitor's own connection
  try { b = await C.board(R, CACHE); b.source = "browser"; }
  catch (e) { ST.err = "browser: " + e.message; }
  // 2) the server, if the browser path failed
  if (!b) { try { b = await getJ(CONFIG.api + "?op=board&r=" + encodeURIComponent(RS), 45000); } catch (e) { ST.err += " | api: " + e.message; } }
  if (b && b.coins) { BOARD = b; ST.mode = "live"; ST.last = now(); ls.set("held.board.v1", b); }
  else if (!BOARD) { const snap = ls.get("held.board.v1", null); if (snap && snap.coins) { BOARD = snap; ST.mode = "snapshot"; } else { BOARD = sample(); ST.mode = "preview"; } }
  else if (now() - ST.last > 150000) ST.mode = "snapshot";
  afterBoard();
}
function afterBoard() {
  collectLog(BOARD);
  renderLamp(); renderBoard(); renderHeroList(); renderLog(); renderTape();
}
function schedule() { NEXT = now() + CONFIG.refreshSec * 1000; setTimeout(async () => { if (!document.hidden) await loadBoard(); schedule(); }, CONFIG.refreshSec * 1000); }

function renderLamp() {
  const l = $("#lamp"), live = ST.mode === "live";
  l.className = "lamp" + (live ? " live" : "");
  $("#lampWord").textContent = live ? "live" : ST.mode === "snapshot" ? "snapshot" : ST.mode === "preview" ? "preview" : "connecting";
  $("#lampTxt").textContent = BOARD ? " · " + (BOARD.dipping || 0) + " dips watched" : "";
}
const tenHTML = (x, cls) => {
  const ws = (x.whales || []).slice(0, 10); let h = "";
  for (let i = 0; i < 10; i++) { const w = ws[i]; h += w ? `<i><s style="height:${Math.round((1 - w.held) * 100)}%"></s></i>` : `<i class="e"></i>`; }
  return `<span class="${cls || "ten10"}" title="top 10 holders: black = still held, red = sold">${h}</span>`;
};
function rowHTML(x, i) {
  const drop = Math.min(100, Math.max(0, -x.dip)), trig = Math.min(100, R.dip);
  const paperN = x.paperSellers ? x.paperSellers + " wallets" : "";
  return `<div class="row${OPEN === x.pool ? " open" : ""}" data-pool="${esc(x.pool)}" data-mint="${esc(x.mint)}">
    <span class="n">${String(i + 1).padStart(2, "0")}</span>
    <span class="coin"><b>$${esc(x.sym || short(x.mint))}</b><i>${esc(x.dex || "")}${x.fdv ? " · " + usd(x.fdv) : ""}</i></span>
    <span class="dipc"><b>${dipS(x.dip)}</b><span class="bar"><i style="width:${drop}%"></i><u style="left:${trig}%" title="trigger −${R.dip}%"></u></span></span>
    <span class="heldc">${x.whales ? tenHTML(x) : ""}<b>${x.whales ? heldS(x.heldPct) : "—"}</b></span>
    <span class="sol p"><em class="ml">paper hands</em>${x.whales ? solS(x.paperSoldSol) : "—"}<small>${paperN}</small></span>
    <span class="sol w"><em class="ml">whales</em>${x.whales ? solS(x.whaleSoldSol) : "—"}<small>${x.whaleBoughtSol > 0.05 ? "+" + solS(x.whaleBoughtSol) + " bought" : ""}</small></span>
    <span class="vv"><i class="v ${x.verdict}">${x.verdict === "NODIP" ? "NO DIP" : x.verdict}</i></span>
    <span class="eng ${x.engine === "would buy" ? "buy" : x.engine}">${esc(x.engine)}</span>
    <span class="why">${esc(x.reason || "")}</span>
  </div>${OPEN === x.pool ? `<div class="drawer">${xrayHTML(x, true)}</div>` : ""}`;
}
function renderBoard() {
  const b = BOARD; if (!b) return;
  const list = (b.coins || []).filter(x => FILTER === "all" || x.verdict === FILTER);
  const nH = (b.coins || []).filter(x => x.verdict === "HELD").length, nS = (b.coins || []).filter(x => x.verdict === "SOLD").length;
  $("#bStat").innerHTML = `<b>${ST.mode === "preview" ? "preview · sample data" : ST.mode === "snapshot" ? "snapshot · " + ago(b.t) : "live"}</b> · ${b.scanned || 0} pools scanned · <b>${b.dipping || 0}</b> dipping · <b>${b.deep || 0}</b> past −${R.dip}% · <b>${nH}</b> would buy · <b>${nS}</b> skip · updated ${ago(b.t)}`;
  $$("#chips .chip").forEach(c => c.classList.toggle("on", c.dataset.f === FILTER));
  $("#rows").innerHTML = list.length ? list.map(rowHTML).join("") : `<div class="empty">${(b.coins || []).length ? "Nothing in this filter right now." : "No Solana coin in the scan is down " + R.watch + "%+ in the last hour. Calm market: the engine waits. Paste any CA in the X-ray to check a coin yourself."}</div>`;
  if (OPEN) drawShare(($("#rows .drawer canvas")), (b.coins || []).find(x => x.pool === OPEN));
  const ex = (b.coins || []).filter(x => x.mint).slice(0, 3);
  const hint = ex.length ? "Try one from the board: " + ex.map(x => `<a data-ca="${esc(x.mint)}">$${esc(x.sym)}</a>`).join("") : "Paste a pump.fun link, DexScreener link or a CA.";
  $("#heroHint").innerHTML = hint.replace("Try one from the board:", "Dipping now:"); $("#xHint").innerHTML = hint;
}
$("#rows").addEventListener("click", e => {
  if (e.target.closest("a,button,canvas")) return;
  const r = e.target.closest(".row"); if (!r) return;
  OPEN = OPEN === r.dataset.pool ? null : r.dataset.pool; renderBoard();
});
$("#chips").addEventListener("click", e => { const c = e.target.closest(".chip"); if (!c) return; FILTER = c.dataset.f; renderBoard(); });
document.addEventListener("click", e => { const a = e.target.closest("a[data-ca]"); if (!a) return; e.preventDefault(); runXray(a.dataset.ca, true); });

// ================= hero diptych =================
function renderHeroList() {
  const cs = (BOARD && BOARD.coins || []).filter(x => x.whales);
  const order = { HELD: 0, SOLD: 1, WATCH: 2, NODIP: 3 };
  HERO_LIST = cs.slice().sort((a, b) => (order[a.verdict] - order[b.verdict]) || (a.dip - b.dip)).slice(0, 6);
  if (HERO_I >= HERO_LIST.length) HERO_I = 0;
  $("#dDots").innerHTML = HERO_LIST.length > 1 ? HERO_LIST.map((x, i) => `<button aria-label="$${esc(x.sym)}" data-i="${i}" class="${i === HERO_I ? "on" : ""}"></button>`).join("") : "";
  renderHero();
}
function renderHero() {
  const x = HERO_LIST[HERO_I];
  if (!x) { $("#dSym").textContent = "$—"; $("#dDrop").textContent = BOARD ? "calm" : "scanning"; $("#dStamp").className = "stamp WATCH"; $("#dStamp").textContent = BOARD ? "NO DIPS" : "SCANNING"; if (BOARD) $("#dWhy").textContent = "No coin in the scan is dipping hard right now. The engine waits."; return; }
  const whalesSold = x.verdict === "SOLD";
  $("#dSym").textContent = "$" + (x.sym || short(x.mint));
  $("#dDrop").textContent = dipS(x.dip) + " · 1h";
  $("#dWhen").textContent = ST.mode === "preview" ? "preview · sample" : "read " + ago(x.t);
  const st = $("#dStamp"); st.className = "stamp " + x.verdict; st.textContent = x.verdict === "HELD" ? "WOULD BUY" : x.verdict === "SOLD" ? "SKIP" : "WATCH";
  $("#dSoldLbl").textContent = (whalesSold ? "Whales" : "Paper hands") + " · last " + R.windowMin + " min";
  $("#dSoldNum").textContent = solS(whalesSold ? x.whaleSoldSol : x.paperSoldSol);
  $("#dSoldSub").textContent = whalesSold ? (x.reason || "") : (x.paperSellers || 0) + " wallets outside the top 10";
  $("#dHeldNum").textContent = heldS(x.heldPct);
  $("#dTen").innerHTML = tenHTML(x, "ten").replace(/^<span class="ten"[^>]*>|<\/span>$/g, "");
  $("#dWhy").innerHTML = `<a data-ca="${esc(x.mint)}" href="#xray" style="color:inherit">${esc(x.reason || "")} · open X-ray →</a>`;
  $$("#dDots button").forEach((b, i) => b.classList.toggle("on", i === HERO_I));
  fallAnim(whalesSold ? 0 : Math.min(40, 6 + Math.round((x.paperSellers || 0) / 6)));
}
$("#dDots").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; HERO_I = +b.dataset.i; renderHero(); heroTimer(); });
function heroTimer() { clearInterval(heroTimer.t); heroTimer.t = setInterval(() => { if (HERO_LIST.length > 1 && !document.hidden) { HERO_I = (HERO_I + 1) % HERO_LIST.length; renderHero(); } }, 7000); }
// small white squares falling out of the SOLD tile: the paper hands leaving
function fallAnim(n) {
  const el = $("#dFall"); if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.innerHTML = ""; return; }
  el.innerHTML = Array.from({ length: n }, () => `<b style="left:${8 + Math.random() * 84}%;top:-10px"></b>`).join("");
  $$("b", el).forEach((b, i) => b.animate([{ transform: "translateY(0)", opacity: .95 }, { transform: `translateY(${300 + Math.random() * 300}px)`, opacity: 0 }], { duration: 2600 + Math.random() * 2600, delay: Math.random() * 4000, iterations: Infinity, easing: "cubic-bezier(.4,0,1,1)" }));
}

// ================= X-ray =================
let XR = null;
function xrayHTML(x, inDrawer) {
  if (x.err) return `<div class="xerr">${esc(x.err)}</div>`;
  const ws = x.whales || [];
  const cov = x.cover || {};
  const covTxt = cov.full ? `every trade in the last ${cov.all} min (${cov.trades} trades)` : `all trades in the last ${cov.all} min + sells over $${cov.bigMin} for ${cov.big} min (${cov.trades} trades)`;
  const links = `<a href="https://dexscreener.com/solana/${esc(x.pool)}" target="_blank" rel="noopener">DexScreener</a><a href="https://www.geckoterminal.com/solana/pools/${esc(x.pool)}" target="_blank" rel="noopener">GeckoTerminal</a><a href="https://solscan.io/token/${esc(x.mint)}#holders" target="_blank" rel="noopener">Holders</a>`;
  const rows = ws.map(w => {
    const note = w.left ? '<span class="tag red">sold out of the top 100</span>' : w.moved < 0 ? `<span class="tag red">moved ${tok(-w.moved)}</span>` : w.boughtSol > 0.05 && w.held >= 1 ? '<span class="tag">added</span>' : "";
    return `<tr><td>#${w.rank}</td><td><a href="https://solscan.io/account/${esc(w.owner)}" target="_blank" rel="noopener">${short(w.owner)}</a>${note}</td>
      <td class="r hide-m">${tok(w.pre)}${w.supplyPct != null ? ` <span class="mute">${w.supplyPct.toFixed(1)}%</span>` : ""}</td><td class="r hide-m">${tok(w.now)}</td>
      <td><span class="hb"><i style="width:${Math.round(w.held * 100)}%"></i></span>${heldS(w.held * 100)}</td><td class="r">${w.soldSol > 0.005 ? solS(w.soldSol) : "—"}</td></tr>`;
  }).join("");
  return `<div class="xcard">
    <div class="xtop"><span class="sym">$${esc(x.sym || short(x.mint))}</span><span class="meta">${esc(x.dex || "")} · ${px(x.price)} · mcap ${usd(x.fdv)} · liq ${usd(x.liq)}</span><span class="links">${links}</span></div>
    <div class="xverd"><i class="v ${x.verdict}">${x.verdict === "NODIP" ? "NO DIP" : x.verdict}</i><span class="why">${x.verdict === "HELD" ? "Engine would buy: " : x.verdict === "SOLD" ? "Engine skips: " : x.verdict === "NODIP" ? "" : "Engine watches: "}${esc(x.verdict === "NODIP" ? cap(x.reason || "") : x.reason || "")}</span></div>
    <div class="xstats"><div><span class="k">Dip · 1h</span><b class="red">${dipS(x.dip)}</b></div><div><span class="k">Top 10 held</span><b>${heldS(x.heldPct)}</b></div><div><span class="k">Paper hands sold</span><b>${solS(x.paperSoldSol)}</b></div><div><span class="k">Whales sold</span><b>${solS(x.whaleSoldSol)}</b></div></div>
    <div class="xwide"><table class="wt"><thead><tr><th>#</th><th>Wallet</th><th class="r hide-m">Bag before</th><th class="r hide-m">Now</th><th>Held</th><th class="r">Sold</th></tr></thead><tbody>${rows || `<tr><td colspan="6">No holder data.</td></tr>`}</tbody></table></div>
    <div class="xnote">Read ${ago(x.t)}: ${covTxt} from GeckoTerminal, matched against the top 100 holders${x.holders ? " of " + x.holders.toLocaleString("en-US") : ""} (Jupiter)${cov.verified ? `, ${cov.verified} whale wallets checked on-chain for moves` : ""}. ${x.paperSellers || 0} wallets outside the top 10 sold ${solS(x.paperSoldSol)}.${x.poolPct ? ` ${x.poolPct.toFixed(0)}% of supply sits in pools.` : ""}</div>
    <div class="share"><canvas width="1200" height="630" data-pool="${esc(x.pool)}"></canvas>
      <div class="acts"><button class="btn sm ink" data-act="x" data-pool="${esc(x.pool)}">Post on X</button><button class="btn sm" data-act="copy" data-pool="${esc(x.pool)}">Copy image</button><button class="btn sm" data-act="dl" data-pool="${esc(x.pool)}">Download PNG</button><button class="btn sm" data-act="link" data-pool="${esc(x.pool)}">Copy link</button></div></div>
  </div>`;
}
async function runXray(raw, scroll) {
  const ca = parseCa(raw);
  if (scroll) document.getElementById("xray").scrollIntoView({ behavior: "smooth" });
  if (!isMint(ca)) { $("#xRes").innerHTML = `<div class="xerr">That doesn't look like a Solana address. Paste a CA, a pump.fun link or a DexScreener link.</div>`; return; }
  $("#xCheck input").value = ca;
  try { history.replaceState(null, "", "?ca=" + ca + (PREVIEW ? "&preview" : "")); } catch (e) {}
  $("#xRes").innerHTML = `<div class="xcard"><div class="xload">X-raying ${short(ca)}: reading the dip's trades and the top holders…<div class="bar"><i></i></div></div></div>`;
  let x;
  try {
    const fromBoard = BOARD && (BOARD.coins || []).find(c => c.mint === ca && c.whales && now() - c.t < 90000);
    if (fromBoard) x = fromBoard;
    else if (PREVIEW) x = sampleX(ca);
    else {
      try {
        const P = await C.poolsForMint(ca);
        if (!P.pool) { const e = new Error("No SOL or USDC pool found for this coin on GeckoTerminal yet"); e.final = true; throw e; }
        x = await C.xray(P.pool, R, P.solUsd);
      } catch (e) {
        if (e.final) throw e;
        x = await getJ(CONFIG.api + "?op=xray&ca=" + ca + "&r=" + encodeURIComponent(RS), 40000);
      }
    }
    XR = x; CACHE.set(x.pool, x);
    $("#xRes").innerHTML = xrayHTML(x); drawShare($("#xRes canvas"), x);
  } catch (e) { $("#xRes").innerHTML = `<div class="xcard"><div class="xerr">${esc(e.message || "X-ray failed")}. Try again in a few seconds.</div></div>`; }
}
$("#xCheck").addEventListener("submit", e => { e.preventDefault(); runXray(e.target.ca.value); });
$("#heroCheck").addEventListener("submit", e => { e.preventDefault(); runXray(e.target.ca.value, true); });

// ================= share card (1200x630) =================
const FONT = (w, s, st) => `${st ? "" : ""}${w} ${s}px Archivo, "Helvetica Neue", Arial, sans-serif`;
const MONO = (w, s) => `${w} ${s}px "IBM Plex Mono", ui-monospace, monospace`;
function findX(pool) { return (XR && XR.pool === pool) ? XR : (BOARD && (BOARD.coins || []).find(c => c.pool === pool)) || CACHE.get(pool); }
function drawMark(g, x, y, s, ink, red) {
  const k = s / 100; g.fillStyle = red; g.fillRect(x, y, 50 * k, 100 * k); g.fillStyle = ink; g.fillRect(x + 50 * k, y, 50 * k, 100 * k);
  g.fillStyle = "#fff"; g.fillRect(x + 22 * k, y + 20 * k, 18 * k, 60 * k); g.fillRect(x + 60 * k, y + 20 * k, 18 * k, 60 * k); g.fillRect(x + 40 * k, y + 43 * k, 20 * k, 14 * k);
}
function fitText(g, t, font, max, start) { let s = start; g.font = font(s); while (g.measureText(t).width > max && s > 10) { s -= 2; g.font = font(s); } return s; }
function drawShare(cv, x) {
  if (!cv || !x) return;
  if (document.fonts && !drawShare.ready) { document.fonts.load('900 60px Archivo').then(() => document.fonts.load('500 16px "IBM Plex Mono"')).finally(() => { drawShare.ready = true; drawShare(cv, x); }); return; }
  const g = cv.getContext("2d"), W = 1200, H = 630, INK = "#0c0c0d", RED = "#e1251b", MUTE = "#6c6964";
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  const v = x.verdict, sold = v === "SOLD";
  // left: words
  g.fillStyle = INK; g.font = MONO(500, 18); g.textBaseline = "alphabetic";
  g.fillText("DIP X-RAY  ·  " + dm(x.t).toUpperCase() + " " + hm(x.t) + " UTC", 60, 76);
  const sym = "$" + (x.sym || short(x.mint));
  const ss = fitText(g, sym, s => FONT(800, s), 560, 64); g.fillText(sym, 60, 76 + 22 + ss);
  // the drop
  g.fillStyle = RED; const dt = dipS(x.dip); g.font = FONT(900, 168); g.fillText(dt, 52, 360);
  const dw = g.measureText(dt).width; g.font = MONO(500, 22); g.fillText("in 1h", 60 + dw + 4, 360);
  // the read
  g.fillStyle = INK; g.font = FONT(800, 50); g.fillText("Whales held " + heldS(x.heldPct), 60, 444);
  g.font = FONT(500, 34); g.fillStyle = sold ? RED : INK;
  g.fillText(sold ? "Whales sold " + solS(x.whaleSoldSol) : "Paper hands sold " + solS(x.paperSoldSol), 60, 494);
  // footer
  g.fillStyle = INK; g.fillRect(60, 540, 640, 3);
  drawMark(g, 60, 556, 42, INK, RED);
  g.font = FONT(900, 26); g.fillText("HELD", 110, 588); const hw = g.measureText("HELD").width;
  g.font = MONO(500, 17); g.fillStyle = MUTE; g.fillText(siteHost() + "  ·  every dip has a seller", 110 + hw + 18, 586);
  // right panel: the top 10
  const PX = 760; g.fillStyle = INK; g.fillRect(PX, 0, W - PX, H);
  g.fillStyle = "#fff"; g.font = MONO(500, 16); g.fillText("TOP 10 HOLDERS  ·  BEFORE → NOW", PX + 40, 64);
  const ws = (x.whales || []).slice(0, 10), top = 92, rh = 34, bw = W - PX - 40 - 40 - 70;
  for (let i = 0; i < 10; i++) {
    const w = ws[i], y = top + i * rh;
    g.fillStyle = "rgba(255,255,255,.55)"; g.font = MONO(500, 15); g.fillText("#" + (i + 1), PX + 40, y + 19);
    if (!w) { g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(PX + 84, y + 6, bw, 16); continue; }
    g.fillStyle = RED; g.fillRect(PX + 84, y + 6, bw, 16);
    g.fillStyle = "#fff"; g.fillRect(PX + 84, y + 6, Math.round(bw * Math.min(1, w.held)), 16);
    g.font = MONO(600, 15); g.fillStyle = w.held < 0.995 ? "#ff8d86" : "#fff"; g.fillText(heldS(w.held * 100), PX + 84 + bw + 12, y + 19);
  }
  // verdict block
  const by = 460, bh = 120, bx = PX + 40, bW = W - PX - 80;
  if (v === "HELD") { g.fillStyle = "#fff"; g.fillRect(bx, by, bW, bh); g.fillStyle = INK; }
  else if (v === "SOLD") { g.fillStyle = RED; g.fillRect(bx, by, bW, bh); g.fillStyle = "#fff"; }
  else { g.strokeStyle = "#fff"; g.lineWidth = 3; g.strokeRect(bx + 1.5, by + 1.5, bW - 3, bh - 3); g.fillStyle = "#fff"; }
  g.font = MONO(500, 15); g.fillText("ENGINE", bx + 22, by + 34);
  const vt = v === "HELD" ? "WOULD BUY" : v === "SOLD" ? "SKIP" : v === "NODIP" ? "NO DIP" : "WATCH";
  fitText(g, vt, s => FONT(900, s), bW - 44, 62); g.fillText(vt, bx + 22, by + 96);
}
document.addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const x = findX(b.dataset.pool); if (!x) return;
  const cv = b.closest(".share").querySelector("canvas");
  const link = "https://" + siteHost() + "/?ca=" + x.mint;
  const act = b.dataset.act;
  if (act === "dl") { const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = "held-xray-" + (x.sym || "coin").toLowerCase() + ".png"; a.click(); }
  if (act === "copy") { cv.toBlob(async bl => { try { await navigator.clipboard.write([new ClipboardItem({ "image/png": bl })]); toast("Image copied"); } catch (er) { toast("Copy not allowed here, use Download"); } }); }
  if (act === "link") { try { await navigator.clipboard.writeText(link); toast("Link copied"); } catch (er) { toast(link); } }
  if (act === "x") {
    const t = x.verdict === "SOLD" ? `$${x.sym} dipped ${dipS(x.dip)} in 1h.\nThe whales sold: ${x.reason}.\nHELD skips this one.` :
      `$${x.sym} dipped ${dipS(x.dip)} in 1h.\nWhales held ${heldS(x.heldPct)} · Paper hands sold ${solS(x.paperSoldSol)}.\nHELD: ${x.verdict === "HELD" ? "WOULD BUY" : x.verdict === "NODIP" ? "no dip" : "watching"}`;
    open("https://x.com/intent/tweet?text=" + encodeURIComponent(t + "\n\nX-ray any dip 👇") + "&url=" + encodeURIComponent(link), "_blank", "noopener");
  }
});

// ================= the log =================
// server log (shared) + calls this browser saw itself; both scored 1h and 24h later
let LLOG = ls.get("held.log.v1", []);
function collectLog(b) {
  if (!b || ST.mode === "preview") return;
  const seen = new Map(LLOG.map(e => [e.id, e]));
  for (const e of ((b.log && b.log.items) || [])) { if (!e || !e.id) continue; const o = seen.get(e.id); if (!o) { LLOG.push(e); seen.set(e.id, e); } else { if (e.p1h != null) o.p1h = e.p1h; if (e.p24h != null) o.p24h = e.p24h; } }
  for (const x of b.coins || []) {
    if (x.err || (x.verdict !== "HELD" && x.verdict !== "SOLD")) continue;
    if (LLOG.some(e => e.mint === x.mint && e.verdict === x.verdict && x.t - e.t < 6 * 3600000)) continue;
    const e = C.logEntry(x); LLOG.push(e); seen.set(e.id, e); SHARE.add(e.id);
  }
  LLOG.sort((a, b2) => b2.t - a.t); if (LLOG.length > 300) LLOG.length = 300;
  ls.set("held.log.v1", LLOG);
  pushShared();
}
// the shared log: every visitor's browser adds the calls it sees, so the log keeps growing for everyone
const SHARE = new Set(); let SHARED = { storage: null, at: 0 };
async function pullShared() {
  if (PREVIEW) return;
  try {
    const j = await getJ(CONFIG.api + "?op=log", 12000); SHARED = { storage: j.storage, at: now() };
    const seen = new Map(LLOG.map(e => [e.id, e]));
    for (const e of j.items || []) { const o = seen.get(e.id); if (!o) LLOG.push(e); else { if (o.p1h == null && e.p1h != null) o.p1h = e.p1h; if (o.p24h == null && e.p24h != null) o.p24h = e.p24h; } }
    LLOG.sort((a, b) => b.t - a.t); if (LLOG.length > 300) LLOG.length = 300; ls.set("held.log.v1", LLOG); renderLog();
  } catch (e) { /* the log still works in this browser */ }
}
async function pushShared() {
  if (PREVIEW || !SHARE.size) return;
  const items = LLOG.filter(e => SHARE.has(e.id)).slice(0, 30); SHARE.clear();
  try { await fetch(CONFIG.api + "?op=log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) }); } catch (e) { /* retried with the next call */ }
}
let resolving = false;
async function resolveLocal() {
  if (resolving || PREVIEW) return; resolving = true;
  const due = LLOG.filter(e => (e.p1h == null && now() > e.t + 3900000) || (e.p24h == null && now() > e.t + 86700000 && now() - e.t < 4 * 86400000)).slice(0, 4);
  for (const e of due) {
    try {
      let r; try { const o = { pool: e.pool, t: e.t }; await C.outcome(o); r = o; } catch (er) { r = await getJ(CONFIG.api + "?op=outcome&pool=" + e.pool + "&t=" + e.t, 15000); }
      if (r.p1h != null) e.p1h = r.p1h; if (r.p24h != null) e.p24h = r.p24h;
      if (r.p1h != null || r.p24h != null) SHARE.add(e.id);
    } catch (er) { break; }
  }
  ls.set("held.log.v1", LLOG); resolving = false; if (due.length) { renderLog(); pushShared(); }
}
function renderLog() {
  const items = ST.mode === "preview" ? sampleLog() : LLOG;
  const S = C.logStats(items);
  const rate = (w, n) => n ? Math.round(w / n * 100) + "%" : "—";
  const avg = (s, n) => n ? (s / n >= 0 ? "+" : "−") + Math.abs(s / n).toFixed(1) + "%" : "—";
  $("#lStats").innerHTML = `
    <div><span class="k">Would buy · up 1h later</span><b>${rate(S.HELD.w1, S.HELD.r1)}</b><small>${S.HELD.r1} of ${S.HELD.n} calls scored · avg ${avg(S.HELD.sum1, S.HELD.r1)}</small></div>
    <div><span class="k">Would buy · up 24h later</span><b>${rate(S.HELD.w24, S.HELD.r24)}</b><small>${S.HELD.r24} scored · avg ${avg(S.HELD.sum24, S.HELD.r24)}</small></div>
    <div><span class="k">Skips · kept falling 1h</span><b class="red">${rate(S.SOLD.w1, S.SOLD.r1)}</b><small>${S.SOLD.r1} of ${S.SOLD.n} calls scored · avg ${avg(S.SOLD.sum1, S.SOLD.r1)}</small></div>
    <div><span class="k">Calls logged</span><b>${items.length}</b><small>${items.length ? "since " + dm(Math.min(...items.map(e => e.t))) + " " + hm(Math.min(...items.map(e => e.t))) + " UTC" : "first calls land when a dip triggers"}</small></div>`;
  const ch = (p, e) => p == null || !e.price ? null : (p / e.price - 1) * 100;
  const until = ms => ms < 3600000 ? "in " + Math.max(1, Math.round(ms / 60000)) + "m" : "in " + Math.round(ms / 3600000) + "h";
  const cell = (p, e, span) => { const c = ch(p, e); if (c == null) return `<td class="r mute">${now() < e.t + span ? until(e.t + span - now()) : "…"}</td>`; const hit = e.verdict === "HELD" ? c > 0 : c < 0; return `<td class="r ${c >= 0 ? "up" : "dn"}${hit ? " hit" : ""}">${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(1)}%</td>`; };
  $("#lTable").innerHTML = `<thead><tr><th>Time (UTC)</th><th>Coin</th><th>Call</th><th class="r">Dip</th><th class="r hide-m">Top 10 held</th><th class="r hide-m">Price</th><th class="r">1h later</th><th class="r">24h later</th></tr></thead><tbody>${
    items.slice(0, 40).map(e => `<tr><td>${dm(e.t)} ${hm(e.t)}</td><td><a data-ca="${esc(e.mint)}" href="#xray">$${esc(e.sym)}</a></td><td><i class="v ${e.verdict}" style="min-width:0;padding:4px 7px;font-size:11px">${e.verdict === "HELD" ? "BUY" : "SKIP"}</i></td><td class="r red">${dipS(e.dip)}</td><td class="r hide-m">${heldS(e.heldPct)}</td><td class="r hide-m">${px(e.price)}</td>${cell(e.p1h, e, 3600000)}${cell(e.p24h, e, 86400000)}</tr>`).join("") ||
    `<tr><td colspan="8" class="mute" style="padding:22px 0">No calls yet. A call is logged the moment a coin drops ${R.dip}%+ and the read says HELD or SOLD.</td></tr>`}</tbody>`;
  $("#lNote").textContent = ST.mode === "preview" ? "Preview: sample calls, not real data." :
    `Prices from GeckoTerminal 5-minute candles. Every visitor's browser adds the calls it reads${SHARED.storage ? "" : " (this browser keeps its own copy too)"}. ✓ = the call was right.`;
}

// ================= engine =================
const ENG = { trades: [], bal: null, seen: new Set(), cache: ls.get("held.eng.v1", {}) };
function parseEngineTx(tx, sig) {
  const me = CONFIG.engineWallet, keys = (tx.transaction.message.accountKeys || []).map(k => typeof k === "string" ? k : k.pubkey);
  const i = keys.indexOf(me); let sol = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
  const d = {}; for (const b of tx.meta.preTokenBalances || []) if (b.owner === me) d[b.mint] = (d[b.mint] || 0) - (+b.uiTokenAmount.uiAmountString || 0);
  for (const b of tx.meta.postTokenBalances || []) if (b.owner === me) d[b.mint] = (d[b.mint] || 0) + (+b.uiTokenAmount.uiAmountString || 0);
  if (d[C.SOL]) { sol += d[C.SOL]; delete d[C.SOL]; }
  const mv = Object.entries(d).filter(([, v]) => Math.abs(v) > 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!mv.length) return null;
  const [mint, t] = mv[0];
  return { sig, ts: (tx.blockTime || now() / 1000) * 1000, mint, buy: t > 0, tok: Math.abs(t), sol: Math.abs(sol) };
}
async function engineInit() {
  renderEngine(); if (!CONFIG.engineWallet) return;
  try {
    ENG.bal = (await C.rpc("getBalance", [CONFIG.engineWallet])).value / 1e9;
    const sigs = await C.rpc("getSignaturesForAddress", [CONFIG.engineWallet, { limit: 50 }]);
    for (const s of (sigs || [])) {
      if (s.err || ENG.seen.has(s.signature)) continue; ENG.seen.add(s.signature);
      let t = ENG.cache[s.signature];
      if (t === undefined) { try { const tx = await C.rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]); t = tx && tx.meta ? parseEngineTx(tx, s.signature) : null; ENG.cache[s.signature] = t; } catch (e) { continue; } }
      if (t) ENG.trades.push(t);
    }
    ENG.trades.sort((a, b) => b.ts - a.ts); ls.set("held.eng.v1", ENG.cache);
  } catch (e) { ENG.err = e.message; }
  renderEngine();
}
function engineStats() {
  const pos = new Map(); let back = 0;
  for (const t of ENG.trades.slice().reverse()) {
    if (CONFIG.ca && t.mint === CONFIG.ca) { if (t.buy) back += t.sol; continue; }
    const p = pos.get(t.mint) || { in: 0, out: 0, ti: 0, to: 0 }; if (t.buy) { p.in += t.sol; p.ti += t.tok; } else { p.out += t.sol; p.to += t.tok; } pos.set(t.mint, p);
  }
  const closed = [...pos.values()].filter(p => p.ti > 0 && p.to >= p.ti * .97), wins = closed.filter(p => p.out > p.in).length;
  return { n: ENG.trades.length, closed: closed.length, rate: closed.length ? Math.round(wins / closed.length * 100) + "%" : "—", net: closed.reduce((s, p) => s + p.out - p.in, 0), back };
}
function renderEngine() {
  const w = CONFIG.engineWallet;
  $("#eBox").innerHTML = `<span class="beta">BETA</span><div class="k">Engine wallet</div><code>${w ? esc(w) : "posted here at launch"}</code>
    <p>${w ? "Buys are placed by hand from this wallet while the engine is in beta, following the board's WOULD BUY calls. Every trade below is read straight from the chain." : "At launch the first buys are placed by hand from one public wallet, following the board's WOULD BUY calls. Once the wallet is posted here, every trade shows up below, read from the chain."}</p>
    ${w ? `<div class="herobtns"><a class="btn sm" href="https://solscan.io/account/${esc(w)}" target="_blank" rel="noopener">Solscan</a></div>` : ""}`;
  const s = engineStats();
  $("#eStats").innerHTML = `<div><span class="k">Balance</span><b>${ENG.bal != null ? solS(ENG.bal) : "—"}</b></div><div><span class="k">Trades</span><b>${w ? s.n : "—"}</b></div><div><span class="k">Win rate</span><b>${w ? s.rate : "—"}</b></div><div><span class="k">Bought back</span><b>${w ? solS(s.back) : "—"}</b></div>`;
  const sym = m => { const c = BOARD && (BOARD.coins || []).find(x => x.mint === m); return m === CONFIG.ca ? "$HELD" : c ? "$" + c.sym : short(m); };
  $("#eFeed").innerHTML = ENG.trades.length ? ENG.trades.slice(0, 12).map(t => `<div><span class="mute">${hm(t.ts)}</span><span class="${t.buy ? "" : "red"}">${t.buy ? "BUY" : "SELL"}</span><span>${esc(sym(t.mint))} · ${solS(t.sol)}${t.mint === CONFIG.ca && t.buy ? " · buyback" : ""}</span><a href="https://solscan.io/tx/${t.sig}" target="_blank" rel="noopener">tx ↗</a></div>`).join("")
    : `<div style="grid-template-columns:1fr"><span class="mute">${w ? (ENG.err ? "Couldn't read the wallet right now." : "No trades yet.") : "The trade feed starts when the wallet is posted."}</span></div>`;
}

// ================= market tape: the hook =================
async function loadMarket() {
  try {
    const j = await getJ("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=120&interval=daily", 12000);
    const p = (j.prices || []).map(a => a[1]); if (p.length < 30) return;
    const s = await getJ("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true", 8000).catch(() => null);
    const cur = (s && s.bitcoin && s.bitcoin.usd) || p[p.length - 1], low = Math.min(...p, cur), ch = s && s.bitcoin ? s.bitcoin.usd_24h_change : null;
    MKT = { btc: cur, low, ch, off: (cur / low - 1) * 100 }; renderTape();
  } catch (e) { /* keep the static tape */ }
}
let MKT = null;
function renderTape() {
  const parts = [];
  if (MKT) parts.push(`<span><b>BTC $${Math.round(MKT.btc).toLocaleString("en-US")}</b>${MKT.ch != null ? ` ${MKT.ch >= 0 ? "+" : "−"}${Math.abs(MKT.ch).toFixed(1)}% 24h` : ""}</span>`, `<span>${MKT.off < 0.5 ? "at" : MKT.off.toFixed(1) + "% above"} its 4-month low</span>`);
  else parts.push(`<span><b>BTC</b> near a 4-month low</span>`);
  if (BOARD && BOARD.solUsd) parts.push(`<span><b>SOL</b> $${BOARD.solUsd.toFixed(2)}</span>`);
  if (BOARD && ST.mode !== "preview") parts.push(`<span><b>${BOARD.dipping || 0}</b> Solana coins dipping ${R.watch}%+ this hour</span>`);
  else parts.push(`<span>Everything dips</span>`);
  $("#tape").innerHTML = parts.join('<span class="sep">/</span>') + `<span class="end">Every dip has a seller. HELD checks who.</span>`;
}

// ================= preview (sample data, clearly labelled) =================
function rnd(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function fakeAddr(r) { const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let s = ""; for (let i = 0; i < 44; i++) s += A[Math.floor(r() * A.length)]; return s; }
function sampleX(mint, i) {
  const r = rnd(7 + (i || 3) * 101), syms = ["GRIND", "PIGEON", "SNOOZE", "WOBBLE", "KETTLE", "MOTH", "BRICK"], sym = syms[(i || 0) % syms.length];
  const kinds = ["HELD", "HELD", "SOLD", "WATCH", "HELD", "SOLD", "WATCH"], k = kinds[(i || 0) % kinds.length];
  const whales = Array.from({ length: 10 }, (_, j) => { const pre = (9 - j) * 9000 + 20000 * r(); let held = k === "SOLD" && j === 2 ? 0.31 : r() > .85 ? 0.93 + r() * .07 : 1; return { rank: j + 1, owner: fakeAddr(r), pre, now: pre * held, held, supplyPct: pre / 1e6 * 100, soldSol: (1 - held) * pre / 3000, boughtSol: r() > .8 ? r() * 2 : 0, moved: 0 }; });
  whales.sort((a, b) => b.pre - a.pre).forEach((w, j) => w.rank = j + 1);
  const preSum = whales.reduce((s, w) => s + w.pre, 0), kept = whales.reduce((s, w) => s + w.now, 0);
  const x = { mint: mint || fakeAddr(r) + "pump".slice(0, 0), pool: fakeAddr(r), sym, dex: "pumpswap", price: 0.0001 + r() * 0.002, fdv: 200000 + r() * 3e6, liq: 30000 + r() * 200000, ch: {}, dip: k === "WATCH" ? -(14 + r() * 12) : -(31 + r() * 20), t: now() - r() * 60000,
    whales, heldPct: kept / preSum * 100, whaleSoldSol: whales.reduce((s, w) => s + w.soldSol, 0), whaleBoughtSol: 0.4, paperSoldSol: 12 + r() * 60, paperSellers: 40 + Math.floor(r() * 220), cover: { trades: 300, all: 60, big: 60, full: true, verified: 8 }, poolPct: 18 };
  x.sellSol = x.paperSoldSol + x.whaleSoldSol; x.paperShare = x.paperSoldSol / x.sellSol * 100;
  return Object.assign(x, C.verdict(x, R));
}
function sample() { const coins = Array.from({ length: 7 }, (_, i) => sampleX(null, i)); return { t: now(), solUsd: 69.4, scanned: 80, watched: 64, dipping: 9, deep: 5, coins, storage: "preview", log: { items: [] } }; }
function sampleLog() { const r = rnd(42); return Array.from({ length: 12 }, (_, i) => { const v = r() > .4 ? "HELD" : "SOLD", t = now() - (i + 1.3) * 3600000 * 2.2, p = 0.0004 + r() * 0.001; return { id: "s" + i, mint: fakeAddr(r), pool: fakeAddr(r), sym: ["GRIND", "MOTH", "KETTLE", "WOBBLE"][i % 4], verdict: v, t, price: p, dip: -(30 + r() * 25), heldPct: v === "HELD" ? 96 + r() * 4 : 60 + r() * 20, p1h: p * (1 + (v === "HELD" ? .12 : -.1) + (r() - .5) * .3), p24h: i > 4 ? p * (1 + (r() - .4) * .8) : null }; }); }

// ================= boot =================
function cfgLines() {
  const L = (a, b) => `<span>${a}<b>${b}</b></span>`;
  $("#cfg1").innerHTML = L("Dip that triggers a read", "−" + R.dip + "% in 1h") + L("Shown as WATCH", "−" + R.watch + "% to −" + R.dip + "%") + L("Liquidity / 1h volume floor", usd(R.minLiq) + " / " + usd(R.minVol));
  $("#cfg2").innerHTML = L("Whales", "top 10 before the dip") + L("Read window", "last " + R.windowMin + " min") + L("Paper hands", "everyone else");
  $("#cfg3").innerHTML = L("Buy if top 10 held", "≥ " + R.held + "%") + L("Skip if top 10 held", "< " + R.sold + "%") + L("Skip if one whale sold", "≥ " + R.dump + "% of its bag");
  $("#xCfg").innerHTML = `<span class="k" style="display:block;margin-bottom:8px">The rule, in numbers</span>` + L("Trigger", "−" + R.dip + "% in 1h") + L("Would buy", "top 10 held ≥ " + R.held + "%") + L("Skip", "top 10 < " + R.sold + "% or a whale sold ≥ " + R.dump + "%") + L("Paper hands", "≥ " + R.paper + "% of the selling");
  $("#rDip").textContent = R.dip + "%"; $("#rHeld").textContent = R.held + "%";
}
function wireCA() {
  const host = siteHost(); $("#footSite").textContent = host;
  if (CONFIG.x) $("#xlink").href = CONFIG.x;
  if (!CONFIG.ca) return;
  ["#ca", "#ca2"].forEach(s => $(s).textContent = CONFIG.ca);
  ["#copyCa", "#copyCa2"].forEach(s => { const b = $(s); b.hidden = false; b.onclick = () => navigator.clipboard.writeText(CONFIG.ca).then(() => toast("CA copied")).catch(() => toast(CONFIG.ca)); });
  ["#buy", "#buyTop"].forEach(s => { $(s).href = buyUrl(CONFIG.ca); $(s).target = "_blank"; $(s).rel = "noopener"; });
  if (!CONFIG.ca.endsWith("pump")) $("#buy").textContent = "Buy on Raydium";
  const d = $("#dexlink"); d.hidden = false; d.href = CONFIG.dexscreener || "https://dexscreener.com/solana/" + CONFIG.ca;
}
function debugBox() {
  if (!DEBUG) return; let el = $("#debug"); if (!el) { el = document.createElement("div"); el.id = "debug"; document.body.appendChild(el); }
  el.textContent = `mode ${ST.mode}\nsource ${BOARD && BOARD.source}\nlog ${SHARED.storage}\nboard ${BOARD ? ago(BOARD.t) : "-"}\nerr ${ST.err}\ncore ${JSON.stringify(C.STAT)}\nrule ${RS}`;
}
cfgLines(); wireCA(); renderEngine(); renderTape(); renderLog();
loadBoard().then(() => { schedule(); heroTimer(); const ca = Q.get("ca") || Q.get("c"); if (ca) runXray(ca, true); else if (HERO_LIST[0]) { XR = HERO_LIST[0]; $("#xRes").innerHTML = xrayHTML(XR); drawShare($("#xRes canvas"), XR); } });
loadMarket(); engineInit(); pullShared(); setInterval(pullShared, 180000);
setInterval(() => { resolveLocal(); if (BOARD) { renderLamp(); const s = $("#bStat"); if (s && BOARD) s.innerHTML = s.innerHTML.replace(/updated [^<]*$/, "updated " + ago(BOARD.t)); } debugBox(); }, 5000);
setTimeout(resolveLocal, 4000);
