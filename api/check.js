// pages/api/check.js
// GlassBox backend – v2 (clean rebuild)
// - Helius RPC for mint + holders
// - DexScreener for price / liquidity / age / volume / tx count / socials
// - Insider snapshot + holder summary + simple scam score
// - IMPORTANT: never hard-code HELIUS key, only use process.env

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// --- Stablecoins we treat specially -----------------------------------

const STABLECOIN_WHITELIST = {
  // USDC (correct Solana mint)
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
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    if (!result || !Array.isArray(result.value)) return null;
    return result.value.length;
  } catch (e) {
    console.error("safeCountTokenHolders error:", e?.message);
    return null; // front-end will show “RPC limit / index missing”
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
 *  - dexFeesUsd24h (~0.3% of vol24)
 *  - poolMintReserve (for LP matching)
 *  - socials { website, twitter, telegram, discord, others[] } (URLs)
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
      typeof p.liquidity?.usd === "number"
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
      // Adjust if our mint is quote
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
     
