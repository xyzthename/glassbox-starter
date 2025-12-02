// api/check.js
// GlassBox backend
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const KNOWN_STABLES = {
  // USDC (Solana)
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1": {
    symbol: "USDC",
    nameOverride: "USD Coin (Solana)",
    note:
      "Canonical USDC stablecoin on Solana. Centralized issuer controls mint and freeze; contract is widely used.",
  },
  // USDT (Solana)
  "es9vmfrzacerdmvgzya4a1nvumczwyvzbm6z9qkfx6f": {
    symbol: "USDT",
    nameOverride: "Tether USD (Solana)",
    note:
      "Canonical USDT stablecoin on Solana. Centralized issuer controls mint and freeze; contract is widely used.",
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
    throw new Error(`Helius RPC HTTP ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  if (json.error) {
    console.error("Helius RPC error:", json.error);
    throw new Error(json.error.message || "Helius RPC error");
  }
  return json.result;
}

// Keep this robust: for some mints (esp. old / huge ones) asset index might not exist
async function safeGetAsset(mint) {
  try {
    const result = await heliusRpc("getAsset", [mint]);
    if (!result) return null;
    if (result.error || result.message === "Asset not found") {
      console.warn("getAsset asset-not-found:", mint, result);
      return null;
    }
    return result;
  } catch (err) {
    console.warn("safeGetAsset failed for", mint, err.message);
    return null;
  }
}

// token holdings – we only need top accounts; Helius mirrors Solana RPC here
async function safeGetLargestAccounts(mint) {
  try {
    const largest = await heliusRpc("getTokenLargestAccounts", [mint]);
    return largest?.value || [];
  } catch (err) {
    console.warn("getTokenLargestAccounts failed:", mint, err.message);
    return [];
  }
}

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

// DexScreener: quick & dirty market data
async function fetchDexScreenerStats(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("DexScreener HTTP", res.status, res.statusText);
      return {
        priceUsd: null,
        liquidityUsd: null,
        globalFeesUsd: null,
        ageDays: null,
      };
    }
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (!pairs.length) {
      return {
        priceUsd: null,
        liquidityUsd: null,
        globalFeesUsd: null,
        ageDays: null,
      };
    }

    // pick the deepest pool as “best”
    const best = pairs.reduce((a, b) => {
      const la = Number(a.liquidity?.usd || 0);
      const lb = Number(b.liquidity?.usd || 0);
      return lb > la ? b : a;
    });

    const priceUsd =
      best.priceUsd != null
        ? Number(best.priceUsd)
        : best?.priceNative
        ? Number(best.priceNative)
        : null;

    const liquidityUsd =
      best.liquidity?.usd != null
        ? Number(best.liquidity.usd)
        : null;

    const fee24hUsd =
      best.volume?.h24 != null && best.txns?.h24?.buys != null
        ? Number(best.volume.h24) * 0.003 // rough 0.3% fee guess
        : null;

    let ageDays = null;
    const createdAt = best.pairCreatedAt || best.createdAt;
    if (createdAt) {
      const createdMs = Number(createdAt);
      if (!Number.isNaN(createdMs) && createdMs > 0) {
        const now = Date.now();
        ageDays = Math.max(0, (now - createdMs) / (1000 * 60 * 60 * 24));
      }
    }

    return {
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
      liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : null,
      globalFeesUsd: Number.isFinite(fee24hUsd) ? fee24hUsd : null,
      ageDays: ageDays != null && Number.isFinite(ageDays) ? ageDays : null,
    };
  } catch (err) {
    console.warn("DexScreener fetch failed:", err.message);
    return {
      priceUsd: null,
      liquidityUsd: null,
      globalFeesUsd: null,
      ageDays: null,
    };
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

    const mintLower = mint.toLowerCase();
    const stableInfo = KNOWN_STABLES[mintLower] || null;

    // 1) Mint account info – strict
    const accountInfo = await heliusRpc("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);

    if (!accountInfo?.value) {
      return res
        .status(404)
        .json({ error: "Not a valid SPL mint account on Solana." });
    }

    const dataBase64 = accountInfo.value.data?.[0];
    if (!dataBase64) {
      return res
        .status(400)
        .json({ error: "Mint account data missing or malformed." });
    }

    const parsedMint = parseMintAccount(dataBase64);
    const mintInfo = {
      supply: parsedMint.supply, // string
      decimals: parsedMint.decimals,
    };

    const mintAuthority = parsedMint.hasMintAuthority;
    const freezeAuthority = parsedMint.hasFreezeAuthority;

    // 2) Basic metadata (name / symbol / logo) via asset
    const asset = await safeGetAsset(mint);

    let name = "Unknown Token";
    let symbol = "";
    let logoURI = null;

    if (asset?.content?.metadata) {
      name = asset.content.metadata.name || name;
      symbol = asset.content.metadata.symbol || symbol;
    }
    if (asset?.content?.links?.image) {
      logoURI = asset.content.links.image;
    }

    // Stablecoins: override name/symbol to be super clear
    if (stableInfo) {
      if (stableInfo.nameOverride) name = stableInfo.nameOverride;
      if (stableInfo.symbol) symbol = stableInfo.symbol;
    }

    const tokenMeta = { name, symbol, logoURI };

    let ageDays = null;
    if (asset?.native?.createdAt) {
      const createdMs = Number(asset.native.createdAt);
      if (!Number.isNaN(createdMs) && createdMs > 0) {
        const now = Date.now();
        ageDays = Math.max(0, (now - createdMs) / (1000 * 60 * 60 * 24));
      }
    }

    // 3) Largest token accounts (top holders)
    const largestAccounts = await safeGetLargestAccounts(mint);

    const supplyBN =
      parsedMint.supply != null ? BigInt(parsedMint.supply) || 1n : 1n;

    const topHolders = (largestAccounts || [])
      .slice(0, 10)
      .map((entry) => {
        const amountBN = BigInt(entry.amount || "0");
        const pct = Number((amountBN * 10_000n) / supplyBN) / 100; // %
        return {
          address: entry.address,
          pct,
          uiAmount: entry.uiAmount,
        };
      });

    const top10Pct = topHolders.reduce(
      (sum, h) => sum + (Number.isFinite(h.pct) ? h.pct : 0),
      0
    );

    const holderSummary = {
      top10Pct: Number.isFinite(top10Pct) ? top10Pct : null,
      topHolders,
    };

    // 4) Origin hint – very lightweight for now
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

    // 5) Risk model – now with stablecoin override
    const top10PctVal =
      holderSummary.top10Pct != null ? holderSummary.top10Pct : Infinity;

    let level = "medium";
    let blurb = "";
    let score = 50;

    if (stableInfo) {
      level = "low";
      blurb =
        stableInfo.note ||
        "Recognized Solana stablecoin. Centralized issuer controls mint and freeze; holder concentration is expected.";
      score = 95;
    } else if (!mintAuthority && !freezeAuthority && top10PctVal <= 25) {
      level = "low";
      blurb =
        "Mint authority renounced, no freeze authority, and top holders are reasonably distributed.";
      score = 90;
    } else if (!mintAuthority && top10PctVal <= 60) {
      level = "medium";
      blurb =
        "Mint authority renounced, but supply is still fairly concentrated.";
      score = 65;
    } else {
      level = "high";
      blurb =
        "Mint authority or freeze authority is still active and/or top holders control a large portion of supply.";
      score = 25;
    }

    const riskSummary = { level, blurb, score };

    // 6) Market data via DexScreener
    const dexStats = await fetchDexScreenerStats(mint);

    const tokenMetrics = {
      priceUsd: dexStats.priceUsd,
      liquidityUsd: dexStats.liquidityUsd,
      globalFeesUsd: dexStats.globalFeesUsd,
    };

    const tokenAge = {
      ageDays:
        ageDays != null && Number.isFinite(ageDays)
          ? ageDays
          : dexStats.ageDays ?? null,
    };

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
    console.error("check handler error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal GlassBox backend error" });
  }
}
