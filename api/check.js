// pages/api/check.js
// GlassBox backend – v2
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age / volume / tx count / socials
// - Insider snapshot + holder summary + risk score
// - IMPORTANT: never hard-code HELIUS key, only use process.env

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// --- Stablecoins we treat specially -----------------------------------

// We whitelist both common USDC mint formats + USDT
const STABLECOIN_WHITELIST = {
  // USDC (canonical Solana mint)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1": {
    symbol: "USDC",
    name: "USD Coin (USDC)",
  },
  // USDC (alt / trailing v variant if your wallet shows it that way)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
    symbol: "USDC",
    name: "USD Coin (USDC)",
  },
  // USDT
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
    symbol: "USDT",
    name: "Tether USD (USDT)",
  },
};

// --- Generic helpers ---------------------------------------------------

async function callRpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) throw new Error(`RPC error: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

// Decode SPL Mint account (base64) → supply/decimals/authorities
function parseMintAccount(base64Data) {
  if (!base64Data) throw new Error("Missing mint account data");
  const buf = Buffer.from(base64Data, "base64");
  if (buf.length < 82) throw new Error("Mint account data too short");

  const supply = buf.readBigUInt64LE(36);
  const decimals = buf[44];
  const mintAuthOpt = buf.readUInt32LE(0);
  const freezeAuthOpt = buf.readUInt32LE(48);

  return {
    supply: supply.toString(),
    decimals,
    hasMintAuthority: mintAuthOpt !== 0,
    hasFreezeAuthority: freezeAuthOpt !== 0,
  };
}

function shortAddr(a) {
  if (!a || a.length <= 8) return a;
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

// Count holders without downloading full account data
async function safeCountTokenHolders(mint) {
  try {
    const result = await callRpc("getTokenAccountsByMint", [
      mint,
      {
        commitment: "confirmed",
        encoding: "jsonParsed",
        dataSlice: { offset: 0, length: 0 }, // just need the list, not balances
      },
    ]);

    if (!result || !Array.isArray(result.value)) return null;

    // One token account == one holder slot
    return result.value.length;
  } catch (e) {
    console.error("safeCountTokenHolders error:", e?.message || e);
    return null;
  }
}


// --- DexScreener integration ------------------------------------------

async function fetchDexAndAgeStatsFromDexScreener(mint) {
  const chainId = "solana";
  const url = `https://api.dexscreener.com/token-pairs/v1/${chainId}/${mint}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener error: ${res.status}`);
  const json = await res.json();

  const pairs = Array.isArray(json) ? json : [];
  if (!pairs.length) {
    return {
      priceUsd: null,
      liquidityUsd: null,
      ageDays: null,
      volume24Usd: null,
      txCount24: null,
      dexFeesUsd24h: null,
      poolMintReserve: null,
      socials: null,
      dexId: null,
    };
  }

  const mintLower = mint.toLowerCase();
  let best = null;
  let bestLiq = 0;

  for (const p of pairs) {
    if (!p || p.chainId !== chainId) continue;

    const liqUsd =
      p.liquidity && typeof p.liquidity.usd === "number"
        ? p.liquidity.usd
        : Number(p.liquidity?.usd ?? NaN);
    const priceUsd = p.priceUsd != null ? Number(p.priceUsd) : NaN;
    const priceNative = p.priceNative != null ? Number(p.priceNative) : NaN;

    if (!liqUsd || Number.isNaN(liqUsd) || Number.isNaN(priceUsd)) continue;

    const baseAddr = p.baseToken?.address?.toLowerCase();
    const quoteAddr = p.quoteToken?.address?.toLowerCase();

    let myPriceUsd = null;
    let poolMintReserve = null;

    if (baseAddr === mintLower) {
      myPriceUsd = priceUsd;
      poolMintReserve =
        p.liquidity?.base != null ? Number(p.liquidity.base) : null;
    } else if (
      quoteAddr === mintLower &&
      !Number.isNaN(priceNative) &&
      priceNative !== 0
    ) {
      myPriceUsd = priceUsd / priceNative;
      poolMintReserve =
        p.liquidity?.quote != null ? Number(p.liquidity.quote) : null;
    } else {
      continue;
    }

    if (Number.isNaN(myPriceUsd)) continue;
    if (!best || liqUsd > bestLiq) {
      best = {
        pair: p,
        priceUsd: myPriceUsd,
        liquidityUsd: liqUsd,
        poolMintReserve,
      };
      bestLiq = liqUsd;
    }
  }

  if (!best) {
    const p = pairs.reduce((a, b) =>
      (a.liquidity?.usd || 0) >= (b.liquidity?.usd || 0) ? a : b
    );
    best = {
      pair: p,
      priceUsd: Number(p.priceUsd ?? NaN),
      liquidityUsd: Number(p.liquidity?.usd ?? NaN),
      poolMintReserve:
        p.baseToken?.address?.toLowerCase() === mintLower
          ? Number(p.liquidity?.base ?? NaN)
          : Number(p.liquidity?.quote ?? NaN),
    };
  }

  const selected = best.pair;
  let volume24 = null;
  let txCount24 = null;
  let ageDays = null;
  let dexFeesUsd24h = null;

  if (selected.volume && selected.volume.h24 != null) {
    const v24 = Number(selected.volume.h24);
    if (!Number.isNaN(v24) && v24 > 0) volume24 = v24;
  }

  if (selected.txns && selected.txns.h24) {
    const buys = Number(selected.txns.h24.buys || 0);
    const sells = Number(selected.txns.h24.sells || 0);
    const total = buys + sells;
    if (!Number.isNaN(total) && total > 0) txCount24 = total;
  }

  if (volume24 != null) dexFeesUsd24h = volume24 * 0.003;

  // pairCreatedAt in ms
  if (selected.pairCreatedAt != null) {
    const createdMs = Number(selected.pairCreatedAt);
    const now = Date.now();
    if (!Number.isNaN(createdMs) && createdMs > 0 && createdMs < now) {
      ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
    }
  }

  // Socials + website (URLs)
  let socials = null;
  if (selected.info) {
    const info = selected.info;
    const websites = Array.isArray(info.websites) ? info.websites : [];
    const socialsArr = Array.isArray(info.socials) ? info.socials : [];

    const website =
      websites.length && websites[0] && typeof websites[0].url === "string"
        ? websites[0].url
        : null;

    const find = (platformName) =>
      socialsArr.find(
        (s) =>
          s &&
          typeof s.platform === "string" &&
          s.platform.toLowerCase() === platformName
      ) || null;

    const tw = find("twitter");
    const tg = find("telegram");
    const dc = find("discord");

    const others = socialsArr
      .filter(
        (s) =>
          s &&
          typeof s.platform === "string" &&
          !["twitter", "telegram", "discord"].includes(
            s.platform.toLowerCase()
          )
      )
      .map((s) => ({
        platform: s.platform,
        url: s.handle ? `https://${s.platform}.com/${s.handle}` : null,
      }));

    socials = {
      website,
      twitter: tw && tw.handle ? `https://x.com/${tw.handle}` : null,
      telegram: tg && tg.handle ? `https://t.me/${tg.handle}` : null,
      discord: dc && dc.handle ? `https://discord.gg/${dc.handle}` : null,
      others,
    };
  }

  return {
    priceUsd: best.priceUsd,
    liquidityUsd: best.liquidityUsd,
    poolMintReserve: best.poolMintReserve ?? null,
    ageDays,
    volume24Usd: volume24,
    txCount24,
    dexFeesUsd24h,
    socials,
    dexId: selected.dexId ? String(selected.dexId).toLowerCase() : null,
  };
}

