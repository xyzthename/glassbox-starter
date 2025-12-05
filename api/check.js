// api/check.js
// GlassBox backend
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age / 24h DEX fees

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Known Solana stablecoins (whitelist)
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
  // Add others as needed
};

// ---------------------------------------------------------------------
// Low-level RPC helper
// ---------------------------------------------------------------------

async function callRpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`RPC error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message || "RPC error");
  }
  return json.result;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Decode mint account data from base64 SPL mint layout
function parseMintAccount(base64Data) {
  if (!base64Data) throw new Error("Missing mint account data");
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length < 82) {
    throw new Error("Mint account data too short");
  }

  // SPL Mint layout:
  //   0   4   u32   mint authority option
  //   4   32  Pubkey mint authority
  //   36  8   u64   supply
  //   44  8   u8 + padding
  //   45  1   decimals
  //   46  1   isInitialized
  //   47  4   u32   freeze authority option
  //   51  32  Pubkey freeze authority
  const supply = buffer.readBigUInt64LE(36);
  const decimals = buffer[44];
  const mintAuthorityOption = buffer.readUInt32LE(0);
  const freezeAuthorityOption = buffer.readUInt32LE(48);

  const hasMintAuthority = mintAuthorityOption !== 0;
  const hasFreezeAuthority = freezeAuthorityOption !== 0;

  return {
    supply: supply.toString(),
    decimals,
    hasMintAuthority,
    hasFreezeAuthority,
  };
}

function shortAddr(addr) {
  if (!addr || addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// Safe wrappers so big RPC failures don’t blow up the whole scan
async function safeCountTokenHolders(mint) {
  try {
    const result = await callRpc("getTokenAccountsByMint", [
      mint,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
      },
    ]);

    if (!result || !Array.isArray(result.value)) return null;
    return result.value.length;
  } catch (e) {
    console.error("safeCountTokenHolders error:", e?.message);
    // If it fails, we just won't show holdersCount instead of breaking API
    return null;
  }
}

/**
 * DexScreener helper:
 *  - GET /token-pairs/v1/solana/{tokenAddress}
 *  - Compute:
 *      priceUsd         -> token price in USD
 *      liquidityUsd
 *      ageDays          -> pairCreatedAt -> days
 *      dexFeesUsd24h    -> ~24h DEX trading fees in USD (0.3% of h24 volume)
 *      poolMintReserve  -> token amount in the main pool (for LP detection)
 *      volume24Usd      -> 24h volume in USD
 *      txCount24        -> 24h trades count (buys + sells)
 *      socials          -> website + socials handles for UI pills
 */
async function fetchDexAndAgeStatsFromDexScreener(mint) {
  const chainId = "solana";
  const url = `https://api.dexscreener.com/token-pairs/v1/${chainId}/${mint}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DexScreener error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const rawPairs = Array.isArray(json) ? json : [];
  const mintLower = mint.toLowerCase();

  const pairs = rawPairs.filter((p) => p && p.chainId === chainId);

  if (!pairs.length) {
    return {
      priceUsd: null,
      liquidityUsd: null,
      ageDays: null,
      dexFeesUsd24h: null,
      poolMintReserve: null,
      volume24Usd: null,
      txCount24: null,
      socials: null,
    };
  }

  // We want the pair that best represents our mint, with highest liquidity
  let best = null;
  let bestLiquidity = 0;

  for (const p of pairs) {
    const baseAddr = p.baseToken?.address;
    const quoteAddr = p.quoteToken?.address;
    if (!baseAddr && !quoteAddr) continue;

    const rawPriceUsd =
      p.priceUsd != null ? Number(p.priceUsd) : null; // BASE in USD
    const priceNative =
      p.priceNative != null ? Number(p.priceNative) : null; // base in terms of quote
    const liqUsd =
      p.liquidity?.usd != null ? Number(p.liquidity.usd) : null;

    if (liqUsd == null || Number.isNaN(liqUsd)) continue;
    if (rawPriceUsd == null || Number.isNaN(rawPriceUsd)) continue;

    let myPriceUsd = null;
    let poolMintReserve = null;

    if (baseAddr && baseAddr.toLowerCase() === mintLower) {
      // Mint is BASE
      myPriceUsd = rawPriceUsd;
      poolMintReserve =
        p.liquidity?.base != null ? Number(p.liquidity.base) : null;
    } else if (
      quoteAddr &&
      quoteAddr.toLowerCase() === mintLower &&
      priceNative != null &&
      !Number.isNaN(priceNative) &&
      priceNative !== 0
    ) {
      // Mint is QUOTE
      myPriceUsd = rawPriceUsd / priceNative;
      poolMintReserve =
        p.liquidity?.quote != null ? Number(p.liquidity.quote) : null;
    } else {
      continue;
    }

    if (myPriceUsd == null || Number.isNaN(myPriceUsd)) continue;

    if (!best || liqUsd > bestLiquidity) {
      best = {
        pair: p,
        priceUsd: myPriceUsd,
        liquidityUsd: liqUsd,
        poolMintReserve,
      };
      bestLiquidity = liqUsd;
    }
  }

  let selectedPair = null;
  let priceUsd = null;
  let liquidityUsd = null;
  let pairCreatedAt = null;
  let volume24 = null;
  let txCount24 = null;
  let poolMintReserve = null;
  let dexFeesUsd24h = null;
  // Basic social + website info from DexScreener (if available)
  let socials = null;

  if (best) {
    selectedPair = best.pair;
    priceUsd = best.priceUsd;
    liquidityUsd = best.liquidityUsd;
    poolMintReserve = best.poolMintReserve ?? null;
  } else {
    // Fallback: pick highest-liquidity pair even if price mapping is imperfect
    selectedPair = pairs.reduce((a, b) =>
      (a.liquidity?.usd || 0) >= (b.liquidity?.usd || 0) ? a : b
    );
    liquidityUsd =
      selectedPair.liquidity?.usd != null
        ? Number(selectedPair.liquidity.usd)
        : null;
    priceUsd =
      selectedPair.priceUsd != null
        ? Number(selectedPair.priceUsd)
        : null;

    const baseAddr = selectedPair.baseToken?.address;
    const quoteAddr = selectedPair.quoteToken?.address;
    if (baseAddr && baseAddr.toLowerCase() === mintLower) {
      poolMintReserve =
        selectedPair.liquidity?.base != null
          ? Number(selectedPair.liquidity.base)
          : null;
    } else if (quoteAddr && quoteAddr.toLowerCase() === mintLower) {
      poolMintReserve =
        selectedPair.liquidity?.quote != null
          ? Number(selectedPair.liquidity.quote)
          : null;
    }
  }

  // 24h volume (USD) – DexScreener volume.h24
  if (selectedPair && selectedPair.volume) {
    const v24 = selectedPair.volume.h24;
    if (v24 != null) {
      const n24 = Number(v24);
      if (!Number.isNaN(n24)) {
        volume24 = n24;
      }
    }
  }

  // 24h trades (buys + sells) – used for fake-liquidity detection
  if (selectedPair && selectedPair.txns && typeof selectedPair.txns === "object") {
    const t24 = selectedPair.txns.h24;
    if (t24) {
      const buys = Number(t24.buys || 0);
      const sells = Number(t24.sells || 0);
      const total = buys + sells;
      if (!Number.isNaN(total) && total > 0) {
        txCount24 = total;
      }
    }
  }

  // 24h DEX fee estimate (assuming 0.3% pool fee)
  if (volume24 != null && !Number.isNaN(volume24)) {
    dexFeesUsd24h = volume24 * 0.003;
  }

  // pairCreatedAt timestamp -> age in days (ms vs s heuristic)
  if (selectedPair) {
    pairCreatedAt = selectedPair.pairCreatedAt;
  }

  let ageDays = null;
  if (pairCreatedAt != null && !Number.isNaN(pairCreatedAt)) {
    const now = Date.now();
    // DexScreener docs use ms; if it's too small, treat as seconds.
    let createdMs = Number(pairCreatedAt);
    if (createdMs < 10_000_000_000) {
      // likely seconds
      createdMs *= 1000;
    }
    if (!Number.isNaN(createdMs) && createdMs > 0 && createdMs < now) {
      ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
    }
  }

  // Extract socials + website from the selected pair (for UI pills)
  if (selectedPair && selectedPair.info) {
    const info = selectedPair.info;
    const websites = Array.isArray(info.websites) ? info.websites : [];
    const socialsArr = Array.isArray(info.socials) ? info.socials : [];

    const websiteUrl =
      websites.length &&
      websites[0] &&
      typeof websites[0].url === "string"
        ? websites[0].url
        : null;

    const findPlatform = (name) =>
      socialsArr.find(
        (s) =>
          s &&
          typeof s.platform === "string" &&
          s.platform.toLowerCase() === name
      ) || null;

    const twitter = findPlatform("twitter");
    const telegram = findPlatform("telegram");
    const discord = findPlatform("discord");

    const otherSocials = socialsArr
      .filter(
        (s) =>
          s &&
          typeof s.platform === "string" &&
          !["twitter", "telegram", "discord"].includes(
            s.platform.toLowerCase()
          )
      )
      .map((s) => ({
        platform: s.platform || null,
        handle: s.handle || null,
      }));

    socials = {
      website: websiteUrl,
      twitter: twitter ? twitter.handle || null : null,
      telegram: telegram ? telegram.handle || null : null,
      discord: discord ? discord.handle || null : null,
      others: otherSocials,
    };
  }

  return {
    priceUsd,
    liquidityUsd,
    ageDays,
    dexFeesUsd24h,
    poolMintReserve,
    volume24Usd: volume24,
    txCount24,
    socials,
  };
}

