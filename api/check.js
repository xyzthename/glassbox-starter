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
  // PYUSD (PayPal USD)
  BNY2gPBNQqgM1FmpRzQvSmaGBJy5dkdKgdpH11Zkz7hN: {
    symbol: "PYUSD",
    name: "PayPal USD",
  },
};

// Short helper: call Helius RPC
async function heliusRpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "glassbox",
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`Helius RPC error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(`Helius RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

// Fetch basic mint account info for an SPL token
async function fetchMintAccount(mintAddress) {
  const result = await heliusRpc("getAccountInfo", [
    mintAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);

  if (!result || !result.value) {
    throw new Error("Mint account not found or not an SPL token");
  }

  const { value } = result;
  const data = value.data?.[0];
  const owner = value.owner;
  const executable = value.executable;
  const lamports = value.lamports;

  if (!data || owner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    throw new Error("Not a valid SPL mint account on Solana.");
  }

  return {
    raw: value,
    data,
    executable,
    lamports,
  };
}

// Parse minimal mint fields from raw account data
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
  const supplyBig =
    BigInt(high >>> 0) * 2n ** 32n + BigInt(low >>> 0);
  offset += 8;

  // u8: decimals
  const decimals = view.getUint8(offset);
  offset += 1;

  // skip isInitialized flag (1 byte)
  offset += 1;

  // u32: freezeAuthorityOption
  const freezeOpt = view.getUint32(offset, true);
  const hasFreezeAuthority = freezeOpt !== 0;

  return {
    mintAuthorityOption: hasMintAuthority ? 1 : 0,
    freezeAuthorityOption: hasFreezeAuthority ? 1 : 0,
    supply: supplyBig.toString(),
    decimals,
  };
}

// Fetch largest token holders for a mint
async function fetchLargestHolders(mint) {
  const result = await heliusRpc("getTokenLargestAccounts", [
    mint,
    { commitment: "confirmed" },
  ]);

  const value = result?.value || [];
  return value;
}

// Fetch basic token metadata (name/symbol) via getTokenMetadata
async function fetchTokenMetadata(mint) {
  try {
    const result = await heliusRpc("getTokenMetadata", [
      mint,
      { commitment: "confirmed" },
    ]);
    if (!result || !result.mint) {
      return null;
    }

    const { name, symbol, logo, uri } = result;

    return {
      name: name || "",
      symbol: symbol || "",
      logo: logo || null,
      uri: uri || null,
    };
  } catch (e) {
    console.error("fetchTokenMetadata error:", e?.message || e);
    return null;
  }
}

