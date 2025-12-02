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

// getAsset but swallow "Asset Not Found" etc so USDC still scans
async function safeGetAsset(mint) {
  try {
    const result = await heliusRpc("getAsset", [mint]);
    return result;
  } catch (err) {
    const msg = (err?.message || "").toLowerCase();
    if (
      msg.includes("asset not found") ||
      msg.includes("recordnotfound") ||
      msg.includes("not a token mint")
    ) {
      console.warn("getAsset: no metadata for mint", mint, "-", err.message);
      return null;
    }
    console.error("getAsset failed:", err);
    return null;
  }
}

// getTokenLargestAccounts but never kill the whole request
async function safeGetLargestAccounts(mint) {
  try {
    const result = await heliusRpc("getTokenLargestAccounts", [mint]);
    return result;
  } catch (err) {
    console.warn(
      "getTokenLargestAccounts failed, returning empty holders:",
      err.message
    );
    return { value: [] };
  }
}

// Decode mint account data -> supply, decimals, authorities
function parseMintAccount(base64Data) {
  const raw = Buffer.from(base64Data, "base64");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  let offset = 0;

  // u32: mintAuthorityOption
  const mintAuthOpt = view.getUint32(offset, true);
  const hasMintAuthority = mintAuthOpt !== 0;
  offset += 4 + 32; // option + pubkey

  // u64: supply (little-endian)
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

// DexScreener: best-liquidity pair → price, liquidity, age
async function fetchDexScreenerStats(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("DexScreener HTTP", res.status, res.statusText);
      return null;
    }
    const json = await res.json();
    const pairs = Array.isArray(json.pairs) ? json.pairs : [];
    if (!pairs.length) return null;

    // choose pair with highest USD liquidity
    let best = pairs[0];
    for (const p of pairs) {
      const liq = p?.liquidity?.usd ?? 0;
      const bestLiq = best?.liquidity?.usd ?? 0;
      if (liq > bestLiq) best = p;
    }

    const priceUsd = best.priceUsd ? Number(best.priceUsd) : null;
    const liquidityUsd = best.liquidity?.usd ?? null;

    let ageDays = null;
    const created = best.pairCreatedAt || best.createdAt;
    if (created) {
      let ms =
        typeof created === "number" ? created : Date.parse(String(created));
      // If it looks like seconds, convert to ms
      if (ms < 10_000_000_000) {
        ms *= 1000;
      }
      if (!Number.isNaN(ms)) {
        ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
      }
    }

    // DexScreener doesn’t give a simple “global fees paid” – keep null for now.
    const globalFeesUsd = null;

    return { priceUsd, liquidityUsd, ageDays, globalFeesUsd };
  } catch (err) {
    console.warn("DexScreener fetch failed:", err.message);
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
        .status(404)
        .json({ error: "Unable to read mint account data." });
    }

    const parsedMint = parseMintAccount(dataBase64);
    const mintInfo = {
      supply: parsedMint.supply,
      decimals: parsedMint.decimals,
    };
    const mintAuthority = parsedMint.hasMintAuthority;
    const freezeAuthority = parsedMint.hasFreezeAuthority;

    // 2) Optional metadata + age (Helius asset)
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

    const tokenMeta = { name, symbol, logoURI };

    let ageDays = null;
    if (asset?.native?.createdAt) {
      let ms = asset.native.createdAt;
      if (ms < 10_000_000_000) {
        ms *= 1000;
      }
      if (!Number.isNaN(ms)) {
        ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
      }
    }

    // 3) Top holders (best effort)
    const largest = await safeGetLargestAccounts(mint);
    const largestAccounts = largest?.value || [];

    const supplyBN = BigInt(parsedMint.supply || "0") || 1n;

    const topHolders = largestAccounts.slice(0, 10).map((entry) => {
      const amountBN = BigInt(entry.amount || "0");
      const pct = Number((amountBN * 10_000n) / supplyBN) / 100;
      return {
        address: entry.address,
        pct,
        uiAmount: entry.uiAmount,
      };
    });

    const top10Pct = topHolders.reduce((sum, h) => sum + (h.pct || 0), 0);

    const holderSummary = {
      top10Pct,
      topHolders,
    };

    // 4) Origin hint
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

    // 6) Market data via DexScreener
    const dexStats = await fetchDexScreenerStats(mint);

    const tokenMetrics = {
      priceUsd: dexStats?.priceUsd ?? null,
      liquidityUsd: dexStats?.liquidityUsd ?? null,
      globalFeesUsd: dexStats?.globalFeesUsd ?? null,
    };

    const tokenAge = {
      ageDays: dexStats?.ageDays ?? ageDays ?? null,
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
    console.error("API /api/check error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
