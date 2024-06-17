import * as anchor from "@coral-xyz/anchor";
import { sendAndConfirmVersionedTransaction } from "../kamino_helpers/utils";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionSignature,
} from "@solana/web3.js";
import { convertUint8ArrayNumberArray } from "./numberArray";
import { EzLend } from "../../target/types/ez_lend";
import { ExpressRelay } from "../../target/types/express_relay";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { constructExpressRelayTransaction } from "./expressRelayTransaction";

export async function constructAndSendEzLendLiquidateTransaction(
  connection: Connection,
  relayerSigner: Keypair,
  relayerFeeReceiver: Keypair,
  vaultEzLend: PublicKey,
  vaultIdEzLend: anchor.BN,
  permissionEzLend: PublicKey,
  searcher: Keypair,
  collateralInfo: {
    mint: PublicKey;
    ataSearcher: PublicKey;
    ataRelayer: PublicKey;
    taProtocol: PublicKey;
    amount: anchor.BN;
  },
  debtInfo: {
    mint: PublicKey;
    ataSearcher: PublicKey;
    ataRelayer: PublicKey;
    taProtocol: PublicKey;
    amount: anchor.BN;
  },
  ezLend: anchor.Program<EzLend>,
  expressRelay: anchor.Program<ExpressRelay>,
  bidAmount: anchor.BN,
  validUntil: anchor.BN,
  opportunityAdapter: boolean
): Promise<TransactionSignature> {
  let vaultIdEzLendSeed = new Uint8Array(32);
  vaultIdEzLendSeed.set(vaultIdEzLend.toArrayLike(Buffer, "le", 32), 0);

  let liquidatorEzLend;
  let collateralAtaLiquidatorEzLend;
  let debtAtaLiquidatorEzLend;
  if (opportunityAdapter) {
    liquidatorEzLend = relayerSigner;
    collateralAtaLiquidatorEzLend = collateralInfo.ataRelayer;
    debtAtaLiquidatorEzLend = debtInfo.ataRelayer;
  } else {
    liquidatorEzLend = searcher;
    collateralAtaLiquidatorEzLend = collateralInfo.ataSearcher;
    debtAtaLiquidatorEzLend = debtInfo.ataSearcher;
  }

  const ixLiquidateEzLend = await ezLend.methods
    .liquidate({
      vaultId: convertUint8ArrayNumberArray(
        vaultIdEzLend.toArrayLike(Buffer, "le", 32)
      ),
    })
    .accountsPartial({
      vault: vaultEzLend,
      payer: liquidatorEzLend.publicKey,
      collateralMint: collateralInfo.mint,
      debtMint: debtInfo.mint,
      collateralAtaPayer: collateralAtaLiquidatorEzLend,
      collateralTaProgram: collateralInfo.taProtocol,
      debtAtaPayer: debtAtaLiquidatorEzLend,
      debtTaProgram: debtInfo.taProtocol,
      permission: permissionEzLend,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([liquidatorEzLend])
    .instruction();

  let txLiquidateEzLend = await constructExpressRelayTransaction(
    connection,
    expressRelay,
    relayerSigner,
    relayerFeeReceiver,
    searcher,
    ezLend.programId,
    vaultIdEzLendSeed,
    bidAmount,
    validUntil,
    [ixLiquidateEzLend],
    {
      sellTokens: [
        {
          mint: debtInfo.mint,
          amount: debtInfo.amount,
        },
      ],
      buyTokens: [
        {
          mint: collateralInfo.mint,
          amount: collateralInfo.amount,
        },
      ],
    },
    opportunityAdapter
  );

  // send and confirm the transaction
  let txResponse = await sendAndConfirmVersionedTransaction(
    connection,
    txLiquidateEzLend
  );

  return txResponse;
}
