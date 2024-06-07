import {
  Connection,
  PublicKey,
  Keypair,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { getTxSize } from "./size_tx";
import { waitForNewBlock } from "./sleep";
import * as anchor from "@coral-xyz/anchor";
import { LookupTable } from "../kamino_helpers/types";
import { Kamino, METADATA_PROGRAM_ID } from "@hubbleprotocol/kamino-sdk";
import {
  KaminoMarket,
  PubkeyHashMap,
  PublicKeySet,
  getLookupTableAccount,
  userMetadataPda,
  WRAPPED_SOL_MINT,
  ReserveStatus,
  isNotNullPubkey,
  KaminoReserve,
} from "@kamino-finance/klend-sdk";
import { Decimal } from "decimal.js";
import {
  getAssociatedTokenAddress,
  WrappedTokenType,
  getReserveLiquidityMints,
} from "../kamino_helpers/token";
import { PROGRAM_ID as KLEND_PROGRAM_ID } from "@kamino-finance/klend-sdk/dist/idl_codegen/programId";
import { WHIRLPOOL_PROGRAM_ID } from "@hubbleprotocol/kamino-sdk/dist/whirpools-client/programId";
import { PROGRAM_ID as KAMINO_PROGRAM_ID } from "@hubbleprotocol/kamino-sdk/dist/kamino-client/programId";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { COMPUTE_BUDGET_PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { RAYDIUM_PROGRAM_ID } from "../kamino_helpers/constants";

export async function createLookupTableIx(
  authority: PublicKey,
  payer: PublicKey,
  slot: number
): Promise<[anchor.web3.TransactionInstruction, PublicKey]> {
  const [lookupTableInst, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: authority,
      payer: payer,
      recentSlot: slot,
    });
  return [lookupTableInst, lookupTableAddress];
}

export async function extendLookupTableIx(
  lookupTable: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
  addresses: PublicKey[]
): Promise<anchor.web3.TransactionInstruction> {
  const extendInstruction = AddressLookupTableProgram.extendLookupTable({
    payer: payer,
    authority: authority,
    lookupTable: lookupTable,
    addresses: addresses,
  });
  return extendInstruction;
}

export async function createAndPopulateLookupTable(
  c: Connection,
  accounts: Set<PublicKey>,
  authority: Keypair,
  payer: Keypair,
  lookupTable?: PublicKey
): Promise<PublicKey> {
  let slot = (await c.getSlot()) - 1;

  const transactionLookupTable = new anchor.web3.Transaction();

  let lookupTableAddress;

  if (!lookupTable) {
    const createLookupTableOutput = await createLookupTableIx(
      authority.publicKey,
      payer.publicKey,
      slot
    );
    const lookupTableInst = createLookupTableOutput[0];
    lookupTableAddress = createLookupTableOutput[1];
    transactionLookupTable.add(lookupTableInst);
  } else {
    lookupTableAddress = lookupTable;
  }

  const extendInstruction = await extendLookupTableIx(
    lookupTableAddress,
    authority.publicKey,
    payer.publicKey,
    Array.from(accounts)
  );
  transactionLookupTable.add(extendInstruction);
  console.log("NUMBER OF accounts to put into table: ", accounts.size);
  console.log(
    "SIZE of transaction (create lookup tables): ",
    getTxSize(transactionLookupTable, payer.publicKey)
  );
  let signatureLookupTable = await c
    .sendTransaction(transactionLookupTable, [authority, payer], {})
    .catch((err) => {
      console.log(err);
    });
  const latestBlockHashLookupTable = await c.getLatestBlockhash();
  await c.confirmTransaction({
    blockhash: latestBlockHashLookupTable.blockhash,
    lastValidBlockHeight: latestBlockHashLookupTable.lastValidBlockHeight,
    signature: signatureLookupTable,
  });
  console.log("Lookup table created");

  // sleep to allow the lookup table to activate
  await waitForNewBlock(c, 1);

  return lookupTableAddress;
}

export async function createOrSyncUserLookupTables(
  c: Connection,
  liquidator: Keypair,
  markets: KaminoMarket[],
  kamino: Kamino,
  feePerCUILamports?: Decimal
): Promise<Map<PublicKey, LookupTable>> {
  const requiredLuts = await getRequiredLutsForMarkets(
    liquidator.publicKey,
    markets,
    kamino
  );
  const existingLuts = await getOrDropExtraUserLookupTables(
    c,
    markets,
    requiredLuts,
    liquidator,
    feePerCUILamports
  );
  const map = new PubkeyHashMap<PublicKey, LookupTable>();
  const lutTasks: Array<Promise<void>> = [];
  const recentSlot = await c.getSlot("confirmed");
  Array.from(requiredLuts.entries()).forEach(
    ([market, requiredAddresses], i) => {
      lutTasks.push(
        (async () => {
          // use a unique slot otherwise the PDA will be the same
          const slot = recentSlot + i;
          const lut = existingLuts.get(market);
          if (!lut) {
            const newLut = await createUserLookupTable(
              c,
              liquidator,
              requiredAddresses
            );
            map.set(market, {
              address: newLut,
              account: (await getLookupTableAccount(c, newLut))!,
            });
          } else {
            const [, newLut] = await syncUserLookupTable(
              c,
              liquidator,
              [market],
              requiredAddresses,
              lut,
              slot,
              feePerCUILamports
            );
            map.set(market, {
              address: newLut,
              account: (await getLookupTableAccount(c, newLut))!,
            });
          }
        })()
      );
    }
  );
  await Promise.all(lutTasks);
  return map;
}

export async function getOrDropExtraUserLookupTables(
  c: Connection,
  markets: KaminoMarket[],
  requiredLuts: Map<PublicKey, Array<PublicKey>>,
  liquidator: Keypair,
  feePerCULamports?: Decimal
): Promise<Map<PublicKey, AddressLookupTableAccount>> {
  const allUserTables = await getAllUserLookupTables(c, liquidator.publicKey);
  if (allUserTables.length === 0) {
    return new PubkeyHashMap<PublicKey, AddressLookupTableAccount>();
  }
  const tablesToUse = mapTablesToMarkets(requiredLuts, allUserTables);
  const closePromises = [];
  const selectedTables = new PublicKeySet<PublicKey>([]);
  for (const [, tableToUse] of tablesToUse) {
    selectedTables.add(tableToUse.key);
  }
  // for (const lut of allUserTables) {
  //   if (!selectedTables.contains(lut.key)) {
  //     logger.info(`Closing lookup table ${lut.key} as it is not needed.`);
  //     closePromises.push(closeLookupTable(c, liquidator, lut, feePerCULamports));
  //   }
  // }
  await Promise.all(closePromises);
  return tablesToUse;
}

export async function getAllUserLookupTables(
  c: Connection,
  user: PublicKey
): Promise<AddressLookupTableAccount[]> {
  const accountInfos = await c.getProgramAccounts(
    AddressLookupTableProgram.programId,
    {
      filters: [
        {
          memcmp: {
            offset: 22,
            bytes: user.toBase58(),
          },
        },
      ],
    }
  );

  return accountInfos.map(
    (info) =>
      new AddressLookupTableAccount({
        // @ts-ignore
        key: info.pubkey,
        state: AddressLookupTableAccount.deserialize(info.account.data),
      })
  );
}

export const createUserLookupTable = async (
  c: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> => {
  let currentAddresses = addresses;
  let addAddresses;
  let nLoops = 0;
  let lookupTableAddress;

  while (currentAddresses.length > 0) {
    if (currentAddresses.length > 30) {
      addAddresses = currentAddresses.slice(0, 30);
      currentAddresses = currentAddresses.slice(30);
    } else {
      addAddresses = currentAddresses;
      currentAddresses = [];
    }

    if (nLoops == 0) {
      lookupTableAddress = await createAndPopulateLookupTable(
        c,
        new Set(addAddresses),
        payer,
        payer
      );
    } else {
      await createAndPopulateLookupTable(
        c,
        new Set(addAddresses),
        payer,
        payer,
        lookupTableAddress
      );
    }

    nLoops++;
  }

  return lookupTableAddress;
};

export async function syncUserLookupTable(
  c: Connection,
  liquidator: Keypair,
  markets: PublicKey[],
  requiredAddresses: PublicKey[],
  table: AddressLookupTableAccount,
  recentSlot: number,
  feePerCUILamports?: Decimal
): Promise<[PublicKey, PublicKey]> {
  const { addressesToAdd, addressesToRemove } = checkUserLookupTable(
    table,
    requiredAddresses
  );
  if (addressesToRemove.length > 0) {
    //   await closeLookupTable(c, liquidator, table, feePerCUILamports);
    //   const slot = await c.getSlot();
    //   return [table.key, await createUserLookupTable(c, liquidator, requiredAddresses)];
  }
  if (addressesToAdd.length > 0) {
    createAndPopulateLookupTable(
      c,
      new Set(addressesToAdd),
      liquidator,
      liquidator,
      table.key
    );
  }
  return [table.key, table.key];
}

export function checkUserLookupTable(
  lut: AddressLookupTableAccount,
  requiredAddresses: PublicKey[]
): {
  addressesToAdd: PublicKey[];
  addressesToRemove: PublicKey[];
} {
  const existingLutDuplicates = findDuplicates(lut.state.addresses);
  const addressesStrings = requiredAddresses.map((a) => a.toBase58());
  const lookupTableStrings = lut.state.addresses.map((a) => a.toBase58());
  const addressesToRemove = lookupTableStrings
    .filter((a) => !addressesStrings.includes(a))
    .map((a) => new PublicKey(a));
  addressesToRemove.push(...existingLutDuplicates);
  const addressesToAdd = addressesStrings
    .filter((a) => !lookupTableStrings.includes(a))
    .map((a) => new PublicKey(a));
  return {
    addressesToAdd,
    addressesToRemove,
  };
}

function findDuplicates(arr: PublicKey[]): PublicKey[] {
  const seen = new PublicKeySet<PublicKey>([]);
  const duplicates = new PublicKeySet<PublicKey>([]);

  for (const item of arr) {
    if (seen.contains(item)) {
      duplicates.add(item);
    } else {
      seen.add(item);
    }
  }
  return duplicates.toArray();
}

export function mapTablesToMarkets(
  requiredLuts: Map<PublicKey, Array<PublicKey>>,
  allUserTables: AddressLookupTableAccount[]
): Map<PublicKey, AddressLookupTableAccount> {
  const lutMap = new PubkeyHashMap<PublicKey, AddressLookupTableAccount>();
  for (const [market, requiredLut] of requiredLuts.entries()) {
    const lut = allUserTables.find(
      (lut) =>
        lut.state.addresses.find((addr) => market.equals(addr)) !== undefined
    );
    if (lut === undefined) {
    } else if (!lut.isActive()) {
    } else {
      const checkIfValid = checkUserLookupTable(lut, requiredLut);
      if (checkIfValid.addressesToRemove.length > 0) {
      } else {
        const existingEntry = lutMap.get(market);
        if (existingEntry) {
          const existing = checkUserLookupTable(existingEntry, requiredLut);
          if (checkIfValid.addressesToAdd > existing.addressesToAdd) {
          } else {
            lutMap.set(market, lut);
          }
        } else {
          lutMap.set(market, lut);
        }
      }
    }
  }
  return lutMap;
}

export async function getRequiredLutsForMarkets(
  liquidator: PublicKey,
  markets: KaminoMarket[],
  kamino: Kamino
): Promise<Map<PublicKey, Array<PublicKey>>> {
  const requiredLuts = new PubkeyHashMap<PublicKey, Array<PublicKey>>();
  for (const m of markets) {
    const addresses = await getLookupTableAddresses(liquidator, [m], kamino);
    requiredLuts.set(m.getAddress(), addresses);
  }
  return requiredLuts;
}

/**
 * Get addresses of everything for the liquidator and market to minimise the need for additional lookup tables, including: liquidator wsol ata, liquidator atas, mints, program id, Kamino strategy accounts etc.
 */
export async function getLookupTableAddresses(
  liquidator: PublicKey,
  kaminoMarkets: KaminoMarket[],
  kamino: Kamino
): Promise<PublicKey[]> {
  const addresses: PublicKey[] = [];
  addresses.push(liquidator);
  const [userMetadata] = userMetadataPda(liquidator, KLEND_PROGRAM_ID);
  addresses.push(userMetadata);
  addresses.push(await getAssociatedTokenAddress(WRAPPED_SOL_MINT, liquidator));
  addresses.push(KLEND_PROGRAM_ID);
  addresses.push(WHIRLPOOL_PROGRAM_ID, RAYDIUM_PROGRAM_ID);
  addresses.push(KAMINO_PROGRAM_ID);
  addresses.push(kamino.getGlobalConfig());
  addresses.push(TOKEN_PROGRAM_ID);
  addresses.push(ASSOCIATED_TOKEN_PROGRAM_ID);
  addresses.push(METADATA_PROGRAM_ID);
  addresses.push(SYSVAR_INSTRUCTIONS_PUBKEY);
  addresses.push(SYSVAR_RENT_PUBKEY);
  addresses.push(COMPUTE_BUDGET_PROGRAM_ID);
  const allMints: Array<PublicKey> = [];
  const allPrices: Array<PublicKey> = [];
  const allKTokenMints: Array<PublicKey> = [];
  for (const kaminoMarket of kaminoMarkets) {
    const kaminoReserves = kaminoMarket
      .getReserves()
      .filter(
        (res) =>
          !res.getLiquidityAvailableAmount().eq(0) ||
          res.stats.status === ReserveStatus.Active
      );
    const mints: PublicKey[] = kaminoReserves.map((reserve) =>
      reserve.getLiquidityMint()
    );
    allMints.push(...mints);
    const reserves: PublicKey[] = dedupKeys(
      kaminoReserves.map((reserve) => reserve.address)
    );
    const ctokenMints: PublicKey[] = dedupKeys(
      kaminoReserves.map((reserve) => reserve.state.collateral.mintPubkey)
    );
    const ctokenMintsAtas: PublicKey[] = await Promise.all(
      ctokenMints.map((mint) => getAssociatedTokenAddress(mint, liquidator))
    );
    const vaults = dedupKeys(
      kaminoReserves.flatMap(({ state: { collateral, liquidity } }) => [
        collateral.supplyVault,
        liquidity.supplyVault,
        liquidity.feeVault,
      ])
    );
    const farms = dedupKeys(
      kaminoReserves
        .flatMap(({ state }) => [state.farmCollateral, state.farmDebt])
        .filter((farm) => isNotNullPubkey(farm))
    );
    const prices: PublicKey[] = kaminoReserves.flatMap((reserve) =>
      getPriceKeysForReserve(reserve)
    );
    allPrices.push(...prices);
    const kTokenMints: PublicKey[] = (
      await getReserveLiquidityMints(kaminoMarket)
    )
      .filter(
        (mint) => mint.wrappedTokenType === WrappedTokenType.KAMINO_LP_TOKEN
      )
      .map((mint) => mint.address);
    allKTokenMints.push(...kTokenMints);
    addresses.push(kaminoMarket.getAddress());
    addresses.push(kaminoMarket.getLendingMarketAuthority());
    addresses.push(...reserves);
    addresses.push(...vaults);
    addresses.push(...farms);
    addresses.push(...ctokenMints);
    addresses.push(...ctokenMintsAtas);
  }
  const dedupMints = dedupKeys(allMints);
  addresses.push(...dedupMints);
  const mintsAtas: PublicKey[] = await Promise.all(
    dedupMints.map((mint) => getAssociatedTokenAddress(mint, liquidator))
  );
  addresses.push(...mintsAtas);
  const dedupPrices = dedupKeys(allPrices);
  addresses.push(...dedupPrices);
  const dedupKTokenMints = dedupKeys(allKTokenMints);
  for (const kTokenMint of dedupKTokenMints) {
    const strategy = await kamino.getStrategyByKTokenMint(kTokenMint);
    if (strategy === null) {
      throw new Error(`Strategy not found for kToken mint ${kTokenMint}`);
    }
    const sharesAta = await getAssociatedTokenAddress(
      strategy.strategy.sharesMint,
      liquidator
    );
    const tokenAAta = await getAssociatedTokenAddress(
      strategy.strategy.tokenAMint,
      liquidator
    );
    const tokenBAta = await getAssociatedTokenAddress(
      strategy.strategy.tokenBMint,
      liquidator
    );

    // each strategy should have its own lookup table
    // we only need to add liquidator-specific accounts
    addresses.push(...[sharesAta, tokenAAta, tokenBAta]);
  }
  // todo - JLP - add JLP pool and custody accounts
  return dedupKeys(addresses);
}

function dedupKeys(keys: PublicKey[]): PublicKey[] {
  return new PublicKeySet(keys).toArray();
}

export function getPriceKeysForReserve(reserve: KaminoReserve) {
  const { pythConfiguration, switchboardConfiguration, scopeConfiguration } =
    reserve.state.config.tokenInfo;
  const priceKeys: PublicKey[] = [];
  if (isNotNullPubkey(pythConfiguration.price)) {
    priceKeys.push(pythConfiguration.price);
  }
  if (isNotNullPubkey(switchboardConfiguration.priceAggregator)) {
    priceKeys.push(switchboardConfiguration.priceAggregator);
  }
  if (isNotNullPubkey(switchboardConfiguration.twapAggregator)) {
    priceKeys.push(switchboardConfiguration.twapAggregator);
  }
  if (isNotNullPubkey(scopeConfiguration.priceFeed)) {
    priceKeys.push(scopeConfiguration.priceFeed);
  }
  return priceKeys;
}