async function fetchDexStatsSafe(mint) {
  try {
    return await fetchDexAndAgeStatsFromDexScreener(mint);
  } catch (e) {
    console.error("DexScreener failed:", e?.message);
    return {
      priceUsd: null,
      liquidityUsd: null,
      poolMintReserve: null,
      ageDays: null,
      volume24Usd: null,
      txCount24: null,
      dexFeesUsd24h: null,
      socials: null,
      dexId: null,
    };
  }
}

// --- Origin / protocol detection helper -------------------------------

function detectOrigin({ mint, name, symbol, desc, dexId }) {
  const lowerMint = (mint || "").toLowerCase();
  const lowerName = (name || "").toLowerCase();
  const lowerSym = (symbol || "").toLowerCase();
  const lowerDesc = (desc || "").toLowerCase();
  const dex = (dexId || "").toLowerCase();

  let key = "unknown";
  let label = "Unknown protocol / origin";
  let detail =
    "Origin could not be confidently determined from mint pattern, metadata, or pool.";

  const hasAny = (str, words) =>
    words.some((w) => w && str.includes(w.toLowerCase()));

  // Pump.fun
  if (
    lowerMint.endsWith("pump") ||
    hasAny(lowerDesc, ["pump.fun"]) ||
    hasAny(lowerName, [" pump", "pump "]) ||
    hasAny(lowerSym, ["pump"]) ||
    dex === "pump"
  ) {
    key = "pump";
    label = "Pump.fun";
    detail =
      "Token likely minted via Pump.fun or traded primarily on Pump.fun pools. Pump.fun often locks LP, but always verify LP lock and insiders.";
    return { key, label, detail };
  }

  // Bonk ecosystem
  if (
    lowerMint.endsWith("bonk") ||
    hasAny(lowerName, ["bonk"]) ||
    hasAny(lowerDesc, ["bonk", "bonkbot"])
  ) {
    key = "bonk";
    label = "Bonk ecosystem";
    detail =
      "Token appears related to Bonk tooling or branding. LP and insider distribution still drive risk.";
    return { key, label, detail };
  }

  // Sugar
  if (
    lowerMint.endsWith("sugar") ||
    hasAny(lowerName, ["sugar"]) ||
    hasAny(lowerDesc, ["sugar"])
  ) {
    key = "sugar";
    label = "Sugar";
    detail =
      "Mint or metadata suggests a Sugar-style launch. LP and insider distribution remain the main safety signals.";
    return { key, label, detail };
  }

  // Bags
  if (
    lowerMint.endsWith("bags") ||
    hasAny(lowerDesc, ["bags.fun"]) ||
    hasAny(lowerName, ["bags "]) ||
    hasAny(lowerSym, ["bags"])
  ) {
    key = "bags";
    label = "Bags";
    detail =
      "Token metadata or mint pattern resembles Bags-style launches. Check LP and holder spread carefully.";
    return { key, label, detail };
  }

  // Daos.fun
  if (
    hasAny(lowerDesc, ["daos.fun"]) ||
    hasAny(lowerName, ["daos "]) ||
    hasAny(lowerSym, ["daos"])
  ) {
    key = "daosfun";
    label = "Daos.fun";
    detail =
      "Likely launched via Daos.fun. Governance/DAO features may apply, but rug risk still depends on insiders and LP.";
    return { key, label, detail };
  }

  // Believe
  if (
    lowerMint.endsWith("blv") ||
    hasAny(lowerName, ["believe"]) ||
    hasAny(lowerSym, ["blv"]) ||
    hasAny(lowerDesc, ["believe protocol"])
  ) {
    key = "believe";
    label = "Believe";
    detail =
      "Branding suggests a Believe-style launch. LP and insider structure are what matter for safety.";
    return { key, label, detail };
  }

  // Boop
  if (
    lowerMint.endsWith("boop") ||
    hasAny(lowerName, ["boop"]) ||
    hasAny(lowerSym, ["boop"])
  ) {
    key = "boop";
    label = "Boop";
    detail =
      "Name, symbol or mint suffix suggests a Boop-style launch. Check for concentrated insiders and LP unlock risk.";
    return { key, label, detail };
  }

  // Mayhem
  if (
    lowerMint.endsWith("mayhem") ||
    hasAny(lowerName, ["mayhem"]) ||
    hasAny(lowerDesc, ["mayhem"])
  ) {
    key = "mayhem";
    label = "Mayhem Protocol";
    detail =
      "Token appears linked to Mayhem’s high-volatility launch mechanics. Expect extremely degen early trading conditions.";
    return { key, label, detail };
  }

  // Moonshot
  if (
    lowerMint.endsWith("moonshot") ||
    hasAny(lowerName, ["moonshot"]) ||
    hasAny(lowerDesc, ["moonshot"])
  ) {
    key = "moonshot";
    label = "Moonshot";
    detail =
      "Moonshot-style launch. Watch token age and insider activity closely.";
    return { key, label, detail };
  }

  // Candle
  if (
    lowerMint.endsWith("candle") ||
    hasAny(lowerName, ["candle"]) ||
    hasAny(lowerDesc, ["candle"])
  ) {
    key = "candle";
    label = "Candle";
    detail =
      "Token name or mint suggests a Candle-style launch. Check LP lock and holder distribution.";
    return { key, label, detail };
  }

  // Heaven
  if (
    lowerMint.endsWith("heaven") ||
    hasAny(lowerName, ["heaven"]) ||
    hasAny(lowerDesc, ["heaven"])
  ) {
    key = "heaven";
    label = "Heaven";
    detail =
      "Heaven-style branding detected. Still a degen launch; treat risk as normal for memes.";
    return { key, label, detail };
  }

  // Moonit
  if (
    lowerMint.endsWith("moonit") ||
    lowerMint.endsWith("moont") ||
    hasAny(lowerName, ["moonit", "moont"]) ||
    hasAny(lowerDesc, ["moonit", "moont"])
  ) {
    key = "moonit";
    label = "Moonit";
    detail =
      "Looks like a Moonit-style token. Small-cap degen launches require careful attention to holders and LP safety.";
    return { key, label, detail };
  }

  // Jupiter Studio
  if (
    hasAny(lowerDesc, ["jupiter studio"]) ||
    hasAny(lowerName, ["jupiter studio"])
  ) {
    key = "jupiter-studio";
    label = "Jupiter Studio";
    detail =
      "Likely created via Jupiter Studio or associated tools. Origin is more structured, but LP and insiders still drive risk.";
    return { key, label, detail };
  }

  // LaunchLab
  if (
    hasAny(lowerDesc, ["launchlab"]) ||
    hasAny(lowerName, ["launchlab"]) ||
    lowerMint.endsWith("launchlab")
  ) {
    key = "launchlab";
    label = "LaunchLab";
    detail =
      "Likely launched via LaunchLab. Fair-launch style does not remove rug risk from insiders or LP.";
    return { key, label, detail };
  }

  // Wavebreak
  if (
    hasAny(lowerDesc, ["wavebreak"]) ||
    hasAny(lowerName, ["wavebreak"])
  ) {
    key = "wavebreak";
    label = "Wavebreak";
    detail =
      "Branding suggests a Wavebreak-related token. Always verify LP lock and insider holdings.";
    return { key, label, detail };
  }

  // Dynamic BC
  if (
    hasAny(lowerName, ["dynamic bc"]) ||
    hasAny(lowerDesc, ["dynamic bc", "dynamicbc"])
  ) {
    key = "dynamic-bc";
    label = "Dynamic BC";
    detail =
      "Token metadata references Dynamic BC. Treat as an experimental launch style; LP and insiders still drive rug risk.";
    return { key, label, detail };
  }

  // AMMs
  if (dex === "raydium") {
    key = "raydium";
    label = "Raydium AMM";
    detail =
      "Primary liquidity pool is on Raydium. LP safety depends on lock/burn status and who holds the LP tokens.";
    return { key, label, detail };
  }

  if (dex === "orca") {
    key = "orca";
    label = "Orca AMM";
    detail =
      "Primary liquidity pool is on Orca. Check LP lock and holder concentration for rug risk.";
    return { key, label, detail };
  }

  if (dex === "meteora" || dex === "meteora-amm-v2" || dex === "meteora-amm") {
    key = "meteora";
    label = "Meteora AMM";
    detail =
      "Primary liquidity pool is on Meteora. Dynamic pools can be capital-efficient but LP unlocks can still rug.";
    return { key, label, detail };
  }

  if (dex === "pump") {
    key = "pump-amm";
    label = "Pump AMM";
    detail =
      "Token trades mainly via Pump AMM liquidity. Verify LP lock/burn and top-holder distribution.";
    return { key, label, detail };
  }

  return { key, label, detail };
}

