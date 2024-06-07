// import Decimal from 'decimal.js';
// import {
//     KaminoMarket,
//     KaminoReserve,
//     MIN_AUTODELEVERAGE_BONUS_BPS,
//     Position,
//     toDays,
//     KaminoObligation,
//     LendingMarket,
//     Obligation,
//   } from '@kamino-finance/klend-sdk';
// import { PublicKey } from '@solana/web3.js';
import { Decimal } from "decimal.js";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { Cluster, LiquidationConfig, LiquidationMethod } from "./types";
import {
  KaminoMarket,
  KaminoObligation,
  KaminoReserve,
  KaminoAction,
  createAssociatedTokenAccountIdempotentInstruction,
  getMarketsFromApi,
} from "@kamino-finance/klend-sdk";
import { Kamino } from "@hubbleprotocol/kamino-sdk";
import { LiquidityMintInfo, getReserveLiquidityMints } from "./token";
import {
  ReserveAutodeleverageStatus,
  getAutodeleverageStatus,
} from "./getReserveAutodeleverageStatus";
import {
  getAdditionalOraclePrices,
  getTokensOracleData,
  TokenOracleData,
} from "./oracle";
import {
  createAddExtraComputeUnitsTransaction,
  sanitizeInstructions,
} from "./computeBudget";
import { createOrSyncUserLookupTables } from "../helpers/lookupTable";
import { KAMINO_GLOBAL_CONFIG, RAYDIUM_PROGRAM_ID } from "./constants";
import { WHIRLPOOL_PROGRAM_ID } from "@hubbleprotocol/kamino-sdk/dist/whirpools-client/programId";
import { PROGRAM_ID as KAMINO_PROGRAM_ID } from "@hubbleprotocol/kamino-sdk/dist/kamino-client/programId";
import { loadMarkets } from "./utils";

export async function getLiquidationLookupTables(
  // kaminoMarket: KaminoMarket,
  c: Connection,
  klendProgramId: PublicKey,
  kaminoMarket: PublicKey,
  liquidator: Keypair
): Promise<AddressLookupTableAccount[]> {
  const config = await getMarketsFromApi(klendProgramId);

  // const marketKeys = config.map(
  //   ({ lendingMarket }) => new PublicKey(lendingMarket)
  // ); // this is hardcoded to some preset values, just use the created kamino market
  const marketKeys = [kaminoMarket];

  const kaminoMarkets = await loadMarkets(c, klendProgramId, marketKeys);

  const kamino = new Kamino(
    "localnet",
    c,
    KAMINO_GLOBAL_CONFIG,
    KAMINO_PROGRAM_ID,
    WHIRLPOOL_PROGRAM_ID,
    RAYDIUM_PROGRAM_ID
  );

  const luts = await createOrSyncUserLookupTables(
    c,
    liquidator,
    [...kaminoMarkets.values()],
    kamino,
    undefined // await getRecentAverageFees(cluster)
  );

  let lookupTables: AddressLookupTableAccount[] = [];

  for (const [marketIndex, market] of marketKeys.entries()) {
    const { account: liquidatorLookupTable } = luts.get(market)!;
    lookupTables.push(liquidatorLookupTable);
  }

  return lookupTables;
}

export async function getMarketAccounts(
  c: Connection,
  cluster: Cluster,
  klendProgramId: PublicKey,
  market: PublicKey,
  config: LiquidationConfig,
  additionalTokenInfos: KaminoReserve[]
): Promise<{
  kaminoMarket: KaminoMarket;
  liquidityTokenMints: LiquidityMintInfo[];
  collateralExchangeRates: Map<PublicKey, Decimal>;
  cumulativeBorrowRates: Map<PublicKey, Decimal>;
  currentSlot: number;
  config: LiquidationConfig;
  reserveAutodeleverageStatus: ReserveAutodeleverageStatus;
  additionalOraclePrices: Array<TokenOracleData>;
}> {
  const kaminoMarket = await KaminoMarket.load(c, market, klendProgramId);
  if (kaminoMarket === null) {
    throw new Error(`Failed to load kamino market ${market}`);
  }
  const [
    liquidityTokenMints,
    currentSlot,
    averageFeePerCULamports,
    additionalOraclePrices,
  ] = await Promise.all([
    getReserveLiquidityMints(kaminoMarket),
    c.getSlot(),
    undefined,
    //   getRecentAverageFees(cluster),
    getAdditionalOraclePrices(c, additionalTokenInfos),
  ]);
  const newConfig = config;
  if (averageFeePerCULamports) {
    newConfig.txConfig.feePerCULamports = averageFeePerCULamports;
  }

  return {
    kaminoMarket,
    liquidityTokenMints,
    ...calculateExchangeRates(kaminoMarket, currentSlot),
    currentSlot,
    config: newConfig,
    reserveAutodeleverageStatus: getAutodeleverageStatus(
      kaminoMarket,
      currentSlot
    ),
    additionalOraclePrices,
  };
}

