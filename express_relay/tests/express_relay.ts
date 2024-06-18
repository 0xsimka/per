import Decimal from "decimal.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ExpressRelay } from "../target/types/express_relay";
import { EzLend } from "../target/types/ez_lend";
import {
  Token,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
  Ed25519Program,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { getTxSize, getVersionedTxSize } from "./helpers/size_tx";
import { createSignature } from "./helpers/signature";
import { convertUint8ArrayNumberArray } from "./helpers/numberArray";
import {
  writeKeypairToFile,
  readKeypairFromFile,
} from "./helpers/keypairUtils";
import * as fs from "fs";
import { setLogLevel, LogLevel } from "./helpers/console";

import {
  WRAPPED_SOL_MINT,
  getTokenAccountBalance,
} from "@kamino-finance/klend-sdk";
import { setupMarketWithLoan } from "./kamino_helpers/fixtures";
import { Env, TokenCount } from "./kamino_helpers/types";
import {
  mintToUser,
  reloadMarket,
  updatePrice,
  reloadReservesAndRefreshMarket,
} from "./kamino_helpers/operations";
import {
  constructAndSendVersionedTransaction,
  sendAndConfirmVersionedTransaction,
  toLamports,
} from "./kamino_helpers/utils";
import { Price } from "./kamino_helpers/price";
import {
  getLiquidationLookupTables,
  getMarketAccounts,
  liquidateAndRedeem,
  swapAndLiquidate,
} from "./kamino_helpers/liquidate";
import { createAndPopulateLookupTable } from "./helpers/lookupTable";
import { initializeFarmsForReserve } from "./kamino_helpers/kamino/initFarms";
import { constructExpressRelayTransaction } from "./helpers/expressRelayTransaction";
import { constructAndSendEzLendLiquidateTransaction } from "./helpers/ezLendTransaction";
import { LAMPORTS_PER_SOL } from "./kamino_helpers/constants";
import { aggregateUserTokenInfo } from "./kamino_helpers/swap";
import { getTokensOracleData } from "./kamino_helpers/oracle";
import { getWalletBalances } from "./kamino_helpers/wallet";
import { Jupiter } from "./kamino_helpers/jupiter";

// args
// set log-level to "debug" to see all logs; set to "log" or "error" to see only subset
// set kamino-elim-ixs to "none" to include all Kamino ixs; set to "initFarm" to eliminate all initFarm ixs; set to "farm" to eliminate all farm ixs
const args = process.argv.slice(7);
const indexLogLevel = args.indexOf("--log-level") + 1;
const indexKaminoElimIxs = args.indexOf("--kamino-elim-ixs") + 1;
const logLevel = args[indexLogLevel] as LogLevel;
const kaminoElimIxs = args[indexKaminoElimIxs];

global.logLevel = logLevel;

setLogLevel();

describe("express_relay", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const expressRelay = anchor.workspace.ExpressRelay as Program<ExpressRelay>;
  const ezLend = anchor.workspace.EzLend as Program<EzLend>;
  const klendProgramId = new PublicKey(
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
  );

  const provider = anchor.AnchorProvider.local();
  const searcher = anchor.web3.Keypair.generate();
  const mintCollateralAuthority = anchor.web3.Keypair.generate();
  const mintDebtAuthority = anchor.web3.Keypair.generate();

  // ezLend vault params
  let vaultIdEzLend1;
  let vaultIdEzLend1Seed;
  let vaultIdEzLend2;
  let vaultIdEzLend2Seed;
  let vaultEzLend1;
  let vaultEzLend2;
  let permissionEzLend1;
  let permissionEzLend2;
  const collateralAmountEzLend = new anchor.BN(100);
  const debtAmountEzLend = new anchor.BN(50);

  let mintCollateral;
  let mintDebt;

  let ataCollateralSearcher;
  let ataDebtSearcher;

  let ataCollateralRelayer;
  let ataDebtRelayer;

  let taCollateralProtocol;
  let taDebtProtocol;

  const expressRelayAuthority = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("authority")],
    expressRelay.programId
  );

  let ezLendFeeReceiver;

  const tokenWsol = new Token(
    provider.connection,
    WRAPPED_SOL_MINT,
    TOKEN_PROGRAM_ID,
    searcher
  );
  const wsolTaExpressRelay = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("ata"), WRAPPED_SOL_MINT.toBuffer()],
    expressRelay.programId
  );
  let wsolTaSearcher;

  const expressRelayMetadata = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode("metadata")],
    expressRelay.programId
  );
  let splitProtocolDefault = new anchor.BN(5000);
  let splitRelayer = new anchor.BN(2000);

  const env: Env = {
    provider: provider,
    programId: klendProgramId,
    admin: searcher,
    wallet: new anchor.Wallet(searcher),
    testCase: `${Date.now().toString()}-${
      Math.floor(Math.random() * 1000000) + 1
    }`,
  };

  let oblig;
  let configLiquidation;

  let ixsKaminoLiq;
  let kaminoLiquidationLookupTables;

  let kaminoMarketVar;
  let obligationVar;
  let liquidatorPathVar;
  let liquidatorVar;

  let liquidityTokenMintsVar;
  let tokensOracleVar;

  let relayerSigner;
  let relayerFeeReceiver;
  let admin;

  // get relayer and admin keypairs
  before(async () => {
    if (!fs.existsSync("tests/keys/relayerSigner.json")) {
      relayerSigner = anchor.web3.Keypair.generate();
      await writeKeypairToFile(
        relayerSigner.secretKey,
        "tests/keys/relayerSigner.json"
      );
    } else {
      relayerSigner = await readKeypairFromFile(
        "tests/keys/relayerSigner.json"
      );
    }

    if (!fs.existsSync("tests/keys/relayerFeeReceiver.json")) {
      relayerFeeReceiver = anchor.web3.Keypair.generate();
      await writeKeypairToFile(
        relayerFeeReceiver.secretKey,
        "tests/keys/relayerFeeReceiver.json"
      );
    } else {
      relayerFeeReceiver = await readKeypairFromFile(
        "tests/keys/relayerFeeReceiver.json"
      );
    }

    if (!fs.existsSync("tests/keys/admin.json")) {
      admin = anchor.web3.Keypair.generate();
      await writeKeypairToFile(admin.secretKey, "tests/keys/admin.json");
    } else {
      admin = await readKeypairFromFile("tests/keys/admin.json");
    }

    console.log("searcher: ", searcher.publicKey.toBase58());
    console.log("relayerSigner: ", relayerSigner.publicKey.toBase58());
    console.log(
      "relayerFeeReceiver: ",
      relayerFeeReceiver.publicKey.toBase58()
    );
    console.log("admin: ", admin.publicKey.toBase58());
  });

  // fund wallets
  before(async () => {
    let airdropSignatureSearcher = await provider.connection.requestAirdrop(
      searcher.publicKey,
      20 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignatureSearcher);

    let airdrop_signature_relayer_signer =
      await provider.connection.requestAirdrop(
        relayerSigner.publicKey,
        30 * LAMPORTS_PER_SOL
      );
    await provider.connection.confirmTransaction(
      airdrop_signature_relayer_signer
    );
  });

  // initialize express relay
  before(async () => {
    const balanceExpressRelayMetadata = await provider.connection.getBalance(
      expressRelayMetadata[0]
    );
    if (balanceExpressRelayMetadata === 0) {
      await expressRelay.methods
        .initialize({
          splitProtocolDefault: splitProtocolDefault,
          splitRelayer: splitRelayer,
        })
        .accountsPartial({
          payer: relayerSigner.publicKey,
          expressRelayMetadata: expressRelayMetadata[0],
          admin: admin.publicKey,
          relayerSigner: relayerSigner.publicKey,
          relayerFeeReceiver: relayerFeeReceiver.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([relayerSigner])
        .rpc();
    } else {
      console.debug("Express Relay already initialized");
    }
  });

  // set up EzLend--mints, tokens, token accounts, approvals
  before(async () => {
    // create mints
    mintCollateral = await Token.createMint(
      provider.connection,
      searcher,
      mintCollateralAuthority.publicKey,
      mintCollateralAuthority.publicKey,
      9,
      TOKEN_PROGRAM_ID
    );
    mintDebt = await Token.createMint(
      provider.connection,
      searcher,
      mintDebtAuthority.publicKey,
      mintDebtAuthority.publicKey,
      9,
      TOKEN_PROGRAM_ID
    );

    ezLendFeeReceiver = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("express_relay_fees")],
      ezLend.programId
    );

    const tokenCollateral = new Token(
      provider.connection,
      mintCollateral.publicKey,
      TOKEN_PROGRAM_ID,
      searcher
    );
    const tokenDebt = new Token(
      provider.connection,
      mintDebt.publicKey,
      TOKEN_PROGRAM_ID,
      searcher
    );

    // Initialize TAs
    ataCollateralSearcher =
      await tokenCollateral.getOrCreateAssociatedAccountInfo(
        searcher.publicKey
      );
    ataDebtSearcher = await tokenDebt.getOrCreateAssociatedAccountInfo(
      searcher.publicKey
    );
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
    taCollateralProtocol = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("ata"),
        mintCollateral.publicKey.toBuffer(),
      ],
      ezLend.programId
    );
    taDebtProtocol = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("ata"), mintDebt.publicKey.toBuffer()],
      ezLend.programId
    );

    wsolTaSearcher = await tokenWsol.getOrCreateAssociatedAccountInfo(
      searcher.publicKey
    );
    const fundWsolTaSearcherTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: searcher.publicKey,
        toPubkey: wsolTaSearcher.address,
        lamports: 5 * LAMPORTS_PER_SOL,
      }),
      new TransactionInstruction({
        keys: [
          { pubkey: wsolTaSearcher.address, isSigner: false, isWritable: true },
        ],
        data: Buffer.from(new Uint8Array([17])),
        programId: TOKEN_PROGRAM_ID,
      })
    );
    await provider.connection.sendTransaction(fundWsolTaSearcherTx, [searcher]);
    await tokenWsol.approve(
      wsolTaSearcher.address,
      expressRelayAuthority[0],
      searcher,
      [],
      5 * LAMPORTS_PER_SOL
    );

    // create protocol collateral ATA via EzLend method
    await ezLend.methods
      .createTokenAcc({})
      .accountsPartial({
        payer: searcher.publicKey,
        mint: mintCollateral.publicKey,
        tokenAccount: taCollateralProtocol[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([searcher])
      .rpc();

    // create protocol ATAs via EzLend method if needed
    let balanceTaDebtProtocol = await provider.connection.getBalance(
      taDebtProtocol[0]
    );
    let balanceTaCollateralProtocol = await provider.connection.getBalance(
      taCollateralProtocol[0]
    );

    if (balanceTaDebtProtocol === 0) {
      await ezLend.methods
        .createTokenAcc({})
        .accountsPartial({
          payer: searcher.publicKey,
          mint: mintDebt.publicKey,
          tokenAccount: taDebtProtocol[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([searcher])
        .rpc();
    }
    if (balanceTaCollateralProtocol === 0) {
      await ezLend.methods
        .createTokenAcc({})
        .accountsPartial({
          payer: searcher.publicKey,
          mint: mintCollateral.publicKey,
          tokenAccount: taCollateralProtocol[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([searcher])
        .rpc();
    }

    // increment vaultIdEzLend1 until uninitialized vault
    vaultIdEzLend1 = null;
    let balanceVault = null;
    while (balanceVault != 0) {
      if (vaultIdEzLend1 === null) {
        vaultIdEzLend1 = new anchor.BN(0);
      } else {
        vaultIdEzLend1 = vaultIdEzLend1.add(new anchor.BN(1));
      }
      vaultIdEzLend1Seed = new Uint8Array(32);
      vaultIdEzLend1Seed.set(vaultIdEzLend1.toArrayLike(Buffer, "le", 32), 0);

      vaultEzLend1 = PublicKey.findProgramAddressSync(
        [anchor.utils.bytes.utf8.encode("vault"), vaultIdEzLend1Seed],
        ezLend.programId
      )[0];
      balanceVault = await provider.connection.getBalance(vaultEzLend1);
    }

    vaultIdEzLend2 = vaultIdEzLend1.add(new anchor.BN(1));
    vaultIdEzLend2Seed = new Uint8Array(32);
    vaultIdEzLend2Seed.set(vaultIdEzLend2.toArrayLike(Buffer, "le", 32), 0);
    vaultEzLend2 = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("vault"), vaultIdEzLend2Seed],
      ezLend.programId
    )[0];

    permissionEzLend1 = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("permission"),
        ezLend.programId.toBuffer(),
        vaultIdEzLend1Seed,
      ],
      expressRelay.programId
    )[0];
    permissionEzLend2 = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode("permission"),
        ezLend.programId.toBuffer(),
        vaultIdEzLend2Seed,
      ],
      expressRelay.programId
    )[0];

    // mint (collateral, searcher)
    await tokenCollateral.mintTo(
      ataCollateralSearcher.address,
      mintCollateralAuthority,
      [],
      1000
    );
    // mint (debt, searcher)
    await tokenDebt.mintTo(
      ataDebtSearcher.address,
      mintDebtAuthority,
      [],
      1000
    );
    // mint (collateral, protocol)
    await tokenCollateral.mintTo(
      taCollateralProtocol[0],
      mintCollateralAuthority,
      [],
      10000
    );
    // mint (debt, protocol)
    await tokenDebt.mintTo(taDebtProtocol[0], mintDebtAuthority, [], 10000);

    // approve searcher's tokens to express relay
    await tokenCollateral.approve(
      ataCollateralSearcher.address,
      expressRelayAuthority[0],
      searcher,
      [],
      1000
    );
    await tokenDebt.approve(
      ataDebtSearcher.address,
      expressRelayAuthority[0],
      searcher,
      [],
      10000
    );

    let vaults = [
      { vaultId: vaultIdEzLend1, vault: vaultEzLend1 },
      { vaultId: vaultIdEzLend2, vault: vaultEzLend2 },
    ];
    // create vaults
    for (let vault of vaults) {
      // get token balances pre
      let balanceCollateralSearcherPre = await getTokenAccountBalance(
        provider,
        ataCollateralSearcher.address
      );
      let balanceDebtSearcherPre = await getTokenAccountBalance(
        provider,
        ataDebtSearcher.address
      );
      let balanceCollateralProtocolPre = await getTokenAccountBalance(
        provider,
        taCollateralProtocol[0]
      );
      let balanceDebtProtocolPre = await getTokenAccountBalance(
        provider,
        taDebtProtocol[0]
      );

      await ezLend.methods
        .createVault({
          vaultId: vault.vaultId.toArrayLike(Buffer, "le", 32),
          collateralAmount: collateralAmountEzLend,
          debtAmount: debtAmountEzLend,
        })
        .accountsPartial({
          vault: vault.vault,
          payer: searcher.publicKey,
          collateralMint: mintCollateral.publicKey,
          debtMint: mintDebt.publicKey,
          collateralAtaPayer: ataCollateralSearcher.address,
          collateralTaProgram: taCollateralProtocol[0],
          debtAtaPayer: ataDebtSearcher.address,
          debtTaProgram: taDebtProtocol[0],
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([searcher])
        .rpc();

      let balanceCollateralSearcherPost = await getTokenAccountBalance(
        provider,
        ataCollateralSearcher.address
      );
      let balanceDebtSearcherPost = await getTokenAccountBalance(
        provider,
        ataDebtSearcher.address
      );
      let balanceCollateralProtocolPost = await getTokenAccountBalance(
        provider,
        taCollateralProtocol[0]
      );
      let balanceDebtProtocolPost = await getTokenAccountBalance(
        provider,
        taDebtProtocol[0]
      );

      assert(
        balanceCollateralSearcherPre - balanceCollateralSearcherPost ===
          collateralAmountEzLend.toNumber()
      );
      assert(
        balanceDebtSearcherPost - balanceDebtSearcherPre ===
          debtAmountEzLend.toNumber()
      );
      assert(
        balanceCollateralProtocolPost - balanceCollateralProtocolPre ===
          collateralAmountEzLend.toNumber()
      );
      assert(
        balanceDebtProtocolPre - balanceDebtProtocolPost ===
          debtAmountEzLend.toNumber()
      );
    }
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

    const startingUsdhBalance = 5000;
    await reloadMarket(env, kaminoMarket);
    await mintToUser(
      env,
      kaminoMarket.getReserveBySymbol("USDH")!.getLiquidityMint(),
      liquidator.publicKey,
      toLamports(startingUsdhBalance, 6),
      liquidator
    );

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
    let { liquidityTokenMints } = marketAccs;
    let tokensOracle = getTokensOracleData(
      kaminoMarket,
      ...marketAccs.additionalOraclePrices
    );

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

    oblig = await kaminoMarket.getObligationByAddress(obligation);

    kaminoMarketVar = kaminoMarket;
    obligationVar = oblig;
    liquidatorPathVar = liquidatorPath;
    liquidatorVar = liquidator;

    liquidityTokenMintsVar = liquidityTokenMints;
    tokensOracleVar = tokensOracle;
  });

  it("Empty Express Relay transaction (for sizing)", async () => {
    let permissionIdEmpty = new Uint8Array(32);
    let validUntilEmpty = new anchor.BN(200_000_000_000);
    let bidAmountEmpty = new anchor.BN(0);
    let protocolEmpty = new PublicKey(0);

    let tokenAmounts = {
      sellTokens: [
        {
          mint: mintCollateral.publicKey,
          amount: new anchor.BN(0),
        },
      ],
      buyTokens: [
        {
          mint: mintDebt.publicKey,
          amount: new anchor.BN(0),
        },
      ],
    };

    for (let opportunityAdapter of [true, false]) {
      if (opportunityAdapter) {
        console.log(
          "Constructing the empty transaction with OpportunityAdapter"
        );
      } else {
        console.log(
          "Constructing the empty transaction without OpportunityAdapter"
        );
      }
      let txExpressRelayEmpty = await constructExpressRelayTransaction(
        provider.connection,
        expressRelay,
        relayerSigner,
        relayerFeeReceiver,
        searcher,
        protocolEmpty,
        permissionIdEmpty,
        bidAmountEmpty,
        validUntilEmpty,
        [],
        tokenAmounts,
        opportunityAdapter
      );
      await sendAndConfirmVersionedTransaction(
        provider.connection,
        txExpressRelayEmpty
      );
    }
  });

  it("EzLend liquidation (with/without Opportunity Adapter)", async () => {
    let bidAmount = new anchor.BN(100_000_000);
    let validUntil = new anchor.BN(200_000_000_000_000);

    let opportunityAdapterSettingsList = [
      {
        opportunityAdapter: false,
        vaultEzLend: vaultEzLend1,
        vaultIdEzLend: vaultIdEzLend1,
        permissionEzLend: permissionEzLend1,
      },
      {
        opportunityAdapter: true,
        vaultEzLend: vaultEzLend2,
        vaultIdEzLend: vaultIdEzLend2,
        permissionEzLend: permissionEzLend2,
      },
    ];

    // let opportunityAdapterSettings = opportunityAdapterSettingsList[1];
    for (let opportunityAdapterSettings of opportunityAdapterSettingsList) {
      let vaultEzLend = opportunityAdapterSettings.vaultEzLend;
      let vaultIdEzLend = opportunityAdapterSettings.vaultIdEzLend;
      let permissionEzLend = opportunityAdapterSettings.permissionEzLend;
      let opportunityAdapter = opportunityAdapterSettings.opportunityAdapter;

      // get token balances pre liquidation
      let balanceCollateralSearcherPre = await getTokenAccountBalance(
        provider,
        ataCollateralSearcher.address
      );
      let balanceDebtSearcherPre = await getTokenAccountBalance(
        provider,
        ataDebtSearcher.address
      );
      let balanceCollateralProtocolPre = await getTokenAccountBalance(
        provider,
        taCollateralProtocol[0]
      );
      let balanceDebtProtocolPre = await getTokenAccountBalance(
        provider,
        taDebtProtocol[0]
      );

      let txResponse = await constructAndSendEzLendLiquidateTransaction(
        provider.connection,
        relayerSigner,
        relayerFeeReceiver,
        vaultEzLend,
        vaultIdEzLend,
        permissionEzLend,
        searcher,
        {
          mint: mintCollateral.publicKey,
          ataSearcher: ataCollateralSearcher.address,
          ataRelayer: ataCollateralRelayer,
          taProtocol: taCollateralProtocol[0],
          amount: collateralAmountEzLend,
        },
        {
          mint: mintDebt.publicKey,
          ataSearcher: ataDebtSearcher.address,
          ataRelayer: ataDebtRelayer,
          taProtocol: taDebtProtocol[0],
          amount: debtAmountEzLend,
        },
        ezLend,
        expressRelay,
        bidAmount,
        validUntil,
        opportunityAdapter
      );

      // get token balances post liquidation
      let balanceCollateralSearcherPost = await getTokenAccountBalance(
        provider,
        ataCollateralSearcher.address
      );
      let balanceDebtSearcherPost = await getTokenAccountBalance(
        provider,
        ataDebtSearcher.address
      );
      let balanceCollateralProtocolPost = await getTokenAccountBalance(
        provider,
        taCollateralProtocol[0]
      );
      let balanceDebtProtocolPost = await getTokenAccountBalance(
        provider,
        taDebtProtocol[0]
      );

      assert(
        balanceCollateralSearcherPost - balanceCollateralSearcherPre ===
          collateralAmountEzLend.toNumber()
      );
      assert(
        balanceDebtSearcherPre - balanceDebtSearcherPost ===
          debtAmountEzLend.toNumber()
      );
      assert(
        balanceCollateralProtocolPre - balanceCollateralProtocolPost ===
          collateralAmountEzLend.toNumber()
      );
      assert(
        balanceDebtProtocolPost - balanceDebtProtocolPre ===
          debtAmountEzLend.toNumber()
      );
    }
  });

  it("Kamino liquidation liquidate directly (with/without Opportunity Adapter)", async () => {
    let permissionIdEmpty = new Uint8Array(32);
    let validUntilEmpty = new anchor.BN(200_000_000_000);
    let bidAmountEmpty = new anchor.BN(0);
    let protocolEmpty = new PublicKey(0);

    // create kamino liquidation instruction, kaminoElimIxs toggles which instructions to remove from Kamino result
    let liquidationAmount: number = 4;
    ixsKaminoLiq = await liquidateAndRedeem(
      kaminoMarketVar,
      liquidatorVar,
      liquidationAmount,
      kaminoMarketVar.getReserveBySymbol("SOL"),
      kaminoMarketVar.getReserveBySymbol("USDC"),
      oblig,
      configLiquidation,
      kaminoElimIxs
    );

    kaminoLiquidationLookupTables = await getLiquidationLookupTables(
      provider.connection,
      klendProgramId,
      new PublicKey(kaminoMarketVar.address),
      liquidatorVar
    );

    let tokenAmounts = {
      sellTokens: [
        {
          mint: mintCollateral.publicKey,
          amount: new anchor.BN(0),
        },
      ],
      buyTokens: [
        {
          mint: mintDebt.publicKey,
          amount: new anchor.BN(0),
        },
      ],
    };

    for (let opportunityAdapter of [true, false]) {
      if (opportunityAdapter) {
        console.log(
          "Constructing the Kamino direct liquidate transaction with OpportunityAdapter"
        );
      } else {
        console.log(
          "Constructing the Kamino direct liquidate transaction without OpportunityAdapter"
        );
      }
      let txExpressRelayKamino = await constructExpressRelayTransaction(
        provider.connection,
        expressRelay,
        relayerSigner,
        relayerFeeReceiver,
        liquidatorVar,
        protocolEmpty,
        permissionIdEmpty,
        bidAmountEmpty,
        validUntilEmpty,
        ixsKaminoLiq,
        tokenAmounts,
        opportunityAdapter,
        kaminoLiquidationLookupTables
      );
    }
  });

  it("Kamino liquidation swap and liquidate (with/without Opportunity Adapter)", async () => {
    let permissionIdEmpty = new Uint8Array(32);
    let validUntilEmpty = new anchor.BN(200_000_000_000);
    let bidAmountEmpty = new anchor.BN(0);
    let protocolEmpty = new PublicKey(0);

    let targets: TokenCount[] = [
      {
        symbol: "USDC",
        target: 2,
      },
      {
        symbol: "USDH",
        target: 3,
      },
      {
        symbol: "SOL",
        target: 1,
      },
    ];

    let walletBalances = await getWalletBalances(
      provider.connection,
      kaminoMarketVar,
      liquidatorVar,
      tokensOracleVar
    );

    const tokenInfos = aggregateUserTokenInfo(
      liquidityTokenMintsVar,
      tokensOracleVar,
      walletBalances.liquidityBalances,
      liquidatorVar,
      targets
    );
    const baseTokenInfo = tokenInfos.find(({ symbol }) => symbol === "USDH");
    const amountToSwap = 1000;

    // set to ensure jupiter txs are constructed
    const jupiter = new Jupiter(liquidatorVar, provider.connection, env);
    const cluster = "localnet";

    ixsKaminoLiq = await swapAndLiquidate(
      provider.connection,
      kaminoMarketVar,
      liquidatorVar,
      oblig,
      amountToSwap,
      kaminoMarketVar.getReserveBySymbol("SOL"),
      kaminoMarketVar.getReserveBySymbol("USDC"),
      baseTokenInfo,
      jupiter,
      cluster,
      configLiquidation
    );

    kaminoLiquidationLookupTables = await getLiquidationLookupTables(
      provider.connection,
      klendProgramId,
      new PublicKey(kaminoMarketVar.address),
      liquidatorVar
    );

    let tokenAmounts = {
      sellTokens: [
        {
          mint: mintCollateral.publicKey,
          amount: new anchor.BN(0),
        },
      ],
      buyTokens: [
        {
          mint: mintDebt.publicKey,
          amount: new anchor.BN(0),
        },
      ],
    };

    for (let opportunityAdapter of [true, false]) {
      if (opportunityAdapter) {
        console.log(
          "Constructing the Kamino swap & liquidate transaction with OpportunityAdapter"
        );
      } else {
        console.log(
          "Constructing the Kamino swap & liquidate transaction without OpportunityAdapter"
        );
      }
      let txExpressRelayKamino = await constructExpressRelayTransaction(
        provider.connection,
        expressRelay,
        relayerSigner,
        relayerFeeReceiver,
        liquidatorVar,
        protocolEmpty,
        permissionIdEmpty,
        bidAmountEmpty,
        validUntilEmpty,
        ixsKaminoLiq,
        tokenAmounts,
        opportunityAdapter,
        kaminoLiquidationLookupTables
      );
    }
  });
});