// --- API handler -------------------------------------------------------

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const mint = (req.query.mint || "").trim();
    if (!mint) return res.status(400).json({ error: "Missing mint param" });
    if (!HELIUS_API_KEY) {
      return res
        .status(500)
        .json({ error: "HELIUS_API_KEY missing in env" });
    }

    // 1) Mint account
    const accountInfoPromise = callRpc("getAccountInfo", [
      mint,
      { encoding: "base64", commitment: "confirmed" },
    ]);

    // 2) Token metadata
    const assetPromise = fetch(
      "https://mainnet.helius-rpc.com/?api-key=" + HELIUS_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAsset",
          params: { id: mint },
        }),
      }
    ).then(async (r) => {
      if (!r.ok) throw new Error("getAsset error " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "getAsset error");
      return j.result;
    });

    // 3) Largest accounts (top holders)
    const largestPromise = callRpc("getTokenLargestAccounts", [
      mint,
      { commitment: "confirmed" },
    ]);

    // 4) Dex stats
    const dexStatsPromise = fetchDexStatsSafe(mint);

    // 5) Total holder count
    const holdersCountPromise = safeCountTokenHolders(mint);

    const [accountInfo, asset, largest, dexStats, holdersCount] =
      await Promise.all([
        accountInfoPromise,
        assetPromise,
        largestPromise,
        dexStatsPromise,
        holdersCountPromise,
      ]);

    if (!accountInfo?.value) {
      return res.status(404).json({ error: "Not a valid SPL mint account" });
    }

    // Mint core info
    const mintDataBase64 = accountInfo.value.data?.[0];
    const mintParsed = parseMintAccount(mintDataBase64);

    const mintInfo = {
      supply: mintParsed.supply,
      decimals: mintParsed.decimals,
      mintAuthority: mintParsed.hasMintAuthority,
      freezeAuthority: mintParsed.hasFreezeAuthority,
    };

    // Token metadata
    let name = "Unknown Token";
    let symbol = "";
    let logoURI = null;

    try {
      if (asset?.content?.metadata) {
        name = asset.content.metadata.name || name;
        symbol = asset.content.metadata.symbol || "";
      }
      if (asset?.content?.links?.image) {
        logoURI = asset.content.links.image;
      }
    } catch (e) {
      console.error("metadata parse error:", e?.message);
    }

    const tokenMeta = { mint, name, symbol, logoURI };

