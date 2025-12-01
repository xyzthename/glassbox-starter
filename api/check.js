import bs58 from "bs58";

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
    // 1️⃣ Get mint account as raw bytes
    const mintInfo = await rpc("getAccountInfo", [mint, { encoding: "base64" }]);

    if (!mintInfo || !mintInfo.value) {
      return res.status(200).json({
        ok: false,
        message: "Mint not found — this is not a valid Solana token mint.",
      });
    }

    const [base64Data] = mintInfo.value.data;

    // Convert base64 → raw bytes
    const rawBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

    // 2️⃣ SPL Mint Layout Reference:
    // https://spl.solana.com/token#token-mint

    // mintAuthorityOption = rawBytes[0]
    const mintAuthorityOption = rawBytes[0];

    // mintAuthority = bytes 4..36 (32 bytes)
    const mintAuthorityBytes = rawBytes.slice(4, 36);
    const mintAuthority = bs58.encode(mintAuthorityBytes);

    // If mint authority option is 0 → NO mint authority
    if (mintAuthorityOption === 0) {
      return res.status(200).json({
        ok: true,
        mint,
        risk: "LOW",
        mintAuthority: null,
        mintAuthorityOption,
      });
    }

    // If mint authority exists
    return res.status(200).json({
      ok: true,
      mint,
      risk: "HIGH",
      mintAuthority,
      mintAuthorityOption,
    });

  } catch (err) {
    console.error("Error reading mint:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error while decoding mint authority.",
    });
  }
}