/**
 * Fetch DexScreener price/liquidity/mcap data for this mint.
 * We also pull out:
 *  - tokenAge (in ms)
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

  const pairs = rawPairs.filter(
    (p) => p && p.chainId === chainId && p.baseToken?.address?.toLowerCase() === mintLower
  );

  if (!pairs.length) {
    return {
      priceUsd: null,
      liquidityUsd: null,
      fdvUsd: null,
      poolMintReserve: null,
      tokenAgeMs: null,
    };
  }

  // Use the pair with the highest liquidity
  const best = pairs.reduce((acc, p) =>
    !acc || (p.liquidity?.usd || 0) > (acc.liquidity?.usd || 0) ? p : acc,
    null
  );

  if (!best) {
    return {
      priceUsd: null,
      liquidityUsd: null,
      fdvUsd: null,
      poolMintReserve: null,
      tokenAgeMs: null,
    };
  }

  const priceUsd = best.priceUsd != null ? Number(best.priceUsd) : null;
  const liquidityUsd = best.liquidity?.usd != null
    ? Number(best.liquidity.usd)
    : null;
  const fdvUsd = best.fdv != null ? Number(best.fdv) : null;

  let poolMintReserve = null;
  if (best.baseToken && best.liquidity?.base != null) {
    poolMintReserve = Number(best.liquidity.base);
  }

  let tokenAgeMs = null;
  if (best.pairCreatedAt) {
    const createdAtMs = Number(best.pairCreatedAt);
    if (!Number.isNaN(createdAtMs) && createdAtMs > 0) {
      const now = Date.now();
      tokenAgeMs = Math.max(0, now - createdAtMs);
    }
  }

  return {
    priceUsd,
    liquidityUsd,
    fdvUsd,
    poolMintReserve,
    tokenAgeMs,
  };
}

function formatStableMeta(mint) {
  if (STABLECOIN_WHITELIST[mint]) {
    return STABLECOIN_WHITELIST[mint];
  }
  return null;
}

// Main API handler
module.exports = async function handler(req, res) {
  try {
    const { mint } = req.query || {};
    const canonicalMint = (mint || "").trim();

    if (!canonicalMint || canonicalMint.length < 32) {
      return res.status(400).json({
        error: "Missing or invalid mint address.",
      });
    }

    // -----------------------------------------------------------------
    // 1) Fetch mint account + largest holders + token metadata in parallel
    // -----------------------------------------------------------------
    const [mintAcct, largestAccounts, meta, dexStats] = await Promise.all([
      fetchMintAccount(canonicalMint),
      fetchLargestHolders(canonicalMint),
      fetchTokenMetadata(canonicalMint),
      fetchDexAndAgeStatsFromDexScreener(canonicalMint),
    ]);

    const mintInfo = parseMintAccount(mintAcct.data);
    const { supply: rawSupply, decimals } = mintInfo;
    const supplyBN = BigInt(rawSupply || "0");
    const mintAuthority = mintInfo.mintAuthorityOption !== 0;
    const freezeAuthority = mintInfo.freezeAuthorityOption !== 0;

    const tokenMeta =
      formatStableMeta(canonicalMint) ||
      meta || {
        name: "",
        symbol: "",
        logo: null,
        uri: null,
      };

    const {
      priceUsd,
      liquidityUsd,
      fdvUsd,
      poolMintReserve,
      tokenAgeMs,
    } = dexStats || {};

    const tokenAge = tokenAgeMs;

    const tokenMetrics = {
      priceUsd,
      liquidityUsd,
      fdvUsd,
    };

    // -----------------------------------------------------------------
    // 2) Holder distribution & LP detection
    // -----------------------------------------------------------------

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
        amount: amountBN.toString(),
        uiAmount,
        rank: entry.rank ?? null,
      };

      return holder;
    });

    // Sort best-known holders by descending percentage
    allHolders.sort((a, b) => (b.pct || 0) - (a.pct || 0));

    // LP detection
    let lpHolder = null;

    if (poolMintReserve != null && poolMintReserve > 0) {
      let bestMatch = null;
      let bestRelDiff = Infinity;

      for (const h of allHolders) {
        const ui = h.uiAmount;
        if (ui == null || Number.isNaN(ui) || ui <= 0) continue;

        const diff = Math.abs(ui - poolMintReserve);
        const relDiff = diff / poolMintReserve;

        if (relDiff < 0.04 && relDiff < bestRelDiff) {
          bestRelDiff = relDiff;
          bestMatch = h;
        }
      }

      if (bestMatch) {
        lpHolder = bestMatch;
      }
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
    };

    // -----------------------------------------------------------------
    // Insider / whale clustering (basic v1)
    // -----------------------------------------------------------------
    const insiderWhaleThresholdPct = 1.0; // wallets >= 1% counted as whales

    const insiderWhales = nonLpHolders
      .filter((h) => (h.pct || 0) >= insiderWhaleThresholdPct)
      // Ensure sorted largest first
      .sort((a, b) => (b.pct || 0) - (a.pct || 0));

    let whalesTotalPct = null;
    let largestWhalePct = null;

    if (insiderWhales.length) {
      whalesTotalPct = insiderWhales.reduce(
        (sum, h) => sum + (h.pct || 0),
        0
      );
      largestWhalePct = insiderWhales[0].pct || null;
    }

    let insiderRiskLevel = "low";
    let insiderNote = "";

    if (!insiderWhales.length) {
      insiderRiskLevel = "low";
      insiderNote = "No non-LP wallet currently holds ≥ 1% of supply.";
    } else if (
      (largestWhalePct != null && largestWhalePct >= 20) ||
      (whalesTotalPct != null && whalesTotalPct >= 50)
    ) {
      insiderRiskLevel = "high";
      insiderNote =
        "One or more non-LP whales control a very large share of supply. Exits can nuke the chart.";
    } else if (
      (largestWhalePct != null && largestWhalePct >= 10) ||
      (whalesTotalPct != null && whalesTotalPct >= 35)
    ) {
      insiderRiskLevel = "medium";
      insiderNote =
        "A handful of non-LP whales own a meaningful chunk of supply. Watch their wallets.";
    } else {
      insiderRiskLevel = "low";
      insiderNote =
        "Whale holdings are present but not overwhelmingly concentrated.";
    }

    const insiderSummary = {
      whaleCount: insiderWhales.length,
      whalesTotalPct,
      largestWhalePct,
      whales: insiderWhales.slice(0, 10),
      insiderRiskLevel,
      insiderNote,
    };

    // -----------------------------------------------------------------
    // Origin hint
    // -----------------------------------------------------------------
    let originLabel = "Unknown protocol / origin";
    let originDetail = "";

    if (tokenAge != null) {
      const oneDay = 24 * 60 * 60 * 1000;
      if (tokenAge < 7 * oneDay) {
        originDetail = "Very new token – extra caution.";
      }
    }

    if (
      tokenMeta.name?.toLowerCase().includes("pump") ||
      tokenMeta.symbol?.toLowerCase().includes("pump")
    ) {
      originLabel = "Likely Pump.fun mint";
      originDetail =
        "Mint resembles Pump.fun pattern. Always double-check creator & socials.";
    }

    const originHint = {
      label: originLabel,
      detail: originDetail,
    };

    // -----------------------------------------------------------------
    // Scam score (simple v1)
    // -----------------------------------------------------------------
    let scamScore = 90;

    if (mintAuthority) {
      scamScore -= 25;
    }
    if (freezeAuthority) {
      scamScore -= 15;
    }
    if (top10PctExcludingLP != null) {
      if (top10PctExcludingLP > 70) scamScore -= 25;
      else if (top10PctExcludingLP > 50) scamScore -= 15;
      else if (top10PctExcludingLP > 35) scamScore -= 8;
    }

    if (liquidityUsd != null && liquidityUsd < 5000) {
      scamScore -= 10;
    }

    if (tokenAge != null && tokenAge < 24 * 60 * 60 * 1000) {
      scamScore -= 10;
    }

    if (tokenAge != null && tokenAge > 90 * 24 * 60 * 60 * 1000 && scamScore < 40) {
      scamScore += 10;
    }

    if (scamScore < 0) scamScore = 0;
    if (scamScore > 100) scamScore = 100;

    let riskBlurb = "";
    if (scamScore >= 80) {
      riskBlurb =
        "Low rug risk on mint side – renounced or locked controls and non-LP top holders are reasonably distributed.";
    } else if (scamScore >= 60) {
      riskBlurb =
        "Moderate risk – some centralization or remaining dev controls. Size positions accordingly.";
    } else if (scamScore >= 40) {
      riskBlurb =
        "High risk – concentrated holders or mint/freeze authority still active. Treat as a degen play.";
    } else {
      riskBlurb =
        "Severe risk – this looks like a rug or honeypot setup. Enter only if you are fully prepared to lose it all.";
    }

    const riskSummary = {
      scamScore,
      blurb: riskBlurb,
    };

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
    });
  } catch (err) {
    console.error("API /api/check error:", err);
    return res.status(500).json({
      error: "Unexpected server error. Please try again.",
    });
  }
};