export function calculateExchangeRates(
  kaminoMarket: KaminoMarket,
  slot: number
): {
  collateralExchangeRates: Map<PublicKey, Decimal>;
  cumulativeBorrowRates: Map<PublicKey, Decimal>;
} {
  return {
    collateralExchangeRates:
      kaminoMarket.getCollateralExchangeRatesByReserve(slot),
    cumulativeBorrowRates: kaminoMarket.getCumulativeBorrowRatesByReserve(slot),
  };
}

/// Create ATAs and liquidate the obligation in the same tx
export async function liquidateAndRedeem(
  kaminoMarket: KaminoMarket,
  liquidator: Keypair,
  liquidityAmount: number | string,
  repayReserve: KaminoReserve,
  withdrawReserve: KaminoReserve,
  obligation: KaminoObligation,
  config: LiquidationConfig
): Promise<TransactionInstruction[]> {
  const { overrides, txConfig } = config;
  const ob = `${obligation.obligationAddress}`;
  const ixs: TransactionInstruction[] = [];
  ixs.push(
    ...createAddExtraComputeUnitsTransaction(350_000, txConfig.feePerCULamports)
  );

  const { ixs: liquidationIxs } = await getLiquidationInstructionsFromAction(
    kaminoMarket,
    liquidator,
    obligation,
    repayReserve.address,
    withdrawReserve.address,
    Number(liquidityAmount),
    new Decimal(0), // todo elliot
    overrides.ltvPct ?? 0
  );
  ixs.push(...liquidationIxs);

  return sanitizeInstructions(ixs);
  //   try {
  //     const txHash = await sendAndConfirmTransactionV0(
  //       c,
  //       liquidator,
  //       sanitizeInstructions(ixs),
  //       [liquidatorLookupTable],
  //       [],
  //       `${ob} LiquidateAndRedeem`,
  //       logger.info
  //     );
  //     incLiquidationTxSuccessCounter(LiquidationMethod.LIQUIDATE_AND_REDEEM);
  //     return [txHash, true];
  //   } catch (e) {
  //     incLiquidationTxFailCounter(LiquidationMethod.LIQUIDATE_AND_REDEEM);
  //     try {
  //       const { encodedTx, simulationUrl } = base64EncodeTx(cluster, liquidator.publicKey, liquidationIxs, [
  //         liquidatorLookupTable,
  //       ]);
  //       if (e instanceof TransactionError) {
  //         logger.error(`${ob} LiquidateAndRedeem failed txHash: ${e.sig}`, { encodedTx, simulationUrl }, e);
  //         return [e.sig, false];
  //       }
  //     } catch (e) {
  //       if (e instanceof TransactionError) {
  //         logger.error(`${ob} LiquidateAndRedeem failed txHash: ${e.sig}`, e);
  //         return [e.sig, false];
  //       }
  //     }
  //     throw e;
  //   }
}