// --- Holder distribution (LP + whales) --------------------------------
const largestAccounts = Array.isArray(largest?.value) ? largest.value : [];
const supplyBN = BigInt(mintParsed.supply || "0");

const allHolders = largestAccounts.map((acc) => {
  const amountStr = acc.amount || "0";
  const amountBN = BigInt(amountStr);

  const pct =
    supplyBN > 0n
      ? Number((amountBN * 10_000n) / supplyBN) / 100 // keep two decimals
      : 0;

  const uiAmount =
    typeof acc.uiAmount === "number"
      ? acc.uiAmount
      : Number(acc.uiAmount ?? 0);

  return {
    address: acc.address,
    pct,
    uiAmount,
  };
});

// Try to match LP to the DexScreener pool size
let lpHolder = null;
let bestRelDiff = Infinity;
const poolReserve = dexStats.poolMintReserve;

if (poolReserve != null && !Number.isNaN(poolReserve) && poolReserve > 0) {
  for (const h of allHolders) {
    if (!h.uiAmount || Number.isNaN(h.uiAmount)) continue;
    const diff = Math.abs(h.uiAmount - poolReserve);
    const rel = diff / poolReserve;
    if (rel < 0.2 && rel < bestRelDiff) {
      bestRelDiff = rel;
      lpHolder = h;
    }
  }
}