// Simple fallback if DexScreener is down
async function fetchDexAndAgeStatsFallback(mint) {
  try {
    const res = await fetchDexAndAgeStatsFromDexScreener(mint);
    return res;
  } catch (e) {
    console.error("Dex/Age stats fallback error for mint", mint, e?.message);
    return {
      priceUsd: null,
      liquidityUsd: null,
      ageDays: null,
      dexFeesUsd24h: null,
      poolMintReserve: null,
      volume24Usd: null,
      txCount24: null,
      socials: null,
    };
  }
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const mint = (req.query.mint || "").trim();
    if (!mint) {
      return res.status(400).json({ error: "Missing mint query parameter" });
    }

    if (!HELIUS_API_KEY) {
      return res
        .status(500)
        .json({ error: "HELIUS_API_KEY is not set in environment" });
    }

    // 1) Raw mint account (for supply, decimals, authorities)
    const accountInfoPromise = callRpc("getAccountInfo", [
      mint,
      {
        encoding: "base64",
        commitment: "confirmed",
      },
    ]);

    // 2) Token metadata via Helius getAsset
    const assetPromise = fetch("https://mainnet.helius-rpc.com/?api-key=" + HELIUS_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: {
          id: mint,
        },
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error("getAsset error " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "getAsset error");
      return j.result;
    });

    // 3) Largest token accounts (for top holders / LP detection)
    const largestPromise = callRpc("getTokenLargestAccounts", [
      mint,
      {
        commitment: "confirmed",
      },
    ]);

    // 4) Price / liquidity / age / 24h fees from DexScreener
    const dexStatsPromise = fetchDexAndAgeStatsFallback(mint);

    // 5) Total unique holders (via getTokenAccountsByMint)
    const holdersCountPromise = safeCountTokenHolders(mint);

    const [accountInfo, asset, largest, dexStats, holdersCount] =
      await Promise.all([
        accountInfoPromise,
        assetPromise,
        largestPromise,
        dexStatsPromise,
        holdersCountPromise,
      ]);

    const dexSocials = dexStats && dexStats.socials ? dexStats.socials : null;

    if (!accountInfo?.value) {
      return res
        .status(404)
        .json({ error: "Not a valid SPL mint account on Solana." });
    }

    const dataBase64 = accountInfo.value.data?.[0];
    const parsedMint = parseMintAccount(dataBase64);

    const rawSupply = parsedMint.supply; // string
    const decimals = parsedMint.decimals;
    const mintAuthority = parsedMint.hasMintAuthority;
    const freezeAuthority = parsedMint.hasFreezeAuthority;

    const mintInfo = {
      supply: rawSupply,
      decimals,
      mintAuthority,
      freezeAuthority,
    };

    // Token metadata from asset
    let name = "Unknown Token";
    let symbol = "";
    let logoURI = null;

    try {
      if (asset?.content?.metadata) {
        name = asset.content.metadata.name || name;
        symbol = asset.content.metadata.symbol || symbol;
      }
      if (asset?.content?.links?.image) {
        logoURI = asset.content.links.image;
      }
    } catch (e) {
      console.error("Metadata parse error:", e?.message);
    }

    const tokenMeta = {
      mint,
      name,
      symbol,
      logoURI,
    };

    // -----------------------------------------------------------------
    // Holder distribution & LP detection
    // -----------------------------------------------------------------
    const supplyBN = BigInt(rawSupply || "0");

    const largestAccounts = Array.isArray(largest?.value) ? largest.value : [];
    let lpHolder = null;
    let bestReserveRelDiff = Infinity;

    // First pass: build all holders + try to detect LP
    let allHolders = largestAccounts.map((entry) => {
      const amountStr = entry.amount || "0";
      const amountBN = BigInt(amountStr);
      let pct = 0;
      if (supplyBN > 0n) {
        pct = Number((amountBN * 10_000n) / supplyBN) / 100; // %
      }

      const uiAmount =
        typeof entry.uiAmount === "number"
          ? entry.uiAmount
          : Number(entry.uiAmount ?? 0);

      const holder = {
        address: entry.address,
        pct,
        uiAmount,
      };

      // Primary LP detection: match DexScreener pool reserve to a holder
      const poolMintReserve = dexStats.poolMintReserve;
      if (
        poolMintReserve != null &&
        !Number.isNaN(poolMintReserve) &&
        poolMintReserve > 0 &&
        uiAmount != null &&
        !Number.isNaN(uiAmount) &&
        uiAmount > 0
      ) {
        const diff = Math.abs(uiAmount - poolMintReserve);
        const relDiff = diff / poolMintReserve;

        // Allow up to 20% slack for rounding / fees / pool drift
        if (relDiff < 0.2 && relDiff < bestReserveRelDiff) {
          bestReserveRelDiff = relDiff;
          lpHolder = holder;
        }
      }

      return holder;
    });

    // If we couldn’t detect LP from Dex pool, fall back to “highest holder” heuristic
    if (!lpHolder && allHolders.length > 0) {
      lpHolder = allHolders.reduce((a, b) =>
        (a.uiAmount || 0) >= (b.uiAmount || 0) ? a : b
      );
    }

    // Sort holders by pct descending
    allHolders.sort((a, b) => (b.pct || 0) - (a.pct || 0));

    // Top 10 with and without LP
    const top10InclLP = allHolders.slice(0, 10);

    const nonLpHolders = lpHolder
      ? allHolders.filter((h) => h.address !== lpHolder.address)
      : allHolders.slice();

    const top10ExclLP = nonLpHolders.slice(0, 10);

    let top10Pct = 0;
    let top10PctExcludingLP = null;

    if (top10InclLP.length) {
      top10Pct = top10InclLP.reduce((sum, h) => sum + (h.pct || 0), 0);
    }

    if (top10ExclLP.length && rawSupply && rawSupply !== "0") {
      top10PctExcludingLP = top10ExclLP.reduce(
        (sum, h) => sum + (h.pct || 0),
        0
      );
    }

    // ---------------------------------------------------------------
    // Insider / whale snapshot (non-LP wallets only)
    // ---------------------------------------------------------------
    const INSIDER_THRESHOLD_PCT = 1; // wallets >= 1% count as insiders
    const WHALE_THRESHOLD_PCT = 5; // wallets >= 5% count as whales

    const insidersAll = nonLpHolders.filter(
      (h) => (h.pct || 0) >= INSIDER_THRESHOLD_PCT
    );
    const whales = nonLpHolders.filter(
      (h) => (h.pct || 0) >= WHALE_THRESHOLD_PCT
    );

    const insidersTotalPct = insidersAll.reduce(
      (sum, h) => sum + (h.pct || 0),
      0
    );

    const largestInsider = insidersAll.length ? insidersAll[0] : null;

    let insiderRiskLevel = "low";
    let insiderNote = "No significant insider concentration detected.";

    if (insidersTotalPct > 60 || whales.length >= 3) {
      insiderRiskLevel = "high";
      insiderNote =
        "Very high concentration among a small number of wallets. Strong rug-pull risk if these insiders dump.";
    } else if (insidersTotalPct > 35 || whales.length >= 1) {
      insiderRiskLevel = "medium";
      insiderNote =
        "Moderate concentration among insiders. Watch wallets >= 1% of supply.";
    }

    const insiderSummary = {
      insidersAll,
      whales,
      insidersTotalPct, // % of supply (ex-LP) they control
      largestInsider, // top insider wallet (if any)
      riskLevel: insiderRiskLevel, // low / medium / high
      note: insiderNote, // human-readable summary
    };

    const effectiveHoldersCount =
      holdersCount != null ? holdersCount : allHolders.length;

    const holderSummary = {
      // Top 10 including LP (raw concentration)
      top10Pct,
      topHolders: top10InclLP,

      // Top 10 AFTER dropping the LP wallet
      top10PctExcludingLP,
      topHoldersExcludingLP: top10ExclLP,

      // LP wallet we detected (or null)
      lpHolder,

      // Total unique wallets with > 0 balance (or fallback to top-20 count)
      holdersCount: effectiveHoldersCount,
    };

    // -----------------------------------------------------------------
    // Origin hint
    // -----------------------------------------------------------------
    let originLabel = "Unknown protocol / origin";
    let originDetail = "";

    // Simple Pump.fun detection (from mint metadata / symbol / name)
    const lowerName = name.toLowerCase();
    const lowerSymbol = (symbol || "").toLowerCase();

    if (
      lowerName.includes("pump") ||
      lowerSymbol.includes("pump") ||
      (asset?.content?.metadata?.description || "")
        .toLowerCase()
        .includes("pump.fun")
    ) {
      originLabel = "Likely Pump.fun mint";
      originDetail =
        "Mint resembles Pump.fun pattern. Always double-check creator + socials.";
    }

    const originHint = {
      label: originLabel,
      detail: originDetail,
    };

    // -----------------------------------------------------------------
    // Simple scam score based on authorities + distribution
    // -----------------------------------------------------------------
    let level = "medium";
    let blurb = "";
    let score = 50;

    if (!mintAuthority && !freezeAuthority && top10PctExcludingLP <= 35) {
      level = "low";
      blurb =
        "Mint authority renounced, no freeze authority, and non-LP top holders are reasonably distributed.";
      score = 90;
    } else if (
      !mintAuthority &&
      (top10PctExcludingLP === null || top10PctExcludingLP <= 60)
    ) {
      level = "medium";
      blurb =
        "Mint authority renounced, but non-LP supply may still be fairly concentrated.";
      score = 65;
    } else {
      level = "high";
      blurb =
        "Mint authority or freeze authority is still active and/or non-LP top holders control a large portion of supply.";
      score = 25;
    }

    const riskSummary = { level, blurb, score };

    // -----------------------------------------------------------------
    // Dex metrics + token age + 24h DEX fee estimate
    // -----------------------------------------------------------------
    const tokenMetrics = {
      priceUsd: dexStats.priceUsd,
      liquidityUsd: dexStats.liquidityUsd,
      // IMPORTANT: this is 24h DEX fees est., NOT global chain fees
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

    // -----------------------------------------------------------------
    // Liquidity truth heuristic (wash / fake volume)
    // -----------------------------------------------------------------
    const liqUsd = dexStats.liquidityUsd;
    const vol24 = dexStats.volume24Usd;
    const txCount24 = dexStats.txCount24;

    let tradeToLiquidity = null;
    let avgTradeUsd = null;
    let liqTruthLevel = null;
    let liqTruthLabel = "Unknown";
    let liqTruthNote =
      "Insufficient volume / trade information to assess liquidity quality.";

    if (
      liqUsd != null &&
      !Number.isNaN(liqUsd) &&
      liqUsd > 0 &&
      vol24 != null &&
      !Number.isNaN(vol24) &&
      vol24 > 0 &&
      txCount24 != null &&
      !Number.isNaN(txCount24) &&
      txCount24 > 0
    ) {
      tradeToLiquidity = vol24 / liqUsd; // how many times liquidity churned in 24h
      avgTradeUsd = vol24 / txCount24;

      // Heuristic:
      // - very high volume vs liquidity + few trades  → likely wash / fake
      // - moderate volume vs liquidity + modest trades → suspicious
      // - otherwise → mostly real
      if (tradeToLiquidity > 100 && txCount24 < 50) {
        liqTruthLevel = "high";
        liqTruthLabel = "Likely fake / wash";
        liqTruthNote =
          "24h volume is extremely high versus liquidity with very few trades. This pattern often indicates wash trading or spoofed volume.";
      } else if (tradeToLiquidity > 30 && txCount24 < 150) {
        liqTruthLevel = "medium";
        liqTruthLabel = "Suspicious";
        liqTruthNote =
          "24h volume is large relative to liquidity, but trade count is modest. Liquidity may be partially fake or heavily farmed.";
      } else {
        liqTruthLevel = "low";
        liqTruthLabel = "Mostly real";
        liqTruthNote =
          "Volume and trade count look consistent with liquidity size. No obvious fake-liquidity pattern detected.";
      }
    }

    const liquidityTruth = {
      level: liqTruthLevel,
      label: liqTruthLabel,
      note: liqTruthNote,
      tradeToLiquidity,
      avgTradeUsd,
      volume24Usd: vol24,
      txCount24,
    };

    // -----------------------------------------------------------------
    // Stablecoin special handling (USDC/USDT)
    // -----------------------------------------------------------------
    const stableConfig = STABLECOIN_WHITELIST[mint];
    if (stableConfig) {
      originHint.label = `${stableConfig.symbol} – centralized stablecoin`;
      originHint.detail =
        `${stableConfig.symbol} on Solana from a known centralized issuer. ` +
        "High holder concentration and active freeze authority are normal for this type of token.";

      riskSummary.level = "low";
      riskSummary.score = 95;
      riskSummary.blurb =
        "This is a whitelisted centralized stablecoin on Solana. " +
        "Issuer risk and smart contract risk still exist, but 'rug pull' style mint tricks " +
        "are not the main concern. Distribution and freeze authority look scary but are expected.";

      if (
        tokenMetrics.priceUsd == null ||
        Number.isNaN(tokenMetrics.priceUsd)
      ) {
        tokenMetrics.priceUsd = 1.0;
      }
    }

    // -----------------------------------------------------------------
    // Final payload
    // -----------------------------------------------------------------
    return res.status(200).json({
      tokenMeta,
      mintInfo,
      mintAuthority,
      freezeAuthority,
      holderSummary,
      insiderSummary,
      originHint,
      riskSummary,
      tokenMetrics,
      tokenAge,
      liquidityTruth,
      socials: dexSocials,
    });
  } catch (err) {
    console.error("API /api/check error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
