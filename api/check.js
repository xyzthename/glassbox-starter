// api/check.js
// GlassBox backend
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age / 24h DEX fees

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Known Solana stablecoins (whitelist)
const STABLECOIN_WHITELIST = {
  // USDC
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: "USDC",
    name: "USD Coin (USDC)",
  },
  // USDT
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT",
    name: "Tether USD (USDT)",
  },
  // PYUSD (Solana)
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": {
    symbol: "PYUSD",
    name: "PayPal USD (PYUSD)",
  },
};

async function heliusRpc(method, params) {
  if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY is not set in environment");
  }

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

// Decode mint account data (supply, decimals, authorities)
function parseMintAccount(base64Data) {
  const raw = Buffer.from(base64Data, "base64");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  let offset = 0;

  // u32: mintAuthorityOption
  const mintAuthOpt = view.getUint32(offset, true);
  const hasMintAuthority = mintAuthOpt !== 0;
  offset += 4 + 32; // skip option + pubkey bytes

  // u64: supply (little endian)
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const supplyBig = BigInt(low) + (BigInt(high) << 32n);
  offset += 8;

  // u8: decimals
  const decimals = raw[offset];
  offset += 1;

  // u8: isInitialized (unused)
  offset += 1;

  // u32: freezeAuthorityOption
  const freezeOpt = view.getUint32(offset, true);
  const hasFreezeAuthority = freezeOpt !== 0;

  return {
    supply: supplyBig.toString(),
    decimals,
    hasMintAuthority,
    hasFreezeAuthority,
  };
}

