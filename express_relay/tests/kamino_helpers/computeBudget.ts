import Decimal from "decimal.js";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { instructionEquals } from "./utils";

export function createAddExtraComputeUnitsTransaction(
  units: number,
  feePerCULamports?: Decimal
): TransactionInstruction[] {
  const ixns = [];
  ixns.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  if (feePerCULamports) {
    const { microLamports } = getComputeUnitPrice(units, feePerCULamports);
    ixns.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  return ixns;
}

export function getComputeUnitPrice(
  units: number,
  feePerCULamports: Decimal
): {
  microLamports: bigint;
} {
  const multiplier = 1;
  const unitPrice = feePerCULamports
    .mul(10 ** 6)
    .div(units)
    .mul(multiplier);
  const value = unitPrice.floor().toString();
  return { microLamports: BigInt(value) };
}

export function isComputeBudgetComputeUnitLimit(
  ix: ComputeBudgetInstructionType
): ix is "SetComputeUnitLimit" {
  return ix === "SetComputeUnitLimit";
}

export type ComputeBudgetInstructionType =
  | "RequestUnits"
  | "RequestHeapFrame"
  | "SetComputeUnitLimit"
  | "SetComputeUnitPrice";

function eliminateConsecutive<T>(
  arr: T[],
  comparator?: (a: T, b: T) => boolean
): T[] {
  if (!arr.length) return [];

  const result: T[] = [arr[0]];

  for (let i = 1; i < arr.length; i += 1) {
    if (comparator) {
      if (!comparator(arr[i], arr[i - 1])) {
        result.push(arr[i]);
      }
    } else if (arr[i] !== arr[i - 1]) {
      result.push(arr[i]);
    }
  }

  return result;
}

export function sanitizeInstructions(
  ixs: TransactionInstruction[]
): TransactionInstruction[] {
  const uniqIxs = eliminateConsecutive(ixs, instructionEquals);
  let firstCUIx: TransactionInstruction | null = null;
  const ixnsWithoutComputeIxns = uniqIxs.filter((ix) => {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (
        isComputeBudgetComputeUnitLimit(
          ComputeBudgetInstruction.decodeInstructionType(ix)
        )
      ) {
        if (firstCUIx === null) {
          firstCUIx = ix;
        }
        return false;
      }
    }
    return true;
  });
  if (firstCUIx === null) {
    return ixnsWithoutComputeIxns;
  }
  return [firstCUIx, ...ixnsWithoutComputeIxns];
}
