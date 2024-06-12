import Decimal from "decimal.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ExpressRelay } from "../target/types/express_relay";
import { EzLend } from "../target/types/ez_lend";
import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  // createMint,
  // createAccount,
  // getAccount,
  // getOrCreateAssociatedTokenAccount,
  // getAssociatedTokenAddress,
  // transfer,
  // approve,
  // mintTo,
  // TOKEN_PROGRAM_ID,
  // ASSOCIATED_TOKEN_PROGRAM_ID,
  // createWrappedNativeAccount,
  // createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  PublicKey,
  AddressLookupTableProgram,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  Ed25519Program,
  TransactionInstruction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { assert, config } from "chai";
import { getTxSize, getVersionedTxSize } from "./helpers/size_tx";
import { waitForNewBlock } from "./helpers/sleep";
import {
  convertWordArrayToBuffer,
  convertWordArrayToBufferOld,
  wordArrayToByteArray,
  fromWordArray,
} from "./helpers/word_array";
import { sign } from "@noble/ed25519";
import * as crypto from "crypto";

import {
  KaminoAction,
  KaminoObligation,
  VanillaObligation,
  WRAPPED_SOL_MINT,
  idl as klendIdl,
} from "@kamino-finance/klend-sdk";
import { setupMarketWithLoan } from "./kamino_helpers/fixtures";
import { Env } from "./kamino_helpers/types";
import {
  mintToUser,
  reloadMarket,
  updatePrice,
  reloadReservesAndRefreshMarket,
} from "./kamino_helpers/operations";
import { toLamports } from "./kamino_helpers/utils";
import { Price } from "./kamino_helpers/price";
import {
  getLiquidationLookupTables,
  getMarketAccounts,
  liquidateAndRedeem,
} from "./kamino_helpers/liquidate";
import {
  checkLiquidate,
  tryLiquidateObligation,
} from "./kamino_helpers/tryLiquidate";
import { createAndPopulateLookupTable } from "./helpers/lookupTable";
import { initializeFarmsForReserve } from "./kamino_helpers/kamino/initFarms";

