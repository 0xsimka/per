import Decimal from "decimal.js";
import {
  KaminoMarket,
  KaminoReserve,
  MIN_AUTODELEVERAGE_BONUS_BPS,
  Position,
  toDays,
  KaminoObligation,
  LendingMarket,
  Obligation,
} from "@kamino-finance/klend-sdk";
import {
  ElevationGroup,
  ReserveConfig,
} from "@kamino-finance/klend-sdk/dist/idl_codegen/types";
import { PublicKey } from "@solana/web3.js";
import { LiquidationReason, LiquidationScenario } from "./types";
// import { yellow } from './utils';
import { ReserveAutodeleverageStatus } from "./getReserveAutodeleverageStatus";
// import { BadDebtException } from './error';

export function tryLiquidateObligation(
  market: KaminoMarket,
  reserveAutodeleverageStatus: ReserveAutodeleverageStatus,
  obligation: KaminoObligation,
  liquidationThresholdBufferFactor: Decimal
): LiquidationScenario | null {
  // Regular liquidation
  const liquidatable = checkLiquidate(
    market,
    obligation,
    liquidationThresholdBufferFactor
  );
  if (liquidatable) {
    return liquidatable;
  }
  if (reserveAutodeleverageStatus.isEmpty()) {
    return null;
  }
  // Collateral autodeleveraging liquidation
  const collateralAutodeleverage = checkCollateralAutodeleverage(
    market,
    reserveAutodeleverageStatus,
    obligation
  );
  if (collateralAutodeleverage) {
    return collateralAutodeleverage;
  }
  // Debt autodeleveraging liquidation
  const debtAutodeleverage = checkDebtAutodeleverage(
    market,
    reserveAutodeleverageStatus,
    obligation
  );
  if (debtAutodeleverage) {
    return debtAutodeleverage;
  }
  return null;
}

export function getBestLiquidationPairByMarketValue(
  market: KaminoMarket,
  obligation: KaminoObligation,
  deposits: Map<PublicKey, Position>,
  borrows: Map<PublicKey, Position>
): { selectedBorrow: Position; selectedDeposit: Position } {
  let selectedBorrow: (Position & { borrowFactor: Decimal }) | undefined;
  for (const borrow of borrows.values()) {
    const reserveConfig = market.getReserveByMint(borrow.mintAddress)!.state
      .config;
    const reserveBorrowFactorPct =
      obligation.state.elevationGroup !== 0
        ? new Decimal(100)
        : new Decimal(reserveConfig.borrowFactorPct.toString());
    if (
      !selectedBorrow ||
      reserveBorrowFactorPct.gt(selectedBorrow.borrowFactor)
    ) {
      selectedBorrow = { ...borrow, borrowFactor: reserveBorrowFactorPct };
    } else if (
      reserveBorrowFactorPct.equals(selectedBorrow.borrowFactor) &&
      borrow.marketValueRefreshed.gt(selectedBorrow.marketValueRefreshed)
    ) {
      selectedBorrow = { ...borrow, borrowFactor: reserveBorrowFactorPct };
    }
  }

  // select the withdrawal collateral token with the highest market value
  let selectedDeposit: (Position & { ltv: number }) | undefined;
  for (const deposit of deposits.values()) {
    const reserveConfig = market.getReserveByMint(deposit.mintAddress)!.state
      .config;
    const depositReserveLtv =
      obligation.state.elevationGroup !== 0
        ? market.state.elevationGroups[obligation.state.elevationGroup - 1]
            .ltvPct
        : reserveConfig.loanToValuePct;
    if (!selectedDeposit || depositReserveLtv < selectedDeposit.ltv) {
      if (
        reserveConfig.liquidationThresholdPct > 0 &&
        reserveConfig.loanToValuePct > 0
      ) {
        selectedDeposit = { ...deposit, ltv: depositReserveLtv };
      }
    } else if (
      depositReserveLtv === selectedDeposit.ltv &&
      deposit.marketValueRefreshed.gt(selectedDeposit.marketValueRefreshed)
    ) {
      if (
        reserveConfig.liquidationThresholdPct > 0 &&
        reserveConfig.loanToValuePct > 0
      ) {
        selectedDeposit = { ...deposit, ltv: depositReserveLtv };
      }
    }
  }
  //   if (selectedBorrow && !selectedDeposit) {
  //     throw new BadDebtException(deposits, borrows);
  //   }
  if (!selectedBorrow || !selectedDeposit) {
    throw new Error(
      `No liquidation pair found from deposits: [${[...deposits.values()].map(
        (val) => `${val.mintAddress}: ${val.amount}`
      )}] and borrows: [${[...borrows.values()].map(
        (val) => `${val.mintAddress}: ${val.amount}`
      )}]`
    );
  }

  return {
    selectedBorrow,
    selectedDeposit,
  };
}

