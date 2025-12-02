// /pages/api/check.js
//
// GlassBox backend: scan a Solana mint and return:
// - mint info (supply, decimals, authorities)
// - holder summary with LP detection (excludes LP from top10%)
// - risk score
// - token metadata (name, symbol, logo)
// - price / liquidity from Dexscreener
// - best-effort token age (using DAS getAsset)
//
// Requires: process.env.HELIUS_API_KEY

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function rpc(method, params) {
  if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY is not set");
  }

  const resp = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: method,
      method,
      params,
    }),
  });

  if (!resp.ok) {
    throw new Error(`RPC HTTP error ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();
  if (json.error) {
    throw new Error(json.error.message || "RPC error");
  }
  return json.result;
}

// ---- Mint parsing ----------------------------------------------------------

function parseMintAccount(accountInfo) {
  if (!accountInfo || !accountInfo.value) return null;

  try {
    const dataBase64 = accountInfo.value.data?.[0];
    const buf = Buffer.from(dataBase64, "base64");

    // SPL Mint layout:
    // 0..4   COption<mintAuthority>
    // 4..36  mintAuthority pubkey
    // 36..44 supply u64 LE
    // 44     decimals u8
    // 45     isInitialized u8
    // 46..50 COption<freezeAuthority>
    // 50..82 freezeAuthority pubkey

    const supply = buf.readBigUInt64LE(36);
    const decimals = buf[44];

    const mintAuthOpt = buf.readUInt32LE(0);
    const freezeAuthOpt = buf.readUInt32LE(46);

    const hasMintAuthority = mintAuthOpt !== 0;
    const hasFreezeAuthority = freezeAuthOpt !== 0;

    return {
      supply: supply.toString(),
      decimals,
      hasMintAuthority,
      hasFreezeAuthority,
    };
  } catch (e) {
    console.error("parseMintAccount failed", e);
    return null;
  }
}

// ---- Dexscreener metrics ---------------------------------------------------

async function fetchDexscreenerMetrics(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const resp = await fetch(url);
    if (!resp.ok) return {};

    const json = await resp.json();
    const pairs = json?.pairs || [];
    if (!pairs.length) return {};

    // Choose highest-liquidity pair
    const pair = pairs.reduce((best, p) => {
      if (!best) return p;
      const bestL = best?.liquidity?.usd ?? 0;
      const l = p?.liquidity?.usd ?? 0;
      return l > bestL ? p : best;
    }, null);

    if (!pair) return {};

    const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
    const liquidityUsd = pair?.liquidity?.usd ?? null;
    const globalFeesUsd = null; // not available from Dexscreener

    return { priceUsd, liquidityUsd, globalFeesUsd };
  } catch (e) {
    console.error("Dexscreener fetch failed", e);
    return {};
  }
}

// ---- Token age (best-effort, safe) -----------------------------------------

function deriveTokenAgeFromAsset(asset) {
  try {
    if (!asset) return null;

    const ts =
      asset?.token_info?.created_at ??
      asset?.createdAt ??
      asset?.creationTime ??
      asset?.mutable_metadata?.created_at ??
      null;

    if (!ts) return null;

    const nowSec = Math.floor(Date.now() / 1000);
    const createdSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
    const diffSec = Math.max(0, nowSec - createdSec);
    const days = diffSec / 86400;

    return { ageDays: days };
  } catch {
    return null;
  }
}

// ---- Holder summary + LP detection ----------------------------------------
//
// Strategy:
//  * getTokenLargestAccounts(mint) → top token accounts
//  * getMultipleAccounts(top accounts, jsonParsed) → "owner" field (wallet/PDA)
//  * getMultipleAccounts(owner pubkeys) → check if each owner is System Program
//    vs some AMM program (Raydium, Pump, Orca, etc.)
//  * The largest *program-owned* holder (>=1% of supply) is treated as LP vault
//  * top10Pct excludes that LP vault (ex-LP)

async function buildHolderSummary(mintInfo, largestRes) {
  const summary = {
    top10Pct: null,
    lpAddress: null,
    lpPct: 0,
    topHolders: [],
    totalHoldersSampled: 0,
  };

  const largest = largestRes?.value || [];
  if (!largest.length || !mintInfo?.supply) return summary;

  const supplyBN = BigInt(mintInfo.supply || "0");
  if (supplyBN <= 0n) return summary;

  const SAMPLE = largest.slice(0, 20);
  summary.totalHoldersSampled = SAMPLE.length;

  const tokenAccPubkeys = SAMPLE.map((h) => h.address);

  // 1) Token accounts (jsonParsed) to read data.parsed.info.owner
  let tokenAccInfos = [];
  try {
    const multi = await rpc("getMultipleAccounts", [
      tokenAccPubkeys,
      { encoding: "jsonParsed" },
    ]);
    tokenAccInfos = multi?.value || [];
  } catch (e) {
    console.error("getMultipleAccounts token accounts failed", e);
  }

  const ownerWallets = SAMPLE.map((_, idx) => {
    const acc = tokenAccInfos[idx];
    return acc?.data?.parsed?.info?.owner || null;
  });

  // 2) Fetch owner wallet accounts to see if they are System Program wallets
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const uniqueOwners = [...new Set(ownerWallets.filter(Boolean))];

  const ownerProgramByWallet = {};
  if (uniqueOwners.length) {
    try {
      const ownersMulti = await rpc("getMultipleAccounts", [
        uniqueOwners,
        { encoding: "base64" },
      ]);
      const infos = ownersMulti?.value || [];
      uniqueOwners.forEach((wallet, i) => {
        const acc = infos[i];
        if (acc) {
          ownerProgramByWallet[wallet] = acc.owner;
        }
      });
    } catch (e) {
      console.error("getMultipleAccounts owner wallets failed", e);
    }
  }

  const enriched = SAMPLE.map((entry, idx) => {
    const amountBN = BigInt(entry.amount || "0");
    const pct = Number((amountBN * 10000n) / supplyBN) / 100;

    const ownerWallet = ownerWallets[idx] || null;
    const ownerProgram = ownerWallet ? ownerProgramByWallet[ownerWallet] : null;
    const isProgramOwned =
      ownerProgram && ownerProgram !== SYSTEM_PROGRAM ? true : false;

    return {
      rank: idx + 1,
      address: entry.address,
      pct,
      ownerWallet,
      ownerProgram,
      isProgramOwned,
    };
  });

  // 3) LP candidate = largest program-owned holder with pct >= 1%
  let lp = null;
  for (const h of enriched) {
    if (!h.isProgramOwned) continue;
    if (h.pct < 1) continue;
    if (!lp || h.pct > lp.pct) lp = h;
  }

  if (lp) {
    summary.lpAddress = lp.address;
    summary.lpPct = lp.pct;
  }

  // 4) Top 10 % (ex-LP)
  const holdersForPct = enriched
    .filter((h) => h.address !== summary.lpAddress)
    .slice(0, 10);

  const top10Pct = holdersForPct.reduce(
    (sum, h) => (isFinite(h.pct) ? sum + h.pct : sum),
    0
  );
  summary.top10Pct = top10Pct;

  // 5) Public topHolders list (up to 20, frontend will slice to top 10)
  summary.topHolders = enriched.map((h) => ({
    address: h.address,
    pct: h.pct,
    isLp: summary.lpAddress === h.address,
  }));

  return summary;
}

// ---- Risk & origin ---------------------------------------------------------

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
  let blurb =
    "Some centralization risk from mint controls and holder concentration.";

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

  const desc =
    (asset?.content?.metadata?.description ||
      asset?.token_info?.description ||
      "") + "";

  const lower = desc.toLowerCase();

  let label = "Unknown protocol / origin";
  let detail = "";

  if (lower.includes("pump.fun") || lower.includes("pumpfun")) {
    label = "Likely Pump.fun mint";
    detail =
      "Mint resembles Pump.fun pattern. Always double-check creator + socials.";
  } else if (lower.includes("raydium")) {
    label = "Likely Raydium pool mint";
    detail = "Looks like a Raydium-originated pool. Verify via official links.";
  }

  return { label, detail };
}

// ---- Main handler ----------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const mint = (req.query.mint || "").toString().trim();
  if (!mint) {
    return res
      .status(400)
      .json({ error: "Missing ?mint= (Solana token mint address)." });
  }

  try {
    // Core on-chain + DAS + Dexscreener in parallel
    const [mintAccount, asset, largestRes, dexMetrics] = await Promise.all([
      rpc("getAccountInfo", [mint, { encoding: "base64" }]),
      rpc("getAsset", [mint]).catch(() => null),
      rpc("getTokenLargestAccounts", [mint]),
      fetchDexscreenerMetrics(mint),
    ]);

    const mintInfo = parseMintAccount(mintAccount);
    const holderSummary = await buildHolderSummary(mintInfo, largestRes);
    const riskSummary = buildRiskSummary(mintInfo, holderSummary);
    const originHint = buildOriginHint(asset);
    const tokenAge = deriveTokenAgeFromAsset(asset);

    // Metadata
    const tokenMeta = {
      name:
        asset?.content?.metadata?.name ||
        asset?.token_info?.name ||
        "Unknown Token",
      symbol:
        asset?.content?.metadata?.symbol ||
        asset?.token_info?.symbol ||
        "",
      logoURI:
        asset?.content?.links?.image ||
        asset?.token_info?.image ||
        null,
    };

    const priceFromDas = asset?.token_info?.price_info?.price_per_token;

    const tokenMetrics = {
      priceUsd:
        dexMetrics.priceUsd ??
        (priceFromDas != null ? Number(priceFromDas) : null),
      liquidityUsd: dexMetrics.liquidityUsd ?? null,
      globalFeesUsd: dexMetrics.globalFeesUsd ?? null,
    };

    const response = {
      tokenMeta,
      mintInfo,
      mintAuthority: !!mintInfo?.hasMintAuthority,
      freezeAuthority: !!mintInfo?.hasFreezeAuthority,
      holderSummary,
      originHint,
      riskSummary,
      tokenMetrics,
      tokenAge, // { ageDays } or null
    };

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json(response);
  } catch (e) {
    console.error("check handler error", e);
    return res
      .status(500)
      .json({ error: e.message || "Internal error while scanning mint." });
  }
}
