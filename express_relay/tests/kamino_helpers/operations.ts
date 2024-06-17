import {
  AddressLookupTableAccount,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { associatedAddress } from "@coral-xyz/anchor/dist/cjs/utils/token";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  initLendingMarket,
  InitLendingMarketAccounts,
  InitLendingMarketArgs,
  initReserve,
  InitReserveAccounts,
  KaminoAction,
  KaminoMarket,
  KaminoReserve,
  LendingMarket,
  lendingMarketAuthPda,
  PROGRAM_ID,
  Reserve,
  reservePdas,
  sendAndConfirmVersionedTransaction,
  updateEntireReserveConfig,
  UpdateEntireReserveConfigAccounts,
  UpdateEntireReserveConfigArgs,
  updateLendingMarket,
  UpdateLendingMarketAccounts,
  UpdateLendingMarketArgs,
  VanillaObligation,
  WRAPPED_SOL_MINT,
} from "@kamino-finance/klend-sdk";
import * as klendIx from "@kamino-finance/klend-sdk/dist/idl_codegen/instructions";
import {
  ReserveConfig,
  UpdateLendingMarketMode,
} from "@kamino-finance/klend-sdk/dist/idl_codegen/types";
import { Kamino, StrategyWithAddress } from "@hubbleprotocol/kamino-sdk";
import Decimal from "decimal.js";
import { Scope } from "@hubbleprotocol/scope-sdk";
import { BN } from "bn.js";
import { ConfigArgs, Env } from "./types";
import {
  makeConfig,
  constructAndSendVersionedTransaction,
  sendTransactionFromAction,
  sleep,
  getOracleConfigs,
} from "./utils";
// import { ConfigArgs, Env, getOracleConfigs, logGreen, makeConfig } from './utils';
import { createMint, mintTo } from "./token";
import { getPriceAcc, Price, PriceFeed } from "./price";
// import {
//     crankStrategyScopePrices,
//     createDexPool,
//     createKaminoStrategy,
//     getStrategyByKTokenMint,
//     openPosition,
// } from './kamino/kamino-operations';
// import { getKTokenSymbols, isKToken } from './kamino/utils';
// import { createAddExtraComputeUnitsTransaction } from '../../src/libs/computeBudget';
// import {
//     getLookupTableAccountsFromKeys,
//     sendAndConfirmTransactionV0,
//     sendTransactionFromAction,
// } from '../../src/libs/utils/instruction';
// import { checkIfAccountExists, fromLamports, sleep, WRAPPED_SOL_MINT } from '../../src/libs/utils';
// import { addKTokenScopePriceMapping, addScopePriceMapping, crankAndFetchScopePrice } from './kamino/scope';
// import { isJlp } from './jup-perps/utils';
// import { addCustody, addLiquidityIx, createJupPerpPool, fetchPool } from './jup-perps/jup-perps-operations';

const VALUE_BYTE_MAX_ARRAY_LEN_MARKET_UPDATE = 72;

export async function createMarket(
  env: Env
): Promise<[TransactionSignature, Keypair]> {
  const args: InitLendingMarketArgs = {
    quoteCurrency: Array(32).fill(0),
  };

  const marketAccount = Keypair.generate();
  const size = LendingMarket.layout.span + 8;
  const [lendingMarketAuthority] = lendingMarketAuthPda(
    marketAccount.publicKey
  );
  const createMarketIx = SystemProgram.createAccount({
    fromPubkey: env.admin.publicKey,
    newAccountPubkey: marketAccount.publicKey,
    lamports: await env.provider.connection.getMinimumBalanceForRentExemption(
      size
    ),
    space: size,
    programId: env.programId,
  });

  const accounts: InitLendingMarketAccounts = {
    lendingMarketOwner: env.admin.publicKey,
    lendingMarket: marketAccount.publicKey,
    lendingMarketAuthority,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };

  const ix = initLendingMarket(args, accounts); // env.programId
  const updateMarketConfig = updateMarketConfigIx(
    env,
    marketAccount.publicKey,
    UpdateLendingMarketMode.UpdateAutodeleverageEnabled.discriminator,
    1
  );

  const tx = new Transaction();
  tx.add(createMarketIx);
  tx.add(ix);
  tx.add(updateMarketConfig);

  const signatureCreateMarket = await constructAndSendVersionedTransaction(
    env,
    tx,
    [marketAccount]
  );

  return [signatureCreateMarket, marketAccount];
}