function shortAddr(addr) {
  if (!addr || addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// Safe wrappers so big tokens (USDC, USDT, etc.) don’t blow us up
async function safeGetAsset(mint) {
  try {
    return await heliusRpc("getAsset", [mint]);
  } catch (e) {
    console.error("safeGetAsset error for mint", mint, e?.message);
    return null;
  }
}

async function safeGetLargestAccounts(mint) {
  try {
    // Standard SPL RPC – returns up to 20 accounts
    return await heliusRpc("getTokenLargestAccounts", [mint]);
  } catch (e) {
    console.error("safeGetLargestAccounts error for mint", mint, e?.message);
    // Fallback: no holder data instead of hard error
    return { value: [] };
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
    };
  }

  let best = null;
  let bestLiquidity = 0;

  for (const p of pairs) {
    const baseAddr = p.baseToken?.address;
    const quoteAddr = p.quoteToken?.address;

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
    }

    if (myPriceUsd == null || Number.isNaN(myPriceUsd)) continue;

    if (liqUsd > bestLiquidity) {
      bestLiquidity = liqUsd;
      best = {
        pair: p,
        priceUsd: myPriceUsd,
        liquidityUsd: liqUsd,
        poolMintReserve,
      };
    }
  }

  let selectedPair = null;
  let priceUsd = null;
  let liquidityUsd = null;
  let pairCreatedAt = null;
  let volume24 = null;
  let poolMintReserve = null;
  let dexFeesUsd24h = null;

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

  if (selectedPair && selectedPair.volume && typeof selectedPair.volume === "object") {
    const v24 = selectedPair.volume.h24;
    if (v24 != null) {
      const n24 = Number(v24);
      if (!Number.isNaN(n24)) {
        volume24 = n24;
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
  if (pairCreatedAt != null) {
    let createdMs = Number(pairCreatedAt);
    if (!Number.isNaN(createdMs) && createdMs > 0) {
      if (createdMs < 1e12) {
        createdMs *= 1000;
      }
      const now = Date.now();
      if (now > createdMs) {
        ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
      }
    }
  }

  return {
    priceUsd,
    liquidityUsd,
    ageDays,
    dexFeesUsd24h,
    poolMintReserve,
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
    };
  }
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
// Count unique wallet addresses that hold a non-zero balance of this mint
async function countTokenHolders(mint) {
  try {
    const result = await heliusRpc("getTokenAccountsByMint", [
      mint,
      { commitment: "processed", encoding: "jsonParsed" },
    ]);

    const accounts = result?.value || [];
    const owners = new Set();

    for (const acc of accounts) {
      const parsed = acc.account?.data?.parsed;
      const info = parsed?.info;
      if (!info) continue;

      const owner = info.owner;
      const uiAmount = info.tokenAmount?.uiAmount ?? 0;

      // ignore empty / dust accounts
      if (!owner || !uiAmount || uiAmount <= 0) continue;
      owners.add(owner);
    }

    return owners.size;
  } catch (e) {
    console.error("countTokenHolders error for mint", mint, e?.message);
    return null; // don't break the API if this fails
  }
}

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

    // 1) Mint account
    const accountInfoPromise = heliusRpc("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);

    // 2) Metadata
    const assetPromise = safeGetAsset(mint);

    // 3) Largest accounts (holders)
    const largestPromise = safeGetLargestAccounts(mint);

    // 4) Price / liquidity / age / 24h fees from DexScreener
    const dexStatsPromise = fetchDexAndAgeStatsFallback(mint);

    // before
const [accountInfo, asset, largest, dexStats] = await Promise.all([
  accountInfoPromise,
  assetPromise,
  largestPromise,
  dexStatsPromise,
]);

// after
const holdersCountPromise = countTokenHolders(mint);

const [accountInfo, asset, largest, dexStats, holdersCount] = await Promise.all([
  accountInfoPromise,
  assetPromise,
  largestPromise,
  dexStatsPromise,
  holdersCountPromise,
]);

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
      console.error("metadata parse error", e?.message);
    }

    const tokenMeta = { name, symbol, logoURI };

    // -----------------------------------------------------------------
    // Holder summary (top 10 wallets) WITH LP detection
    // -----------------------------------------------------------------
    const largestAccounts = largest?.value || [];
    const supplyBN =
      rawSupply && rawSupply !== "0" ? BigInt(rawSupply) : 0n;

    const poolMintReserve =
      dexStats.poolMintReserve != null
        ? Number(dexStats.poolMintReserve)
        : null;

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

    // Ensure sorted by balance (RPC usually is, but be safe)
    allHolders.sort((a, b) => (b.uiAmount || 0) - (a.uiAmount || 0));

    // Fallback LP detection: if no LP matched by reserve but
    // top holder has a huge chunk (>= 40%), treat first holder as LP.
    if (!lpHolder && allHolders.length > 0 && allHolders[0].pct >= 40) {
      lpHolder = allHolders[0];
    }

    // Top 10 INCLUDING LP (raw)
    const top10InclLP = allHolders.slice(0, 10);

    // Top 10 EXCLUDING LP (remove LP first, then take next 10)
    const nonLpHolders = lpHolder
      ? allHolders.filter((h) => h.address !== lpHolder.address)
      : allHolders;

    const top10ExclLP = nonLpHolders.slice(0, 10);

    let top10Pct = null;
    let top10PctExcludingLP = null;

    if (top10InclLP.length && rawSupply && rawSupply !== "0") {
      top10Pct = top10InclLP.reduce((sum, h) => sum + (h.pct || 0), 0);
    }

    if (top10ExclLP.length && rawSupply && rawSupply !== "0") {
      top10PctExcludingLP = top10ExclLP.reduce(
        (sum, h) => sum + (h.pct || 0),
        0
      );
    }

    const holderSummary = {
  // Top 10 including LP (raw concentration)
  top10Pct,
  topHolders: top10InclLP,

  // Top 10 AFTER dropping the LP wallet
  top10PctExcludingLP,
  topHoldersExcludingLP: top10ExclLP,

  // LP wallet we detected (or null)
  lpHolder,

  // NEW: total number of unique wallets holding a non-zero amount
  holdersCount,
};


    // -----------------------------------------------------------------
    // Origin hint
    // -----------------------------------------------------------------
    let originLabel = "Unknown protocol / origin";
    let originDetail = "";
    const lowerMint = mint.toLowerCase();

    if (lowerMint.endsWith("pump")) {
      originLabel = "Likely Pump.fun mint";
      originDetail =
        "Mint resembles Pump.fun pattern. Always double-check creator + socials.";
    }

    const originHint = {
      label: originLabel,
      detail: originDetail,
    };

    // -----------------------------------------------------------------
    // Risk model (uses TOP 10 EXCLUDING LP)
    // -----------------------------------------------------------------
    let level = "medium";
    let blurb = "";
    let score = 50;

    if (
      !mintAuthority &&
      !freezeAuthority &&
      top10PctExcludingLP !== null &&
      top10PctExcludingLP <= 25
    ) {
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

    const tokenAge =
      dexStats.ageDays != null
        ? { ageDays: dexStats.ageDays }
        : { ageDays: null };

    // -----------------------------------------------------------------
    // Stablecoin special handling (whitelist)
    // -----------------------------------------------------------------
    const stableConfig = STABLECOIN_WHITELIST[mint];

    if (stableConfig) {
      if (!tokenMeta.symbol) tokenMeta.symbol = stableConfig.symbol;
      if (!tokenMeta.name || tokenMeta.name === "Unknown Token") {
        tokenMeta.name = stableConfig.name;
      }

      originHint.label = "Known Solana stablecoin";
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
      originHint,
      riskSummary,
      tokenMetrics,
      tokenAge,
    });
  } catch (err) {
    console.error("API /api/check error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
