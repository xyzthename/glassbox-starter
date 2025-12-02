// /api/check.js
// GlassBox backend: Helius RPC + DexScreener
// - Gets mint info (supply / decimals / authorities)
// - Gets largest token accounts (top holders)
// - Gets price / liquidity / token age from DexScreener
// - Heuristically finds the liquidity pool wallet and excludes it from
//   "Top 10 wallets %" while still returning it separately.

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Helius RPC endpoint
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Basic RPC helper
async function rpc(method, params) {
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

// Decode the mint account to pull:
// - supply (string)
// - decimals (u8)
// - flags for mintAuthority / freezeAuthority
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

// DexScreener helper: fetch best pair + derived metrics.
// This NEVER touches Helius, so no "too many pubkeys" issues here.
async function fetchDexData(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const json = await res.json();
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    if (!pairs.length) return null;

    // Pick the pair with the highest USD liquidity
    let best = pairs[0];
    for (const p of pairs) {
      const liq = Number(p?.liquidity?.usd || 0);
      const bestLiq = Number(best?.liquidity?.usd || 0);
      if (liq > bestLiq) best = p;
    }

    const mintLc = mint.toLowerCase();
    const baseIsMint =
      (best.baseToken?.address || "").toLowerCase() === mintLc ||
      (best.baseToken?.addressAlt || "").toLowerCase() === mintLc;

    const tokenSide = baseIsMint ? best.baseToken : best.quoteToken;

    const liquidityTokenAmount = Number(
      baseIsMint ? best?.liquidity?.base || 0 : best?.liquidity?.quote || 0
    );

    const priceUsd = Number(best?.priceUsd || 0);
    const liquidityUsd = Number(best?.liquidity?.usd || 0);

    const tokenName = tokenSide?.name || tokenSide?.symbol || null;
    const tokenSymbol = tokenSide?.symbol || "";
    const logoURI =
      best?.info?.imageUrl ||
      tokenSide?.logoURI ||
      tokenSide?.icon ||
      null;

    // Token age from DexScreener's listing time (seconds → ms)
    let tokenAge = null;
    const listedAtSec = best?.info?.listedAt;
    if (listedAtSec && Number(listedAtSec) > 0) {
      const listedAtMs = Number(listedAtSec) * 1000;
      const nowMs = Date.now();
      const ageDays = Math.max(0, (nowMs - listedAtMs) / 86_400_000);
      tokenAge = {
        ageDays,
        listedAt: new Date(listedAtMs).toISOString(),
      };
    }

    // Dex Paid / Boost flags (optional; not yet fully wired in UI)
    const dexPaid =
      !!best?.info?.imageUrl ||
      (Array.isArray(best?.info?.websites) && best.info.websites.length > 0);
    const dexBoost =
      Array.isArray(best?.boosts) && best.boosts.length
        ? best.boosts[0].amountUsd || best.boosts[0].boostMultiplier || null
        : null;

    const dexId = best?.dexId || "";

    return {
      priceUsd,
      liquidityUsd,
      liquidityTokenAmount,
      tokenName,
      tokenSymbol,
      logoURI,
      tokenAge,
      dexPaid,
      dexBoost,
      dexId,
    };
  } catch (e) {
    console.error("DexScreener fetch error:", e);
    return null;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const mint = String(req.query.mint || "").trim();

    if (!mint) {
      return res.status(400).json({ error: "Missing mint query parameter" });
    }

    if (!HELIUS_API_KEY) {
      return res
        .status(500)
        .json({ error: "HELIUS_API_KEY is not set in environment" });
    }

    // Helius RPC calls
    const accountInfoPromise = rpc("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);

    // getTokenLargestAccounts returns at most 20 accounts, so it’s safe
    const largestPromise = rpc("getTokenLargestAccounts", [mint]).catch(
      (err) => {
        console.error("getTokenLargestAccounts error:", err);
        return null;
      }
    );

    // getAsset sometimes returns "Asset Not Found" for old / huge tokens.
    const assetPromise = rpc("getAsset", [mint]).catch((err) => {
      console.warn("getAsset error (non-fatal):", err?.message || err);
      return null;
    });

    // DexScreener metrics
    const dexPromise = fetchDexData(mint);

    const [accountInfo, largest, asset, dexData] = await Promise.all([
      accountInfoPromise,
      largestPromise,
      assetPromise,
      dexPromise,
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

    // --- Token metadata: Helius first, DexScreener as fallback ---
    let name = "Unknown Token";
    let symbol = "";
    let logoURI = null;

    try {
      if (asset?.content?.metadata) {
        name = asset.content.metadata.name || name;
        symbol = asset.content.metadata.symbol || symbol;
      }
      // Try to find image URI
      if (
        asset?.content?.files &&
        Array.isArray(asset.content.files) &&
        asset.content.files.length
      ) {
        const img = asset.content.files.find(
          (f) =>
            f?.uri &&
            (f?.mime === "image/png" ||
              f?.mime === "image/jpeg" ||
              String(f?.mime || "").startsWith("image/"))
        );
        if (img?.uri) logoURI = img.uri;
      }
      if (asset?.content?.links?.image && !logoURI) {
        logoURI = asset.content.links.image;
      }
    } catch (e) {
      console.warn("Asset metadata parse failed:", e);
    }

    // Dex fallback / overrides
    if ((!name || name === "Unknown Token") && dexData?.tokenName) {
      name = dexData.tokenName;
    }
    if (!symbol && dexData?.tokenSymbol) {
      symbol = dexData.tokenSymbol;
    }
    if (!logoURI && dexData?.logoURI) {
      logoURI = dexData.logoURI;
    }

    const tokenMeta = { name, symbol, logoURI };

    // --- Holders & liquidity pool detection ---

    const largestAccounts = Array.isArray(largest?.value) ? largest.value : [];
    const supplyBN =
      parsedMint.supply != null ? BigInt(parsedMint.supply) : 0n;

    const holderRows = largestAccounts.map((entry) => {
      const amountStr = entry?.amount || "0";
      const amountBN = BigInt(amountStr || "0");
      const pct =
        supplyBN > 0n
          ? Number((amountBN * 10_000n) / supplyBN) / 100 // keep 2 decimals
          : 0;
      return {
        address: entry.address,
        amountBN,
        uiAmount: typeof entry.uiAmount === "number"
          ? entry.uiAmount
          : Number(entry.uiAmount || 0),
        pct,
        isLp: false,
      };
    });

    let lpHolder = null;

    // Use DexScreener pool size to guess the LP token account
    if (
      dexData &&
      typeof dexData.liquidityTokenAmount === "number" &&
      dexData.liquidityTokenAmount > 0 &&
      holderRows.length
    ) {
      const target = dexData.liquidityTokenAmount;
      let bestIndex = -1;
      let bestRatio = Infinity;

      holderRows.forEach((h, idx) => {
        const amt = h.uiAmount || 0;
        if (!isFinite(amt) || amt <= 0) return;
        const diff = Math.abs(amt - target);
        const ratio = target > 0 ? diff / target : Infinity;
        if (ratio < bestRatio) {
          bestRatio = ratio;
          bestIndex = idx;
        }
      });

      // Treat within 2% of DexScreener LP size as the LP account
      if (bestIndex >= 0 && bestRatio <= 0.02) {
        holderRows[bestIndex].isLp = true;
        lpHolder = holderRows[bestIndex];
      }
    }

    const nonLpHolders = holderRows.filter((h) => !h.isLp);
    const topHolders = nonLpHolders.slice(0, 10);

    const top10Pct = topHolders.reduce((sum, h) => sum + (h.pct || 0), 0);

    const holderSummary = {
      totalHolders: holderRows.length, // NOTE: this is "top accounts fetched", not global count
      top10Pct,
      topHolders,
      lpHolder, // may be null; frontend can use this to show 💧
    };

    // --- Origin hint (basic, mostly via Dex ID) ---
    let originLabel = "Unknown protocol / origin";
    let originDetail = "";

    const lowerMint = mint.toLowerCase();
    if (lowerMint.endsWith("pump") || dexData?.dexId?.includes("pump")) {
      originLabel = "Likely Pump.fun mint";
      originDetail =
        "Mint resembles Pump.fun pattern or is traded primarily on Pump routers.";
    } else if (dexData?.dexId?.toLowerCase().includes("raydium")) {
      originLabel = "Raydium pool";
      originDetail = "Token appears to trade via a Raydium AMM pool.";
    }

    const originHint = {
      label: originLabel,
      detail: originDetail,
    };

    // --- Risk model (same structure as before) ---
    const topPctForRisk = top10Pct; // already ex-LP
    let level = "medium";
    let blurb = "";
    let score = 50;

    if (!mintAuthority && !freezeAuthority && topPctForRisk <= 25) {
      level = "low";
      blurb =
        "Mint authority renounced, no freeze authority, and top holders are reasonably distributed.";
      score = 90;
    } else if (!mintAuthority && topPctForRisk <= 60) {
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

    // --- Token metrics (price / liquidity / fees placeholder) ---
    const tokenMetrics = {
      priceUsd: dexData?.priceUsd ?? null,
      liquidityUsd: dexData?.liquidityUsd ?? null,
      globalFeesUsd: null, // still "N/A" in UI for now
    };

    const tokenAge = dexData?.tokenAge || null;

    // Optional Dex flags for future UI wiring
    const dexFlags = {
      dexPaid: !!dexData?.dexPaid,
      dexBoost: dexData?.dexBoost ?? null,
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
      dexFlags,
    });
  } catch (err) {
    console.error("check handler error:", err);
    return res
      .status(500)
      .json({ error: err?.message || "Internal server error" });
  }
}