export const getLiquidationInstructionsFromAction = async (
  kaminoMarket: KaminoMarket,
  payer: Keypair,
  obligation: KaminoObligation,
  repayReserveAddress: PublicKey,
  withdrawReserveAddress: PublicKey,
  liquidityAmount: number | string,
  minCollateralReceiveLamports: Decimal,
  maxAllowedLtvOverridePercent: number = 0
): Promise<{
  ixs: TransactionInstruction[];
  labels: string[];
  liquidateAction: KaminoAction;
}> => {
  const ob = `${obligation.obligationAddress}`;
  const repayReserve = kaminoMarket.getReserveByAddress(repayReserveAddress)!;
  const withdrawReserve = kaminoMarket.getReserveByAddress(
    withdrawReserveAddress
  )!;

  const liquidateAction = await KaminoAction.buildLiquidateTxns(
    kaminoMarket,
    liquidityAmount.toString(),
    minCollateralReceiveLamports.toString(),
    repayReserve.getLiquidityMint(),
    withdrawReserve.getLiquidityMint(),
    payer.publicKey,
    obligation.state.owner,
    obligation,
    undefined,
    false,
    undefined,
    undefined,
    // DEFAULT_REFERRER,
    PublicKey.default,
    maxAllowedLtvOverridePercent
  );

  const [withdrawCTokenAta, withdrawCTokenAtaIx] =
    await createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      withdrawReserve.state.collateral.mintPubkey
    );
  const [withdrawAta, withdrawAtaIx] =
    await createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      withdrawReserve.getLiquidityMint()
    );

  const labels = [
    `CreateUserAta[${withdrawAta.toBase58()}]`,
    `CreateCollateralUserAta[${withdrawCTokenAta.toBase58()}]`,
    ...liquidateAction.setupIxsLabels,
    ...liquidateAction.lendingIxsLabels,
    ...liquidateAction.cleanupIxsLabels,
  ];
  console.log("HERE ARE THE IXS FROM KAMINO");
  console.log("#1");
  console.log(withdrawAtaIx);
  console.log("#2");
  console.log(withdrawCTokenAtaIx);
  console.log("#3");
  for (let i = 0; i < liquidateAction.setupIxs.length; i++) {
    console.log("KEYS");
    console.log(liquidateAction.setupIxs[i].keys);
    console.log("DATA");
    console.log(liquidateAction.setupIxs[i].data);
    console.log("PID");
    console.log(liquidateAction.setupIxs[i].programId);
  }
  console.log("");
  console.log("#4");
  for (let i = 0; i < liquidateAction.lendingIxs.length; i++) {
    console.log("KEYS");
    console.log(liquidateAction.lendingIxs[i].keys);
    console.log("DATA");
    console.log(liquidateAction.lendingIxs[i].data);
    console.log("PID");
    console.log(liquidateAction.lendingIxs[i].programId);
  }
  console.log("");
  console.log("#5");
  for (let i = 0; i < liquidateAction.cleanupIxs.length; i++) {
    console.log("KEYS");
    console.log(liquidateAction.cleanupIxs[i].keys);
    console.log("DATA");
    console.log(liquidateAction.cleanupIxs[i].data);
    console.log("PID");
    console.log(liquidateAction.cleanupIxs[i].programId);
  }
  return {
    ixs: [
      withdrawAtaIx,
      withdrawCTokenAtaIx,
      ...liquidateAction.setupIxs,
      ...liquidateAction.lendingIxs,
      ...liquidateAction.cleanupIxs,
    ],
    labels,
    liquidateAction,
  };
};

// export function getBestLiquidationPairByMarketValue(
//     market: KaminoMarket,
//     deposits: Map<PublicKey, Position>,
//     borrows: Map<PublicKey, Position>
//   ): { selectedBorrow: Position; selectedDeposit: Position } {
//     let selectedBorrow: Position | undefined;
//     for (const borrow of borrows.values()) {
//       if (!selectedBorrow || borrow.marketValueRefreshed.gt(selectedBorrow.marketValueRefreshed)) {
//         selectedBorrow = borrow;
//       }
//     }

