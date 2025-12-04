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
  // PYUSD (Solana)
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": {
    symbol: "PYUSD",
    name: "PayPal USD (PYUSD)",
  },
  // USD1 (Solana)
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB": {
    symbol: "USD1",
    name: "World Liberty Financial USD (USD1)",
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
    return null;
  }
}

// DexScreener fetch (Solana)
async function fetchDexStats(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DexScreener error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const pair = (json.pairs || [])[0];

  if (!pair) {
    return {
      priceUsd: null,
      liquidityUsd: null,
      dexFeesUsd24h: null,
      ageDays: null,
      volume24hUsd: null,
      trades24h: null,
    };
  }

  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
  const liquidityUsd = pair.liquidity?.usd
    ? Number(pair.liquidity.usd)
    : null;

  // 24h DEX fees estimate (0.3% of 24h volume as a rough guess)
  const volume24hUsd = pair.volume?.h24 ? Number(pair.volume.h24) : null;
  const dexFeesUsd24h =
    volume24hUsd != null && Number.isFinite(volume24hUsd)
      ? volume24hUsd * 0.003
      : null;

  const trades24h = pair.txns?.h24
    ? Number(pair.txns.h24.buys || 0) + Number(pair.txns.h24.sells || 0)
    : null;

  let ageDays = null;
  if (pair.pairCreatedAt) {
    const createdMs = Number(pair.pairCreatedAt);
    if (Number.isFinite(createdMs) && createdMs > 0) {
      const diffMs = Date.now() - createdMs;
      ageDays = diffMs / (1000 * 60 * 60 * 24);
    }
  }

  return {
    priceUsd,
    liquidityUsd,
    dexFeesUsd24h,
    ageDays,
    volume24hUsd,
    trades24h,
  };
}

// ---------------------------------------------------------------------
// Liquidity truth model
// ---------------------------------------------------------------------

function buildLiquidityTruth(dexStats) {
  const { liquidityUsd, volume24hUsd, trades24h, ageDays } = dexStats;

  if (
    liquidityUsd == null ||
    volume24hUsd == null ||
    liquidityUsd <= 0 ||
    volume24hUsd < 0
  ) {
    return {
      level: "unknown",
      label: "Unknown",
      note: "Not enough data from DexScreener to judge liquidity vs volume.",
      tradeToLiquidity: null,
      trades24h: trades24h ?? null,
    };
  }

  const tradeToLiquidity = volume24hUsd / liquidityUsd;

  let level = "medium";
  let label = "Mostly real";
  let note =
    "Volume and trade count look roughly consistent with liquidity size.";

  // Very early / new pool – treat with caution
  if (ageDays != null && ageDays < 0.25) {
    if (tradeToLiquidity > 20 || (trades24h != null && trades24h < 20)) {
      level = "high";
      label = "Suspicious";
      note =
        "Very new pool with big volume relative to liquidity or thin trade count. Watch for spoofed volume.";
    } else {
      level = "medium";
      label = "Mostly real";
      note =
        "New pool. Early volume/liquidity looks roughly okay, but still treat carefully.";
    }
  } else {
    // Older pool – looser thresholds
    if (tradeToLiquidity > 40) {
      level = "high";
      label = "Suspicious";
      note =
        "24h volume is extremely high vs liquidity. Could be spoofed or wash-traded.";
    } else if (tradeToLiquidity < 1 && trades24h != null && trades24h < 20) {
      level = "high";
      label = "Too low";
      note =
        "Very low trading activity relative to liquidity. May be a dead or abandoned pool.";
    } else if (tradeToLiquidity <= 20) {
      level = "low";
      label = "Mostly real";
      note =
        "Volume and trade count look consistent with liquidity size. No obvious fake-liquidity pattern detected.";
    }
  }

  return {
    level,
    label,
    note,
    tradeToLiquidity,
    trades24h: trades24h ?? null,
  };
}

