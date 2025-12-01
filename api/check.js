import bs58 from "bs58";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdGq8cYk6TKfNfGKEbDU9zG6GbdsuUuWg2u7W";

// Very common burn-style addresses (heuristic)
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
      message:
        "Missing Helius API key on server. Set HELIUS_API_KEY in your Vercel env.",
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
    if (json.error) throw new Error(json.error.message || "RPC error");
    return json.result;
  }

  try {
    // 1️⃣ Figure out if user pasted a mint or a token account
    const accountInfo = await rpc("getAccountInfo", [
      mint,
      { encoding: "jsonParsed" },
    ]);

    if (!accountInfo || !accountInfo.value) {
      return res.status(200).json({
        ok: false,
        message:
          "No account found at that address. Make sure you pasted a token mint or token account.",
      });
    }

    const acc = accountInfo.value;
    const owner = acc.owner;
    const parsed = acc.data?.parsed;
    const parsedType = parsed?.type || null;
    const parsedInfo = parsed?.info || {};

    let mintAddress = mint;

    // If it's a token ACCOUNT, hop to its mint
    if (parsedType === "account" && parsedInfo.mint) {
      mintAddress = parsedInfo.mint;
    } else if (
      owner !== TOKEN_PROGRAM &&
      owner !== TOKEN_2022_PROGRAM &&
      parsedType !== "mint"
    ) {
      return res.status(200).json({
        ok: false,
        message:
          "That address is a valid Solana account, but not an SPL token mint or token account.",
      });
    }

    // 2️⃣ Get mint account as raw bytes for reliable decoding
    const mintInfo = await rpc("getAccountInfo", [
      mintAddress,
      { encoding: "base64" },
    ]);

    if (!mintInfo || !mintInfo.value) {
      return res.status(200).json({
        ok: false,
        message: "Could not load the mint account for that token.",
      });
    }

    const [base64Data] = mintInfo.value.data;
    const raw = Buffer.from(base64Data, "base64");

    // SPL Mint layout (see: https://spl.solana.com/token#token-mint)
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

    const decimals = raw[offset];
    offset += 1;

    const isInitialized = raw[offset] === 1;
    offset += 1;

    const freezeAuthorityOption = readU32(raw, offset);
    offset += 4;

    let freezeAuthority = null;
    if (freezeAuthorityOption === 1) {
      freezeAuthority = bs58.encode(raw.subarray(offset, offset + 32));
    }

    let riskMint = "UNKNOWN";
    if (mintAuthorityOption === 0) riskMint = "LOW";
    else if (mintAuthorityOption === 1) riskMint = "HIGH";

    // 3️⃣ Holder snapshot via getTokenLargestAccounts
    let holders = null;
    try {
      const largest = await rpc("getTokenLargestAccounts", [mintAddress]);
      const list = largest?.value || [];

      const top = [];
      let top1Percent = 0;
      let top10Percent = 0;
      let burnInfo = {
        hasBurn: false,
        burnedPercent: 0,
        burnedAddress: null,
      };

      if (supply > 0n && list.length > 0) {
        const total = supply;

        for (let i = 0; i < list.length && i < 10; i++) {
          const item = list[i];
          const amountRaw = BigInt(item.amount);
          const percent =
            Number((amountRaw * 10000n) / (total === 0n ? 1n : total)) / 100;

          const entry = {
            rank: i + 1,
            address: item.address,
            amount: item.amount,
            uiAmount: item.uiAmount,
            percent,
          };
          top.push(entry);

          if (i === 0) top1Percent = percent;
          top10Percent += percent;

          if (BURN_ADDRESSES.includes(item.address)) {
            burnInfo.hasBurn = true;
            burnInfo.burnedPercent += percent;
            burnInfo.burnedAddress = item.address;
          }
        }
      }

      holders = {
        top,
        top1Percent,
        top10Percent,
        burnInfo,
      };
    } catch (e) {
      console.error("getTokenLargestAccounts failed:", e);
      holders = null;
    }

    // 4️⃣ Pump.fun detection placeholder (safe stub, no broken calls)
    const pumpfun = {
      isPumpfun: false,
      reason: "Pump.fun origin detection coming soon.",
    };

    return res.status(200).json({
      ok: true,
      mint: mintAddress,
      riskMint,
      mintAuthorityOption,
      mintAuthority,
      freezeAuthorityOption,
      freezeAuthority,
      supply: supply.toString(),
      decimals,
      isInitialized,
      holders,
      pumpfun,
    });
  } catch (err) {
    console.error("Glassbox /api/check error:", err);
    return res.status(500).json({
      ok: false,
      message: "Backend error talking to Solana RPC. Try again.",
    });
  }
}
