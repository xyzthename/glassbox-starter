// api/check.js
// GlassBox backend
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

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

// Decode mint account data just enough to know:
// - supply
// - decimals
// - whether mint authority / freeze authority exist
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

  // u8: isInitialized (unused here)
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
    console.error(
      "safeGetLargestAccounts error for mint",
      mint,
      e?.message
    );
    // Fallback: no holder data instead of hard error
    return { value: [] };
  }
}

// DexScreener helper – we only care about Solana pairs for this mint
async function fetchDexAndAgeStatsFromDexScreener(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DexScreener error: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const pairs = Array.isArray(json.pairs) ? json.pairs : [];

  if (!pairs.length) {
    return {
      priceUsd: null,
      liquidityUsd: null,
      ageDays: null,
      globalFeesUsd: null,
    };
  }

  // pick the pair with highest liquidity
  const best = pairs.reduce((a, b) =>
    (a.liquidity?.usd || 0) >= (b.liquidity?.usd || 0) ? a : b
  );

  const priceUsd = best.priceUsd ? Number(best.priceUsd) : null;
  const liquidityUsd = best.liquidity?.usd
    ? Number(best.liquidity.usd)
    : null;

  // DexScreener gives createdAt in ms
  let ageDays = null;
  if (best.createdAt) {
    const created = new Date(best.createdAt).getTime();
    const now = Date.now();
    if (!Number.isNaN(created) && created > 0 && now > created) {
      ageDays = (now - created) / (1000 * 60 * 60 * 24);
    }
  }

  // crude fees estimate: volumeUsd24h * 0.003 if present
  const volume24 = best.volume?.h24 ? Number(best.volume.h24) : null;
  const globalFeesUsd =
    volume24 && !Number.isNaN(volume24) ? volume24 * 0.003 : null;

  return { priceUsd, liquidityUsd, ageDays, globalFeesUsd };
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
      globalFeesUsd: null,
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

    // 1) Mint account
    const accountInfoPromise = heliusRpc("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);

    // 2) Metadata
    const assetPromise = safeGetAsset(mint);

    // 3) Largest accounts (holders)
    const largestPromise = safeGetLargestAccounts(mint);

    // 4) Price / liquidity / age from DexScreener
    const dexStatsPromise = fetchDexAndAgeStatsFallback(mint);

    const [accountInfo, asset, largest, dexStats] = await Promise.all([
      accountInfoPromise,
      assetPromise,
      largestPromise,
      dexStatsPromise,
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
      // ignore meta failure
      console.error("metadata parse error", e?.message);
    }

    const tokenMeta = { name, symbol, logoURI };

    // Holder summary (top 10 wallets)
    const largestAccounts = largest?.value || [];
    const supplyBN =
      rawSupply && rawSupply !== "0" ? BigInt(rawSupply) : 0n;

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

    // 🔧 FIX: if we couldn't fetch any holders (e.g. USDC/USDT too big),
    // don't pretend it's 0%. Use `null` so the UI can show "No holder data".
    let top10Pct = null;

    if (topHolders.length && rawSupply && rawSupply !== "0") {
      top10Pct = topHolders.reduce((sum, h) => sum + (h.pct || 0), 0);
    }

    const holderSummary = {
      top10Pct,
      topHolders,
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

    // Simple risk model (mint side only)
    let level = "medium";
    let blurb = "";
    let score = 50;

    if (!mintAuthority && !freezeAuthority && top10Pct !== null && top10Pct <= 25) {
      level = "low";
      blurb =
        "Mint authority renounced, no freeze authority, and top holders are reasonably distributed.";
      score = 90;
    } else if (!mintAuthority && (top10Pct === null || top10Pct <= 60)) {
      level = "medium";
      blurb =
        "Mint authority renounced, but supply may still be fairly concentrated.";
      score = 65;
    } else {
      level = "high";
      blurb =
        "Mint authority or freeze authority is still active and/or top holders control a large portion of supply.";
      score = 25;
    }

    const riskSummary = { level, blurb, score };

    // Dex metrics + token age
    const tokenMetrics = {
      priceUsd: dexStats.priceUsd,
      liquidityUsd: dexStats.liquidityUsd,
      globalFeesUsd: dexStats.globalFeesUsd,
    };

    const tokenAge =
      dexStats.ageDays != null
        ? { ageDays: dexStats.ageDays }
        : { ageDays: null };

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
    });
  } catch (err) {
    console.error("API /api/check error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
