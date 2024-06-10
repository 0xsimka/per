import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { farmsId, getFarmAuthorityPDA } from "@hubbleprotocol/farms-sdk";
import {
  initFarmsForReserve,
  InitFarmsForReserveAccounts,
  lendingMarketAuthPda,
} from "@kamino-finance/klend-sdk";
import { ReserveFarmKind } from "@kamino-finance/klend-sdk/dist/idl_codegen/types";
import { Env } from "../types";
import { constructAndSendVersionedTransaction } from "../utils";

export async function initializeFarmsForReserve(
  env: Env,
  lendingMarket: PublicKey,
  reserve: PublicKey,
  kind: string,
  farmsGlobalConfigOverride?: string
) {
  const farmsGlobalConfig =
    farmsGlobalConfigOverride ?? "6UodrBjL2ZreDy7QdR4YV1oxqMBjVYSEyrFpctqqwGwL";

  const [lendingMarketAuthority] = lendingMarketAuthPda(
    lendingMarket,
    env.programId
  );

  const SIZE_FARM_STATE = 8336;
  const farmState: Keypair = Keypair.generate();
  const createFarmIx = SystemProgram.createAccount({
    fromPubkey: env.admin.publicKey,
    newAccountPubkey: farmState.publicKey,
    space: SIZE_FARM_STATE,
    lamports: await env.provider.connection.getMinimumBalanceForRentExemption(
      SIZE_FARM_STATE
    ),
    programId: farmsId,
  });

  const ix = initFarmsForReserve(
    {
      mode: ReserveFarmKind.fromDecoded({ [kind]: "" }).discriminator,
    },
    {
      lendingMarketOwner: env.admin.publicKey,
      lendingMarket,
      lendingMarketAuthority,
      reserve,
      farmsProgram: farmsId,
      farmsGlobalConfig: new PublicKey(farmsGlobalConfig),
      farmState: farmState.publicKey,
      farmsVaultAuthority: getFarmAuthorityPDA(farmsId, farmState.publicKey),
      rent: SYSVAR_RENT_PUBKEY,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as InitFarmsForReserveAccounts
  );

  const tx = new Transaction();
  tx.add(createFarmIx);
  tx.add(ix);

  return constructAndSendVersionedTransaction(env, tx, [farmState]);
}
