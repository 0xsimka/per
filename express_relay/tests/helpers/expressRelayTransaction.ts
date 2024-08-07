import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  Token,
} from "@solana/spl-token";
import {
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  Connection,
  Ed25519Program,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { createSignature } from "./signature";
import { getTxSize, getVersionedTxSize } from "./size_tx";
import { convertUint8ArrayNumberArray } from "./numberArray";
import { WRAPPED_SOL_MINT } from "@kamino-finance/klend-sdk";
import { createAndPopulateLookupTable } from "./lookupTable";
import { ExpressRelay } from "../../target/types/express_relay";

export async function constructExpressRelayTransaction(
  connection: Connection,
  expressRelay: anchor.Program<ExpressRelay>,
  relayerSigner: Keypair,
  relayerFeeReceiver: Keypair,
  searcher: Keypair,
  protocol: PublicKey,
  permissionId: Uint8Array,
  bidAmount: anchor.BN,
  validUntil: anchor.BN,
  liquidationIxs: TransactionInstruction[],
  tokenAmounts: {
    sellTokens: {
      mint: PublicKey;
      amount: anchor.BN;
    }[];
    buyTokens: {
      mint: PublicKey;
      amount: anchor.BN;
    }[];
  },
  opportunityAdapter: boolean,
  additionalLookupTables: AddressLookupTableAccount[] = [],
  verbose: boolean = false
): Promise<VersionedTransaction> {
  let tokenExpectationsCollateral: PublicKey[] = tokenAmounts.buyTokens.map(
    (token) => {
      return PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token_expectation"),
          searcher.publicKey.toBuffer(),
          token.mint.toBuffer(),
        ],
        protocol
      )[0];
    }
  );
  let tokenExpectationsDebt: PublicKey[] = tokenAmounts.sellTokens.map(
    (token) => {
      return PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("token_expectation"),
          searcher.publicKey.toBuffer(),
          token.mint.toBuffer(),
        ],
        protocol
      )[0];
    }
  );

  const expressRelayAuthority = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("authority")],
    expressRelay.programId
  );
  const expressRelayMetadata = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("metadata")],
    expressRelay.programId
  );

  const tokenWsol = new Token(
    connection,
    WRAPPED_SOL_MINT,
    TOKEN_PROGRAM_ID,
    searcher
  );
  const wsolTaExpressRelay = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("ata"), WRAPPED_SOL_MINT.toBuffer()],
    expressRelay.programId
  );
  const wsolTaSearcher = await tokenWsol.getOrCreateAssociatedAccountInfo(
    searcher.publicKey
  );

  let opportunityAdapterArgs = null;
  let opportunityAdapterArgsWithMints;
  let remainingAccountsOpportunityAdapter = [];
  let tasProtocol = [];
  let atasRelayer = [];

  if (opportunityAdapter) {
    opportunityAdapterArgsWithMints = tokenAmounts;
    opportunityAdapterArgs = {
      sellTokens: tokenAmounts.sellTokens.map((token) => token.amount),
      buyTokens: tokenAmounts.buyTokens.map((token) => token.amount),
    };
    remainingAccountsOpportunityAdapter = [
      {
        pubkey: searcher.publicKey,
        isWritable: false,
        isSigner: false,
      },
      {
        pubkey: expressRelayAuthority[0],
        isWritable: false,
        isSigner: false,
      },
      {
        pubkey: TOKEN_PROGRAM_ID,
        isWritable: false,
        isSigner: false,
      },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isWritable: false,
        isSigner: false,
      },
    ];
    for (let tokenArr of [tokenAmounts.sellTokens, tokenAmounts.buyTokens]) {
      for (let i = 0; i < tokenArr.length; i++) {
        let mint = tokenArr[i].mint;
        let ataSearcher = await Token.getAssociatedTokenAddress(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          mint,
          searcher.publicKey
        );
        let tokenExpectation = PublicKey.findProgramAddressSync(
          [
            anchor.utils.bytes.utf8.encode("token_expectation"),
            searcher.publicKey.toBuffer(),
            mint.toBuffer(),
          ],
          expressRelay.programId
        );
        let ataRelayer = await Token.getAssociatedTokenAddress(
          ASSOCIATED_TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          mint,
          relayerSigner.publicKey
        );

        // this is set for ez lend ta format
        let taProtocol = PublicKey.findProgramAddressSync(
          [anchor.utils.bytes.utf8.encode("ata"), mint.toBuffer()],
          protocol
        );
        tasProtocol.push(taProtocol[0]);
        atasRelayer.push(ataRelayer);

        let accountsToken = [
          {
            pubkey: mint,
            isWritable: false,
            isSigner: false,
          },
          {
            pubkey: ataSearcher,
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey: tokenExpectation[0],
            isWritable: true,
            isSigner: false,
          },
          {
            pubkey: ataRelayer,
            isWritable: true,
            isSigner: false,
          },
        ];
        remainingAccountsOpportunityAdapter.push(...accountsToken);
      }
    }
  }

  let protocolFeeReceiver = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("express_relay_fees")],
    protocol
  );

  let protocolConfig = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("config_protocol"), protocol.toBuffer()],
    expressRelay.programId
  );

  let [signatureExpressRelay, digestExpressRelay] = await createSignature(
    protocol,
    permissionId,
    searcher,
    bidAmount,
    validUntil,
    opportunityAdapterArgsWithMints
  );
  const signatureExpressRelayFirst32 = signatureExpressRelay.slice(0, 32);
  const signatureExpressRelayLast32 = signatureExpressRelay.slice(32, 64);
  let signatureAccounting = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode("signature_accounting"),
      signatureExpressRelayFirst32,
      signatureExpressRelayLast32,
    ],
    expressRelay.programId
  );

  let permission = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode("permission"),
      protocol.toBuffer(),
      permissionId,
    ],
    expressRelay.programId
  );

  const ixPermission = await expressRelay.methods
    .permission({
      permissionId: convertUint8ArrayNumberArray(permissionId),
      validUntil: validUntil,
      bidAmount: bidAmount,
      opportunityAdapterArgs: opportunityAdapterArgs,
    })
    .accountsPartial({
      relayerSigner: relayerSigner.publicKey,
      permission: permission[0],
      protocol: protocol,
      signatureAccounting: signatureAccounting[0],
      systemProgram: anchor.web3.SystemProgram.programId,
      sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .remainingAccounts(remainingAccountsOpportunityAdapter)
    .signers([relayerSigner])
    .instruction();

  const ixDepermission = await expressRelay.methods
    .depermission()
    .accountsPartial({
      relayerSigner: relayerSigner.publicKey,
      permission: permission[0],
      user: searcher.publicKey,
      protocol: protocol,
      protocolFeeReceiver: protocolFeeReceiver[0],
      relayerFeeReceiver: relayerFeeReceiver.publicKey,
      protocolConfig: protocolConfig[0],
      expressRelayMetadata: expressRelayMetadata[0],
      wsolMint: WRAPPED_SOL_MINT,
      wsolTaUser: wsolTaSearcher.address,
      wsolTaExpressRelay: wsolTaExpressRelay[0],
      expressRelayAuthority: expressRelayAuthority[0],
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .remainingAccounts(remainingAccountsOpportunityAdapter.slice(4))
    .signers([relayerSigner])
    .instruction();

  const ixSigVerifyExpressRelay =
    anchor.web3.Ed25519Program.createInstructionWithPublicKey({
      publicKey: searcher.publicKey.toBytes(),
      message: digestExpressRelay,
      signature: signatureExpressRelay,
    });

  // create transaction
  let transaction = new anchor.web3.Transaction();

  transaction.add(ixPermission); // 48, 40 + 8
  transaction.add(ixSigVerifyExpressRelay); // 0, 136 + 8

  if (liquidationIxs.length > 0) {
    transaction.add(...liquidationIxs);
  }

  transaction.add(ixDepermission); // 120, 104 + 8

  console.log(
    "SIZE of transaction (no lookup tables): ",
    getTxSize(transaction, relayerSigner.publicKey, verbose)
  );

  const lutAccountsGlobal = [
    relayerSigner.publicKey,
    relayerFeeReceiver.publicKey,
    expressRelayMetadata[0],
    WRAPPED_SOL_MINT,
    wsolTaExpressRelay[0],
    expressRelayAuthority[0],
  ];
  const lutPrograms = [
    anchor.web3.SystemProgram.programId,
    TOKEN_PROGRAM_ID,
    anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    expressRelay.programId,
    Ed25519Program.programId,
  ];
  const lutAccountsProtocol = [
    protocol,
    protocolFeeReceiver[0],
    protocolConfig[0],
  ]
    .concat(tokenAmounts.buyTokens.map((token) => token.mint))
    .concat(tokenAmounts.sellTokens.map((token) => token.mint))
    .concat(tasProtocol)
    .concat(atasRelayer)
    .concat(tokenExpectationsCollateral)
    .concat(tokenExpectationsDebt);
  const lookupTableProtocol = await createAndPopulateLookupTable(
    connection,
    new Set(lutAccountsGlobal.concat(lutPrograms).concat(lutAccountsProtocol)),
    relayerSigner,
    relayerSigner
  );

  // construct original tx with lookup table
  const lookupTableProtocolAccount = (
    await connection.getAddressLookupTable(lookupTableProtocol)
  ).value;

  let allLookupTables = [lookupTableProtocolAccount];
  allLookupTables = allLookupTables.concat(additionalLookupTables);

  const latestBlockHash = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: relayerSigner.publicKey,
    recentBlockhash: latestBlockHash.blockhash,
    instructions: transaction.instructions, // note this is an array of instructions
  }).compileToV0Message(allLookupTables);

  // create a v0 transaction from the v0 message
  const transactionV0 = new VersionedTransaction(messageV0);
  const sizeVersionedTx = getVersionedTxSize(
    transactionV0,
    relayerSigner.publicKey,
    verbose
  );

  console.log("ESTIMATE OF versioned tx size: ", sizeVersionedTx);
  try {
    console.log("LENGTH OF versioned msg: ", messageV0.serialize().length);

    // sign the v0 transaction
    let signers;
    if (opportunityAdapter || liquidationIxs.length === 0) {
      signers = [relayerSigner];
    } else {
      signers = [relayerSigner, searcher];
    }
    transactionV0.sign(signers);

    console.log("LENGTH OF versioned tx: ", transactionV0.serialize().length);
  } catch (e) {
    console.error("ERROR, versioned tx too large: ", e);
  }

  return transactionV0;
}
