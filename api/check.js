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
  const ASSET_URL = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

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

  // Fetch token metadata using Helius "getAsset"
  async function fetchMetadata(mintAddress) {
    try {
      const response = await fetch(ASSET_URL, {
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

    const supply = readU64LE(raw, offset);
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

    // 3. Holder snapshot
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
            Number((BigInt(ent.amount) * 10000n) / (supply || 1n)) / 100;

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
      holders = null;
    }

    // 4. Token metadata
    const metadata = await fetchMetadata(mintAddress);

    return res.status(200).json({
      ok: true,
      mint: mintAddress,
      decimals,
      supply: supply.toString(),
      isInitialized,
      riskMint,
      mintAuthorityOption,
      mintAuthority,
      freezeAuthorityOption,
      freezeAuthority,
      holders,
      metadata,
    });
  } catch (err) {
    console.error("Backend error:", err);
    return res.status(500).json({
      ok: false,
      message: "Backend RPC error.",
    });
  }
}
