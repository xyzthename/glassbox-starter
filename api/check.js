export default async function handler(req, res) {
  const { mint } = req.query;

  if (!mint || typeof mint !== "string") {
    return res
      .status(400)
      .json({ ok: false, message: "Missing ?mint= address in query." });
  }

  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) {
    return res.status(500).json({
      ok: false,
      message: "Server missing Helius API key. Set H E L I U S _ A P I _ K E Y in Vercel.",
    });
  }

  const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

  async function rpc(method, params) {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message || "RPC error");
    return json.result;
  }

  try {
    // 1️⃣ First call: see what the account is
    const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);

    if (!info || !info.value) {
      return res.status(200).json({
        ok: false,
        message: "No account found at that address. Is this really a mint?",
      });
    }

    const value = info.value;
    const owner = value.owner;
    const parsed = value.data?.parsed;
    const pType = parsed?.type || null;
    const pInfo = parsed?.info || {};

    const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const TOKEN_2022_PROGRAM = "TokenzQdGq8cYk6TKfNfGKEbDU9zG6GbdsuUuWg2u7W";

    let mintAddress = mint;

    // If they pasted a token account, hop to its mint
    if (pType === "account" && pInfo.mint) {
      mintAddress = pInfo.mint;
    } else if (
      owner !== TOKEN_PROGRAM &&
      owner !== TOKEN_2022_PROGRAM &&
      pType !== "mint"
    ) {
      return res.status(200).json({
        ok: false,
        message:
          "That address is a valid Solana account, but not an SPL token mint or token account.",
      });
    }

    // 2️⃣ Ensure we have the mint account itself
    const mintInfo =
      pType === "mint" && mintAddress === mint
        ? info
        : await rpc("getAccountInfo", [
            mintAddress,
            { encoding: "jsonParsed" },
          ]);

    if (!mintInfo || !mintInfo.value) {
      return res.status(200).json({
        ok: false,
        message: "Could not load the mint account for that token.",
      });
    }

    const mintParsed = mintInfo.value.data?.parsed;
    const mintParsedInfo = mintParsed?.info || {};
    const mintType = mintParsed?.type || null;

    if (mintType !== "mint") {
      return res.status(200).json({
        ok: false,
        message:
          "Account exists, but does not look like a standard SPL mint in parsed form.",
      });
    }

    const mintAuthorityOption = mintParsedInfo.mintAuthorityOption;
    const mintAuthority = mintParsedInfo.mintAuthority || null;

    let risk = "UNKNOWN";
    if (mintAuthorityOption === 0) risk = "LOW";
    else if (mintAuthorityOption === 1) risk = "HIGH";

    return res.status(200).json({
      ok: true,
      mint: mintAddress,
      risk,
      mintAuthorityOption,
      mintAuthority,
    });
  } catch (e) {
    console.error("Glassbox /api/check error:", e);
    return res.status(500).json({
      ok: false,
      message: "Backend error talking to Solana RPC. Try again.",
    });
  }
}
