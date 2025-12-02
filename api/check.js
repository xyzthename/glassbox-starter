// /pages/api/check.js
//
// GlassBox backend: Solana mint → mint info, holder summary, basic risk,
// price/liquidity (Dexscreener) and best-effort token age.
//
// ENV: process.env.HELIUS_API_KEY must be set.

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

if (!HELIUS_API_KEY) {
  // Fail loud in dev; Vercel will log this.
  console.warn("HELIUS_API_KEY is not set – /api/check will not work.");
}

async function rpc(method, params) {
  const body = {
    jsonrpc: "2.0",
    id: method,
    method,
    params,
  };

  const resp = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`RPC HTTP error ${resp.status}`);
  }

  const json = await resp.json();
  if (json.error) {
    const msg = json.error.message || "RPC error";
    throw new Error(msg);
  }
  return json.result;
}

// --- Mint parsing -----------------------------------------------------------

function parseMintAccount(accountInfo) {
  if (!accountInfo || !accountInfo.value) return null;

  try {
    const dataBase64 = accountInfo.value.data[0];
    const buf = Buffer.from(dataBase64, "base64");

    // SPL Mint layout:
    //   0..4   COption<mintAuthority>
    //   4..36 mintAuthority pubkey
    //  36..44 supply u64 LE
    //    44   decimals u8
    //    45   isInitialized u8
    //  46..50 COption<freezeAuthority>
    //  50..82 freezeAuthority pubkey

    const supply = buf.readBigUInt64LE(36); // u64
    const decimals = buf[44];

    const mintAuthOption = buf.readUInt32LE(0);
    const freezeAuthOption = buf.readUInt32LE(46);

    const hasMintAuthority = mintAuthOption !== 0;
    const hasFreezeAuthority = freezeAuthOption !== 0;

    return {
      supply: supply.toString(), // keep as string to avoid JS overflow
      decimals,
      hasMintAuthority,
      hasFreezeAuthority,
    };
  } catch (e) {
    console.error("parseMintAccount error", e);
    return null;
  }
}

// --- Dexscreener metrics ----------------------------------------------------

async function fetchDexscreenerMetrics(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const resp = await fetch(url);
    if (!resp.ok) return {};

    const json = await resp.json();
    const pairs = json?.pairs || [];
    if (!pairs.length) return {};

    // Pick the highest-liquidity pair as "main"
    const pair = pairs.reduce((best, p) => {
      if (!best) return p;
      const bestLiq = best?.liquidity?.usd ?? 0;
      const liq = p?.liquidity?.usd ?? 0;
      return liq > bestLiq ? p : best;
    }, null);

    if (!pair) return {};

    const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
    const liquidityUsd = pair?.liquidity?.usd ?? null;

    // Dexscreener doesn't expose "global fees paid" – leave null for now.
    const globalFeesUsd = null;

    return { priceUsd, liquidityUsd, globalFeesUsd };
  } catch (e) {
    console.error("Dexscreener fetch failed", e);
    return {};
  }
}

// --- Token age (best-effort, safe) ------------------------------------------

// We *only* try to compute age from DAS asset timestamps when they exist.
// For huge / old tokens (USDC, USDT, etc.) this will be null – no errors.
function deriveTokenAgeFromAsset(asset) {
  try {
    if (!asset) return null;

    // Different DAS versions expose slightly different timestamps.
    // Try a few, in seconds.
    const ts =
      asset?.token_info?.created_at ??
      asset?.createdAt ??
      asset?.creationTime ??
      null;

    if (!ts) return null;

    // If Helius gives ms, convert to seconds-ish.
    const nowSec = Math.floor(Date.now() / 1000);
    const createdSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
    const diffSec = Math.max(0, nowSec - createdSec);

    const days = diffSec / 86400;

    return { ageDays: days };
  } catch {
    return null;
  }
}

// --- Holder summary + LP detection -----------------------------------------
//
// Strategy:
//  1. getTokenLargestAccounts(mint) → top balances (token accounts).
//  2. getMultipleAccounts(topTokenAccounts, jsonParsed) → find each
//     token account’s "owner" (wallet or PDA).
//  3. getMultipleAccounts(ownerWallets, base64) → see whether each
//     owner is System Program (normal wallet) or some program (Raydium,
//     Orca, Pump, Meteora, etc.).
//  4. The largest *program-owned* holder is treated as the LP vault,
//     if it holds at least ~1% of supply.
//  5. top10Pct is computed *excluding* that LP address.