export function checkLiquidate(
  market: KaminoMarket,
  obligation: KaminoObligation,
  thresholdBufferFactor: Decimal
): LiquidationScenario | null {
  if (
    obligation.refreshedStats.userTotalBorrow.gt(0) &&
    obligation.refreshedStats.userTotalBorrowBorrowFactorAdjusted.gte(
      obligation.refreshedStats.borrowLiquidationLimit.mul(
        thresholdBufferFactor
      )
    )
  ) {
    // select repay token that has the highest market value
    const { selectedBorrow, selectedDeposit } =
      getBestLiquidationPairByMarketValue(
        market,
        obligation,
        obligation.deposits,
        obligation.borrows
      );
    // const prefix = yellow(obligation.obligationAddress.toBase58());
    const prefix = obligation.obligationAddress.toBase58();
    const liquidationBonusPct = calculateLiquidationBonusPct(
      market.state,
      market.getReserveByMint(selectedDeposit!.mintAddress)!.state.config,
      market.getReserveByMint(selectedBorrow!.mintAddress)!.state.config,
      obligation,
      prefix
    );
    return {
      obligation: prefix,
      selectedBorrow,
      selectedDeposit,
      liquidationBonusPct,
      reason: LiquidationReason.LTV_CROSSED,
    };
  }
  return null;
}

export function calculateLiquidationBonusPct(
  lendingMarket: LendingMarket,
  collateralReserveConfig: ReserveConfig,
  debtReserveConfig: ReserveConfig,
  obligation: KaminoObligation,
  prefix: string,
  maxAllowedLtvOverridePct?: Decimal
): Decimal {
  const emodeMaxLiquidationBonusBps = getEmodeMaxLiquidationBonusBps(
    lendingMarket,
    collateralReserveConfig,
    debtReserveConfig,
    obligation.state
  );
  const badDebtLtvPercent = new Decimal("100");

  const userLtvPercent = obligation.refreshedStats.loanToValue.mul("100");
  const maxAllowedLtvPercent =
    maxAllowedLtvOverridePct ||
    obligation.refreshedStats.borrowLiquidationLimit
      .div(obligation.refreshedStats.userTotalDeposit)
      .mul("100");

  if (userLtvPercent.gte("99")) {
    // Current situation (bad or almost bad debt)
    // 0 ----- maxAllowedLtv ----- 100 (badDebtLtv) ----- userLtv

    const liquidationBonusBadDebtBps = Math.min(
      collateralReserveConfig.badDebtLiquidationBonusBps,
      debtReserveConfig.badDebtLiquidationBonusBps
    );
    const liquidationBonusBadDebtPct = new Decimal(
      liquidationBonusBadDebtBps
    ).div("100");
    const cappedBonus = userLtvPercent.lt(badDebtLtvPercent)
      ? Decimal.max(
          liquidationBonusBadDebtPct,
          badDebtLtvPercent.minus(userLtvPercent)
        ) // cannot overflow because of the check above
      : liquidationBonusBadDebtPct;

    return cappedBonus;
  }

  // Current situation
  // 0 ----- maxAllowedLtv ----- userLtv ----- 100 (badDebtLtv)

  const unhealthyFactorBps = userLtvPercent
    .sub(maxAllowedLtvPercent)
    .mul("100")
    .floor()
    .toNumber();

  // (Capped) Maximum receivable, can't get more than maxBonus
  let maxBonusBps = Math.max(
    collateralReserveConfig.maxLiquidationBonusBps,
    debtReserveConfig.maxLiquidationBonusBps
  );

  // Emode group max bonus
  maxBonusBps = Math.min(maxBonusBps, emodeMaxLiquidationBonusBps);

  const minReserveBonusBps = Math.max(
    collateralReserveConfig.minLiquidationBonusBps,
    debtReserveConfig.minLiquidationBonusBps
  );

  // (Floored) Minimum receivable, can't get less than minBonus (2% for example)
  const minBonusBps = Math.max(minReserveBonusBps, unhealthyFactorBps);

  const collaredBonusBps = Math.min(minBonusBps, maxBonusBps);

  // Bad debt adjusted bonus, ensure bonus doesn't turn obligation to bad debt
  const diffToBadDebtPercentBps = badDebtLtvPercent
    .sub(userLtvPercent)
    .mul("100")
    .floor()
    .toNumber();
  const cappedMaxLiqBonusBadDebtBps = Math.min(
    collaredBonusBps,
    diffToBadDebtPercentBps
  );
  const result = new Decimal(cappedMaxLiqBonusBadDebtBps).div("100");

  return result;
}

