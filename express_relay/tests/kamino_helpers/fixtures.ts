import {
  KaminoAction,
  KaminoMarket,
  VanillaObligation,
  PROGRAM_ID,
} from "@kamino-finance/klend-sdk";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Price } from "./price";
import { Env, AssetQuantityTuple, ReserveInitArgs } from "./types";
import { createKeypair } from "./keypair";
import {
  createMarket,
  reloadMarket,
  createMintAndReserve,
  mintToUser,
} from "./operations";
import { toLamports, sendTransactionFromAction } from "./utils";
import {
  createKaminoClient,
  setUpGlobalConfig,
  setUpCollateralInfo,
} from "./kamino/kamino-operations";
import { Scope } from "@hubbleprotocol/scope-sdk";
import { createScopeFeed } from "./kamino/scope";
import { Kamino } from "@hubbleprotocol/kamino-sdk";

export async function setupMarketWithLoan({
  reserves = [
    ["USDH", "0"],
    ["USDC", "0"],
  ],
  loan = {
    deposits: [["USDH", "100"]],
    borrows: [["USDH", "50"]],
  },
  prices = {
    SOL: Price.SOL_USD_20,
    USDH: Price.USDC_USD_1,
    USDC: Price.USDC_USD_1,
    STSOL: Price.STSOL_USD_20,
    MSOL: Price.SOL_USD_20,
    JLP: Price.SOL_USD_20,
  },
  env = {
    provider: anchor.Provider.env(),
    programId: new anchor.Wallet(Keypair.generate()).publicKey,
    admin: Keypair.generate(),
    wallet: new anchor.Wallet(Keypair.generate()),
    testCase: "default",
  },
}: {
  reserves?: ReserveInitArgs[];
  liquidatorAmounts?: AssetQuantityTuple[];
  loan?: {
    deposits: AssetQuantityTuple[];
    borrows: AssetQuantityTuple[];
  };
  prices?: Record<string, Price>;
  env?: Env;
} = {}) {
  const [liquidator, liquidatorPath] = await createKeypair(
    env,
    `liquidator-${env.testCase}.json`
  );

  // The separation of concerns is the following
  // * env.admin -> is the lending market authority and kamino vaults authority
  // * liquidator -> has sol, token balances, and is the minting authority
  // * first_borrower -> has the loan
  // * first_depositor -> deposits the initial liquidity in the reserves
  // * they are all different => first_borrower != first_depositor != env.admin != liquidator

  const firstBorrower = Keypair.generate();
  const firstDepositor = Keypair.generate();
  const mintAuthority = liquidator;
  await env.provider.connection.requestAirdrop(
    firstBorrower.publicKey,
    LAMPORTS_PER_SOL
  );
  await env.provider.connection.requestAirdrop(
    firstDepositor.publicKey,
    LAMPORTS_PER_SOL
  );

  const [, lendingMarket] = await createMarket(env);
  const kamino = createKaminoClient(env);
  const scope = new Scope("localnet", env.provider.connection);
  const scopeFeed = await createScopeFeed(env, scope);
  await setUpGlobalConfig(env, kamino, scopeFeed);
  await setUpCollateralInfo(env, kamino);

  const kaminoMarket = (await KaminoMarket.load(
    env.provider.connection,
    lendingMarket.publicKey
  ))!;

  // 1. Create reserves with initial liquidity
  for (const initReserveArgs of reserves.sort(specialTokenComparator)) {
    const symbol = initReserveArgs[0];
    const initialLiquidity = initReserveArgs[1];
    const extraConfigArgs =
      initReserveArgs.length === 3 ? initReserveArgs[2] : undefined;
    // Give all SOL derivatives 9 dp or else the kamino dex pools will be 1:1000 - weird pricing
    const decimals = symbol.endsWith("SOL") ? 9 : 6;
    const initialLiquidityLamports = toLamports(initialLiquidity, decimals);
    console.log(
      `Creating ${symbol} reserve with ${initialLiquidityLamports} lamports initial liquidity (${initialLiquidity})`
    );
    const [, reserve] = await createMintAndReserve(
      env,
      kaminoMarket,
      kamino,
      symbol,
      initialLiquidityLamports,
      firstDepositor,
      mintAuthority,
      decimals,
      prices,
      extraConfigArgs
    );
    console.log(
      `Created ${symbol} reserve with address: ${reserve.toBase58()}`
    );
  }

  // 2. Create the first borrower (loan)
  await reloadMarket(env, kaminoMarket);
  const { obligation } = await newBorrower(
    env,
    mintAuthority,
    kaminoMarket,
    kamino,
    loan,
    firstBorrower
  );

  return {
    liquidator,
    liquidatorPath,
    kaminoMarket,
    kamino,
    obligation,
    firstBorrower,
  };
}

