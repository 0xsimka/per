import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionSignature,
  AccountInfo,
  Connection,
  SystemProgram,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintInfo,
  MintLayout,
  u64,
  AccountInfo as TokenAccountInfo,
  AccountLayout,
} from "@solana/spl-token";
import BN from "bn.js";
import { Env } from "./types";
import { constructAndSendVersionedTransaction } from "./utils";
import { KaminoMarket } from "@kamino-finance/klend-sdk";
import {
  KaminoReserve,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@kamino-finance/klend-sdk";

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

export async function getAssociatedTokenAdressesForRewards(
  collCtokenMint: PublicKey,
  collLiquidityMint: PublicKey,
  debtLiquidityMint: PublicKey,
  payer: PublicKey
) {
  const collCtokenAta = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    collCtokenMint,
    payer
  );

  const collTokenAta = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    collLiquidityMint,
    payer
  );

  const debtTokenAta = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    debtLiquidityMint,
    payer
  );

  return [collCtokenAta, collTokenAta, debtTokenAta];
}

export async function createCollTokenAtaAndCTokenAtaAccounts(
  c: Connection,
  payer: Keypair,
  collReserve: KaminoReserve,
  tokenAta: PublicKey,
  cTokenAta: PublicKey
) {
  const ixs: TransactionInstruction[] = [];
  const cTokenAtaAccountInfo = await c.getAccountInfo(cTokenAta);

  if (!cTokenAtaAccountInfo) {
    const [, createcTokenAccountIx] =
      await createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        collReserve.state.collateral.mintPubkey,
        payer.publicKey,
        cTokenAta
      );
    ixs.push(createcTokenAccountIx);
  } else {
    const cTokenAtaBalance = await c.getTokenAccountBalance(cTokenAta);
    console.debug(
      `cTokenAtaBalance before: ${cTokenAtaBalance.value.uiAmountString}`
    );
  }

  const tokenAtaAccountInfo = await c.getAccountInfo(tokenAta);
  if (!tokenAtaAccountInfo) {
    const [, createTokenAccountIx] =
      await createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        collReserve.getLiquidityMint(),
        payer.publicKey,
        tokenAta
      );
    ixs.push(createTokenAccountIx);
  } else {
    const collTokenAtaBalance = await c.getTokenAccountBalance(tokenAta);
    console.debug(
      `collTokenAtaBalance before: ${collTokenAtaBalance.value.uiAmountString}`
    );
  }

  return ixs;
}

export function deserializeTokenAccount(
  address: PublicKey,
  data: Buffer
): TokenAccountInfo {
  const accountInfo = AccountLayout.decode(data);
  accountInfo.address = address;
  accountInfo.mint = new PublicKey(accountInfo.mint);
  accountInfo.owner = new PublicKey(accountInfo.owner);
  accountInfo.amount = u64.fromBuffer(accountInfo.amount);

  if (accountInfo.delegateOption === 0) {
    accountInfo.delegate = null;
    // eslint-disable-next-line new-cap
    accountInfo.delegatedAmount = new u64(0);
  } else {
    accountInfo.delegate = new PublicKey(accountInfo.delegate);
    accountInfo.delegatedAmount = u64.fromBuffer(accountInfo.delegatedAmount);
  }

  accountInfo.isInitialized = accountInfo.state !== 0;
  accountInfo.isFrozen = accountInfo.state === 2;

  if (accountInfo.isNativeOption === 1) {
    accountInfo.rentExemptReserve = u64.fromBuffer(accountInfo.isNative);
    accountInfo.isNative = true;
  } else {
    accountInfo.rentExemptReserve = null;
    accountInfo.isNative = false;
  }

  if (accountInfo.closeAuthorityOption === 0) {
    accountInfo.closeAuthority = null;
  } else {
    accountInfo.closeAuthority = new PublicKey(accountInfo.closeAuthority);
  }

  return accountInfo;
}

export async function createTokenAccountInstructions(
  connection: Connection,
  newAccountPubkey: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  lamports?: number
): Promise<TransactionInstruction[]> {
  let rent = lamports;
  if (rent === undefined) {
    rent = await connection.getMinimumBalanceForRentExemption(165);
  }
  return [
    SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey,
      space: 165,
      lamports: rent,
      programId: TOKEN_PROGRAM_ID,
    }),
    Token.createInitAccountInstruction(
      TOKEN_PROGRAM_ID,
      mint,
      newAccountPubkey,
      owner
    ),
  ];
}