export const getEmodeMaxLiquidationBonusBps = (
  lendingMarket: LendingMarket,
  collateralReserveConfig: ReserveConfig,
  debtReserveConfig: ReserveConfig,
  obligation: Obligation
): number => {
  if (
    obligation.elevationGroup !== 0 &&
    collateralReserveConfig.elevationGroups.includes(
      obligation.elevationGroup
    ) &&
    debtReserveConfig.elevationGroups.includes(obligation.elevationGroup)
  ) {
    const elevationGroup = getElevationGroup(
      lendingMarket,
      obligation.elevationGroup
    );

    if (
      elevationGroup.maxLiquidationBonusBps >
        collateralReserveConfig.maxLiquidationBonusBps ||
      elevationGroup.maxLiquidationBonusBps >
        debtReserveConfig.maxLiquidationBonusBps ||
      elevationGroup.maxLiquidationBonusBps === 0
    ) {
      return 65535;
    }

    return elevationGroup.maxLiquidationBonusBps;
  }

  return 65535; // 65535 bps to pct = 655.35%
};

function checkCollateralAutodeleverage(
  market: KaminoMarket,
  reserveAutodeleverageStatus: ReserveAutodeleverageStatus,
  obligation: KaminoObligation
): LiquidationScenario | null {
  let selectedBorrow: Position | undefined;
  let selectedDeposit: Position | undefined;
  let selectedLiquidationBonusBps = new Decimal(0);
  for (const [
    reserveAddress,
    autodeleverageStatus,
  ] of reserveAutodeleverageStatus.entries()) {
    const slotsSinceAutodeleverageStarted =
      autodeleverageStatus.collateralSlotsSinceAutodeleverageStarted;
    if (slotsSinceAutodeleverageStarted) {
      const obligationDeposit = obligation.getDepositByReserve(reserveAddress);
      if (obligationDeposit) {
        const autodeleverageReserve = market.getReserveByAddress(
          obligationDeposit.reserveAddress
        )!;
        const liquidationParams = getAutodeleverageLiquidationParams(
          obligation,
          autodeleverageReserve,
          slotsSinceAutodeleverageStarted
        );
        if (liquidationParams !== null) {
          const [, liquidationBonusBps] = liquidationParams;
          if (liquidationBonusBps.gt(selectedLiquidationBonusBps)) {
            selectedLiquidationBonusBps = liquidationBonusBps;
            selectedDeposit = obligationDeposit;
          }
        }
      }
    }
  }
  if (selectedDeposit) {
    // select repay token that has the highest market value
    obligation.borrows.forEach((borrow) => {
      if (
        !selectedBorrow ||
        borrow.marketValueRefreshed.gt(selectedBorrow.marketValueRefreshed)
      ) {
        selectedBorrow = borrow;
      }
    });
  }
  if (selectedBorrow && selectedDeposit) {
    return {
      obligation: obligation.obligationAddress.toBase58(), //yellow(obligation.obligationAddress.toBase58()),
      selectedBorrow,
      selectedDeposit,
      liquidationBonusPct: selectedLiquidationBonusBps.div("100"),
      reason: LiquidationReason.AUTODELEVERAGE_COLLATERAL,
    };
  }
  return null;
}

export const getElevationGroup = (
  lendingMarket: LendingMarket,
  index: number
): ElevationGroup => {
  if (index === 0) {
    return new ElevationGroup({
      maxLiquidationBonusBps: 0,
      id: 0,
      ltvPct: 0,
      liquidationThresholdPct: 0,
      allowNewLoans: 0,
      reserved: [],
      padding: [],
    });
  }
  return lendingMarket.elevationGroups[index - 1];
};

function checkDebtAutodeleverage(
  market: KaminoMarket,
  reserveAutodeleverageStatus: ReserveAutodeleverageStatus,
  obligation: KaminoObligation
): LiquidationScenario | null {
  let selectedBorrow: Position | undefined;
  let selectedDeposit: Position | undefined;
  let selectedLiquidationBonusBps = new Decimal(0);
  for (const [
    reserveAddress,
    autodeleverageStatus,
  ] of reserveAutodeleverageStatus.entries()) {
    const slotsSinceAutodeleverageStarted =
      autodeleverageStatus.debtSlotsSinceAutodeleverageStarted;
    if (slotsSinceAutodeleverageStarted) {
      const obligationBorrow = obligation.getBorrowByReserve(reserveAddress);
      if (obligationBorrow) {
        const autodeleverageReserve = market.getReserveByAddress(
          obligationBorrow.reserveAddress
        )!;
        const liquidationParams = getAutodeleverageLiquidationParams(
          obligation,
          autodeleverageReserve,
          slotsSinceAutodeleverageStarted
        );
        if (liquidationParams !== null) {
          const [, liquidationBonusBps] = liquidationParams;
          if (liquidationBonusBps.gt(selectedLiquidationBonusBps)) {
            selectedLiquidationBonusBps = liquidationBonusBps;
            selectedBorrow = obligationBorrow;
          }
        }
      }
    }
  }
  if (selectedBorrow) {
    // select repay token that has the highest market value
    obligation.deposits.forEach((deposit) => {
      if (
        !selectedDeposit ||
        deposit.marketValueRefreshed.gt(selectedDeposit.marketValueRefreshed)
      ) {
        selectedDeposit = deposit;
      }
    });
  }
  if (selectedBorrow && selectedDeposit) {
    return {
      obligation: obligation.obligationAddress.toBase58(), //yellow(obligation.obligationAddress.toBase58()),
      selectedBorrow,
      selectedDeposit,
      liquidationBonusPct: selectedLiquidationBonusBps.div("100"),
      reason: LiquidationReason.AUTODELEVERAGE_DEBT,
    };
  }
  return null;
}

