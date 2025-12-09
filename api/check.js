// pages/api/check.js
// GlassBox backend – v2
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age / volume / tx count / socials
// - Insider snapshot + holder summary + simple scam score
// - IMPORTANT: never hard-code HELIUS key, only use process.env

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// --- Stablecoins we treat specially -----------------------------------

const STABLECOIN_WHITELIST = {
  // USDC
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

// Count token accounts – but don’t crash API if it fails
async function safeCountTokenHolders(mint) {
  try {
    const result = await callRpc("getTokenAccountsByMint", [
      mint,
      {
        // we only care about how many accounts exist, not their data
        encoding: "jsonParsed",
        commitment: "confirmed",
        dataSlice: { offset: 0, length: 0 },
      },
    ]);

    if (!result || !Array.isArray(result.value)) return null;
    return result.value.length;
  } catch (e) {
    console.error("safeCountTokenHolders error:", e?.message);
    return null;
  }
}

// --- DexScreener integration ------------------------------------------

/**
 * Uses DexScreener "token-pairs" endpoint:
 *   GET https://api.dexscreener.com/token-pairs/v1/solana/{mint}
 *
 * Returns:
 *  - priceUsd
 *  - liquidityUsd
 *  - ageDays
 *  - volume24Usd
 *  - txCount24
 *  - dexFeesUsd24h  (~0.3% of vol24)
 *  - poolMintReserve (for LP matching)
 *  - socials { website, twitter, telegram, discord, others[] }  (URLs)
 */
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
    const priceUsd =
      p.priceUsd != null ? Number(p.priceUsd) : NaN;
    const priceNative =
      p.priceNative != null ? Number(p.priceNative) : NaN;

    if (!liqUsd || Number.isNaN(liqUsd) || Number.isNaN(priceUsd)) continue;

    const baseAddr = p.baseToken?.address?.toLowerCase();
    const quoteAddr = p.quoteToken?.address?.toLowerCase();

    let myPriceUsd = null;
    let poolMintReserve = null;

    if (baseAddr === mintLower) {
      myPriceUsd = priceUsd;
      poolMintReserve =
        p.liquidity?.base != null ? Number(p.liquidity.base) : null;
    } else if (quoteAddr === mintLower && !Number.isNaN(priceNative) && priceNative !== 0) {
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
    // fall back to any highest-liquidity pair if mapping fails
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

  // NOTE: DexScreener pairCreatedAt is in ms (per docs)
  if (selected.pairCreatedAt != null) {
    const createdMs = Number(selected.pairCreatedAt);
    const now = Date.now();
    if (!Number.isNaN(createdMs) && createdMs > 0 && createdMs < now) {
      ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
    }
  }

  // Socials + website (we’ll use URLs, not handles)
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
    };
  }
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

    // --- Holder distribution ------------------------------------------

    const largestAccounts = Array.isArray(largest?.value) ? largest.value : [];
    const supplyBN = BigInt(mintParsed.supply || "0");

    const allHolders = largestAccounts.map((acc) => {
      const amountStr = acc.amount || "0";
      const amountBN = BigInt(amountStr);
      const pct =
        supplyBN > 0n
          ? Number((amountBN * 10_000n) / supplyBN) / 100
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

    // Detect LP by matching Dex pool reserve to a holder (or fallback to biggest)
    let lpHolder = null;
    let bestRelDiff = Infinity;
    const poolReserve = dexStats.poolMintReserve;

    if (
      poolReserve != null &&
      !Number.isNaN(poolReserve) &&
      poolReserve > 0
    ) {
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

    if (!lpHolder && allHolders.length) {
      lpHolder = allHolders.reduce((a, b) =>
        (a.uiAmount || 0) >= (b.uiAmount || 0) ? a : b
      );
    }

    allHolders.sort((a, b) => (b.pct || 0) - (a.pct || 0));
    const top10InclLP = allHolders.slice(0, 10);

    const nonLpHolders = lpHolder
      ? allHolders.filter((h) => h.address !== lpHolder.address)
      : allHolders.slice();

    const top10ExclLP = nonLpHolders.slice(0, 10);

    const pctTop10InclLP = top10InclLP.reduce(
      (sum, h) => sum + (h.pct || 0),
      0
    );
    const pctTop10ExclLP = top10ExclLP.reduce(
      (sum, h) => sum + (h.pct || 0),
      0
    );

   // If RPC holder count failed, fall back to “at least number of known holders”
let finalHoldersCount = holdersCount;
if (finalHoldersCount == null) {
  // allHolders comes from getTokenLargestAccounts (usually up to 20)
  // This is a lower bound, but better than N/A on the UI.
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

    // Simple “cluster” object so the Insiders & Clusters UI always has data
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

    // --- Origin hint ---------------------------------------------------

    let originLabel = "Unknown protocol / origin";
    let originDetail = "";
    const lowerName = name.toLowerCase();
    const lowerSym = (symbol || "").toLowerCase();
    const desc = (asset?.content?.metadata?.description || "").toLowerCase();

    if (
      lowerName.includes("pump") ||
      lowerSym.includes("pump") ||
      desc.includes("pump.fun")
    ) {
      originLabel = "Likely Pump.fun mint";
      originDetail =
        "Mint resembles Pump.fun pattern. Pump.fun usually locks LP, but always double-check.";
    }

    const originHint = { label: originLabel, detail: originDetail };

    // --- Scam score ----------------------------------------------------

    let scoreLevel = "medium";
    let scoreBlurb = "";
    let score = 50;

    if (!mintInfo.mintAuthority && !mintInfo.freezeAuthority && pctTop10ExclLP <= 35) {
      scoreLevel = "low";
      score = 90;
      scoreBlurb =
        "Mint & freeze authority renounced, and non-LP top holders are reasonably distributed.";
    } else if (!mintInfo.mintAuthority && pctTop10ExclLP <= 60) {
      scoreLevel = "medium";
      score = 65;
      scoreBlurb =
        "Mint authority renounced but non-LP holders still have some concentration.";
    } else {
      scoreLevel = "high";
      score = 25;
      scoreBlurb =
        "Mint or freeze authority still active and/or heavy concentration among non-LP holders.";
    }

    const riskSummary = {
      level: scoreLevel,
      blurb: scoreBlurb,
      score, // GlassBox scam score 0-100
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
        days: dexStats.ageDays,
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
