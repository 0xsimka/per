import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionSignature,
  AccountInfo,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintInfo,
  MintLayout,
  u64,
} from "@solana/spl-token";
import BN from "bn.js";
import { Env } from "./types";
import { constructAndSendVersionedTransaction } from "./utils";
import { KaminoMarket } from "@kamino-finance/klend-sdk";

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

export type KeyedMintInfo = MintInfo & { address: PublicKey };

export enum WrappedTokenType {
  KAMINO_LP_TOKEN = "KAMINO_LP_TOKEN",
  JLP_TOKEN = "JLP_TOKEN",
}

export type LiquidityMintInfo = KeyedMintInfo & {
  wrappedTokenType?: WrappedTokenType;
};

export async function getReserveLiquidityMints(
  kaminoMarket: KaminoMarket
): Promise<LiquidityMintInfo[]> {
  const mintPubkeys = new Array<PublicKey>();
  for (const reserve of kaminoMarket.reserves.values()) {
    mintPubkeys.push(reserve.getLiquidityMint());
  }
  const accInfos = await kaminoMarket
    .getConnection()
    .getMultipleAccountsInfo(mintPubkeys);
  const keyedResults: { address: PublicKey; accInfo: AccountInfo<Buffer> }[] =
    [];
  for (let i = 0; i < mintPubkeys.length; i++) {
    if (accInfos[i] !== null) {
      keyedResults.push({
        address: mintPubkeys[i],
        accInfo: accInfos[i]!,
      });
    }
  }
  return keyedResults
    .map(({ address, accInfo }) => ({
      address,
      ...deserializeMint(accInfo.data),
    }))
    .map(
      (mintInfo) =>
        ({
          ...mintInfo,
          wrappedTokenType: getWrappedTokenType(mintInfo),
        } as LiquidityMintInfo)
    );
}

function getWrappedTokenType(
  mintInfo: KeyedMintInfo
): WrappedTokenType | undefined {
  // if (isKToken(mintInfo)) {
  //   return WrappedTokenType.KAMINO_LP_TOKEN;
  // }
  // if (isJlpMint(mintInfo.address)) {
  //   return WrappedTokenType.JLP_TOKEN;
  // }
  return undefined;
}

function deserializeMint(data: Buffer): MintInfo {
  if (data.length !== MintLayout.span) {
    throw new Error("Not a valid Mint");
  }

  const mintInfo = MintLayout.decode(data);

  if (mintInfo.mintAuthorityOption === 0) {
    mintInfo.mintAuthority = null;
  } else {
    mintInfo.mintAuthority = new PublicKey(mintInfo.mintAuthority);
  }

  mintInfo.supply = u64.fromBuffer(mintInfo.supply);
  mintInfo.isInitialized = mintInfo.isInitialized !== 0;

  if (mintInfo.freezeAuthorityOption === 0) {
    mintInfo.freezeAuthority = null;
  } else {
    mintInfo.freezeAuthority = new PublicKey(mintInfo.freezeAuthority);
  }

  return mintInfo;
}

export async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = true,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer()))
    throw new Error("Token owner off curve");

  return Token.getAssociatedTokenAddress(
    associatedTokenProgramId,
    programId,
    mint,
    owner,
    allowOwnerOffCurve
  );
}
