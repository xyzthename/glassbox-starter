// api/check.js
// Serverless function for Vercel
// Uses Helius RPC to fetch mint info + metadata + top holders.

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

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

    // 2) Fetch Jupiter-style metadata via Helius getAsset
    const assetPromise = rpc("getAsset", [mint]);

    // 3) Fetch largest token accounts (top holders)
    const largestPromise = rpc("getTokenLargestAccounts", [mint]);

    const [accountInfo, asset, largest] = await Promise.all([
      accountInfoPromise,
      assetPromise,
      largestPromise,
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
    } catch (e) {
      // ignore meta failure
    }

    const tokenMeta = { name, symbol, logoURI };

    // Top holders (NOTE: this is ONLY the largest accounts, NOT full holder count)
    const largestAccounts = largest?.value || [];

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

    // full on-chain holder count is NOT available from this RPC alone,
    // so we leave it null instead of lying with "20".
    const holderSummary = {
      totalHolders: null,
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

    // Simple risk model
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

    // Placeholder metrics; with free infra we don't have these yet.
    const tokenMetrics = {
      priceUsd: null,
      liquidityUsd: null,
      globalFeesUsd: null,
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
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
}