describe("express_relay", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const expressRelay = anchor.workspace.ExpressRelay as Program<ExpressRelay>;
  const ezLend = anchor.workspace.EzLend as Program<EzLend>;
  const klendProgramId = new PublicKey(
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
  );
  // const klendProgramId = new PublicKey("3hoVgJh7XrZWyfTULgR8KkdS7PYgxhZnSbCsWGtYGgdb");

  // tx config
  const protocolLiquidate: string = "kamino"; // 'ezlend'
  const omitOpportunityAdapter: boolean = false;
  const elimIxs: string = "none";

  const provider = anchor.AnchorProvider.local();
  const LAMPORTS_PER_SOL = 1000000000;
  const payer = anchor.web3.Keypair.generate();
  const mintCollateralAuthority = anchor.web3.Keypair.generate();
  const mintDebtAuthority = anchor.web3.Keypair.generate();

  let mintCollateral;
  let mintDebt;

  let ataCollateralPayer;
  let ataDebtPayer;

  let ataCollateralRelayer;
  let ataDebtRelayer;

  let taCollateralProtocol;
  let taDebtProtocol;

  let expressRelayAuthority;

  let protocol = ezLend.programId;
  let protocolFeeReceiver;

  const relayerSigner = anchor.web3.Keypair.generate();
  const relayerFeeReceiver = anchor.web3.Keypair.generate();
  const relayerRentReceiver = anchor.web3.Keypair.generate();
  const admin = anchor.web3.Keypair.generate();

  let wsolTaUser;
  let wsolTaExpressRelay;

  let expressRelayMetadata;
  let splitProtocolDefault = new anchor.BN(5000);
  let splitRelayer = new anchor.BN(2000);

  const env: Env = {
    provider: provider,
    programId: klendProgramId,
    admin: payer,
    wallet: new anchor.Wallet(payer),
    testCase: `${Date.now().toString()}-${
      Math.floor(Math.random() * 1000000) + 1
    }`,
  };

  let kaminoMarket;
  let obligation;
  let liquidatorPath;
  let liquidator;
  let kaminoLiquidator: anchor.web3.Keypair;

  let obligPre;
  let obligPost;
  let configLiquidation;

  let ixsKaminoLiq;
  let kaminoLiquidationLookupTables;

  console.log("payer: ", payer.publicKey.toBase58());
  console.log("relayerSigner: ", relayerSigner.publicKey.toBase58());
  console.log("relayerFeeReceiver: ", relayerFeeReceiver.publicKey.toBase58());
  console.log("admin: ", admin.publicKey.toBase58());

  // set up mints, tokens, token accounts, approvals; initialize express relay
  before(async () => {
    let airdrop_signature_payer = await provider.connection.requestAirdrop(
      payer.publicKey,
      20 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop_signature_payer);

    let airdrop_signature_relayer_signer =
      await provider.connection.requestAirdrop(
        relayerSigner.publicKey,
        30 * LAMPORTS_PER_SOL
      );
    await provider.connection.confirmTransaction(
      airdrop_signature_relayer_signer
    );

    // create mints
    mintCollateral = await Token.createMint(
      provider.connection,
      payer,
      mintCollateralAuthority.publicKey,
      mintCollateralAuthority.publicKey,
      9,
      TOKEN_PROGRAM_ID
    );
    mintDebt = await Token.createMint(
      provider.connection,
      payer,
      mintDebtAuthority.publicKey,
      mintDebtAuthority.publicKey,
      9,
      TOKEN_PROGRAM_ID
    );

    protocolFeeReceiver = await PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("express_relay_fees")],
      protocol
    );

    const tokenCollateral = new Token(
      provider.connection,
      mintCollateral.publicKey,
      TOKEN_PROGRAM_ID,
      payer
    );
    const tokenDebt = new Token(
      provider.connection,
      mintDebt.publicKey,
      TOKEN_PROGRAM_ID,
      payer
    );

    // Initialize TAs
    ataCollateralPayer = await tokenCollateral.getOrCreateAssociatedAccountInfo(
      payer.publicKey
    );
    ataDebtPayer = await tokenDebt.getOrCreateAssociatedAccountInfo(
      payer.publicKey
    );
    // ataCollateralPayer = await getOrCreateAssociatedTokenAccount(
    //   provider.connection,
    //   payer,
    //   mintCollateral,
    //   payer.publicKey
    // );
    // ataDebtPayer = await getOrCreateAssociatedTokenAccount(
    //   provider.connection,
    //   payer,
    //   mintDebt,
    //   payer.publicKey
    // );
    ataCollateralRelayer = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mintCollateral.publicKey,
      relayerSigner.publicKey
    );
    ataDebtRelayer = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      mintDebt.publicKey,
      relayerSigner.publicKey
    );
    taCollateralProtocol = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("ata"),
        mintCollateral.publicKey.toBuffer(),
      ],
      protocol
    );
    taDebtProtocol = await PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("ata"), mintDebt.publicKey.toBuffer()],
      protocol
    );

    expressRelayAuthority = await PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("authority")],
      expressRelay.programId
    );

    const tokenWsol = new Token(
      provider.connection,
      WRAPPED_SOL_MINT,
      TOKEN_PROGRAM_ID,
      payer
    );
    wsolTaUser = await tokenWsol.getOrCreateAssociatedAccountInfo(
      payer.publicKey
    );
    // wsolTaUser = await getOrCreateAssociatedTokenAccount(
    //   provider.connection,
    //   payer,
    //   WRAPPED_SOL_MINT,
    //   payer.publicKey
    // );
    const fundWsolTaUserTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: wsolTaUser.address,
        lamports: 5 * LAMPORTS_PER_SOL,
      }),
      new TransactionInstruction({
        keys: [
          { pubkey: wsolTaUser.address, isSigner: false, isWritable: true },
        ],
        data: Buffer.from(new Uint8Array([17])),
        programId: TOKEN_PROGRAM_ID,
      })
      // createSyncNativeInstruction(wsolTaUser.address)
    );
    await provider.connection.sendTransaction(fundWsolTaUserTx, [payer]);
    await tokenWsol.approve(
      wsolTaUser.address,
      expressRelayAuthority[0],
      payer,
      [],
      5 * LAMPORTS_PER_SOL
    );
    // await approve(
    //   provider.connection,
    //   payer,
    //   wsolTaUser.address,
    //   expressRelayAuthority[0],
    //   payer.publicKey,
    //   5 * LAMPORTS_PER_SOL
    // );

    wsolTaExpressRelay = await PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("ata"), WRAPPED_SOL_MINT.toBuffer()],
      expressRelay.programId
    );

    expressRelayMetadata = await PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("metadata")],
      expressRelay.programId
    );

    const tx_collateral_ta = await ezLend.methods
      .createTokenAcc({})
      .accounts({
        payer: payer.publicKey,
        mint: mintCollateral.publicKey,
        tokenAccount: taCollateralProtocol[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const tx_debt_ta = await ezLend.methods
      .createTokenAcc({})
      .accounts({
        payer: payer.publicKey,
        mint: mintDebt.publicKey,
        tokenAccount: taDebtProtocol[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // (collateral, payer)
    await tokenCollateral.mintTo(
      ataCollateralPayer.address,
      mintCollateralAuthority,
      [],
      1000
    );

    // await mintTo(
    //   provider.connection,
    //   payer,
    //   mintCollateral,
    //   ataCollateralPayer.address,
    //   mintCollateralAuthority,
    //   1000,
    //   [],
    //   undefined,
    //   TOKEN_PROGRAM_ID
    // );
    // (debt, payer)
    await tokenDebt.mintTo(ataDebtPayer.address, mintDebtAuthority, [], 1000);

    // await mintTo(
    //   provider.connection,
    //   payer,
    //   mintDebt.publicKey,
    //   ataDebtPayer.address,
    //   mintDebt.publicKeyAuthority,
    //   1000,
    //   [],
    //   undefined,
    //   TOKEN_PROGRAM_ID
    // );

    // (collateral, protocol)
    await tokenCollateral.mintTo(
      taCollateralProtocol[0],
      mintCollateralAuthority,
      [],
      10000
    );
    // await mintTo(
    //   provider.connection,
    //   payer,
    //   mintCollateral,
    //   taCollateralProtocol[0],
    //   mintCollateralAuthority,
    //   10000,
    //   [],
    //   undefined,
    //   TOKEN_PROGRAM_ID
    // );
    // (debt, protocol)
    await tokenDebt.mintTo(taDebtProtocol[0], mintDebtAuthority, [], 10000);
    // await mintTo(
    //   provider.connection,
    //   payer,
    //   mintDebt.publicKey,
    //   taDebtProtocol[0],
    //   mintDebt.publicKeyAuthority,
    //   10000,
    //   [],
    //   undefined,
    //   TOKEN_PROGRAM_ID
    // );

    // approve user's tokens to express relay
    await tokenCollateral.approve(
      ataCollateralPayer.address,
      expressRelayAuthority[0],
      payer,
      [],
      1000
    );
    // await approve(
    //   provider.connection,
    //   payer,
    //   ataCollateralPayer.address,
    //   expressRelayAuthority[0],
    //   payer.publicKey,
    //   1000
    // );
    await tokenDebt.approve(
      ataDebtPayer.address,
      expressRelayAuthority[0],
      payer,
      [],
      10000
    );
    // await approve(
    //   provider.connection,
    //   payer,
    //   ataDebtPayer.address,
    //   expressRelayAuthority[0],
    //   payer.publicKey,
    //   10000
    // );

    await expressRelay.methods
      .initialize({
        splitProtocolDefault: splitProtocolDefault,
        splitRelayer: splitRelayer,
      })
      .accounts({
        payer: relayerSigner.publicKey,
        expressRelayMetadata: expressRelayMetadata[0],
        admin: admin.publicKey,
        relayerSigner: relayerSigner.publicKey,
        relayerFeeReceiver: relayerFeeReceiver.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([relayerSigner])
      .rpc();
  });

  // set up klend market and obligation, undercollateralize by pulling price down
  before(async () => {
    let { kaminoMarket, obligation, liquidatorPath, liquidator } =
      await setupMarketWithLoan({
        loan: {
          deposits: [["USDC", "130"]],
          borrows: [["SOL", "4"]],
        },
        reserves: [
          ["USDC", "2000"],
          ["SOL", "2000"],
          ["USDH", "2000"],
        ],
        env: env,
      });

    initializeFarmsForReserve(
      env,
      new PublicKey(kaminoMarket.address),
      new PublicKey(kaminoMarket.getReserveBySymbol("USDC").address),
      "Collateral"
    );
    initializeFarmsForReserve(
      env,
      new PublicKey(kaminoMarket.address),
      new PublicKey(kaminoMarket.getReserveBySymbol("SOL").address),
      "Debt"
    );

    const overrides = {
      thresholdBufferFactor: new Decimal("1"),
      liquidationMethod: undefined,
      ignoreNegativeProfit: false,
    };
    configLiquidation = {
      maxObligationRetries: 0,
      txConfig: {},
      slippageConfig: {
        pxSlippageBps: 10,
        swapSlippageBps: 50,
      },
      overrides: overrides,
    };
    let marketAccs = await getMarketAccounts(
      provider.connection,
      "localnet",
      klendProgramId,
      new PublicKey(kaminoMarket.address),
      configLiquidation,
      []
    );
    let { reserveAutodeleverageStatus } = marketAccs;

    obligPre = await kaminoMarket.getObligationByAddress(obligation);

    let liquidationScenarioPre = tryLiquidateObligation(
      kaminoMarket,
      reserveAutodeleverageStatus,
      obligPre,
      new Decimal("1")
    );
    console.log("LIQUIDATION SCENARIO PRE: ", liquidationScenarioPre);

    // give the liquidator enough USDC to not need to flash borrow
    await mintToUser(
      env,
      kaminoMarket.getReserveBySymbol("USDC")!.getLiquidityMint(),
      liquidator.publicKey,
      toLamports(200, 6),
      liquidator
    );

    await reloadMarket(env, kaminoMarket);

    await updatePrice(
      env,
      kaminoMarket.getReserveBySymbol("SOL")!,
      Price.SOL_USD_30
    );
    await reloadReservesAndRefreshMarket(env, kaminoMarket);

    console.log("kaminoMarket: ", kaminoMarket);
    console.log("obligation: ", obligation);
    console.log("liquidatorPath: ", liquidatorPath);
    console.log("liquidator: ", liquidator);
    console.log("GOT THROUGH THE KAMINO SETUP");

    obligPost = await kaminoMarket.getObligationByAddress(obligation);

    let runCheckPost = checkLiquidate(
      kaminoMarket,
      obligPost,
      new Decimal("1")
    );
    console.log(runCheckPost);
    let liquidationScenarioPost = tryLiquidateObligation(
      kaminoMarket,
      reserveAutodeleverageStatus,
      obligPost,
      new Decimal("1")
    );
    //   console.log("LIQUIDATION SCENARIO Post: ", liquidationScenarioPost);
    // });

    // it("Liquidate the Kamino obligation", async () => {
    let liquidationAmount: number = 4;
    ixsKaminoLiq = await liquidateAndRedeem(
      kaminoMarket,
      liquidator,
      liquidationAmount,
      kaminoMarket.getReserveBySymbol("SOL"),
      kaminoMarket.getReserveBySymbol("USDC"),
      obligPost,
      configLiquidation,
      elimIxs
    );

    kaminoLiquidator = liquidator;

    kaminoLiquidationLookupTables = await getLiquidationLookupTables(
      provider.connection,
      klendProgramId,
      new PublicKey(kaminoMarket.address),
      liquidator
    );
  });

  it("Create and liquidate vault", async () => {
    let vault_id_BN = new anchor.BN(0);
    let collateral_amount = new anchor.BN(100);
    let debt_amount = new anchor.BN(50);

    // get token balances pre
    let balance_collateral_payer_0 = Number(
      (
        await provider.connection.getTokenAccountBalance(
          ataCollateralPayer.address
        )
      ).value.amount
    );
    let balance_debt_payer_0 = Number(
      (await provider.connection.getTokenAccountBalance(ataDebtPayer.address))
        .value.amount
    );
    let balance_collateral_protocol_0 = Number(
      (
        await provider.connection.getTokenAccountBalance(
          taCollateralProtocol[0]
        )
      ).value.amount
    );
    let balance_debt_protocol_0 = Number(
      (await provider.connection.getTokenAccountBalance(taDebtProtocol[0]))
        .value.amount
    );

    // convert the vault id to a bytearray
    let vault_id_bytes = new Uint8Array(32);
    vault_id_bytes.set(vault_id_BN.toArrayLike(Buffer, "le", 32), 0);
    let vault = await PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("vault"), vault_id_bytes],
      protocol
    );

    const tx_create_vault = await ezLend.methods
      .createVault({
        vaultId: vault_id_bytes,
        collateralAmount: collateral_amount,
        debtAmount: debt_amount,
      })
      .accounts({
        vault: vault[0],
        payer: payer.publicKey,
        collateralMint: mintCollateral.publicKey,
        debtMint: mintDebt.publicKey,
        collateralAtaPayer: ataCollateralPayer.address,
        collateralTaProgram: taCollateralProtocol[0],
        debtAtaPayer: ataDebtPayer.address,
        debtTaProgram: taDebtProtocol[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // get token balances post creation
    let balance_collateral_payer_1 = Number(
      (
        await provider.connection.getTokenAccountBalance(
          ataCollateralPayer.address
        )
      ).value.amount
    );
    let balance_debt_payer_1 = Number(
      (await provider.connection.getTokenAccountBalance(ataDebtPayer.address))
        .value.amount
    );
    let balance_collateral_protocol_1 = Number(
      (
        await provider.connection.getTokenAccountBalance(
          taCollateralProtocol[0]
        )
      ).value.amount
    );
    let balance_debt_protocol_1 = Number(
      (await provider.connection.getTokenAccountBalance(taDebtProtocol[0]))
        .value.amount
    );

    let permission = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("permission"),
        protocol.toBuffer(),
        vault_id_bytes,
      ],
      expressRelay.programId
    );

    let collateralAtaPayer;
    let debtAtaPayer;
    let liquidatorEzLend;
    if (omitOpportunityAdapter) {
      liquidatorEzLend = payer;
      collateralAtaPayer = ataCollateralPayer.address;
      debtAtaPayer = ataDebtPayer.address;
    } else {
      liquidatorEzLend = relayerSigner;
      collateralAtaPayer = ataCollateralRelayer;
      debtAtaPayer = ataDebtRelayer;
    }

    const ixLiquidate = await ezLend.methods
      .liquidate({
        vaultId: vault_id_bytes,
      })
      .accounts({
        vault: vault[0],
        payer: liquidatorEzLend.publicKey,
        // payer: payer.publicKey,
        collateralMint: mintCollateral.publicKey,
        debtMint: mintDebt.publicKey,
        collateralAtaPayer: collateralAtaPayer,
        // collateralAtaPayer: ataCollateralPayer.address,
        collateralTaProgram: taCollateralProtocol[0],
        debtAtaPayer: debtAtaPayer,
        // debtAtaPayer: ataDebtPayer.address,
        debtTaProgram: taDebtProtocol[0],
        permission: permission[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([liquidatorEzLend])
      .instruction();

    let bidId: Uint8Array = new Uint8Array(16);
    let bidAmount = new anchor.BN(100_000_000);

    let protocolConfig = await PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("config_protocol"), protocol.toBuffer()],
      expressRelay.programId
    );

    const validUntilExpressRelay = new anchor.BN(200_000_000_000_000);

    let tokenExpectationCollateral = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("token_expectation"),
        payer.publicKey.toBuffer(),
        mintCollateral.publicKey.toBuffer(),
      ],
      expressRelay.programId
    );

    let tokenExpectationDebt = await PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("token_expectation"),
        payer.publicKey.toBuffer(),
        mintDebt.publicKey.toBuffer(),
      ],
      expressRelay.programId
    );

    const buyTokens = [collateral_amount];
    const buyMints = [mintCollateral.publicKey];
    const sellTokens = [debt_amount];
    const sellMints = [mintDebt.publicKey];

    let opportunityAdapterArgs;
    let remainingAccountsOpportunityAdapter;
    if (omitOpportunityAdapter) {
      opportunityAdapterArgs = null;
      remainingAccountsOpportunityAdapter = [];
    } else {
      opportunityAdapterArgs = {
        sellTokens: sellTokens,
        buyTokens: buyTokens,
      };
      remainingAccountsOpportunityAdapter = [
        {
          pubkey: payer.publicKey,
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
        {
          pubkey: mintDebt.publicKey,
          isWritable: false,
          isSigner: false,
        },
        {
          pubkey: ataDebtPayer.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: tokenExpectationDebt[0],
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: ataDebtRelayer,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: mintCollateral.publicKey,
          isWritable: false,
          isSigner: false,
        },
        {
          pubkey: ataCollateralPayer.address,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: tokenExpectationCollateral[0],
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: ataCollateralRelayer,
          isWritable: true,
          isSigner: false,
        },
      ];
    }

    const msgExpressRelay1 = Uint8Array.from(protocol.toBuffer());
    const msgExpressRelay2 = Uint8Array.from(vault_id_bytes);
    const msgExpressRelay3 = Uint8Array.from(payer.publicKey.toBuffer());
    const msgExpressRelay4 = Uint8Array.from(
      bidAmount.toArrayLike(Buffer, "le", 8)
    );
    const msgExpressRelay5 = Uint8Array.from(
      validUntilExpressRelay.toArrayLike(Buffer, "le", 8)
    );
    let msgOpportunityAdapter1 = new Uint8Array(2);
    msgOpportunityAdapter1[0] = buyTokens.length;
    msgOpportunityAdapter1[1] = sellTokens.length;
    let msgOpportunityAdapter2 = new Uint8Array(40 * buyTokens.length);
    for (let i = 0; i < buyTokens.length; i++) {
      msgOpportunityAdapter2.set(buyMints[i].toBuffer(), i * 40);
      msgOpportunityAdapter2.set(buyTokens[i].toBuffer(), i * 40 + 32);
    }
    let msgOpportunityAdapter3 = new Uint8Array(40 * sellTokens.length);
    for (let i = 0; i < sellTokens.length; i++) {
      msgOpportunityAdapter3.set(sellMints[i].toBuffer(), i * 40);
      msgOpportunityAdapter3.set(sellTokens[i].toBuffer(), i * 40 + 32);
    }
    let msgExpressRelay;
    if (omitOpportunityAdapter) {
      msgExpressRelay = Buffer.concat([
        msgExpressRelay1,
        msgExpressRelay2,
        msgExpressRelay3,
        msgExpressRelay4,
        msgExpressRelay5,
      ]);
    } else {
      msgExpressRelay = Buffer.concat([
        msgExpressRelay1,
        msgExpressRelay2,
        msgExpressRelay3,
        msgExpressRelay4,
        msgExpressRelay5,
        msgOpportunityAdapter1,
        msgOpportunityAdapter2,
        msgOpportunityAdapter3,
      ]);
    }
    const digestExpressRelay = Buffer.from(
      await crypto.subtle.digest("SHA-256", msgExpressRelay)
    );
    const signatureExpressRelay = await sign(
      digestExpressRelay,
      payer.secretKey.slice(0, 32)
    );
    const signatureExpressRelayFirst32 = signatureExpressRelay.slice(0, 32);
    const signatureExpressRelayLast32 = signatureExpressRelay.slice(32, 64);
    let signatureAccountingExpressRelay =
      await PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode("signature_accounting"),
          signatureExpressRelayFirst32,
          signatureExpressRelayLast32,
        ],
        expressRelay.programId
      );

    const ixPermission = await expressRelay.methods
      .permission({
        permissionId: vault_id_bytes,
        validUntil: validUntilExpressRelay,
        // bidId: bidId,
        bidAmount: bidAmount,
        opportunityAdapterArgs: opportunityAdapterArgs,
      })
      .accounts({
        relayerSigner: relayerSigner.publicKey,
        permission: permission[0],
        protocol: protocol,
        signatureAccounting: signatureAccountingExpressRelay[0],
        systemProgram: anchor.web3.SystemProgram.programId,
        sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(remainingAccountsOpportunityAdapter)
      .signers([relayerSigner])
      .instruction();

    const ixDepermission = await expressRelay.methods
      .depermission()
      .accounts({
        relayerSigner: relayerSigner.publicKey,
        permission: permission[0],
        user: payer.publicKey,
        protocol: protocol,
        protocolFeeReceiver: protocolFeeReceiver[0],
        relayerFeeReceiver: relayerFeeReceiver.publicKey,
        protocolConfig: protocolConfig[0],
        expressRelayMetadata: expressRelayMetadata[0],
        wsolMint: WRAPPED_SOL_MINT,
        wsolTaUser: wsolTaUser.address,
        wsolTaExpressRelay: wsolTaExpressRelay[0],
        expressRelayAuthority: expressRelayAuthority[0],
        signatureAccounting: signatureAccountingExpressRelay[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        sysvarInstructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(remainingAccountsOpportunityAdapter.slice(4))
      .signers([relayerSigner])
      .instruction();

    const ixSigVerifyExpressRelay =
      anchor.web3.Ed25519Program.createInstructionWithPublicKey({
        publicKey: payer.publicKey.toBytes(),
        message: digestExpressRelay,
        signature: signatureExpressRelay,
      });

    // create transaction
    let transaction = new anchor.web3.Transaction();

    transaction.add(ixPermission); // 48, 40 + 8
    transaction.add(ixSigVerifyExpressRelay); // 0, 136 + 8

    if (protocolLiquidate == "ezlend") {
      // ez lend
      transaction.add(ixLiquidate); // 88, 32 + 8
    } else if (protocolLiquidate == "kamino") {
      // kamino lend
      transaction.add(...ixsKaminoLiq);
    } else if (protocolLiquidate == "none") {
    } else {
      throw new Error("Invalid protocol liquidation");
    }

    transaction.add(ixDepermission); // 120, 104 + 8

    let solProtocolPre = await provider.connection.getBalance(
      protocolFeeReceiver[0]
    );
    let solRelayerRentReceiverPre = await provider.connection.getBalance(
      relayerRentReceiver.publicKey
    );
    let solRelayerFeeReceiverPre = await provider.connection.getBalance(
      relayerFeeReceiver.publicKey
    );
    let solExpressRelayPre = await provider.connection.getBalance(
      expressRelayMetadata[0]
    );

    console.log(
      "SIZE of transaction (no lookup tables): ",
      getTxSize(transaction, relayerSigner.publicKey)
    );

    // get lookup table accounts
    const accountsGlobal = new Set<PublicKey>();
    const accountsProtocol = new Set<PublicKey>();

    // globals
    accountsGlobal.add(relayerSigner.publicKey);
    accountsGlobal.add(relayerFeeReceiver.publicKey);
    accountsGlobal.add(relayerRentReceiver.publicKey);
    accountsGlobal.add(expressRelayMetadata[0]);
    accountsGlobal.add(WRAPPED_SOL_MINT);
    accountsGlobal.add(wsolTaExpressRelay[0]);
    accountsGlobal.add(expressRelayAuthority[0]);

    // programs
    accountsGlobal.add(anchor.web3.SystemProgram.programId);
    accountsGlobal.add(TOKEN_PROGRAM_ID);
    accountsGlobal.add(anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY);
    accountsGlobal.add(ASSOCIATED_TOKEN_PROGRAM_ID);
    accountsGlobal.add(expressRelay.programId);
    accountsGlobal.add(Ed25519Program.programId);

    // per protocol
    accountsProtocol.add(protocol);
    accountsProtocol.add(protocolFeeReceiver[0]);
    accountsProtocol.add(protocolConfig[0]);
    accountsProtocol.add(mintCollateral.publicKey);
    accountsProtocol.add(mintDebt.publicKey);
    accountsProtocol.add(taCollateralProtocol[0]);
    accountsProtocol.add(taDebtProtocol[0]);
    accountsProtocol.add(ataCollateralRelayer);
    accountsProtocol.add(ataDebtRelayer);
    accountsProtocol.add(tokenExpectationCollateral[0]);
    accountsProtocol.add(tokenExpectationDebt[0]);
    // could potentially add tokenExpectationCollateral and tokenExpectationDebt if still doesn't fit

    console.log("LENGTH OF ACCOUNTS (GLOBAL): ", accountsGlobal.size);
    console.log("LENGTH OF ACCOUNTS (PROTOCOL): ", accountsProtocol.size);

    // create Lookup tables
    const lookupTableGlobal = await createAndPopulateLookupTable(
      provider.connection,
      accountsGlobal,
      relayerSigner,
      relayerSigner
    );
    const lookupTableProtocol = await createAndPopulateLookupTable(
      provider.connection,
      accountsProtocol,
      relayerSigner,
      relayerSigner
    );

    // construct original tx with lookup table
    const lookupTableGlobalAccount = (
      await provider.connection.getAddressLookupTable(lookupTableGlobal)
    ).value;
    const lookupTableProtocolAccount = (
      await provider.connection.getAddressLookupTable(lookupTableProtocol)
    ).value;

    let allLookupTables = [
      lookupTableGlobalAccount,
      lookupTableProtocolAccount,
    ];

    if (protocolLiquidate == "kamino") {
      allLookupTables = allLookupTables.concat(kaminoLiquidationLookupTables);
    }

    const latestBlockHash = await provider.connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: relayerSigner.publicKey,
      recentBlockhash: latestBlockHash.blockhash,
      instructions: transaction.instructions, // note this is an array of instructions
    }).compileToV0Message(allLookupTables);

    // create a v0 transaction from the v0 message
    const transactionV0 = new VersionedTransaction(messageV0);
    console.log(
      "JSON Stringified tx (legacy) object: ",
      JSON.stringify(transaction)
    );
    console.log(
      "JSON Stringified tx (V0) object: ",
      JSON.stringify(transactionV0)
    );
    const sizeVersionedTx = getVersionedTxSize(
      transactionV0,
      relayerSigner.publicKey
    );

    console.log("ESTIMATE OF versioned tx size: ", sizeVersionedTx);
    console.log("LENGTH OF versioned msg: ", messageV0.serialize().length);

    // sign the v0 transaction
    if (omitOpportunityAdapter && protocolLiquidate == "ezlend") {
      transactionV0.sign([relayerSigner, liquidatorEzLend]);
    } else if (omitOpportunityAdapter && protocolLiquidate == "kamino") {
      transactionV0.sign([relayerSigner, kaminoLiquidator]);
    } else if (omitOpportunityAdapter) {
      transactionV0.sign([relayerSigner, payer]);
    } else {
      transactionV0.sign([relayerSigner]);
    }

    console.log("LENGTH OF versioned tx: ", transactionV0.serialize().length);

    // send and confirm the transaction
    // const txResponse = await provider.connection.sendTransaction(transactionV0); // {skipPreflight: true}
    const txResponse = await sendAndConfirmTransaction(
      provider.connection,
      transactionV0
    ).catch((err) => {
      console.log(err);
    }); // {skipPreflight: true}

    let solProtocolPost = await provider.connection.getBalance(
      protocolFeeReceiver[0]
    );
    let solRelayerRentReceiverPost = await provider.connection.getBalance(
      relayerRentReceiver.publicKey
    );
    let solRelayerFeeReceiverPost = await provider.connection.getBalance(
      relayerFeeReceiver.publicKey
    );
    let solExpressRelayPost = await provider.connection.getBalance(
      expressRelayMetadata[0]
    );

    // get token balances post liquidation
    let balance_collateral_payer_2 = Number(
      (
        await provider.connection.getTokenAccountBalance(
          ataCollateralPayer.address
        )
      ).value.amount
    );
    let balance_debt_payer_2 = Number(
      (await provider.connection.getTokenAccountBalance(ataDebtPayer.address))
        .value.amount
    );
    let balance_collateral_protocol_2 = Number(
      (
        await provider.connection.getTokenAccountBalance(
          taCollateralProtocol[0]
        )
      ).value.amount
    );
    let balance_debt_protocol_2 = Number(
      (await provider.connection.getTokenAccountBalance(taDebtProtocol[0]))
        .value.amount
    );

    console.log("TX RESPONSE", txResponse);

    assert(
      balance_collateral_payer_1 ==
        balance_collateral_payer_0 - collateral_amount.toNumber()
    );
    assert(
      balance_debt_payer_1 == balance_debt_payer_0 + debt_amount.toNumber()
    );
    assert(
      balance_collateral_protocol_1 ==
        balance_collateral_protocol_0 + collateral_amount.toNumber()
    );
    assert(
      balance_debt_protocol_1 ==
        balance_debt_protocol_0 - debt_amount.toNumber()
    );

    console.log(
      "BALANCES, COLLATERAL, USER",
      balance_collateral_payer_2,
      balance_collateral_payer_1,
      collateral_amount
    );
    console.log(
      "BALANCES, DEBT, USER",
      balance_debt_payer_2,
      balance_debt_payer_1,
      debt_amount
    );
    console.log(
      "BALANCES, COLLATERAL, PROTOCOL",
      balance_collateral_protocol_2,
      balance_collateral_protocol_1,
      collateral_amount
    );
    console.log(
      "BALANCES, DEBT, PROTOCOL",
      balance_debt_protocol_2,
      balance_debt_protocol_1,
      debt_amount
    );
    assert(
      balance_collateral_payer_2 ==
        balance_collateral_payer_1 + collateral_amount.toNumber()
    );
    assert(
      balance_debt_payer_2 == balance_debt_payer_1 - debt_amount.toNumber()
    );
    assert(
      balance_collateral_protocol_2 ==
        balance_collateral_protocol_1 - collateral_amount.toNumber()
    );
    assert(
      balance_debt_protocol_2 ==
        balance_debt_protocol_1 + debt_amount.toNumber()
    );
  });
});
