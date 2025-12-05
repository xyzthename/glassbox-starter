// pages/api/check.js
// GlassBox backend:
// - Helius RPC for mint, holders, basic funding history
// - DexScreener for price / liquidity / age / 24h fees
// HELIUS_API_KEY must be in env (Vercel / .env.local). DO NOT hardcode.

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Known Solana stablecoins
const STABLECOIN_WHITELIST = {
  // USDC (Solana)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1": {
    symbol: "USDC",
    name: "USD Coin (USDC)",
  },
  // USDT (Solana)
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
    symbol: "USDT",
    name: "Tether USD (USDT)",
  },
  // PYUSD
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": {
    symbol: "PYUSD",
    name: "PayPal USD (PYUSD)",
  },
  // USD1
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

// -----------------------------------------------------
// Mint parsing
// -----------------------------------------------------
function parseMintAccount(base64Data) {
  const raw = Buffer.from(base64Data, "base64");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  let offset = 0;

  // u32: mintAuthorityOption
  const mintAuthOpt = view.getUint32(offset, true);
  const hasMintAuthority = mintAuthOpt !== 0;
  offset += 4 + 32; // option + pubkey

  // u64 supply
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const supplyBig = BigInt(low) + (BigInt(high) << 32n);
  offset += 8;

  // u8 decimals
  const decimals = raw[offset];
  offset += 1;

  // u8 isInitialized
  offset += 1;

  // u32 freezeAuthorityOption
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

// -----------------------------------------------------
// Safe helpers
// -----------------------------------------------------
async function safeGetAsset(mint) {
  try {
    return await heliusRpc("getAsset", [mint]);
  } catch (e) {
    console.error("safeGetAsset error", mint, e?.message);
    return null;
  }
}

async function safeGetLargestAccounts(mint) {
  try {
    return await heliusRpc("getTokenLargestAccounts", [mint]);
  } catch (e) {
    console.error("safeGetLargestAccounts error", mint, e?.message);
    return { value: [] };
  }
}

// ✅ holders count using getTokenAccountsByMint
async function safeCountTokenHolders(mint) {
  try {
    const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    const result = await heliusRpc("getTokenAccountsByMint", [
      mint,
      {
        programId: TOKEN_PROGRAM_ID,
        encoding: "jsonParsed",
        commitment: "processed",
      },
    ]);

    const accounts = Array.isArray(result?.value) ? result.value : [];
    const owners = new Set();

    for (const acc of accounts) {
      const parsed = acc.account?.data?.parsed;
      const info = parsed?.info;
      if (!info) continue;
      const owner = info.owner;
      const uiAmount = info.tokenAmount?.uiAmount ?? 0;
      if (!owner || !uiAmount || uiAmount <= 0) continue;
      owners.add(owner);
    }

    return owners.size || null;
  } catch (e) {
    console.error("safeCountTokenHolders error", mint, e?.message);
    // return null when it fails -> frontend shows N/A instead of lying
    return null;
  }
}

// DexScreener stats
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
    };
  }

  let best = null;
  let bestLiquidity = 0;

  for (const p of pairs) {
    const baseAddr = p.baseToken?.address;
    const quoteAddr = p.quoteToken?.address;
    const rawPriceUsd =
      p.priceUsd != null ? Number(p.priceUsd) : null;
    const priceNative =
      p.priceNative != null ? Number(p.priceNative) : null;
    const liqUsd =
      p.liquidity?.usd != null ? Number(p.liquidity.usd) : null;

    if (liqUsd == null || Number.isNaN(liqUsd)) continue;
    if (rawPriceUsd == null || Number.isNaN(rawPriceUsd)) continue;

    let myPriceUsd = null;
    let poolMintReserve = null;

    if (baseAddr && baseAddr.toLowerCase() === mintLower) {
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
      myPriceUsd = rawPriceUsd / priceNative;
      poolMintReserve =
        p.liquidity?.quote != null ? Number(p.liquidity.quote) : null;
    }

    if (myPriceUsd == null || Number.isNaN(myPriceUsd)) continue;

    if (liqUsd > bestLiquidity) {
      bestLiquidity = liqUsd;
      best = { pair: p, priceUsd: myPriceUsd, liquidityUsd: liqUsd, poolMintReserve };
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

  if (best) {
    selectedPair = best.pair;
    priceUsd = best.priceUsd;
    liquidityUsd = best.liquidityUsd;
    poolMintReserve = best.poolMintReserve ?? null;
  } else {
    selectedPair = pairs.reduce((a, b) =>
      (a.liquidity?.usd || 0) >= (b.liquidity?.usd || 0) ? a : b
    );
    liquidityUsd =
      selectedPair.liquidity?.usd != null
        ? Number(selectedPair.liquidity.usd)
        : null;
    priceUsd =
      selectedPair.priceUsd != null ? Number(selectedPair.priceUsd) : null;

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

  if (selectedPair?.volume?.h24 != null) {
    const n = Number(selectedPair.volume.h24);
    if (!Number.isNaN(n)) volume24 = n;
  }

  if (selectedPair?.txns?.h24) {
    const buys = Number(selectedPair.txns.h24.buys || 0);
    const sells = Number(selectedPair.txns.h24.sells || 0);
    const total = buys + sells;
    if (!Number.isNaN(total) && total > 0) txCount24 = total;
  }

  if (volume24 != null && !Number.isNaN(volume24)) {
    dexFeesUsd24h = volume24 * 0.003;
  }

  if (selectedPair?.pairCreatedAt != null) {
    let createdMs = Number(selectedPair.pairCreatedAt);
    if (!Number.isNaN(createdMs) && createdMs > 0) {
      if (createdMs < 1e12) createdMs *= 1000; // seconds → ms
      const now = Date.now();
      if (now > createdMs) {
        const diffMs = now - createdMs;
        const days = diffMs / (1000 * 60 * 60 * 24);
        pairCreatedAt = createdMs;
        return {
          priceUsd,
          liquidityUsd,
          ageDays: days,
          dexFeesUsd24h,
          poolMintReserve,
          volume24Usd: volume24,
          txCount24,
        };
      }
    }
  }

  return {
    priceUsd,
    liquidityUsd,
    ageDays: null,
    dexFeesUsd24h,
    poolMintReserve,
    volume24Usd: volume24,
    txCount24,
  };
}

async function fetchDexAndAgeStatsFallback(mint) {
  try {
    return await fetchDexAndAgeStatsFromDexScreener(mint);
  } catch (e) {
    console.error("Dex stats error", mint, e?.message);
    return {
      priceUsd: null,
      liquidityUsd: null,
      ageDays: null,
      dexFeesUsd24h: null,
      poolMintReserve: null,
      volume24Usd: null,
      txCount24: null,
    };
  }
}

// -----------------------------------------------------
// Insider clustering helpers
// -----------------------------------------------------
async function safeGetSignatures(address, limit = 5) {
  try {
    const res = await heliusRpc("getSignaturesForAddress", [
      address,
      { limit },
    ]);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    console.error("safeGetSignatures error", address, e?.message);
    return [];
  }
}

async function safeGetParsedTransaction(signature) {
  try {
    const res = await heliusRpc("getParsedTransaction", [
      signature,
      { maxSupportedTransactionVersion: 0 },
    ]);
    return res || null;
  } catch (e) {
    console.error("safeGetParsedTransaction error", signature, e?.message);
    return null;
  }
}

// Map<holder, {funders:Set<string>}>
async function buildHolderFundersMap(holderAddresses) {
  const result = {};
  const addresses = holderAddresses.slice(0, 5); // keep it cheap

  await Promise.all(
    addresses.map(async (addr) => {
      const funders = new Set();
      const sigs = await safeGetSignatures(addr, 3);
      for (const s of sigs) {
        if (!s?.signature) continue;
        const tx = await safeGetParsedTransaction(s.signature);
        const feePayer =
          tx?.transaction?.message?.accountKeys?.[0]?.pubkey || null;
        if (feePayer && feePayer !== addr) funders.add(feePayer);
      }
      result[addr] = { funders };
    })
  );

  return result;
}

function buildInsiderClusters(nonLpHolders, holderFundersMap) {
  const funderClusters = new Map();

  for (const h of nonLpHolders) {
    const addr = h.address;
    const pct = h.pct || 0;
    const funders = holderFundersMap[addr]?.funders || new Set();
    for (const f of funders) {
      if (!funderClusters.has(f)) {
        funderClusters.set(f, {
          funder: f,
          holderAddresses: [],
          pctOfSupply: 0,
        });
      }
      const cluster = funderClusters.get(f);
      cluster.holderAddresses.push(addr);
      cluster.pctOfSupply += pct;
    }
  }

  const clusters = Array.from(funderClusters.values()).filter(
    (c) => c.holderAddresses.length >= 2
  );

  if (!clusters.length) {
    return {
      clusters: [],
      largestCluster: null,
      totalClusterPct: 0,
      riskLevel: "low",
      note:
        "No strong funding-based insider clusters detected among top non-LP holders (based on recent transactions).",
    };
  }

  clusters.sort((a, b) => b.pctOfSupply - a.pctOfSupply);
  const largestCluster = clusters[0];
  const totalClusterPct = clusters.reduce(
    (sum, c) => sum + (c.pctOfSupply || 0),
    0
  );

  let riskLevel = "medium";
  let note = "";

  if (largestCluster.pctOfSupply >= 25 || totalClusterPct >= 35) {
    riskLevel = "high";
    note = `Funding-based dev/insider cluster detected. Biggest cluster (${shortAddr(
      largestCluster.funder
    )}) controls ~${largestCluster.pctOfSupply.toFixed(
      1
    )}% of supply across ${largestCluster.holderAddresses.length} wallets.`;
  } else if (largestCluster.pctOfSupply >= 10) {
    riskLevel = "medium";
    note = `Moderate insider cluster risk. A funding cluster (${shortAddr(
      largestCluster.funder
    )}) controls ~${largestCluster.pctOfSupply.toFixed(
      1
    )}% of supply across ${
      largestCluster.holderAddresses.length
    } wallets.`;
  } else {
    riskLevel = "low";
    note =
      "Some mild funding-based linkage between holders, but cluster sizes are small relative to supply.";
  }

  return {
    clusters,
    largestCluster,
    totalClusterPct,
    riskLevel,
    note,
  };
}

// -----------------------------------------------------
// API handler
// -----------------------------------------------------
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

    const accountInfoPromise = heliusRpc("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);
    const assetPromise = safeGetAsset(mint);
    const largestPromise = safeGetLargestAccounts(mint);
    const dexStatsPromise = fetchDexAndAgeStatsFallback(mint);
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
      return res
        .status(404)
        .json({ error: "Not a valid SPL mint account on Solana." });
    }

    const dataBase64 = accountInfo.value.data?.[0];
    const parsedMint = parseMintAccount(dataBase64);

    const rawSupply = parsedMint.supply;
    const decimals = parsedMint.decimals;
    const mintAuthority = parsedMint.hasMintAuthority;
    const freezeAuthority = parsedMint.hasFreezeAuthority;

    const mintInfo = { supply: rawSupply, decimals };

    // metadata
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

    // holders & LP
    const largestAccounts = largest?.value || [];
    const supplyBN =
      rawSupply && rawSupply !== "0" ? BigInt(rawSupply) : 0n;
    const poolMintReserve =
      dexStats.poolMintReserve != null
        ? Number(dexStats.poolMintReserve)
        : null;

    let lpHolder = null;
    let bestReserveRelDiff = Infinity;

    let allHolders = largestAccounts.map((entry) => {
      const amountStr = entry.amount || "0";
      const amountBN = BigInt(amountStr);
      let pct = 0;
      if (supplyBN > 0n) {
        pct = Number((amountBN * 10_000n) / supplyBN) / 100;
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
        if (relDiff < 0.2 && relDiff < bestReserveRelDiff) {
          bestReserveRelDiff = relDiff;
          lpHolder = holder;
        }
      }

      return holder;
    });

    allHolders.sort((a, b) => (b.uiAmount || 0) - (a.uiAmount || 0));

    if (!lpHolder && allHolders.length > 0 && allHolders[0].pct >= 40) {
      lpHolder = allHolders[0];
    }

    const top10InclLP = allHolders.slice(0, 10);
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

    // insider summary (non-LP)
    const INSIDER_THRESHOLD_PCT = 1;
    const WHALE_THRESHOLD_PCT = 5;

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
    let insiderNote = "";

    if (!insidersAll.length) {
      insiderRiskLevel = "low";
      insiderNote =
        "No non-LP wallet holds more than 1% of supply. Insider risk looks low based on distribution.";
    } else if (insidersTotalPct <= 20 && whales.length <= 1) {
      insiderRiskLevel = "medium";
      insiderNote = `${insidersAll.length} wallets each hold ≥1% (total ${insidersTotalPct.toFixed(
        1
      )}% of supply). Some concentrated holders but not extreme.`;
    } else {
      insiderRiskLevel = "high";
      insiderNote = `${insidersAll.length} wallets each hold ≥1% (total ${insidersTotalPct.toFixed(
        1
      )}% of supply). This is a strong insider/whale cluster.`;
    }

    const insiderSummary = {
      insiderCount: insidersAll.length,
      whaleCount: whales.length,
      insidersTotalPct,
      largestInsider,
      riskLevel: insiderRiskLevel,
      note: insiderNote,
    };

    const holderSummary = {
      top10Pct,
      topHolders: top10InclLP,
      top10PctExcludingLP,
      topHoldersExcludingLP: top10ExclLP,
      lpHolder,
      holdersCount: holdersCount ?? null, // null => frontend shows N/A
    };

    // insider clustering
    const nonLpAddresses = nonLpHolders.map((h) => h.address);
    const holderFundersMap = await buildHolderFundersMap(nonLpAddresses);
    const insiderClusters = buildInsiderClusters(
      nonLpHolders,
      holderFundersMap
    );

    // origin hint
    let originLabel = "Unknown protocol / origin";
    let originDetail = "";
    const lowerMint = mint.toLowerCase();
    if (lowerMint.endsWith("pump")) {
      originLabel = "Likely Pump.fun mint";
      originDetail =
        "Mint resembles Pump.fun pattern. Always double-check creator + socials.";
    }
    const originHint = { label: originLabel, detail: originDetail };

    // risk summary (uses non-LP top10)
    let level = "medium";
    let blurb = "";
    let score = 50;

    if (
      !mintAuthority &&
      !freezeAuthority &&
      top10PctExcludingLP != null &&
      top10PctExcludingLP <= 25
    ) {
      level = "low";
      blurb =
        "Mint authority renounced, no freeze authority, and non-LP top holders are reasonably distributed.";
      score = 90;
    } else if (
      !mintAuthority &&
      (top10PctExcludingLP == null || top10PctExcludingLP <= 60)
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

    const tokenMetrics = {
      priceUsd: dexStats.priceUsd,
      liquidityUsd: dexStats.liquidityUsd,
      dexFeesUsd24h: dexStats.dexFeesUsd24h,
    };

    const tokenAge =
      dexStats.ageDays != null
        ? { ageDays: dexStats.ageDays }
        : { ageDays: null };

    // liquidity truth (fake-liq sniff)
    const liqUsd = dexStats.liquidityUsd;
    const vol24 = dexStats.volume24Usd ?? null;
    const txCount24 = dexStats.txCount24 ?? null;

    let liqTruthLevel = "unknown";
    let liqTruthLabel = "Unknown";
    let liqTruthNote =
      "Not enough DEX data to judge whether liquidity is real or spoofed.";
    let tradeToLiquidity = null;
    let avgTradeUsd = null;

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
      tradeToLiquidity = vol24 / liqUsd;
      avgTradeUsd = vol24 / txCount24;

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
      volume24Usd: vol24,
      txCount24,
      tradeToLiquidity,
      avgTradeUsd,
      lockPercent: null, // we are NOT guessing; stay honest until we build LP lock engine
    };

    // stablecoin override
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
        "are not the main concern.";
    }

    return res.status(200).json({
      tokenMeta,
      mintInfo,
      freezeAuthority,
      mintAuthority,
      holderSummary,
      insiderSummary,
      insiderClusters,
      originHint,
      riskSummary,
      tokenMetrics,
      tokenAge,
      liquidityTruth,
    });
  } catch (e) {
    console.error("GlassBox /api/check error:", e?.message);
    return res.status(500).json({
      error:
        e?.message || "Unexpected error while scanning this mint on-chain.",
    });
  }
}