// Fallback: biggest wallet = LP
if (!lpHolder && allHolders.length) {
  lpHolder = allHolders.reduce((a, b) =>
    (a.uiAmount || 0) >= (b.uiAmount || 0) ? a : b
  );
}

// Sort by % of supply and take top 10
allHolders.sort((a, b) => (b.pct || 0) - (a.pct || 0));

const top10InclLP = allHolders.slice(0, 10);
const nonLpHolders = lpHolder
  ? allHolders.filter((h) => h.address !== lpHolder.address)
  : allHolders.slice();
const top10ExclLP = nonLpHolders.slice(0, 10);

const pctTop10InclLP = top10InclLP.reduce((sum, h) => sum + (h.pct || 0), 0);
const pctTop10ExclLP = top10ExclLP.reduce((sum, h) => sum + (h.pct || 0), 0);

// Holder count: prefer full RPC count, fall back to “at least this many”
let finalHoldersCount = holdersCount;
if (finalHoldersCount == null) {
  finalHoldersCount = allHolders.length || null;
}

const holderSummary = {
  top10Pct: pctTop10InclLP,
  topHolders: top10InclLP,
  top10PctExcludingLP: pctTop10ExclLP,
  topHoldersExcludingLP: top10ExclLP,
  lpHolder,
  holdersCount: finalHoldersCount,
};

    // --- Insiders snapshot --------------------------------------------

    const INSIDER_PCT = 1; // insider ≥1%
    const WHALE_PCT = 5;   // whale   ≥5%

    const insidersAll = nonLpHolders.filter((h) => (h.pct || 0) >= INSIDER_PCT);
    const whales = nonLpHolders.filter((h) => (h.pct || 0) >= WHALE_PCT);
    const insidersTotalPct = insidersAll.reduce(
      (sum, h) => sum + (h.pct || 0),
      0
    );
    const largestInsider = insidersAll[0] || null;

    let insiderRiskLevel = "low";
    let insiderNote = "No strong insider concentration detected.";

    if (insidersTotalPct > 60 || whales.length >= 3) {
      insiderRiskLevel = "high";
      insiderNote =
        "Very high concentration among a few wallets. Classic rug-pull pattern if they dump.";
    } else if (insidersTotalPct > 35 || whales.length >= 1) {
      insiderRiskLevel = "medium";
      insiderNote =
        "Moderate concentration among insiders. Watch wallets holding ≥1% closely.";
    }

    const insiderSummary = {
      insidersAll,
      whales,
      insidersTotalPct,
      largestInsider,
      riskLevel: insiderRiskLevel,
      note: insiderNote,
      insiderWalletCount: insidersAll.length,
    };

    const insiderClusters = {
      riskLevel: insiderRiskLevel,
      note: insiderNote,
      sampleCluster: largestInsider
        ? {
            label: "Largest insider",
            leader: largestInsider.address,
            leaderShort: shortAddr(largestInsider.address),
            pctOfSupply: largestInsider.pct,
          }
        : null,
    };

    // --- Dex metrics + age + liquidity truth --------------------------

    const tokenMetrics = {
      priceUsd: dexStats.priceUsd,
      liquidityUsd: dexStats.liquidityUsd,
      dexFeesUsd24h: dexStats.dexFeesUsd24h,
    };

    let tokenAge = null;
    if (
      dexStats.ageDays != null &&
      !Number.isNaN(dexStats.ageDays) &&
      dexStats.ageDays >= 0
    ) {
      tokenAge = {
        ageDays: dexStats.ageDays,
      };
    }

    const liqUsd = dexStats.liquidityUsd;
    const vol24 = dexStats.volume24Usd;
    const tx24 = dexStats.txCount24;

    let tradeToLiquidity = null;
    let avgTradeUsd = null;
    let liqTruthLevel = null;
    let liqTruthLabel = "Unknown";
    let liqTruthNote =
      "Not enough volume / trade data to judge liquidity quality.";

    if (
      liqUsd != null &&
      liqUsd > 0 &&
      vol24 != null &&
      vol24 > 0 &&
      tx24 != null &&
      tx24 > 0
    ) {
      tradeToLiquidity = vol24 / liqUsd;
      avgTradeUsd = vol24 / tx24;

      if (tradeToLiquidity > 100 && tx24 < 50) {
        liqTruthLevel = "high";
        liqTruthLabel = "Likely fake / wash";
        liqTruthNote =
          "24h volume is huge vs liquidity but with very few trades – classic wash-trading pattern.";
      } else if (tradeToLiquidity > 30 && tx24 < 150) {
        liqTruthLevel = "medium";
        liqTruthLabel = "Suspicious";
        liqTruthNote =
          "Volume is high relative to liquidity with only modest trade count.";
      } else {
        liqTruthLevel = "low";
        liqTruthLabel = "Mostly real";
        liqTruthNote =
          "Volume and trade count look consistent with liquidity size.";
      }
    }

    const liquidityTruth = {
      level: liqTruthLevel,
      label: liqTruthLabel,
      note: liqTruthNote,
      tradeToLiquidity,
      avgTradeUsd,
      volume24Usd: vol24,
      txCount24: tx24,
      // will wire real % later when we have an LP lock source
      lockPercent: null,
    };

    // --- Origin hint + Mayhem Mode ------------------------------------

    const rawDesc = asset?.content?.metadata?.description || "";
    const originMeta = detectOrigin({
      mint,
      name,
      symbol,
      desc: rawDesc,
      dexId: dexStats.dexId,
    });

    // Mayhem Mode: Mayhem origin + super fresh token (< 1 hour)
    const MAYHEM_MODE_WINDOW_DAYS = 1 / 24; // 1 hour
    let mayhemMode = { active: false, secondsRemaining: null };

    const ageDaysForMayhem = tokenAge?.ageDays ?? null;
    if (originMeta.key === "mayhem" && ageDaysForMayhem != null) {
      if (ageDaysForMayhem < MAYHEM_MODE_WINDOW_DAYS) {
        const remainingDays = MAYHEM_MODE_WINDOW_DAYS - ageDaysForMayhem;
        const secondsRemaining = Math.max(
          0,
          Math.round(remainingDays * 24 * 60 * 60)
        );
        mayhemMode = { active: true, secondsRemaining };
      }
    }

    const originHint = {
      label: originMeta.label,
      detail: originMeta.detail,
      key: originMeta.key,
    };

    // --- GlassBox risk score ------------------------------------------

    const liquidityTruthSafe =
      liquidityTruth ?? { level: "medium", lockPercent: null };

    // 1) Mint safety (0–100)
    let mintScore = 50;
    if (!mintInfo.mintAuthority && !mintInfo.freezeAuthority) {
      mintScore = 95;
    } else if (!mintInfo.mintAuthority && mintInfo.freezeAuthority) {
      mintScore = 75;
    } else {
      mintScore = 35;
    }

    // 2) Holder / insider safety (0–100)
    const top10PctExclLP = holderSummary.top10PctExcludingLP ?? 0;
    const insidersPct = insiderSummary.insidersTotalPct ?? 0;

    let holderScore = 50;
    if (top10PctExclLP <= 25 && insidersPct <= 30) {
      holderScore = 90;
    } else if (top10PctExclLP <= 40 && insidersPct <= 45) {
      holderScore = 65;
    } else {
      holderScore = 35;
    }

    // 3) Liquidity safety (0–100)
    let liqScore = 50;
    if (liquidityTruthSafe.level === "low") {
      liqScore = 90;
    } else if (liquidityTruthSafe.level === "medium") {
      liqScore = 60;
    } else if (liquidityTruthSafe.level === "high") {
      liqScore = 35;
    }

    const liqLockPct = liquidityTruthSafe.lockPercent ?? null;
    if (liqLockPct != null) {
      if (liqLockPct < 50) liqScore -= 15;
      else if (liqLockPct < 80) liqScore -= 5;
      if (liqScore < 0) liqScore = 0;
    }

    // 4) Age / degen safety (0–100)
    const ageDays = tokenAge?.ageDays ?? null;
    let ageScore = 50;
    if (ageDays != null) {
      if (ageDays < 0.25) {
        ageScore = 30; // < 6h
      } else if (ageDays < 2) {
        ageScore = 50; // 6h–2d
      } else if (ageDays < 14) {
        ageScore = 70; // 2–14d
      } else {
        ageScore = 85; // >14d
      }
    }

    // Bump down risk further if Mayhem Mode is active (super degen)
    if (mayhemMode.active) {
      ageScore = Math.min(ageScore, 30); // treat as ultra new
      liqScore = Math.min(liqScore, 60); // don't over-trust liq yet
    }

    const score = Math.round(
      mintScore * 0.3 + holderScore * 0.3 + liqScore * 0.25 + ageScore * 0.15
    );

    let scoreLevel = "medium";
    if (score >= 80) scoreLevel = "low";
    else if (score <= 45) scoreLevel = "high";

    let scoreBlurb = "";
    if (scoreLevel === "low") {
      scoreBlurb =
        "Mint, holders, liquidity and age all look relatively healthy. Always DYOR, but this is on the safer side for degen plays.";
    } else if (scoreLevel === "medium") {
      scoreBlurb =
        "Mixed signals across mint, holders, liquidity or age. Treat this as a degen play and size accordingly.";
    } else {
      scoreBlurb =
        "One or more serious red flags across mint, holders, liquidity or age. Extreme rug risk.";
    }

    const riskSummary = {
      level: scoreLevel,
      blurb: scoreBlurb,
      score,
      axes: {
        mintScore,
        holderScore,
        liqScore,
        ageScore,
      },
    };

    // --- Stablecoin override ------------------------------------------

    const stable = STABLECOIN_WHITELIST[mint];
    if (stable) {
      originHint.label = `${stable.symbol} – centralized stablecoin`;
      originHint.detail =
        `${stable.symbol} on Solana from a known issuer. ` +
        "High holder concentration + active freeze authority are normal here.";

      riskSummary.level = "low";
      riskSummary.score = 95;
      riskSummary.blurb =
        "Whitelisted centralized stablecoin. Rug-style mint tricks are not the main risk.";

      if (!tokenMetrics.priceUsd) tokenMetrics.priceUsd = 1.0;
    }

    // --- Final JSON ----------------------------------------------------

    return res.status(200).json({
      tokenMeta,
      mintInfo,
      holderSummary,
      insiderSummary,
      insiderClusters,
      originHint,
      mayhemMode,
      riskSummary,
      tokenMetrics,
      tokenAge,
      liquidityTruth,
      socials: dexStats.socials,
    });
  } catch (err) {
    console.error("GlassBox /api/check error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
}
