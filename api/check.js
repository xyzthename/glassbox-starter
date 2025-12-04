// api/check.js
// GlassBox backend
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age / 24h DEX fees

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Known Solana stablecoins (whitelist)
const STABLECOIN_WHITELIST = {
  // USDC
  // NOTE: this mint *must* end with "v"
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
    // Fallback: no holder data instead of hard error
    return { value: [] };
  }
}

// Count unique wallets holding a non-zero balance of this mint
async function safeCountTokenHolders(mint) {
  try {
    // For very large centralized stables, skip this – it’s way too heavy
    if (STABLECOIN_WHITELIST[mint]) {
      return null;
    }

    // SPL Token program id
    const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    const result = await heliusRpc("getProgramAccounts", [
      TOKEN_PROGRAM_ID,
      {
        commitment: "processed",
        encoding: "jsonParsed",
        filters: [
          // SPL token account size
          { dataSize: 165 },
          // Mint field is at offset 0
          {
            memcmp: {
              offset: 0,
              bytes: mint,
            },
          },
        ],
      },
    ]);

    const accounts = Array.isArray(result) ? result : [];
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

    // If this is some huge token, avoid blowing things up
    if (owners.size === 0) return null;

    return owners.size;
  } catch (e) {
    console.error("safeCountTokenHolders error for mint", mint, e?.message);
    // If this fails, we just won't show holdersCount instead of breaking API
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
  let txCount24 = null;
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

  // 24h volume (USD)
  if (
    selectedPair &&
    selectedPair.volume &&
    typeof selectedPair.volume === "object"
  ) {
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
    volume24Usd: volume24,
    txCount24,
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

    // 3) Largest accounts (holders, top 20)
    const largestPromise
