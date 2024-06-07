import {
  KaminoMarket,
  KaminoReserve,
  PubkeyHashMap,
  toSeconds,
} from "@kamino-finance/klend-sdk";
import { PublicKey } from "@solana/web3.js";

export type ReserveAutodeleverageStatus = PubkeyHashMap<
  PublicKey,
  {
    debtSlotsSinceAutodeleverageStarted: number | undefined;
    collateralSlotsSinceAutodeleverageStarted: number | undefined;
  }
>;

/**
 * Get the autodeleverage status for each mint in a market.
 * @returns a map of reserve address to the slots since autodeleveraging started for that reserve, if any
 */
export function getAutodeleverageStatus(
  kaminoMarket: KaminoMarket,
  currentSlot: number
): ReserveAutodeleverageStatus {
  return getReserveAutodeleverageStatus(
    kaminoMarket.getAddress(),
    kaminoMarket.state.autodeleverageEnabled,
    kaminoMarket.reserves,
    currentSlot
  );
}

export function getReserveAutodeleverageStatus(
  market: PublicKey,
  autodeleverageEnabled: number,
  reserves: Map<PublicKey, KaminoReserve>,
  currentSlot: number
): ReserveAutodeleverageStatus {
  const reserveAutodeleverageStatus = new PubkeyHashMap<
    PublicKey,
    {
      debtSlotsSinceAutodeleverageStarted: number | undefined;
      collateralSlotsSinceAutodeleverageStarted: number | undefined;
    }
  >();

  if (autodeleverageEnabled === 0) {
    return reserveAutodeleverageStatus;
  }
  reserves.forEach((res) => {
    reserveAutodeleverageStatus.set(res.address, {
      debtSlotsSinceAutodeleverageStarted:
        getSlotsSinceAutodeleverageReserveDebtBorrowLimitCrossed(
          res,
          currentSlot
        ),
      collateralSlotsSinceAutodeleverageStarted:
        getSlotsSinceAutodeleverageReserveCollateralDepositLimitCrossed(
          res,
          currentSlot
        ),
    });
  });
  return reserveAutodeleverageStatus;
}

/**
 * Check whether a reserve's collateral can be auto-deleveraged, i.e. the deposit limit is crossed, the timestamp is set, and the margin call period has expired.
 * @returns the slots since deleveraging started if auto-deleveraging is possible, null otherwise
 */
export function getSlotsSinceAutodeleverageReserveCollateralDepositLimitCrossed(
  collateralReserve: KaminoReserve,
  slot: number
): number | undefined {
  if (collateralReserve.depositLimitCrossed()) {
    const depositLimitCrossedSlot =
      collateralReserve.state.liquidity.depositLimitCrossedSlot.toNumber();
    if (depositLimitCrossedSlot === 0) {
      return undefined;
    }
    const slotsSinceAutodeleveragingStarted = slot - depositLimitCrossedSlot;
    if (
      hasMarginCallPeriodExpired(
        collateralReserve,
        slotsSinceAutodeleveragingStarted
      )
    ) {
      return slotsSinceAutodeleveragingStarted;
    }
  }
  return undefined;
}

/**
 * Check whether a reserve's debt can be auto-deleveraged, i.e. the borrow limit is crossed, the timestamp is set, and the margin call period has expired.
 * @returns the slots since deleveraging started if auto-deleveraging is possible, null otherwise
 */
export function getSlotsSinceAutodeleverageReserveDebtBorrowLimitCrossed(
  debtReserve: KaminoReserve,
  slot: number
): number | undefined {
  if (debtReserve.borrowLimitCrossed()) {
    const borrowLimitCrossedSlot =
      debtReserve.state.liquidity.borrowLimitCrossedSlot.toNumber();
    if (borrowLimitCrossedSlot === 0) {
      return undefined;
    }
    const slotsSinceAutodeleveragingStarted = slot - borrowLimitCrossedSlot;
    if (
      hasMarginCallPeriodExpired(debtReserve, slotsSinceAutodeleveragingStarted)
    ) {
      return slotsSinceAutodeleveragingStarted;
    }
  }
  return undefined;
}

function hasMarginCallPeriodExpired(
  reserve: KaminoReserve,
  slotsSinceDeleveragingStarted: number
): boolean {
  const secondsSinceDeleveragingStarted = toSeconds(
    slotsSinceDeleveragingStarted
  );
  const deleveragingMarginCallPeriodSecs =
    reserve.state.config.deleveragingMarginCallPeriodSecs.toNumber();
  if (secondsSinceDeleveragingStarted < deleveragingMarginCallPeriodSecs) {
    return false;
  }
  return true;
}