/**
 * Check whether a collateral or debt reserve can be auto-deleveraged and return the reserve and slots since deleveraging started if so
 * @returns [daysSinceDeleveragingStarted, liquidationBonusBps]
 */
function getAutodeleverageLiquidationParams(
  obligation: KaminoObligation,
  autodeleverageReserve: KaminoReserve,
  slotsSinceDeleveragingStarted: number
): [number, Decimal] | null {
  const [ltvReductionBps, autodeleverageLtvPctThreshold] =
    calculateAutodeleverageThreshold(
      autodeleverageReserve,
      slotsSinceDeleveragingStarted
    );
  const userLtv = new Decimal(obligation.refreshedStats.loanToValue).mul("100");
  if (userLtv.greaterThanOrEqualTo(autodeleverageLtvPctThreshold)) {
    const [daysSinceDeleveragingStarted, liquidationBonusBps] =
      calculateAutodeleverageBonus(
        autodeleverageReserve,
        slotsSinceDeleveragingStarted,
        userLtv
      );

    return [daysSinceDeleveragingStarted, liquidationBonusBps];
  }

  return null;
}

/**
 * Calculate the LTV % when an obligation can be auto-deleverage liquidated
 * The auto-deleverage liquidation threshold decreases by the configured rate as slots per bps - e.g. 1 bps per hour would be 7200 slots per bps (assuming 2 slots per second)
 * /// auto_deleverage_ltv_thresh = liquidation_ltv (e.g. 0.75) - (0.01 * (slots_since_auto_deleveraging_started / slots_per_bps))
 * returns 0% if the reduction is more than the LTV, so all loans are auto-deleverage-able
 * @returns [ltvReductionBps, autoDeleverageLtvPctThreshold]
 * */
function calculateAutodeleverageThreshold(
  autodeleverageReserve: KaminoReserve,
  slotsSinceDeleveragingStarted: number
): [Decimal, Decimal] {
  const ltvReductionBps = new Decimal(slotsSinceDeleveragingStarted).div(
    autodeleverageReserve.state.config.deleveragingThresholdSlotsPerBps.toString()
  );
  const liquidationLtvPct = new Decimal(
    autodeleverageReserve.state.config.liquidationThresholdPct
  );
  const autoDeleverageLtvPctThreshold = liquidationLtvPct.minus(
    ltvReductionBps.div(100)
  );
  if (autoDeleverageLtvPctThreshold.lt(0)) {
    return [ltvReductionBps, new Decimal(0)];
  }
  return [ltvReductionBps, autoDeleverageLtvPctThreshold];
}

/**
 * Calculate the auto-deleverage liquidation bonus.
 * Bonus starts at 50bps and increases by the LTV as a % per day up to a maximum of `autodeleverageReserve.state.config.maxLiquidationBonusBps`
 * bonus = 0.5 + current_ltv (e.g. 0.75) * num_days_since_auto_deleveraging_started
 * @returns [daysSinceDeleveragingStarted, maxBonusBps]
 * */
function calculateAutodeleverageBonus(
  autodeleverageReserve: KaminoReserve,
  slotsSinceDeleveragingStarted: number,
  userLtv: Decimal
): [number, Decimal] {
  const daysSinceDeleveragingStarted = toDays(slotsSinceDeleveragingStarted);
  const oneX = new Decimal(100);
  // divide by 100 to convert % to a ratio
  const ltvRate = userLtv.div(oneX);
  const liquidationBonusBps = new Decimal(MIN_AUTODELEVERAGE_BONUS_BPS).plus(
    ltvRate.mul(daysSinceDeleveragingStarted)
  );

  const maxBonusBps = new Decimal(
    autodeleverageReserve.state.config.maxLiquidationBonusBps.toString()
  );
  return [
    daysSinceDeleveragingStarted,
    Decimal.min(liquidationBonusBps, maxBonusBps),
  ];
}
