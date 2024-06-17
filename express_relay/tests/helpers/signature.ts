import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { sign } from "@noble/ed25519";
import * as crypto from "crypto";

export async function createSignature(
  protocol: PublicKey,
  permissionId: Uint8Array,
  searcher: Keypair,
  bidAmount: anchor.BN,
  validUntil: anchor.BN,
  opportunityAdapterArgsWithMints?: {
    sellTokens: {
      mint: PublicKey;
      amount: anchor.BN;
    }[];
    buyTokens: {
      mint: PublicKey;
      amount: anchor.BN;
    }[];
  }
): Promise<[Uint8Array, Buffer]> {
  const msgExpressRelay1 = Uint8Array.from(protocol.toBuffer());
  const msgExpressRelay2 = Uint8Array.from(permissionId);
  const msgExpressRelay3 = Uint8Array.from(searcher.publicKey.toBuffer());
  const msgExpressRelay4 = Uint8Array.from(
    bidAmount.toArrayLike(Buffer, "le", 8)
  );
  const msgExpressRelay5 = Uint8Array.from(
    validUntil.toArrayLike(Buffer, "le", 8)
  );

  let msgExpressRelay;
  if (opportunityAdapterArgsWithMints === undefined) {
    msgExpressRelay = Buffer.concat([
      msgExpressRelay1,
      msgExpressRelay2,
      msgExpressRelay3,
      msgExpressRelay4,
      msgExpressRelay5,
    ]);
  } else {
    let msgOpportunityAdapter1 = new Uint8Array(2);
    let buyTokens = opportunityAdapterArgsWithMints.buyTokens;
    let sellTokens = opportunityAdapterArgsWithMints.sellTokens;
    msgOpportunityAdapter1[0] = buyTokens.length;
    msgOpportunityAdapter1[1] = sellTokens.length;
    let msgOpportunityAdapter2 = new Uint8Array(40 * buyTokens.length);
    for (let i = 0; i < buyTokens.length; i++) {
      msgOpportunityAdapter2.set(buyTokens[i].mint.toBuffer(), i * 40);
      msgOpportunityAdapter2.set(buyTokens[i].amount.toBuffer(), i * 40 + 32);
    }
    let msgOpportunityAdapter3 = new Uint8Array(40 * sellTokens.length);
    for (let i = 0; i < sellTokens.length; i++) {
      msgOpportunityAdapter3.set(sellTokens[i].mint.toBuffer(), i * 40);
      msgOpportunityAdapter3.set(sellTokens[i].amount.toBuffer(), i * 40 + 32);
    }

    msgExpressRelay = Buffer.concat([
      msgExpressRelay1,
      msgExpressRelay2,
      msgExpressRelay3,
      msgExpressRelay4,
      msgExpressRelay5,
      msgOpportunityAdapter1,
      msgOpportunityAdapter2,
      msgOpportunityAdapter3,
    ]);
  }

  const digestExpressRelay = Buffer.from(
    await crypto.subtle.digest("SHA-256", msgExpressRelay)
  );

  const signatureExpressRelay = await sign(
    digestExpressRelay,
    searcher.secretKey.slice(0, 32)
  );

  return [signatureExpressRelay, digestExpressRelay];
}