export function updateMarketConfigIx(
  env: Env,
  market: PublicKey,
  mode: number,
  value: number
): TransactionInstruction {
  const buffer = Buffer.alloc(VALUE_BYTE_MAX_ARRAY_LEN_MARKET_UPDATE);
  buffer.writeUInt16LE(value, 0);

  const args: UpdateLendingMarketArgs = {
    mode: new BN(mode),
    value: [...buffer],
  };

  const accounts: UpdateLendingMarketAccounts = {
    lendingMarketOwner: env.admin.publicKey,
    lendingMarket: market,
  };

  return updateLendingMarket(args, accounts); // env.programId
}

export async function createMintAndReserve(
  env: Env,
  kaminoMarket: KaminoMarket,
  kamino: Kamino,
  symbol: string,
  initialSupplyLamports: number,
  initialDepositor: Keypair,
  mintAuthority: Keypair,
  decimals: number,
  prices: Record<string, Price>,
  extraConfigArgs?: ConfigArgs
): Promise<[PublicKey, PublicKey, ReserveConfig]> {
  let mint: PublicKey;
  let priceFeed: PriceFeed;
  // if (isJlp(symbol)) {
  //   mint = await createJlpPool(env, kaminoMarket, prices);
  //   priceFeed = getPriceAcc(prices[symbol]);
  //   if (initialSupplyLamports > 0) {
  //     await mintJlpToUser(env, initialDepositor, mintAuthority);
  //   }
  // } else if (isKToken(symbol)) {
  //   await kaminoMarket.reload();
  //   const strategy = await createKTokenStrategy(env, kamino, kaminoMarket, symbol, prices);
  //   const scope = new Scope('localnet', env.provider.connection);
  //   priceFeed = await addKTokenScopePriceMapping(env, scope, symbol, strategy);
  //   mint = strategy.strategy.sharesMint;
  //   if (initialSupplyLamports > 0) {
  //     await mintKTokenToUser(env, kamino, initialDepositor, mintAuthority, strategy.strategy.sharesMint);
  //   }
  //   await crankStrategyScopePrices(env, kamino, scope, strategy, symbol);
  // } else {
  priceFeed = getPriceAcc(prices[symbol]);
  if (symbol === "SOL") {
    mint = WRAPPED_SOL_MINT;
  } else {
    mint = await createMint(env, mintAuthority.publicKey, decimals);
  }
  if (initialSupplyLamports > 0) {
    await mintToUser(
      env,
      mint,
      initialDepositor.publicKey,
      initialSupplyLamports,
      mintAuthority,
      false
    );
  }
  // }

  const [reserve, config] = await createReserveWithConfig(
    env,
    kaminoMarket,
    symbol,
    mint,
    initialSupplyLamports,
    initialDepositor,
    priceFeed,
    extraConfigArgs
  );

  return [mint, reserve, config];
}

export async function createReserveWithConfig(
  env: Env,
  kaminoMarket: KaminoMarket,
  symbol: string,
  mint: PublicKey,
  initialSupplyLamports: number,
  initialDepositor: Keypair,
  priceFeed: PriceFeed,
  extraConfigArgs?: ConfigArgs
): Promise<[PublicKey, ReserveConfig]> {
  const [, reserve] = await createReserve(env, kaminoMarket.getAddress(), mint);
  const config = makeConfig(symbol, priceFeed, extraConfigArgs);

  await updateReserve(env, reserve.publicKey, config);
  await reloadMarket(env, kaminoMarket);

  if (initialSupplyLamports > 0) {
    const depositAction = await KaminoAction.buildDepositReserveLiquidityTxns(
      kaminoMarket!,
      initialSupplyLamports.toString(),
      mint,
      initialDepositor.publicKey,
      new VanillaObligation(PROGRAM_ID),
      1_000_000,
      true
    );
    await sendTransactionFromAction(
      env,
      depositAction,
      initialDepositor,
      [],
      "Deposit"
    );
  }
  return [reserve.publicKey, config];
}

export async function createReserve(
  env: Env,
  lendingMarket: PublicKey,
  liquidityMint: PublicKey
): Promise<[TransactionSignature, Keypair]> {
  const reserveAccount = Keypair.generate();
  const size = Reserve.layout.span + 8;
  const [lendingMarketAuthority] = lendingMarketAuthPda(
    lendingMarket,
    env.programId
  );
  const createReserveIx = SystemProgram.createAccount({
    fromPubkey: env.admin.publicKey,
    newAccountPubkey: reserveAccount.publicKey,
    lamports: await env.provider.connection.getMinimumBalanceForRentExemption(
      size
    ),
    space: size,
    programId: env.programId,
  });

  const {
    liquiditySupplyVault,
    collateralMint,
    collateralSupplyVault,
    feeVault,
  } = reservePdas(env.programId, lendingMarket, liquidityMint);

  const accounts: InitReserveAccounts = {
    lendingMarketOwner: env.admin.publicKey,
    lendingMarket,
    lendingMarketAuthority,
    reserve: reserveAccount.publicKey,
    reserveLiquidityMint: liquidityMint,
    reserveLiquiditySupply: liquiditySupplyVault,
    feeReceiver: feeVault,
    reserveCollateralMint: collateralMint,
    reserveCollateralSupply: collateralSupplyVault,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };

  const ix = initReserve(accounts); // env.programId
  const tx = new Transaction();
  tx.add(createReserveIx);
  tx.add(ix);

  const signatureCreateReserve = await constructAndSendVersionedTransaction(
    env,
    tx,
    [reserveAccount]
  );

  return [signatureCreateReserve, reserveAccount];
}

