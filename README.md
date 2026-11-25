Kategori: 1 Köpmotorer
Tagline: Buys the dip whales didn't sell.
Plattform: pump.fun
CA: (fylls i vid launch)   Domän: whalesheld.fun   X: @HeldEngine

# HELD ($HELD)

"Every dip has a seller. HELD checks who."
När en Solana-coin faller 30 % på en timme kollar HELD vem som sålde. Topp 10-holders sitter kvar och det är paper hands som säljer: motorn köper. Valarna säljer: motorn skippar.

## Vad som är riktigt / larp

**Riktigt (live, gratis data, inga API-nycklar):**
- **Tavlan:** Solana-coins som dippar just nu (GeckoTerminal trending + mest handlade pooler). Varje coin får HELD / SOLD / WATCH och ett skäl på en rad.
- **Dip X-ray:** klistra in valfri CA. Visar topp 10-plånböckerna före och efter dippen, vad paper hands sålde i SOL, valar som sålt sig ur topp 100 eller flyttat påsen, och utslaget. Länk: `?ca=<mint>`.
- **Delningskort** 1200×630: Post on X, Copy image, Download PNG, Copy link.
- **Loggen:** varje HELD/SOLD-utslag sparas med pris och poängsätts 1 h och 24 h senare (GeckoTerminal-candles).
- **Motorplånboken:** när `engineWallet` är ifylld läses saldo och alla köp/sälj direkt från kedjan.

**Larp (märkt "beta" på sajten):** själva köpen. I början görs de manuellt från en publik plånbok som följer tavlans WOULD BUY.

## Regeln (CONFIG.rule överst i scriptet)

| Fält | Värde | Betyder |
|---|---|---|
| `dip` | 30 | Fall i % på 1 h som triggar ett utslag |
| `watch` | 12 | Mindre fall visas som WATCH |
| `held` | 95 | Topp 10 måste ha kvar minst så här mycket → WOULD BUY |
| `sold` | 85 | Under detta har valarna sålt → SKIP |
| `dump` | 50 | En val (1 %+ av supply) som sålt så här mycket av sin påse → SKIP |
| `paper` | 60 | Minst så stor del av säljandet ska komma från utanför topp 10 |
| `windowMin` | 60 | Hur långt bakåt dippen läses |
| `minLiq` / `minVol` | 8000 / 4000 | Golv för likviditet och 1h-volym i $ |

Ändrar du siffrorna skickas de med till servern, så tavlan, X-ray och loggen följer dem direkt.

## Fyll i vid launch (CONFIG överst i scriptet i index.html, sök på `CONFIG`)

- `ca`: $HELD-minten. Tom = "posted here and on X at launch". En CA som slutar på `pump` går till pump.fun.
- `engineWallet`: motorns publika plånbok. Tom = "posted here at launch".
- `dexscreener`: chartlänk (valfritt, annars byggs den från CA:n).
- `x` och `site` är förifyllda (@HeldEngine, whalesheld.fun).

Ändrar du något i `src/`: kör `python src/build.py` så byggs `index.html` om. (Claude gör det åt dig.)

## Filer

| Fil | Vad |
|---|---|
| `index.html` | Hela sajten i en fil (byggd från `src/` + `lib/held.js`) |
| `api/held.js` | Vercel-funktion: tavlan (`?op=board`), X-ray (`?op=xray&ca=`), utfall (`?op=outcome`) |
| `lib/held.js` | Motorn: hittar dippar, läser trades och holders, fäller utslaget. Körs både på servern och i webbläsaren |
| `og.png`, `fav.png` | Länkförhandsvisning på X och favicon |
| `grafik/` | pfp, banner, launch, og, fav och `x-kit.md` |

## Datakällor (gratis, inga nycklar)

- **Jupiter (`datapi.jup.ag/v1`):** dip-listan (1h trending / mest handlade / organic, 100 pooler var med 1h-statistik), trades per coin (`/txs`) och 1h-säljvolym.
- **GeckoTerminal:** stora sälj över hela timmen för väldigt aktiva coins, och 5-minuterscandles för loggen. Reserv för dip-listan.
- **Jupiter (`datapi.jup.ag/v1/holders`):** varje coins topp 100-holders. Pooler, bonding curves och program-ägda konton räknas inte som valar.
- **Solana RPC (publicnode):** program-koll av holders, mintens supply, och valar som rört påsen utan trade läses on-chain (`getSignaturesForAddress` + `getTransaction`). OBS: publicnode ger inte längre `getTokenLargestAccounts` gratis, därför Jupiter.
- **CoinGecko:** BTC-priset och fyramånaderslägsta i den röda remsan överst.
- **Motorn körs i besökarens webbläsare** (egen IP mot GeckoTerminal/Jupiter/RPC). Från Vercels delade servrar svarar GeckoTerminal och publika RPC ofta 429/403, så servern är bara reserv. Om inget går märks det "snapshot" eller "preview · sample data".

## Loggen

Varje besökares webbläsare skickar in de utslag den läser (`/api/held?op=log`), så loggen delas av alla. Den ligger i funktionens minne plus i varje webbläsare. För en permanent delad logg: Vercel → Storage → Upstash Redis → Connect till projektet. Då sätts `KV_REST_API_URL` och `KV_REST_API_TOKEN` och loggen sparar sig själv, ingen kodändring.

## Deploy

GitHub → Vercel. Framework: **Other**, ingen build. `api/` blir en funktion av sig själv.

## Kolla efter deploy

- **Typsnitt:** Archivo (rubriker) och IBM Plex Mono (siffror) laddar.
- **X-förhandsvisning:** klistra in länken i ett utkast på X, `og.png` ska synas.
- **Live-lampan** uppe till höger säger LIVE, och tavlan fylls inom ungefär en halv minut. `/api/held?op=diag` visar om datakällorna svarar från servern.
- `?preview` visar exempeldata, `?debug` visar status för datakällorna.

## Ärliga begränsningar

- Stora coins har fler trades än GeckoTerminals gratis-API ger. Då läses alla trades för de senaste minuterna plus alla stora sälj för hela timmen, och X-ray:en skriver ut exakt vad som lästs.
- "Före dippen" = påsen nu + det som sålts − det som köpts i fönstret. Valar som flyttat påsen utan trade kollas on-chain.
- Utslagen är regler, inte råd. Loggen visar hur ofta de stämt.
