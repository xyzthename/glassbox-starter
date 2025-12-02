// /api/check.js
// Serverless function for Vercel
// Uses Helius RPC for mint + metadata + holders
// plus DexScreener for price / liquidity / token age / listing info.

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const DEX_API_BASE = "https://api.dexscreener.com";

// Simple JSON-RPC helper for Helius / Solana
async function rpc(method, params) {
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

// Helper to pull some extra data from DexScreener (price, liquidity, age, boosts, paid listing)
async function fetchDexData(mint) {
  let priceUsd = null;
  let liquidityUsd = null;
  let tokenAge = null;
  let boostsActive = null;
  let dexPaid = false;
  let dexOrderStatus = null;

  // 1) Token / pair data (price, liquidity, boosts, pairCreatedAt)
  try {
    const url = `${DEX_API_BASE}/tokens/v1/solana/${mint}`;
    const res = await fetch(url);
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length > 0) {
        // Pick the pair with the highest liquidity
        let best = null;
        for (const p of arr) {
          if (!p || typeof p !== "object") continue;
          const liq =
            p.liquidity && typeof p.liquidity.usd === "number"
              ? p.liquidity.usd
              : Number(p.liquidity?.usd ?? 0);
          const bestLiq =
            best && best.liquidity && typeof best.liquidity.usd === "number"
              ? best.liquidity.usd
              : Number(best?.liquidity?.usd ?? 0);
          if (!best || liq > bestLiq) {
            best = p;
          }
        }

        if (best) {
          // priceUsd is a string in the docs, so coerce safely
          if (best.priceUsd != null) {
            const parsed = Number(best.priceUsd);
            if (Number.isFinite(parsed)) {
              priceUsd = parsed;
            }
          }

          if (best.liquidity && best.liquidity.usd != null) {
            const l = Number(best.liquidity.usd);
            if (Number.isFinite(l)) {
              liquidityUsd = l;
            }
          }

          // Approximate token "trading age" from pairCreatedAt
          if (typeof best.pairCreatedAt === "number") {
            let createdMs = best.pairCreatedAt;
            // Heuristic: if it's too small, treat as seconds
            if (createdMs < 10_000_000_000) {
              createdMs *= 1000;
            }
            const now = Date.now();
            const ageMs = Math.max(0, now - createdMs);
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            tokenAge = { ageDays };
          }

          if (best.boosts && typeof best.boosts.active === "number") {
            boostsActive = best.boosts.active;
          }
        }
      }
    }
  } catch (e) {
    console.error("DexScreener tokens/v1 error:", e?.message || e);
  }

  // 2) DexScreener paid orders for this token (listing boosted / featured)
  try {
    const ordersUrl = `${DEX_API_BASE}/orders/v1/solana/${mint}`;
    const res = await fetch(ordersUrl);
    if (res.ok) {
      const orders = await res.json();
      if (Array.isArray(orders) && orders.length > 0) {
        dexPaid = true;
        dexOrderStatus = orders[0]?.status || null;
      }
    }
  } catch (e) {
    console.error("DexScreener orders/v1 error:", e?.message || e);
  }

  const dexInfo = {
    paid: dexPaid,
    status: dexOrderStatus,
    boostsActive,
  };

  return { priceUsd, liquidityUsd, tokenAge, dexInfo };
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

    // 1) Fetch mint account info
    const accountInfoPromise = rpc("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);

    // 2) Fetch Jupiter-style metadata + price via Helius DAS getAsset
    // NOTE: DAS expects params as an object: { id: mint }
    const assetPromise = rpc("getAsset", { id: mint });

    // 3) Fetch largest token accounts (top holders)
    const largestPromise = rpc("getTokenLargestAccounts", [mint]);

    // 4) Extra metrics from DexScreener (price / liquidity / age / listing / boosts)
    const dexPromise = fetchDexData(mint);

    const [accountInfo, asset, largest, dexData] = await Promise.all([
      accountInfoPromise,
      assetPromise,
      largestPromise,
      dexPromise,
    ]);

    if (!accountInfo?.value) {
      return res
        .status(404)
        .json({ error: "Not a valid SPL mint account on Solana." });
    }

    const dataBase64 = accountInfo.value.data?.[0];
    if (!dataBase64) {
      return res
        .status(500)
        .json({ error: "Mint account has no data segment." });
    }

    const parsedMint = parseMintAccount(dataBase64);

    const mintInfo = {
      supply: parsedMint.supply, // string
      decimals: parsedMint.decimals,
    };

    const mintAuthority = parsedMint.hasMintAuthority;
    const freezeAuthority = parsedMint.hasFreezeAuthority;

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

      // If DAS token_info has a symbol/name, prefer those as a fallback
      if (asset?.token_info) {
        if (asset.token_info.symbol && !symbol) {
          symbol = asset.token_info.symbol;
        }
        if (asset.token_info.name && name === "Unknown Token") {
          name = asset.token_info.name;
        }
      }
    } catch (e) {
      console.error("Metadata parse error:", e?.message || e);
    }

    const tokenMeta = { name, symbol, logoURI };

    // Top holders (using getTokenLargestAccounts – 20 biggest token accounts)
    const largestAccounts = largest?.value || [];
    const totalHoldersApprox = largestAccounts.length;

    const supplyBN = BigInt(parsedMint.supply || "0") || 1n;

    const topHolders = largestAccounts.slice(0, 10).map((entry) => {
      const amountBN = BigInt(entry.amount || "0");
      const pct = Number((amountBN * 10_000n) / supplyBN) / 100; // %
      return {
        address: entry.address,
        pct,
        uiAmount: entry.uiAmount,
      };
    });

    const top10Pct = topHolders.reduce((sum, h) => sum + (h.pct || 0), 0);

    const holderSummary = {
      totalHolders: totalHoldersApprox, // this is "top holders count", not full chain-wide holder count
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

    // Simple risk model based on authorities + holder concentration
    let level = "medium";
    let blurb = "";
    let score = 50;

    if (!mintAuthority && !freezeAuthority && top10Pct <= 25) {
      level = "low";
      blurb =
        "Mint authority renounced, no freeze authority, and top holders are reasonably distributed.";
      score = 90;
    } else if (!mintAuthority && top10Pct <= 60) {
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

    // Merge tokenMetrics from Helius price (if available) + DexScreener
    let priceUsd = null;
    try {
      const maybePrice =
        asset?.token_info?.price_info?.price_per_token ??
        asset?.token_info?.price_info?.pricePerToken;
      if (maybePrice != null) {
        const parsed = Number(maybePrice);
        if (Number.isFinite(parsed)) {
          priceUsd = parsed;
        }
      }
    } catch (e) {
      console.error("Price parse from asset error:", e?.message || e);
    }

    if (priceUsd == null && dexData?.priceUsd != null) {
      priceUsd = dexData.priceUsd;
    }

    const liquidityUsd =
      dexData?.liquidityUsd != null ? dexData.liquidityUsd : null;

    const tokenMetrics = {
      priceUsd,
      liquidityUsd,
      globalFeesUsd: null, // not available yet (shows as N/A in UI)
    };

    const tokenAge = dexData?.tokenAge || null;
    const dexInfo = dexData?.dexInfo || null;

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
      dexInfo, // not used by your UI yet, but ready for "Dex paid / boost" later
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
