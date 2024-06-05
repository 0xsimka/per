import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionSignature,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { Env } from "./types";
import { constructAndSendVersionedTransaction } from "./utils";

export async function createMint(
  env: Env,
  authority: PublicKey = env.admin.publicKey,
  decimals: number = 6
): Promise<PublicKey> {
  const mint = anchor.web3.Keypair.generate();
  return createMintFromKeypair(env, mint, authority, decimals);
}

export async function createMintFromKeypair(
  env: Env,
  mint: Keypair,
  authority: PublicKey,
  decimals: number = 6
): Promise<PublicKey> {
  const instructions = await createMintInstructions(
    env,
    mint.publicKey,
    authority,
    decimals
  );

  const tx = new anchor.web3.Transaction();
  tx.add(...instructions);

  await constructAndSendVersionedTransaction(env, tx, [mint]);
  return mint.publicKey;
}

async function createMintInstructions(
  env: Env,
  mint: PublicKey,
  authority: PublicKey,
  decimals: number
): Promise<TransactionInstruction[]> {
  return [
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: env.wallet.publicKey,
      newAccountPubkey: mint,
      space: 82,
      lamports: await env.provider.connection.getMinimumBalanceForRentExemption(
        82
      ),
      programId: TOKEN_PROGRAM_ID,
    }),
    Token.createInitMintInstruction(
      TOKEN_PROGRAM_ID,
      mint,
      decimals,
      authority,
      null
    ),
  ];
}

export async function getMintDecimals(
  env: Env,
  mint: PublicKey
): Promise<number> {
  return (
    await new Token(
      env.provider.connection,
      mint,
      TOKEN_PROGRAM_ID,
      env.admin
    ).getMintInfo()
  ).decimals;
}

export async function mintTo(
  env: Env,
  mint: PublicKey,
  recipient: PublicKey,
  amount: string,
  authority: Keypair = env.admin,
  createAtaIxns: TransactionInstruction[] = []
): Promise<TransactionSignature> {
  const instructions = await mintToInstructions(
    env,
    mint,
    recipient,
    amount,
    authority.publicKey
  );

  const tx = new anchor.web3.Transaction();
  tx.add(...createAtaIxns, ...instructions);

  const sig = await constructAndSendVersionedTransaction(env, tx, [authority]);

  return sig;
}

async function mintToInstructions(
  env: Env,
  mint: PublicKey,
  recipient: PublicKey,
  amount: string,
  authority: PublicKey = env.admin.publicKey
): Promise<TransactionInstruction[]> {
  return [
    Token.createMintToInstruction(
      TOKEN_PROGRAM_ID,
      mint,
      recipient,
      authority,
      [],
      new BN(amount).toNumber()
    ),
  ];
}
