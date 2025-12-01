import bs58 from "bs58";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdGq8cYk6TKfNfGKEbDU9zG6GbdsuUuWg2u7W";

const BURN_ADDRESSES = [
  "11111111111111111111111111111111",
  "Burn111111111111111111111111111111111111111",
  "DeaD111111111111111111111111111111111111111",
];

function readU32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readU64LE(bytes, offset) {
  const lo = BigInt(readU32(bytes, offset));
  const hi = BigInt(readU32(bytes, offset + 4));
  return lo + (hi << 32n);
}

// Format a big supply into a human-readable string, e.g. 1_000_000_000 -> "1.00B"
function formatSupplyHuman(supplyBig, decimals) {
  try {
    if (typeof decimals !== "number" || decimals < 0 || decimals > 18) {
      return supplyBig.toString();
    }
    const factor = 10n ** BigInt(decimals);
    const whole = supplyBig / factor;
    const fraction = supplyBig % factor;

    // Build a decimal string with up to 3 fractional digits
    let fracStr = fraction.toString().padStart(decimals, "0");
    fracStr = fracStr.replace(/0+$/, ""); // trim trailing zeros
    if (fracStr.length > 3) fracStr = fracStr.slice(0, 3).replace(/0+$/, "");
    const baseStr =
      fracStr && fracStr.length > 0
        ? `${whole.toString()}.${fracStr}`
        : whole.toString();

    // Abbreviate (K, M, B, T) using the whole part
    const wholeNum = Number(whole);
    if (!Number.isFinite(wholeNum)) {
      return baseStr;
    }
    const abs = Math.abs(wholeNum);
    let suffix = "";
    let value = wholeNum;

    if (abs >= 1_000_000_000_000) {
      suffix = "T";
      value = wholeNum / 1_000_000_000_000;
    } else if (abs >= 1_000_000_000) {
      suffix = "B";
      value = wholeNum / 1_000_000_000;
    } else if (abs >= 1_000_000) {
      suffix = "M";
      value = wholeNum / 1_000_000;
    } else if (abs >= 1_000) {
      suffix = "K";
      value = wholeNum / 1_000;
    } else {
      // no abbreviation
      return baseStr;
    }

    return `${value.toFixed(2)}${suffix}`;
  } catch (e) {
    console.error("formatSupplyHuman error:", e);
    return supplyBig.toString();
  }
}

// Fetch token metadata (name, symbol, image) using Helius getAsset
async function fetchMetadata(rpcUrl, mintAddress) {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: mintAddress },
      }),
    });

    const meta = await response.json();
    const asset = meta?.result;
    if (!asset) return null;

    return {
      name: asset.content?.metadata?.name || null,
      symbol: asset.content?.metadata?.symbol || null,
      image: asset.content?.links?.image || null,
    };
  } catch (err) {
    console.error("Metadata fetch failed:", err);
    return null;
  }
}

// Fetch price in USD from Jupiter Price API (no key required)
async function fetchJupiterPrice(mintAddress) {
  try {
    const url = `https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(
      mintAddress
    )}`;
    const res = await fetch(url);
    const json = await res.json();
    const info = json[mintAddress];
    if (!info || typeof info.usdPrice !== "number") return null;

    return {
      usdPrice: info.usdPrice,
      priceChange24h:
        typeof info.priceChange24h === "number" ? info.priceChange24h : null,
    };
  } catch (err) {
    console.error("Price fetch failed:", err);
    return null;
  }
}

export default async function handler(req, res) {
  const { mint } = req.query;

  if (!mint || typeof mint !== "string") {
    return res.status(400).json({ ok: false, message: "Missing ?mint= address" });
  }

  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) {
    return res.status(500).json({
      ok: false,
      message: "Missing Helius API key on server.",
    });
  }

  const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

  async function rpc(method, params) {
    const raw = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    const json = await raw.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  try {
    // 1. Load account
    const accountInfo = await rpc("getAccountInfo", [
      mint,
      { encoding: "jsonParsed" },
    ]);

    if (!accountInfo || !accountInfo.value) {
      return res.status(200).json({
        ok: false,
        message: "No account at that address.",
      });
    }

    const acc = accountInfo.value;
    const parsedType = acc.data?.parsed?.type;
    const parsedInfo = acc.data?.parsed?.info;
    let mintAddress = mint;

    if (parsedType === "account") {
      // user pasted a token account; hop to its mint
      mintAddress = parsedInfo.mint;
    }

    // 2. Get raw mint data
    const mintAccount = await rpc("getAccountInfo", [
      mintAddress,
      { encoding: "base64" },
    ]);

    const [base64Data] = mintAccount.value.data;
    const raw = Buffer.from(base64Data, "base64");

    let offset = 0;

    const mintAuthorityOption = readU32(raw, offset);
    offset += 4;

    let mintAuthority = null;
    if (mintAuthorityOption === 1) {
      mintAuthority = bs58.encode(raw.subarray(offset, offset + 32));
    }
    offset += 32;

    const supplyBig = readU64LE(raw, offset);
    offset += 8;

    const decimals = raw[offset++];
    const isInitialized = raw[offset++] === 1;

    const freezeAuthorityOption = readU32(raw, offset);
    offset += 4;

    let freezeAuthority = null;
    if (freezeAuthorityOption === 1) {
      freezeAuthority = bs58.encode(raw.subarray(offset, offset + 32));
    }

    let riskMint = mintAuthorityOption === 0 ? "LOW" : "HIGH";

    // 3. Holder snapshot (top holders)
    let holders = null;
    try {
      const largest = await rpc("getTokenLargestAccounts", [mintAddress]);
      const list = largest?.value || [];

      const top = [];
      let top1 = 0;
      let top10 = 0;

      if (list.length > 0) {
        for (let i = 0; i < list.length && i < 10; i++) {
          const ent = list[i];
          const pct =
            Number((BigInt(ent.amount) * 10000n) / (supplyBig || 1n)) / 100;

          top.push({
            rank: i + 1,
            address: ent.address,
            percent: pct,
          });

          if (i === 0) top1 = pct;
          top10 += pct;
        }
      }

      holders = { top, top1, top10 };
    } catch (e) {
      console.error("Holder snapshot failed:", e);
      holders = null;
    }

    // 4. Token metadata (name, symbol, image)
    const metadata = await fetchMetadata(RPC_URL, mintAddress);

    // 5. Price (USD) from Jupiter Price API
    const price = await fetchJupiterPrice(mintAddress);

    // 6. Human-readable supply
    const uiSupplyFormatted = formatSupplyHuman(supplyBig, decimals);

    // NOTE: Liquidity + global fees are set to null for now; they require
    // an external analytics provider (Birdeye / Bitquery / custom indexer).
    const liquidity = null;
    const feesGlobal = null;

    return res.status(200).json({
      ok: true,
      mint: mintAddress,
      decimals,
      supply: supplyBig.toString(),
      uiSupplyFormatted,
      isInitialized,
      riskMint,
      mintAuthorityOption,
      mintAuthority,
      freezeAuthorityOption,
      freezeAuthority,
      holders,
      metadata,
      price,
      liquidity,
      feesGlobal,
    });
  } catch (err) {
    console.error("Backend error:", err);
    return res.status(500).json({
      ok: false,
      message: "Backend RPC error.",
    });
  }
}