// ---------------------------------------------------------------------
// API handler
// ---------------------------------------------------------------------

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const mint = (req.query.mint || "").trim();
    if (!mint) {
      return res.status(400).json({ error: "Missing mint address" });
    }

    // -----------------------------------------------------------------
    // Helius: mint + holders
    // -----------------------------------------------------------------
    const [asset, largest] = await Promise.all([
      safeGetAsset(mint),
      safeGetLargestAccounts(mint),
    ]);

    if (!asset || !asset.value) {
      throw new Error("Mint not found via Helius getAsset");
    }

    // Parse mint data
    const content = asset.value?.content || {};
    const name = content.metadata?.name || "Unknown Token";
    const symbol = content.metadata?.symbol || "";
    const logoURI = content.links?.image || null;

    const mintAccountBase64 =
      asset.value?.token_info?.accountInfo?.data?.[0] ||
      asset.value?.account?.data?.[0];

    if (!mintAccountBase64) {
      throw new Error("Mint account data missing from Helius response");
    }

    const { supply, decimals, hasMintAuthority, hasFreezeAuthority } =
      parseMintAccount(mintAccountBase64);

    const mintInfo = {
      supply,
      decimals,
      hasMintAuthority,
      hasFreezeAuthority,
    };

    const mintAuthority = hasMintAuthority;
    const freezeAuthority = hasFreezeAuthority;

    const tokenMeta = { name, symbol, logoURI };

    // Holder summary (top 10 wallets, identify LP if possible)
    const largestAccounts = largest?.value || [];
    const rawSupply = supply;
    const supplyBN = rawSupply && rawSupply !== "0" ? BigInt(rawSupply) : 0n;

    const topHolders = largestAccounts.slice(0, 10).map((entry) => {
      const amountBN = BigInt(entry.amount || "0");
      let pct = 0;
      if (supplyBN > 0n) {
        pct = Number((amountBN * 10_000n) / supplyBN) / 100; // %
      }
      return {
        address: entry.address,
        pct,
        uiAmount: entry.uiAmount,
      };
    });

    // Try to detect LP holder heuristically:
    // On Solana, this is fuzzy; we use "lp" flag + very large balance as hint.
    let lpHolder = null;
    for (const h of topHolders) {
      const isPoolLike =
        (h.address || "").toLowerCase().includes("amm") ||
        (h.address || "").toLowerCase().includes("pool");
      if (isPoolLike || (h.pct != null && h.pct > 40)) {
        lpHolder = h;
        break;
      }
    }

    let top10Pct = null;
    if (topHolders.length && rawSupply && rawSupply !== "0") {
      top10Pct = topHolders.reduce((sum, h) => sum + (h.pct || 0), 0);
    }

    // Exclude LP from concentration metrics when we think we found it
    let top10PctExcludingLP = top10Pct;
    let topHoldersExcludingLP = topHolders;
    if (lpHolder) {
      topHoldersExcludingLP = topHolders.filter(
        (h) => h.address !== lpHolder.address
      );
      top10PctExcludingLP = topHoldersExcludingLP.reduce(
        (sum, h) => sum + (h.pct || 0),
        0
      );
    }

    const holderSummary = {
      top10Pct,
      top10PctExcludingLP,
      topHolders,
      topHoldersExcludingLP,
      lpHolder,
      holdersCount: largestAccounts.length || null,
    };

    // Very simple origin hint
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

    // Simple risk model (mint side only, using non-LP holders)
    let level = "medium";
    let blurb = "";
    let score = 50;

    const top10PctExLP = top10PctExcludingLP;

    if (
      !mintAuthority &&
      !freezeAuthority &&
      top10PctExLP !== null &&
      top10PctExLP <= 25
    ) {
      level = "low";
      blurb =
        "Mint authority renounced, no freeze authority, and non-LP top holders are reasonably distributed.";
      score = 90;
    } else if (
      !mintAuthority &&
      (top10PctExLP === null || top10PctExLP <= 60)
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

    // Dex metrics + token age + 24h DEX fee estimate
    const dexStats = await fetchDexStats(mint);

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

    const liquidityTruth = buildLiquidityTruth(dexStats);

    // -----------------------------------------------------------------
    // Liquidity lock / burn (placeholder – Solana-wide detection is hard)
    // -----------------------------------------------------------------
    let lpLockStatus = "unknown";
    let lpLockLockedPct = null;
    let lpLockNote =
      "GlassBox cannot yet reliably detect LP lock/burn on Solana without a dedicated LP lock indexer. Treat 'Unknown' as NOT guaranteed safe.";

    const liquidityLock = {
      status: lpLockStatus, // "unknown" | "unlocked" | "locked"
      lockedPct: lpLockLockedPct, // number | null
      note: lpLockNote,
    };

    // Stablecoin special handling (whitelist)
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

      // For centralized stables, LP locks are managed by issuers/MMs
      liquidityLock.note =
        "Centralized stablecoins typically manage liquidity via issuers and market makers, not permanent LP locks. Standard LP lock %s don't really apply.";
    }

    // Final payload
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
      liquidityTruth,
      liquidityLock,
    });
  } catch (err) {
    console.error("API /api/check error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
