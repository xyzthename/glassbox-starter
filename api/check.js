// /api/check.js
// Vercel serverless function.
// Uses Helius RPC for mint + holders, Dexscreener for price/liquidity/age.

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// ---- Generic RPC helper ----
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

// Safe wrapper: if it fails, return null instead of throwing
async function rpcSafe(method, params) {
  try {
    return await rpc(method, params);
  } catch (e) {
    console.warn(`RPC ${method} failed:`, e.message);
    return null;
  }
}

// ---- Mint account decoding (supply, decimals, authorities) ----
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

// ---- Dexscreener helper (price/liquidity/age) ----
async function fetchDexscreenerData(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("Dexscreener HTTP error:", res.status, res.statusText);
      return null;
    }
    const json = await res.json();
    const pairs = json?.pairs || [];
    if (!pairs.length) return null;

    // Take the pair with the highest liquidity
    const pair = pairs.reduce((best, p) => {
      const bestLiq = best?.liquidity?.usd ?? 0;
      const liq = p?.liquidity?.usd ?? 0;
      return liq > bestLiq ? p : best;
    }, null);

    if (!pair) return null;

    const priceUsd = pair.priceUsd != null ? Number(pair.priceUsd) : null;
    const liquidityUsd =
      pair.liquidity && pair.liquidity.usd != null
        ? Number(pair.liquidity.usd)
        : null;

    let ageDays = null;
    if (pair.pairCreatedAt) {
      const created = Number(pair.pairCreatedAt);
      if (created > 0) {
        const nowMs = Date.now();
        ageDays = (nowMs - created) / (1000 * 60 * 60 * 24);
      }
    }

    return {
      priceUsd,
      liquidityUsd,
      globalFeesUsd: null, // placeholder
      ageDays,
      // Dex paid / boost are not exposed in their free API yet.
      dexPaid: null,
      dexBoostUsd: null,
    };
  } catch (e) {
    console.warn("Dexscreener fetch failed:", e.message);
    return null;
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

    // 1) Fetch mint account info + largest token accounts (safe)
    const [accountInfo, largest, dexData] = await Promise.all([
      rpc("getAccountInfo", [mint, { encoding: "base64" }]),
      rpcSafe("getTokenLargestAccounts", [mint]),
      fetchDexscreenerData(mint),
    ]);

    if (!accountInfo?.value) {
      return res
        .status(404)
        .json({ error: "Not a valid SPL mint account on Solana." });
    }

    const dataBase64 = accountInfo.value.data?.[0];
    const parsedMint = parseMintAccount(dataBase64);

    const mintInfo = {
      supply: parsedMint.supply, // string
      decimals: parsedMint.decimals,
    };

    const mintAuthority = parsedMint.hasMintAuthority;
    const freezeAuthority = parsedMint.hasFreezeAuthority;

    // 2) Token metadata from Helius getAsset (safe, may not exist for big tokens like USDC)
    let tokenMeta = {
      name: "Unknown Token",
      symbol: "",
      logoURI: null,
    };

    try {
      const asset = await rpcSafe("getAsset", [mint]);
      if (asset?.content?.metadata) {
        tokenMeta.name = asset.content.metadata.name || tokenMeta.name;
        tokenMeta.symbol = asset.content.metadata.symbol || tokenMeta.symbol;
      }
      if (asset?.content?.links?.image) {
        tokenMeta.logoURI = asset.content.links.image;
      }
    } catch (e) {
      console.warn("getAsset failed:", e.message);
    }

    // 3) Holder summary (top 10)
    const largestAccounts = largest?.value || [];
    const totalHolders = largestAccounts.length;

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
      totalHolders,
      top10Pct,
      topHolders,
    };

    // 4) Simple origin hint
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

    // 5) Simple risk model
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

    // 6) Token metrics + age from Dexscreener (if available)
    const tokenMetrics = {
      priceUsd: dexData?.priceUsd ?? null,
      liquidityUsd: dexData?.liquidityUsd ?? null,
      globalFeesUsd: dexData?.globalFeesUsd ?? null,
    };

    const tokenAge = dexData?.ageDays != null ? { ageDays: dexData.ageDays } : null;

    // 7) Dex profile info (placeholders for now)
    const dexInfo = {
      paid: dexData?.dexPaid ?? null,
      boostUsd: dexData?.dexBoostUsd ?? null,
    };

    // 8) Liquidity lock info (placeholder – needs lockers integration)
    const liquidityInfo = {
      lockedPct: null, // when wired: % of supply locked/burnt
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
      dexInfo,
      liquidityInfo,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