/**
 * Sorts kTokens and JLP to the end of the list so that dependent mints are created first
 * @param a
 * @param b
 */
const specialTokenComparator = ([a]: ReserveInitArgs, [b]: ReserveInitArgs) => {
  if (isSpecialReserve(a) && isSpecialReserve(b)) {
    return 0;
  }
  if (isSpecialReserve(a)) {
    return 1;
  }
  if (isSpecialReserve(b)) {
    return -1;
  }
  return a.localeCompare(b);
};

const isSpecialReserve = (symbol: string) => isKToken(symbol) || isJlp(symbol);

export function isKToken(symbol: string): boolean {
  return symbol.startsWith("k");
}

export function isJlp(symbol: string): boolean {
  return symbol === "JLP";
}

export async function newBorrower(
  env: Env,
  mintAuthority: Keypair,
  kaminoMarket: KaminoMarket,
  kamino: Kamino,
  loan: {
    deposits: AssetQuantityTuple[];
    borrows: AssetQuantityTuple[];
  },
  borrowerKey?: Keypair
) {
  const borrower = borrowerKey || Keypair.generate();

  for (const [token, depositAmount] of loan.deposits) {
    const reserve = kaminoMarket.getReserveBySymbol(token);
    const mint = reserve!.getLiquidityMint();
    const depositLamports = toLamports(depositAmount, reserve!.stats.decimals);
    // if (isJlp(token)) {
    //   await mintJlpToUser(env, borrower, mintAuthority);
    // } else if (isKToken(token)) {
    //   await mintKTokenToUser(env, kamino, borrower, mintAuthority, mint);
    //   await crankStrategyScopePrices(
    //     env,
    //     kamino,
    //     new Scope('localnet', env.provider.connection),
    //     (await kamino.getStrategyByKTokenMint(mint))!,
    //     token
    //   );
    // } else {
    await mintToUser(
      env,
      mint,
      borrower.publicKey,
      depositLamports,
      mintAuthority
    );
    // }

    const depositAction = await KaminoAction.buildDepositTxns(
      kaminoMarket,
      depositLamports.toString(),
      mint,
      borrower.publicKey,
      // new VanillaObligation(env.programId),
      new VanillaObligation(PROGRAM_ID),
      1_000_000,
      true
    );
    await sendTransactionFromAction(
      env,
      depositAction,
      borrower,
      [],
      "Deposit"
    );
  }
  for (const [token, borrowAmount] of loan.borrows) {
    const reserve = kaminoMarket.getReserveBySymbol(token);
    const mint = reserve!.getLiquidityMint();
    const borrowLamports = toLamports(borrowAmount, reserve!.stats.decimals);
    const borrowAction = await KaminoAction.buildBorrowTxns(
      kaminoMarket,
      borrowLamports.toString(),
      mint,
      borrower.publicKey,
      // new VanillaObligation(env.programId),
      new VanillaObligation(PROGRAM_ID),
      1_000_000,
      true
    );
    await sendTransactionFromAction(env, borrowAction, borrower, [], "Borrow");
  }

  // const obligationVanilla = new VanillaObligation(env.programId);
  const obligationVanilla = new VanillaObligation(PROGRAM_ID);
  const obligation = obligationVanilla.toPda(
    kaminoMarket.getAddress(),
    borrower.publicKey
  );

  return { borrower, obligation };
}
