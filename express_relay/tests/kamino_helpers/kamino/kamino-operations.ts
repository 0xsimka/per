import { Env } from "../types";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Kamino } from "@hubbleprotocol/kamino-sdk";
import { WHIRLPOOL_PROGRAM_ID } from "@hubbleprotocol/kamino-sdk/dist/whirpools-client/programId";
import * as KaminoInstructions from "@hubbleprotocol/kamino-sdk/dist/kamino-client/instructions";
import {
  GlobalConfigOption,
  GlobalConfigOptionKind,
  UpdateCollateralInfoMode,
} from "@hubbleprotocol/kamino-sdk/dist/kamino-client/types";
import { constructAndSendVersionedTransaction } from "../utils";

export function createKaminoClient(
  env: Env,
  globalConfig: PublicKey = new PublicKey(
    "GKnHiWh3RRrE1zsNzWxRkomymHc374TvJPSTv2wPeYdB"
  )
): Kamino {
  return new Kamino(
    "localnet",
    env.provider.connection,
    globalConfig,
    // env.programId,
    new PublicKey("E6qbhrt4pFmCotNUSSEh6E5cRQCEJpMcd79Z56EG9KY"),
    WHIRLPOOL_PROGRAM_ID,
    new PublicKey("devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH")
  );
}

export async function setUpGlobalConfig(
  env: Env,
  kamino: Kamino,
  scopePrices: PublicKey = new PublicKey(
    "3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C"
  ),
  scopeProgram: PublicKey = new PublicKey(
    "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ"
  )
): Promise<PublicKey> {
  const globalConfig = Keypair.generate();

  const createGlobalConfigIx = await kamino.createAccountRentExempt(
    env.admin.publicKey,
    globalConfig.publicKey,
    kamino.getProgram().account.globalConfig.size
  );

  const accounts: KaminoInstructions.InitializeGlobalConfigAccounts = {
    adminAuthority: env.admin.publicKey,
    globalConfig: globalConfig.publicKey,
    systemProgram: SystemProgram.programId,
  };

  const initializeGlobalConfigIx =
    KaminoInstructions.initializeGlobalConfig(accounts);
  // fix: set to local Kamino program Id
  // initializeGlobalConfigIx.programId = env.programId;

  const tx = new Transaction();
  tx.add(createGlobalConfigIx);
  tx.add(initializeGlobalConfigIx);

  await constructAndSendVersionedTransaction(env, tx, [globalConfig]);

  kamino.setGlobalConfig(globalConfig.publicKey);

  // Now set the Scope accounts
  await updateGlobalConfig(
    env,
    kamino.getGlobalConfig(),
    "0",
    new GlobalConfigOption.ScopeProgramId(),
    scopeProgram.toString(),
    "key"
  );

  await updateGlobalConfig(
    env,
    kamino.getGlobalConfig(),
    "0",
    new GlobalConfigOption.ScopePriceId(),
    scopePrices.toString(),
    "key"
  );

  return globalConfig.publicKey;
}

export async function updateGlobalConfig(
  env: Env,
  globalConfig: PublicKey,
  keyIndex: string,
  globalConfigOption: GlobalConfigOptionKind,
  flagValue: string,
  flagValueType: string
) {
  let value: bigint | PublicKey | boolean;
  if (flagValueType === "number") {
    value = BigInt(flagValue);
  } else if (flagValueType === "bool") {
    if (flagValue === "false") {
      value = false;
    } else if (flagValue === "true") {
      value = true;
    } else {
      throw new Error("the provided flag value is not valid bool");
    }
  } else if (flagValueType === "key") {
    value = new PublicKey(flagValue);
  } else {
    throw new Error("flagValueType must be 'number', 'bool', or 'key'");
  }

  const index = Number.parseInt(keyIndex, 10);
  const formattedValue = getGlobalConfigValue(value);
  const args: KaminoInstructions.UpdateGlobalConfigArgs = {
    key: globalConfigOption.discriminator,
    index,
    value: formattedValue,
  };
  const accounts: KaminoInstructions.UpdateGlobalConfigAccounts = {
    adminAuthority: env.admin.publicKey,
    globalConfig,
    systemProgram: SystemProgram.programId,
  };

  const updateConfigIx = KaminoInstructions.updateGlobalConfig(args, accounts);
  // fix: set to local Kamino program Id
  // updateConfigIx.programId = env.programId;

  const tx = new Transaction();
  tx.add(updateConfigIx);

  const sig = await constructAndSendVersionedTransaction(env, tx, []);

  console.debug("Update Global Config ", globalConfigOption.toJSON(), sig);
}

export function getGlobalConfigValue(
  value: PublicKey | bigint | boolean
): number[] {
  let buffer: Buffer;
  if (value instanceof PublicKey) {
    buffer = value.toBuffer();
  } else if (typeof value === "boolean") {
    buffer = Buffer.alloc(32);
    if (value) {
      buffer.writeUInt8(1, 0);
    } else {
      buffer.writeUInt8(0, 0);
    }
    // eslint-disable-next-line valid-typeof
  } else if (typeof value === "bigint") {
    buffer = Buffer.alloc(32);
    buffer.writeBigUInt64LE(value); // Because we send 32 bytes and a u64 has 8 bytes, we write it in LE
  } else {
    throw Error("wrong type for value");
  }
  return [...buffer];
}

export async function setUpCollateralInfo(
  env: Env,
  kamino: Kamino
): Promise<PublicKey> {
  const collInfo = Keypair.generate();

  const createCollateralInfoIx = await kamino.createAccountRentExempt(
    env.admin.publicKey,
    collInfo.publicKey,
    kamino.getProgram().account.collateralInfos.size
  );

  const accounts: KaminoInstructions.InitializeCollateralInfoAccounts = {
    adminAuthority: env.admin.publicKey,
    globalConfig: kamino.getGlobalConfig(),
    systemProgram: SystemProgram.programId,
    collInfo: collInfo.publicKey,
  };

  const initializeCollateralInfosIx =
    KaminoInstructions.initializeCollateralInfo(accounts);
  // fix: set to local Kamino program Id
  // initializeCollateralInfosIx.programId = env.programId;

  const tx = new Transaction();
  tx.add(createCollateralInfoIx);
  tx.add(initializeCollateralInfosIx);

  await constructAndSendVersionedTransaction(env, tx, [collInfo]);

  // Now set the collateral infos into the global config
  await updateGlobalConfig(
    env,
    kamino.getGlobalConfig(),
    "0",
    new GlobalConfigOption.UpdateTokenInfos(),
    collInfo.publicKey.toString(),
    "key"
  );

  return collInfo.publicKey;
}
