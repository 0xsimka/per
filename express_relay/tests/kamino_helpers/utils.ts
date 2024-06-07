import Decimal from "decimal.js";
import BN from "bn.js";
import {
  NULL_PUBKEY,
  // sendAndConfirmVersionedTransaction,
  KaminoAction,
  PubkeyHashMap,
  KaminoMarket,
} from "@kamino-finance/klend-sdk";
import {
  ReserveConfigFields,
  WithdrawalCaps,
  PriceHeuristic,
  BorrowRateCurve,
  BorrowRateCurveFields,
  CurvePoint,
  PythConfiguration,
  ReserveConfig,
  ScopeConfiguration,
  SwitchboardConfiguration,
  TokenInfo,
} from "@kamino-finance/klend-sdk/dist/idl_codegen/types";
import { PriceFeed } from "./price";
import { OracleType, U16_MAX } from "@hubbleprotocol/scope-sdk";
import { ConfigArgs } from "./types";
import {
  Transaction,
  TransactionSignature,
  TransactionMessage,
  VersionedTransaction,
  Signer,
  Keypair,
  AddressLookupTableAccount,
  TransactionInstruction,
  Connection,
  Commitment,
  SendOptions,
  PublicKey,
} from "@solana/web3.js";
import { Env } from "./types";

export function toLamports(
  amount: string | BN | number,
  decimals: number
): number {
  const factor = new Decimal(10 ** decimals);
  return new Decimal(amount.toString()).mul(factor).toNumber();
}

const encodeTokenName = (tokenName: string): number[] => {
  const buffer: Buffer = Buffer.alloc(32);

  const tokenNameEncoded = new Uint8Array(32);
  const s: Uint8Array = new TextEncoder().encode(tokenName);
  tokenNameEncoded.set(s);
  for (let i = 0; i < tokenNameEncoded.length; i += 1) {
    buffer[i] = tokenNameEncoded[i];
  }

  return [...buffer];
};

export const makeConfig = (
  tokenName: string,
  priceFeed: PriceFeed,
  args?: ConfigArgs
) => {
  const reserveConfig: ReserveConfigFields = {
    status: 0,
    loanToValuePct: 75,
    maxLiquidationBonusBps: 500,
    minLiquidationBonusBps: 200,
    badDebtLiquidationBonusBps: 10,
    liquidationThresholdPct: 85,
    protocolLiquidationFeePct: 0,
    protocolTakeRatePct: 0,
    assetTier: 0,
    fees: {
      borrowFeeSf: new BN(0),
      flashLoanFeeSf: new BN(0),
      padding: Array(6).fill(0),
    },
    depositLimit: args?.depositLimit ?? new BN("10000000000000000000"),
    borrowLimit: args?.borrowLimit ?? new BN("10000000000000000000"),
    tokenInfo: {
      name: encodeTokenName(tokenName),
      heuristic: new PriceHeuristic({
        lower: new BN(0),
        upper: new BN(0),
        exp: new BN(0),
      }),
      maxTwapDivergenceBps: new BN(0),
      maxAgePriceSeconds: new BN(1000000000),
      maxAgeTwapSeconds: new BN(0),
      ...getOracleConfigs(priceFeed),
      padding: Array(20).fill(new BN(0)),
    } as TokenInfo,
    borrowRateCurve: new BorrowRateCurve({
      points: [
        new CurvePoint({ utilizationRateBps: 0, borrowRateBps: 1 }),
        new CurvePoint({ utilizationRateBps: 100, borrowRateBps: 100 }),
        new CurvePoint({ utilizationRateBps: 10000, borrowRateBps: 100000 }),
        ...Array(8).fill(
          new CurvePoint({ utilizationRateBps: 10000, borrowRateBps: 100000 })
        ),
      ],
    } as BorrowRateCurveFields),
    depositWithdrawalCap: new WithdrawalCaps({
      configCapacity: new BN(0),
      currentTotal: new BN(0),
      lastIntervalStartTimestamp: new BN(0),
      configIntervalLengthSeconds: new BN(0),
    }),
    debtWithdrawalCap: new WithdrawalCaps({
      configCapacity: new BN(0),
      currentTotal: new BN(0),
      lastIntervalStartTimestamp: new BN(0),
      configIntervalLengthSeconds: new BN(0),
    }),
    deleveragingMarginCallPeriodSecs: new BN(259200),
    borrowFactorPct: new BN(100),
    deleveragingThresholdSlotsPerBps: new BN(7200),
    elevationGroups: Array(5).fill(0),
    reserved0: Array(2).fill(new BN(0)),
    reserved1: Array(4).fill(new BN(0)),
    multiplierSideBoost: Array(2).fill(0),
    multiplierTagBoost: Array(8).fill(0),
  };

  return new ReserveConfig(reserveConfig);
};