//     // select the withdrawal collateral token with the highest market value
//     let selectedDeposit: Position | undefined;
//     for (const deposit of deposits.values()) {
//       if (!selectedDeposit || deposit.marketValueRefreshed.gt(selectedDeposit.marketValueRefreshed)) {
//         const reserveConfig = market.getReserveByMint(deposit.mintAddress)!.state.config;
//         if (reserveConfig.loanToValuePct > 0 && reserveConfig.liquidationThresholdPct > 0) {
//           selectedDeposit = deposit;
//         }
//       }
//     }
//     if (selectedBorrow && !selectedDeposit) {
//       throw new BadDebtException(deposits, borrows);
//     }
//     if (!selectedBorrow || !selectedDeposit) {
//       throw new Error(
//         `No liquidation pair found from deposits: [${[...deposits.values()].map((val) => `${val.mintAddress}: ${val.amount}`)}] and borrows: [${[...borrows.values()].map((val) => `${val.mintAddress}: ${val.amount}`)}]`
//       );
//     }

//     return {
//       selectedBorrow,
//       selectedDeposit,
//     };
//   }

// export function checkLiquidate(
//     market: KaminoMarket,
//     obligation: KaminoObligation,
//     thresholdBufferFactor: Decimal
//   ): LiquidationScenario | null {
//     if (
//       obligation.refreshedStats.userTotalBorrow.gt(0) &&
//       obligation.refreshedStats.userTotalBorrowBorrowFactorAdjusted.gte(
//         obligation.refreshedStats.borrowLiquidationLimit.mul(thresholdBufferFactor)
//       )
//     ) {
//       // select repay token that has the highest market value
//       const { selectedBorrow, selectedDeposit } = getBestLiquidationPairByMarketValue(
//         market,
//         obligation.deposits,
//         obligation.borrows
//       );
//       const prefix = yellow(obligation.obligationAddress.toBase58());
//       const liquidationBonusPct = calculateLiquidationBonusPct(
//         market.state,
//         market.getReserveByMint(selectedDeposit!.mintAddress)!.state.config,
//         market.getReserveByMint(selectedBorrow!.mintAddress)!.state.config,
//         obligation,
//         prefix
//       );
//       return {
//         obligation: prefix,
//         selectedBorrow,
//         selectedDeposit,
//         liquidationBonusPct,
//         reason: LiquidationReason.LTV_CROSSED,
//       };
//     }
//     if (logger.isDebugEnabled()) {
//       logger.debug(
//         `${yellow(obligation.obligationAddress.toBase58())} not eligible for low LTV liquidation. ${JSON.stringify({
//           ltv: round(obligation.refreshedStats.loanToValue.mul(100).toNumber(), 5),
//           liqLtv: round(obligation.refreshedStats.liquidationLtv.toNumber() * 100, 5),
//           depositedValue: round(obligation.refreshedStats.userTotalDeposit.toNumber(), 5),
//           borrowedValue: round(obligation.refreshedStats.userTotalBorrow.toNumber(), 5),
//           borrowedValueFactorAdjusted: round(obligation.refreshedStats.userTotalBorrowBorrowFactorAdjusted.toNumber(), 5),
//           borrowLiquidationLimit: round(obligation.refreshedStats.borrowLiquidationLimit.toNumber(), 5),
//         })}`
//       );
//     }
//     return null;
//   }

// export enum LiquidationMethod {
//   FLASH_BORROW_AND_LIQUIDATE = 'FLASH_BORROW_AND_LIQUIDATE',
//   FLASH_BORROW_AND_LIQUIDATE_KTOKEN_COLLATERAL = 'FLASH_BORROW_AND_LIQUIDATE_KTOKEN_COLLATERAL',
//   LIQUIDATE_AND_REDEEM = 'LIQUIDATE_AND_REDEEM',
//   SWAP_AND_LIQUIDATE = 'SWAP_AND_LIQUIDATE',
// }

// export type LiquidationScenario = {
//   obligation: string;
//   reason: LiquidationReason;
//   /**
//    * The % bonus that will be paid to the liquidator
//    */
//   liquidationBonusPct: Decimal;
//   selectedBorrow: Position;
//   selectedDeposit: Position;
// };

// export enum LiquidationReason {
//   LTV_CROSSED = 'LTV_CROSSED',
//   AUTODELEVERAGE_COLLATERAL = 'AUTODELEVERAGE_COLLATERAL',
//   AUTODELEVERAGE_DEBT = 'AUTODELEVERAGE_DEBT',
//   FORCE_LIQUIDATE = 'FORCE_LIQUIDATE',
// }