async function buildHolderSummary(mint, mintInfo, largestRes) {
  const result = {
    top10Pct: null,
    lpAddress: null,
    lpPct: 0,
    topHolders: [],
    totalHoldersSampled: 0,
  };

  const largest = largestRes?.value || [];
  if (!largest.length || !mintInfo?.supply) {
    return result;
  }

  const supplyBN = BigInt(mintInfo.supply || "0");
  if (supplyBN <= 0n) {
    return result;
  }

  const maxAccounts = 20;
  const holderEntries = largest.slice(0, maxAccounts);
  result.totalHoldersSampled = holderEntries.length;

  const tokenAccountPubkeys = holderEntries.map((h) => h.address);

  // 1) Fetch token accounts (jsonParsed) to get "owner" (vault / wallet)
  let tokenAccountInfos = [];
  try {
    const multi = await rpc("getMultipleAccounts", [
      tokenAccountPubkeys,
      { encoding: "jsonParsed" },
    ]);
    tokenAccountInfos = multi?.value || [];
  } catch (e) {
    console.error("getMultipleAccounts (token accounts) failed", e);
  }

  const ownerWallets = holderEntries.map((entry, idx) => {
    const acc = tokenAccountInfos[idx];
    return acc?.data?.parsed?.info?.owner || null;
  });

  // 2) Fetch owner wallet accounts to see which ones are program-owned.
  const uniqueOwnerWallets = [
    ...new Set(ownerWallets.filter((x) => typeof x === "string")),
  ];

  const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
  const ownerProgramByWallet = {};

  if (uniqueOwnerWallets.length) {
    try {
      const ownerMulti = await rpc("getMultipleAccounts", [
        uniqueOwnerWallets,
        { encoding: "base64" },
      ]);
      const ownerInfos = ownerMulti?.value || [];
      uniqueOwnerWallets.forEach((wallet, i) => {
        const acc = ownerInfos[i];
        if (acc) {
          ownerProgramByWallet[wallet] = acc.owner; // program id owning this wallet
        }
      });
    } catch (e) {
      console.error("getMultipleAccounts (owner wallets) failed", e);
    }
  }

  // 3) Build enriched holder list
  const enriched = holderEntries.map((entry, idx) => {
    const amountBN = BigInt(entry.amount || "0");
    const pct = Number((amountBN * 10000n) / supplyBN) / 100; // 2 decimals
    const ownerWallet = ownerWallets[idx] || null;
    const ownerProgram = ownerWallet ? ownerProgramByWallet[ownerWallet] : null;
    const isProgramOwned =
      ownerProgram && ownerProgram !== SYSTEM_PROGRAM_ID ? true : false;

    return {
      rank: idx + 1,
      address: entry.address,
      pct,
      owner: ownerWallet,
      ownerProgram,
      isProgramOwned,
    };
  });

  // 4) LP candidate = largest program-owned holder with pct >= 1%
  let lpCandidate = null;
  for (const h of enriched) {
    if (!h.isProgramOwned) continue;
    if (h.pct < 1) continue; // ignore tiny contract balances
    if (!lpCandidate || h.pct > lpCandidate.pct) {
      lpCandidate = h;
    }
  }

  if (lpCandidate) {
    result.lpAddress = lpCandidate.address;
    result.lpPct = lpCandidate.pct;
  }

  // 5) Compute top10Pct excluding LP address
  const holdersForPct = enriched
    .filter((h) => h.address !== result.lpAddress)
    .slice(0, 10);

  const top10Pct = holdersForPct.reduce(
    (sum, h) => sum + (isFinite(h.pct) ? h.pct : 0),
    0
  );

  result.top10Pct = top10Pct;

  // 6) Final holder list (up to 20, but front-end will .slice(0, 10))
  result.topHolders = enriched.map((h) => ({
    address: h.address,
    pct: h.pct,
    isLp: result.lpAddress === h.address,
  }));

  return result;
}

// --- Risk & origin heuristics -----------------------------------------------

