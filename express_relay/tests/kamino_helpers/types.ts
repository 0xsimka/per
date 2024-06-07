import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import Decimal from "decimal.js";
import { Position } from "@kamino-finance/klend-sdk";

export type Env = {
  provider: anchor.Provider;
  // pool: ConnectionPool;
  programId: PublicKey;
  admin: Keypair;
  wallet: anchor.Wallet;
  testCase: string;
  // jupPerpsAdmin: Keypair;
};

export type AssetQuantityTuple = [string, string];
export type ReserveInitArgs = [string, string] | [string, string, ConfigArgs];
export type ConfigArgs = {
  depositLimit?: BN;
  borrowLimit?: BN;
};

export const EligibleClusters = ["localnet", "devnet", "mainnet-beta"] as const;
export type Cluster = typeof EligibleClusters[number];

export type LiquidationConfig = {
  maxObligationRetries: number;
  slippageConfig: LiquidationSlippageConfig;
  overrides: LiquidationOverrides;
  txConfig: TxConfig;
};

export type LiquidationOverrides = {
  /**
   * To limit spam and stale prices and rounding errors
   * e.g. a factor of 1.005 when the liquidation threshold is $1.00 will not liquidate until the borrow amount is $1.005
   */
  thresholdBufferFactor?: Decimal;
  ltvPct?: number;
  liquidationScenario?: LiquidationScenario;
  liquidationMethod?: LiquidationMethod;
  liquidationAmount?: number;
  /**
   * Set the `min_acceptable_received_collateral_amount` parameter to 0
   */
  ignoreMinAcceptableCollOut?: boolean;
  ignoreNegativeProfit?: boolean;
};

export type LiquidationSlippageConfig = {
  /**
   * Slippage passed to Jupiter when swapping tokens to account for changes in liquidity
   */
  swapSlippageBps: number;
  /**
   * Slippage tolerance passed klend when liquidating to compensate for oracle price fluctuations
   * Determines the minimum amount of collateral to receive parameter
   */
  pxSlippageBps: number;
};

export type TxConfig = {
  feePerCULamports?: Decimal;
};

export enum LiquidationMethod {
  FLASH_BORROW_AND_LIQUIDATE = "FLASH_BORROW_AND_LIQUIDATE",
  FLASH_BORROW_AND_LIQUIDATE_KTOKEN_COLLATERAL = "FLASH_BORROW_AND_LIQUIDATE_KTOKEN_COLLATERAL",
  LIQUIDATE_AND_REDEEM = "LIQUIDATE_AND_REDEEM",
  SWAP_AND_LIQUIDATE = "SWAP_AND_LIQUIDATE",
}

export type LiquidationScenario = {
  obligation: string;
  reason: LiquidationReason;
  /**
   * The % bonus that will be paid to the liquidator
   */
  liquidationBonusPct: Decimal;
  selectedBorrow: Position;
  selectedDeposit: Position;
};

export enum LiquidationReason {
  LTV_CROSSED = "LTV_CROSSED",
  AUTODELEVERAGE_COLLATERAL = "AUTODELEVERAGE_COLLATERAL",
  AUTODELEVERAGE_DEBT = "AUTODELEVERAGE_DEBT",
  FORCE_LIQUIDATE = "FORCE_LIQUIDATE",
}

export type LookupTable = {
  address: PublicKey;
  account: AddressLookupTableAccount;
};
