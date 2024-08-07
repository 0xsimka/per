import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  Transaction,
  AddressLookupTableProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { SolanaPer } from "../target/types/solana_per";
import { LimitOrder } from "../target/types/limit_order";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
  approve,
} from "@solana/spl-token";

describe("solana-per", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const expressRelayProgram = anchor.workspace.SolanaPer as Program<SolanaPer>;
  const limitOrderProgram = anchor.workspace.LimitOrder as Program<LimitOrder>;

  const relayerSigner = anchor.web3.Keypair.generate();
  const relayerFeeReceiver = anchor.web3.Keypair.generate();

  let connection = anchor.getProvider().connection;
  const airdrop = async (address: anchor.web3.PublicKey) => {
    const airdropSignature = await connection.requestAirdrop(
      address,
      20 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSignature);
  };

  before("Initialize Express Relay", async () => {
    let splitProtocolDefault = new anchor.BN(5000);
    let splitRelayer = new anchor.BN(2000);

    const admin = anchor.web3.Keypair.generate();
    const deployer = anchor.web3.Keypair.generate();
    await airdrop(admin.publicKey);
    await airdrop(deployer.publicKey);
    await expressRelayProgram.methods
      .initialize()
      .accounts({
        admin: admin.publicKey,
      })
      .rpc();
    const tx = await expressRelayProgram.methods
      .initializeRelayer({
        splitProtocolDefault: splitProtocolDefault,
        splitRelayer: splitRelayer,
      })
      .accountsPartial({
        relayerSigner: relayerSigner.publicKey,
        relayerFeeReceiver: relayerFeeReceiver.publicKey,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
    console.log("Init transaction signature", tx);
  });
  it("works!", async () => {
    const payer = anchor.web3.Keypair.generate();
    await airdrop(payer.publicKey);
    const mintBuy = await createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      9
    );

    const mintSell = await createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      9
    );
    const taker = anchor.web3.Keypair.generate();
    const maker = anchor.web3.Keypair.generate();
    await airdrop(maker.publicKey);
    const initialBidOwner = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), relayerFeeReceiver.publicKey.toBytes()],
      expressRelayProgram.programId
    )[0];

    for (const mint of [mintBuy, mintSell]) {
      for (const user of [taker.publicKey, maker.publicKey, initialBidOwner]) {
        const associatedToken = getAssociatedTokenAddressSync(mint, user, true);
        const transaction = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            associatedToken,
            user,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
        await sendAndConfirmTransaction(connection, transaction, [payer]);
      }
    }

    let transactionLookupTableCreation = new anchor.web3.Transaction();
    let slot = await anchor.getProvider().connection.getSlot();
    const [lookupTableInst, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot - 1,
      });
    transactionLookupTableCreation.add(lookupTableInst);
    transactionLookupTableCreation.add(
      AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: lookupTableAddress,
        addresses: [
          mintBuy,
          mintSell,
          relayerSigner.publicKey,
          relayerFeeReceiver.publicKey,
          initialBidOwner,
          getAssociatedTokenAddressSync(mintBuy, initialBidOwner, true),
          getAssociatedTokenAddressSync(mintSell, initialBidOwner, true),
          SYSVAR_INSTRUCTIONS_PUBKEY,
          getAssociatedTokenAddressSync(mintBuy, taker.publicKey),
          getAssociatedTokenAddressSync(mintSell, taker.publicKey),
        ],
      })
    );
    await anchor
      .getProvider()
      .sendAndConfirm(transactionLookupTableCreation, [payer]);
    const lookupTableAccount = (
      await anchor
        .getProvider()
        .connection.getAddressLookupTable(lookupTableAddress)
    ).value;

    let limitOrderInstruction = limitOrderProgram.methods
      .fulfillOrder()
      .accounts({
        maker: maker.publicKey,
        makerBuyTokenAccount: getAssociatedTokenAddressSync(
          mintBuy,
          maker.publicKey
        ),
        makerSellTokenAccount: getAssociatedTokenAddressSync(
          mintSell,
          maker.publicKey
        ),
        takerBuyTokenAccount: getAssociatedTokenAddressSync(
          mintBuy,
          taker.publicKey
        ),
        takerSellTokenAccount: getAssociatedTokenAddressSync(
          mintSell,
          taker.publicKey
        ),
      })
      .signers([maker]);
    const txWithoutPermission = await limitOrderInstruction.transaction();
    txWithoutPermission.feePayer = maker.publicKey;
    const txWithoutPermissionSignature = await anchor
      .getProvider()
      .connection.sendTransaction(txWithoutPermission, [maker]);
    await anchor
      .getProvider()
      .connection.confirmTransaction(txWithoutPermissionSignature);
    console.log(
      "Transaction without permission",
      txWithoutPermissionSignature,
      "length",
      txWithoutPermission.serialize().length
    );

    const latestBlockHash = await anchor
      .getProvider()
      .connection.getLatestBlockhash();
    let versionedTransaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: maker.publicKey,
        recentBlockhash: latestBlockHash.blockhash,
        instructions: [await limitOrderInstruction.instruction()],
      }).compileToV0Message([lookupTableAccount])
    );
    versionedTransaction.sign([maker]);
    const txWithoutPermissionWithLookup = await anchor
      .getProvider()
      .connection.sendTransaction(versionedTransaction);
    await anchor
      .getProvider()
      .connection.confirmTransaction(txWithoutPermissionWithLookup);
    console.log(
      "Transaction without permission with lookup table",
      txWithoutPermissionWithLookup,
      "length",
      versionedTransaction.serialize().length
    );

    await mintTo(
      connection,
      payer,
      mintBuy,
      getAssociatedTokenAddressSync(mintBuy, taker.publicKey),
      payer,
      100000,
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );
    await approve(
      connection,
      payer,
      getAssociatedTokenAddressSync(mintBuy, taker.publicKey),
      initialBidOwner,
      taker,
      2000
    );

    let userAccount = await getAccount(
      connection,
      getAssociatedTokenAddressSync(mintBuy, maker.publicKey)
    );
    console.log("User account amount:", userAccount.amount.toString());
    let permissionId = new Uint8Array(32);
    const txWithPermission = new anchor.web3.Transaction();
    txWithPermission.add(await limitOrderInstruction.instruction());
    txWithPermission.add(
      await expressRelayProgram.methods
        .permission({
          permissionId: Array.from(permissionId),
          bidAmount: new anchor.BN(1000),
        })
        .accountsPartial({
          bidToken: getAssociatedTokenAddressSync(mintBuy, taker.publicKey),
          bidProtocol: getAssociatedTokenAddressSync(
            mintBuy,
            initialBidOwner,
            true
          ),
          bidMint: mintBuy,
          bidReceiver: getAssociatedTokenAddressSync(mintBuy, maker.publicKey),
          relayerSigner: relayerSigner.publicKey,
          expressRelayMetadata: initialBidOwner,
          relayerFeeReceiver: relayerFeeReceiver.publicKey,
        })
        .instruction()
    );
    txWithPermission.feePayer = maker.publicKey;
    const txWithPermissionSignature = await anchor
      .getProvider()
      .connection.sendTransaction(txWithPermission, [maker, relayerSigner]);
    userAccount = await getAccount(
      connection,
      getAssociatedTokenAddressSync(mintBuy, maker.publicKey)
    );
    console.log("User account amount:", userAccount.amount.toString());
    console.log(
      "Transaction with permission without lookup table",
      txWithPermissionSignature,
      "length",
      txWithPermission.serialize().length
    );

    const txPermissionedV0 = new VersionedTransaction(
      new TransactionMessage({
        payerKey: maker.publicKey,
        recentBlockhash: (
          await anchor.getProvider().connection.getLatestBlockhash()
        ).blockhash,
        instructions: txWithPermission.instructions,
      }).compileToV0Message([lookupTableAccount])
    );
    txPermissionedV0.sign([maker, relayerSigner]);
    const txWithPermissionWithLookup = await anchor
      .getProvider()
      .connection.sendTransaction(txPermissionedV0);
    await anchor
      .getProvider()
      .connection.confirmTransaction(txWithPermissionWithLookup);
    console.log(
      "Transaction with permission with lookup table",
      txWithPermissionWithLookup,
      "length",
      txPermissionedV0.serialize().length
    );
  });
});