function buildRiskSummary(mintInfo, holderSummary) {
  if (!mintInfo) {
    return {
      level: "unknown",
      score: 50,
      blurb: "Could not read mint account.",
    };
  }

  const hasMint = !!mintInfo.hasMintAuthority;
  const hasFreeze = !!mintInfo.hasFreezeAuthority;
  const top10 = typeof holderSummary?.top10Pct === "number"
    ? holderSummary.top10Pct
    : null;

  let level = "medium";
  let score = 55;
  let blurb = "Some centralization risk from mint controls and holders.";

  if (!hasMint && !hasFreeze && top10 !== null && top10 < 30) {
    level = "low";
    score = 90;
    blurb =
      "Mint & freeze are renounced; holder distribution looks reasonably spread out.";
  } else if (hasMint || hasFreeze || (top10 !== null && top10 > 60)) {
    level = "high";
    score = 25;
    blurb =
      "Mint authority or freeze authority is still active and/or top holders control a large portion of supply.";
  }

  return { level, score, blurb };
}

function buildOriginHint(asset) {
  if (!asset) {
    return {
      label: "Unknown protocol / origin",
      detail: "",
    };
  }

  const name =
    asset?.token_info?.name ||
    asset?.content?.metadata?.name ||
    "Unknown token";
  const symbol =
    asset?.token_info?.symbol || asset?.content?.metadata?.symbol || "";

  const desc =
    (asset?.content?.metadata?.description || "").toLowerCase() || "";

  let label = "Unknown protocol / origin";
  let detail = "";

  if (desc.includes("pump.fun") || desc.includes("pumpfun")) {
    label = "Likely Pump.fun mint";
    detail = "Mint resembles Pump.fun pattern. Always double-check creator + socials.";
  } else if (desc.includes("raydium")) {
    label = "Likely Raydium pool mint";
    detail = "Looks like a Raydium-originated pool. Verify on official links.";
  }

  return { label, detail, name, symbol };
}

// --- Main handler -----------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const mint = (req.query.mint || "").toString().trim();
  if (!mint) {
    return res
      .status(400)
      .json({ error: "Missing ?mint= parameter (Solana token mint address)." });
  }

  try {
    // 1) Core chain + DAS + Dexscreener in parallel
    const [mintAccount, assetResult, largestRes, dexMetrics] = await Promise.all([
      rpc("getAccountInfo", [mint, { encoding: "base64" }]),
      rpc("getAsset", [{ id: mint }]).catch(() => null),
      rpc("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]),
      fetchDexscreenerMetrics(mint),
    ]);

    const mintInfo = parseMintAccount(mintAccount);
    const asset = assetResult?.result || assetResult || null;

    const holderSummary = await buildHolderSummary(mint, mintInfo, largestRes);
    const riskSummary = buildRiskSummary(mintInfo, holderSummary);
    const originHint = buildOriginHint(asset);
    const tokenAge = deriveTokenAgeFromAsset(asset);

    // Token metadata
    const tokenMeta = {
      name:
        asset?.token_info?.name ||
        asset?.content?.metadata?.name ||
        originHint.name ||
        "Unknown Token",
      symbol:
        asset?.token_info?.symbol ||
        asset?.content?.metadata?.symbol ||
        originHint.symbol ||
        "",
      logoURI:
        asset?.content?.links?.image ||
        asset?.token_info?.image ||
        null,
    };

    // Token metrics – combine DAS price (if present) with Dexscreener.
    const priceFromDas = asset?.token_info?.price_info?.price_per_usd ?? null;

    const tokenMetrics = {
      priceUsd: dexMetrics.priceUsd ?? (priceFromDas != null ? Number(priceFromDas) : null),
      liquidityUsd: dexMetrics.liquidityUsd ?? null,
      globalFeesUsd: dexMetrics.globalFeesUsd ?? null,
    };

    const response = {
      tokenMeta,
      mintInfo,
      // We only need boolean presence client-side.
      mintAuthority: mintInfo?.hasMintAuthority ? "present" : null,
      freezeAuthority: mintInfo?.hasFreezeAuthority ? "present" : null,
      holderSummary,
      originHint: {
        label: originHint.label,
        detail: originHint.detail,
      },
      riskSummary,
      tokenMetrics,
      tokenAge, // { ageDays } or null
    };

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json(response);
  } catch (e) {
    console.error("check handler error", e);
    return res.status(500).json({
      error: e.message || "Internal error while scanning mint.",
    });
  }
}