export async function updateReserve(
  env: Env,
  reserve: PublicKey,
  config: ReserveConfig
): Promise<TransactionSignature> {
  const reserveState: Reserve = (await Reserve.fetch(
    env.provider.connection,
    reserve
  ))!!;

  const layout = ReserveConfig.layout();
  const data = Buffer.alloc(1000);
  const len = layout.encode(config.toEncodable(), data);

  const args: UpdateEntireReserveConfigArgs = {
    mode: new anchor.BN(25),
    value: [...data.slice(0, len)],
  };

  const accounts: UpdateEntireReserveConfigAccounts = {
    lendingMarketOwner: env.admin.publicKey,
    lendingMarket: reserveState.lendingMarket,
    reserve,
  };

  const ix = updateEntireReserveConfig(args, accounts); // env.programId
  const tx = new Transaction();
  tx.add(ix);

  return constructAndSendVersionedTransaction(env, tx, []);
}

export async function updatePrice(
  env: Env,
  reserve: KaminoReserve,
  price: Price
): Promise<void> {
  await updateReserve(
    env,
    reserve!.address,
    new ReserveConfig({
      ...reserve.state.config,
      tokenInfo: {
        ...reserve.state.config.tokenInfo,
        ...getOracleConfigs(getPriceAcc(price)),
      },
    })
  );
}

export async function refreshReserves(env: Env, kaminoMarket: KaminoMarket) {
  const ixns = KaminoAction.getRefreshAllReserves(kaminoMarket, [
    ...kaminoMarket.reserves.keys(),
  ]);

  const tx = new Transaction();
  tx.add(...ixns);

  const txHash = await constructAndSendVersionedTransaction(env, tx, []);
  console.debug(`Refreshed reserves with ${txHash}`);
}

export async function reloadReservesAndRefreshMarket(
  env: Env,
  kaminoMarket: KaminoMarket
) {
  await kaminoMarket.reload();
  await refreshReserves(env, kaminoMarket);
  await kaminoMarket.reload();
}

export async function reloadMarket(env: Env, kaminoMarket: KaminoMarket) {
  await kaminoMarket.reload();
}

export async function mintToUser(
  env: Env,
  mint: PublicKey,
  user: PublicKey,
  amountLamports: number,
  mintAuthority: Keypair,
  mintIntoWsolAta: boolean = false
): Promise<PublicKey> {
  if (mint.equals(WRAPPED_SOL_MINT)) {
    const [ata, ix] = await createAssociatedTokenAccountIdempotentInstruction(
      user,
      mint,
      user
    );

    await env.provider.connection.requestAirdrop(user, amountLamports);
    await sleep(3000);

    if (mintIntoWsolAta) {
      // Should never have to do this in fact
      // user simply has SOL
      // The Kamino sdk does not currently wrap SOL automatically
      const depositWsol = await getDepositWsolIxns(user, ata, amountLamports);
      const tx = new Transaction();
      tx.add(...[ix], ...depositWsol);

      await constructAndSendVersionedTransaction(env, tx, []);
    }
    return ata;
  }
  const [ata, ix] = await createAssociatedTokenAccountIdempotentInstruction(
    user,
    mint,
    mintAuthority.publicKey
  );
  await mintTo(env, mint, ata, amountLamports.toString(), mintAuthority, [ix]);
  return ata;
}

export function getDepositWsolIxns(
  owner: PublicKey,
  ata: PublicKey,
  amountLamports: number
) {
  const ixns: TransactionInstruction[] = [];

  ixns.push(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ata,
      lamports: amountLamports,
    })
  );

  // Sync native
  ixns.push(
    new TransactionInstruction({
      keys: [
        {
          pubkey: ata,
          isSigner: false,
          isWritable: true,
        },
      ],
      data: Buffer.from(new Uint8Array([17])),
      programId: TOKEN_PROGRAM_ID,
    })
  );

  return ixns;
}