export function getOracleConfigs(priceFeed: PriceFeed): {
  pythConfiguration: PythConfiguration;
  switchboardConfiguration: SwitchboardConfiguration;
  scopeConfiguration: ScopeConfiguration;
} {
  let pythConfiguration = new PythConfiguration({
    price: NULL_PUBKEY,
  });
  let switchboardConfiguration = new SwitchboardConfiguration({
    priceAggregator: NULL_PUBKEY,
    twapAggregator: NULL_PUBKEY,
  });
  let scopeConfiguration = new ScopeConfiguration({
    priceFeed: NULL_PUBKEY,
    priceChain: [65535, 65535, 65535, 65535],
    twapChain: [65535, 65535, 65535, 65535],
  });

  const { type, price, chain } = priceFeed;

  switch (type.kind) {
    case new OracleType.Pyth().kind: {
      pythConfiguration = new PythConfiguration({ price });
      break;
    }
    case new OracleType.SwitchboardV2().kind: {
      switchboardConfiguration = new SwitchboardConfiguration({
        ...switchboardConfiguration,
        priceAggregator: price,
      });
      break;
    }
    case new OracleType.KToken().kind: {
      scopeConfiguration = new ScopeConfiguration({
        ...scopeConfiguration,
        priceFeed: price,
        priceChain: chain!.concat(Array(4 - chain!.length).fill(U16_MAX)),
      });
      break;
    }
    default:
      throw new Error("Invalid oracle type");
  }
  return {
    pythConfiguration,
    switchboardConfiguration,
    scopeConfiguration,
  };
}

export async function constructAndSendVersionedTransaction(
  env: Env,
  tx: Transaction,
  signers: Signer[]
): Promise<TransactionSignature> {
  const latestBlockHash = await env.provider.connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: env.admin.publicKey,
    recentBlockhash: latestBlockHash.blockhash,
    instructions: tx.instructions, // note this is an array of instructions
  }).compileToV0Message();
  const transactionV0 = new VersionedTransaction(messageV0);
  const signersAll = [env.admin, ...signers];
  transactionV0.sign(signersAll);
  const signature = await sendAndConfirmVersionedTransaction(
    env.provider.connection,
    transactionV0,
    "processed"
  );
  return signature;
}

export async function sendAndConfirmVersionedTransaction(
  c: Connection,
  tx: VersionedTransaction,
  commitment: Commitment = "confirmed",
  sendTransactionOptions: SendOptions = { preflightCommitment: "processed" }
) {
  const defaultOptions: SendOptions = { skipPreflight: true };
  const txId = await c.sendTransaction(tx, {
    ...defaultOptions,
    ...sendTransactionOptions,
  });
  console.log("Sending versioned txn", txId.toString());

  const latestBlockHash = await c.getLatestBlockhash("finalized");
  const t = await c.confirmTransaction(
    {
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txId,
    },
    commitment
  );
  if (t.value && t.value.err) {
    const txDetails = await c.getTransaction(txId, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (txDetails) {
      throw {
        err: txDetails.meta?.err,
        logs: txDetails.meta?.logMessages || [],
      };
    }
    throw t.value.err;
  }
  return txId;
}

export function sendTransactionFromAction(
  env: Env,
  kaminoAction: KaminoAction,
  signer: Keypair,
  lookupTables: AddressLookupTableAccount[],
  withDescription: string = ""
): Promise<TransactionSignature> {
  const ixs: TransactionInstruction[] = [...kaminoAction.setupIxs];
  for (let i = 0; i < kaminoAction.lendingIxs.length; i++) {
    ixs.push(kaminoAction.lendingIxs[i]);
    if (i !== kaminoAction.lendingIxs.length - 1) {
      ixs.push(...kaminoAction.inBetweenIxs);
    }
  }
  ixs.push(...kaminoAction.cleanupIxs);
  const tx = new Transaction().add(...ixs);

  return constructAndSendVersionedTransaction(env, tx, [signer]);
}

export function sleep(ms: number): Promise<void> {
  if (ms === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const instructionEquals = (
  ix1: TransactionInstruction,
  ix2: TransactionInstruction
) =>
  ix1.programId.equals(ix2.programId) &&
  arrayDeepEquals(
    ix1.keys,
    ix2.keys,
    (a, b) =>
      a.isSigner === b.isSigner &&
      a.isWritable === b.isWritable &&
      a.pubkey.equals(b.pubkey)
  ) &&
  arrayDeepEquals(
    Array.from(ix1.data),
    Array.from(ix2.data),
    (a, b) => a === b
  );

export function arrayDeepEquals<T, U>(
  array1: Readonly<T[]>,
  array2: Readonly<U[]>,
  eq: (a: T, b: U) => boolean
): boolean {
  if (array1.length !== array2.length) {
    return false;
  }
  return array1.reduce((prev, current, index) => {
    const other = array2[index];
    if (other == null) {
      return false;
    }
    return prev && eq(current, other);
  }, true);
}

export async function loadMarkets(
  c: Connection,
  programId: PublicKey,
  marketKeys: PublicKey[]
): Promise<Map<PublicKey, KaminoMarket>> {
  const markets = new PubkeyHashMap<PublicKey, KaminoMarket>();
  const loadMarkets = new Array<Promise<void>>();
  for (const market of marketKeys) {
    const load = KaminoMarket.load(c, market, programId).then((km) => {
      if (!km) {
        throw new Error(`Market ${market.toBase58()} not found`);
      }
      markets.set(market, km);
    });
    loadMarkets.push(load);
  }
  await Promise.all(loadMarkets);
  return markets;
}
