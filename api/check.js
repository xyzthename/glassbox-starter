// api/check.js
// Serverless function for Vercel
// Uses Helius RPC to fetch mint info + metadata + top holders.
// Also hits DexScreener for price / liquidity.

// --- CONFIG ----------------------------------------------------

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// --- HELPER: generic RPC caller -------------------------------

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

// --- HELPER: parse SPL mint account ---------------------------
// We only decode what we need: supply, decimals, mint/freeze flags.

function parseMintAccount(base64Data) {
  const raw = Buffer.from(base64Data, "base64");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  let offset = 0;

  // u32 option: mintAuthority
  const mintAuthOpt = view.getUint32(offset, true);
  const hasMintAuthority = mintAuthOpt !== 0;
  offset += 4 + 32; // skip option + pubkey

  // u64: supply (little endian)
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const supplyBig = BigInt(low) + (BigInt(high) << 32n);
  offset += 8;

  // u8: decimals
  const decimals = raw[offset];
  offset += 1;

  // u8: isInitialized (ignored)
  offset += 1;

  // u32 option: freezeAuthority
  const freezeOpt = view.getUint32(offset, true);
  const hasFreezeAuthority = freezeOpt !== 0;

  return {
    supply: supplyBig.toString(), // string
    decimals,
    hasMintAuthority,
    hasFreezeAuthority,
  };
}

// --- HELPER: tiny address formatter ---------------------------

function shortAddr(addr) {
  if (!addr || addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// --- HELPER: DexScreener price / liquidity --------------------

async function fetchDexScreener(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.pairs) || !json.pairs.length) {
      return null;
    }
    // For now just take the first pair. Later you can add smarter selection.
    const pair = json.pairs[0];

    const priceUsd =
      pair && pair.priceUsd != null ? Number(pair.priceUsd) : null;
    const liquidityUsd =
      pair && pair.liquidity && pair.liquidity.usd != null
        ? Number(pair.liquidity.usd)
        : null;

    // DexScreener doesn’t really expose “global fees paid” directly;
    // keep this as null so frontend shows N/A.
    const globalFeesUsd = null;

    return { priceUsd, liquidityUsd, globalFeesUsd };
  } catch (e) {
    console.error("DexScreener fetch error:", e);
    return null;
  }
}

// --- HELPER: extract a reasonable creation timestamp ----------

function getCreationTimestampMs(asset) {
  if (!asset) return null;

  // Helius assets can have different shapes; try a few common fields.
  const cand =
    asset.creationTime ??
    asset.createdAt ??
    asset.timeCreated ??
    asset.timestamp ??
    null;

  if (!cand) return null;

  if (typeof cand === "string") {
    const t = Date.parse(cand);
    return Number.isFinite(t) ? t : null;
  }

  if (typeof cand === "number") {
    // If it's already in ms, keep it; if it looks like seconds, convert.
    if (cand > 1e12) return cand;
    return cand * 1000;
  }

  return null;
}

function buildTokenAge(asset) {
  const createdMs = getCreationTimestampMs(asset);
  if (!createdMs) return null;

  const now = Date.now();
  const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(ageDays) || ageDays < 0) return null;

  return { ageDays };
}

// --- MAIN HANDLER ---------------------------------------------

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

    // 1) RPC calls in parallel
    const accountInfoPromise = rpc("getAccountInfo", [
      mint,
      { encoding: "base64" },
    ]);
    const assetPromise = rpc("getAsset", [mint]);
    const largestPromise = rpc("getTokenLargestAccounts", [mint]);
    const dexPromise = fetchDexScreener(mint);

    const [accountInfo, asset, largest, dexMetrics] = await Promise.all([
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

    // --- Mint parsing -----------------------------------------

    const dataBase64 = accountInfo.value.data?.[0];
    const parsedMint = parseMintAccount(dataBase64);

    const mintInfo = {
      supply: parsedMint.supply, // raw string
      decimals: parsedMint.decimals,
    };

    const mintAuthority = parsedMint.hasMintAuthority;
    const freezeAuthority = parsedMint.hasFreezeAuthority;

    // --- Metadata from Helius asset ---------------------------

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
      // ignore metadata failures
    }

    const tokenMeta = { name, symbol, logoURI };

    // --- Holder / LP logic ------------------------------------

    const largestAccounts = largest?.value || [];

    const supplyBN =
      BigInt(parsedMint.supply || "0") === 0n
        ? 1n
        : BigInt(parsedMint.supply || "0");

    // First, compute pct for each holder.
    const rawHolders = largestAccounts.map((entry) => {
      const amountBN = BigInt(entry.amount || "0");
      const pct = Number((amountBN * 10_000n) / supplyBN) / 100; // 2 decimal %
      return {
        address: entry.address,
        pct,
        uiAmount: entry.uiAmount,
      };
    });

    // Heuristic liquidity-pool detection:
    // if the biggest account holds >= 40% of supply, treat it as LP.
    let liquidityIndex = -1;
    let liquidityPct = null;
    if (rawHolders.length > 0 && rawHolders[0].pct >= 40) {
      liquidityIndex = 0;
      liquidityPct = rawHolders[0].pct;
    }

    const topHolders = rawHolders.map((h, idx) => ({
      ...h,
      isLiquidity: idx === liquidityIndex,
    }));

    // Effective "top 10" = top 10 *non-liquidity* wallets.
    const effectiveTop10 = topHolders
      .filter((h) => !h.isLiquidity)
      .slice(0, 10);
    const top10Pct = effectiveTop10.reduce(
      (sum, h) => sum + (h.pct || 0),
      0
    );

    const holderSummary = {
      top10Pct, // % held by top 10 non-LP wallets
      liquidityPct, // % in the LP, if detected
      liquidityIndex,
      topHolders,
    };

    // --- Origin hint ------------------------------------------

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

    // --- Risk model (very simple) -----------------------------

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

    // --- Token metrics (DexScreener) --------------------------

    const tokenMetrics = {
      priceUsd: dexMetrics?.priceUsd ?? null,
      liquidityUsd: dexMetrics?.liquidityUsd ?? null,
      globalFeesUsd: dexMetrics?.globalFeesUsd ?? null,
    };

    // --- Token age --------------------------------------------

    const tokenAge = buildTokenAge(asset);

    // --- Response ---------------------------------------------

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
    console.error(err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
}
