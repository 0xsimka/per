import Decimal from "decimal.js";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  KaminoMarket,
  WRAPPED_SOL_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  syncNative,
} from "@kamino-finance/klend-sdk";
import {
  Cluster,
  TokenInfo,
  Swapper,
  SwapConfig,
  SwapResponse,
  LiquidityMintInfo,
  TokenCount,
  TokenOracleData,
  TokenBalance,
} from "./types";
import { RebalanceConfig } from "./RebalanceConfig";
import { toLamports, fromLamports, sleep } from "./utils";
import { getAssociatedTokenAddress } from "./token";
import { Token, TOKEN_PROGRAM_ID, u64 } from "@solana/spl-token";
import { LAMPORTS_PER_SOL } from "./constants";
import { Jupiter } from "./jupiter";

export function getSwapper(
  kaminoMarket: KaminoMarket,
  payer: Keypair,
  cluster: Cluster,
  jupiter: null | Jupiter,
  inputMint: PublicKey,
  outputMint: PublicKey,
  additionalTokenInfos: TokenInfo[] = []
): Swapper {
  let swapper: Swapper;
  if (cluster === "localnet" && jupiter === null) {
    const inputReserve = kaminoMarket.getReserveByMint(inputMint);
    if (
      !inputReserve &&
      !additionalTokenInfos.find((t) => t.mintAddress.equals(inputMint))
    ) {
      throw new Error(`Could not find inputReserve for mint ${inputMint}`);
    }
    const outputReserve = kaminoMarket.getReserveByMint(outputMint);
    if (
      !outputReserve &&
      !additionalTokenInfos.find((t) => t.mintAddress.equals(inputMint))
    ) {
      throw new Error(`Could not find outputReserve for mint ${outputMint}`);
    }
    swapper = async (
      inputMint,
      outputMint,
      inputAmountLamports,
      swapConfig
    ) => {
      let inputPrice;
      let inputDecimals;
      const additionalInputTokenInfo = additionalTokenInfos.find((t) =>
        t.mintAddress.equals(inputMint)
      );
      if (!inputReserve && additionalInputTokenInfo) {
        inputPrice = additionalInputTokenInfo.price;
        inputDecimals = additionalInputTokenInfo.decimals;
      } else {
        inputPrice = inputReserve!.tokenOraclePrice.price;
        inputDecimals = inputReserve!.stats.decimals;
      }
      let outputPrice;
      let outputDecimals;
      const additionalOutputTokenInfo = additionalTokenInfos.find((t) =>
        t.mintAddress.equals(inputMint)
      );
      if (!outputReserve && additionalOutputTokenInfo) {
        outputPrice = additionalOutputTokenInfo.price;
        outputDecimals = additionalOutputTokenInfo.decimals;
      } else {
        outputPrice = outputReserve!.tokenOraclePrice.price;
        outputDecimals = outputReserve!.stats.decimals;
      }
      const inputToOutputPrice = inputPrice.div(outputPrice);
      const expectedOutputLamports = toLamports(
        fromLamports(inputAmountLamports, inputDecimals) *
          inputToOutputPrice.toNumber(),
        outputDecimals
      );
      return localSwapTx(
        kaminoMarket.getConnection(),
        payer,
        new Decimal(inputAmountLamports),
        new Decimal(expectedOutputLamports),
        inputMint,
        outputMint,
        swapConfig,
        kaminoMarket
      );
    };
  } else {
    if (jupiter === null) {
      throw new Error("jupiter is undefined");
    }
    const inputReserve = kaminoMarket.getReserveByMint(inputMint);
    swapper = async (
      inputMint,
      outputMint,
      inputAmountLamports,
      swapConfig
    ) => {
      const inputDecimal = fromLamports(
        inputAmountLamports,
        inputReserve!.state.liquidity.mintDecimals.toNumber()
      );
      // Avoid small swaps failing in Jupiter due to 0 out amount etc.
      let actualSwapAmount = new Decimal(inputDecimal);
      if (inputReserve?.getOracleMarketPrice().mul(inputDecimal).lt("0.1")) {
        actualSwapAmount = new Decimal("0.1").div(
          inputReserve!.getOracleMarketPrice()
        );
      }
      const notDecimal = toLamports(
        actualSwapAmount.toNumber(),
        inputReserve!.state.liquidity.mintDecimals.toNumber()
      );
      return jupSwapTx(
        jupiter,
        inputMint,
        outputMint,
        new Decimal(notDecimal),
        swapConfig,
        cluster
      );
    };
  }

  return swapper;
}

export async function localSwapTx(
  connection: Connection,
  userMintAuthority: Keypair,
  inputMintAmountLamports: Decimal, // lamports -> amount to sell / burn
  outputMintAmountLamports: Decimal, // lamports -> amount to buy / mint
  inputMint: PublicKey,
  outputMint: PublicKey,
  swapConfig: SwapConfig,
  kaminoMarket?: KaminoMarket
): Promise<SwapResponse> {
  try {
    const { slippageBps, wrapAndUnwrapSol } = swapConfig;
    const slippageFactor = new Decimal(slippageBps).div("10000").add("1");
    const minOutAmount = new Decimal(outputMintAmountLamports)
      .div(slippageFactor)
      .floor();

    const inputReserve = kaminoMarket?.getReserveByMint(inputMint);
    const outputReserve = kaminoMarket?.getReserveByMint(outputMint);

    const inputSymbol = inputReserve?.stats.symbol;
    const outputSymbol = outputReserve?.stats.symbol;

    if (inputMint.equals(outputMint)) {
      throw new Error(
        `Swapping tokens with the same mint is not allowed: ${inputSymbol}/${inputMint.toBase58()} -> ${outputSymbol}/${outputMint.toBase58()}`
      );
    }
    // Owner is mintAuthority also
    const tokenAAta = await getAssociatedTokenAddress(
      inputMint,
      userMintAuthority.publicKey
    );
    const tokenBAta = await getAssociatedTokenAddress(
      outputMint,
      userMintAuthority.publicKey
    );

    const inputToken = new Token(
      connection,
      inputMint,
      TOKEN_PROGRAM_ID,
      userMintAuthority
    );
    const outputToken = new Token(
      connection,
      outputMint,
      TOKEN_PROGRAM_ID,
      userMintAuthority
    );

    const inputMintInfo = await inputToken.getMintInfo();
    const outputMintInfo = await outputToken.getMintInfo();
    //   if (isKToken({ address: inputMint, ...inputMintInfo }) || isKToken({ address: outputMint, ...outputMintInfo })) {
    //     throw new Error(`Swapping kTokens not supported - tried to swap ${inputSymbol} for ${outputSymbol}`);
    //   }
    //   if (isJlpMint(inputMint) || isJlpMint(outputMint)) {
    //     throw new Error(`Swapping JLP tokens not supported - tried to swap ${inputSymbol} for ${outputSymbol}`);
    //   }

    const inputMintDecimals = inputMintInfo.decimals;
    const outputMintDecimals = outputMintInfo.decimals;

    if (kaminoMarket) {
      console.debug(
        `Swapping ${fromLamports(inputMintAmountLamports, inputMintDecimals)} ${
          inputSymbol ?? inputMint.toString()
        } for ${fromLamports(minOutAmount, outputMintDecimals)} ${
          outputSymbol ?? outputMint.toString()
        }...`
      );
    }

    const burnFromIxns: TransactionInstruction[] = [];
    if (inputMint.equals(WRAPPED_SOL_MINT)) {
      // When it comes to SOL
      // going to assume the swap is always wsol ata -> new wsol ata
      // therefore burn == send that amount to a new random user newly created
      // If we're 'selling' 'sol' it means we actually need to transfer wsols to someone else

      const solReceiver = Keypair.generate();
      await connection.requestAirdrop(solReceiver.publicKey, LAMPORTS_PER_SOL);
      await sleep(2000);

      const userWsolAta = await getAssociatedTokenAddress(
        WRAPPED_SOL_MINT,
        userMintAuthority.publicKey,
        false
      );
      const solReceiverWsolAta = await getAssociatedTokenAddress(
        WRAPPED_SOL_MINT,
        solReceiver.publicKey,
        false
      );
      const [, createWsolAccountIxSolReceiver] =
        await createAssociatedTokenAccountIdempotentInstruction(
          solReceiver.publicKey,
          WRAPPED_SOL_MINT,
          userMintAuthority.publicKey
        );

      const wrapIxs: TransactionInstruction[] = [];
      if (wrapAndUnwrapSol) {
        const [, createWsolAccountIx] =
          await createAssociatedTokenAccountIdempotentInstruction(
            userMintAuthority.publicKey,
            WRAPPED_SOL_MINT,
            userMintAuthority.publicKey,
            userWsolAta
          );
        wrapIxs.push(createWsolAccountIx);
        const depositIntoWsolAta = getDepositWsolIxns(
          userMintAuthority.publicKey,
          userWsolAta,
          inputMintAmountLamports
        );
        wrapIxs.push(...depositIntoWsolAta);
      }

      const transferIx = Token.createTransferCheckedInstruction(
        TOKEN_PROGRAM_ID,
        userWsolAta,
        WRAPPED_SOL_MINT,
        solReceiverWsolAta,
        userMintAuthority.publicKey,
        [],
        // eslint-disable-next-line new-cap
        new u64(inputMintAmountLamports.toString()),
        inputMintDecimals
      );

      const closeWsolAccountIx: TransactionInstruction[] = !wrapAndUnwrapSol
        ? []
        : [
            Token.createCloseAccountInstruction(
              TOKEN_PROGRAM_ID,
              userWsolAta,
              userMintAuthority.publicKey,
              userMintAuthority.publicKey,
              []
            ),
          ];

      // TODO (resolved): We should add this but no space in the logs for the txn, we can't do it
      // but it doesn't matter because this is local jup swap anyway
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const closeWsolAccountIxSolReceiver = Token.createCloseAccountInstruction(
        TOKEN_PROGRAM_ID,
        solReceiverWsolAta,
        solReceiver.publicKey,
        solReceiver.publicKey,
        []
      );

      console.debug(
        `Swapping in ${inputSymbol} ${inputMint.toString()} as wsol ${fromLamports(
          inputMintAmountLamports,
          inputMintDecimals
        )} from ata ${tokenAAta.toString()}`
      );
      burnFromIxns.push(
        createWsolAccountIxSolReceiver,
        ...wrapIxs,
        transferIx,
        ...closeWsolAccountIx
        // closeWsolAccountIxSolReceiver
      );
    } else {
      console.debug(
        `Swapping in ${inputSymbol} ${inputMint.toString()} ${fromLamports(
          inputMintAmountLamports,
          inputMintDecimals
        )} from ata ${tokenAAta.toString()}`
      );
      burnFromIxns.push(
        getBurnFromIx(
          userMintAuthority.publicKey,
          inputMint,
          tokenAAta,
          inputMintAmountLamports
        )
      );
    }

    const mintToIxns: TransactionInstruction[] = [];
    if (outputMint.equals(WRAPPED_SOL_MINT)) {
      // We need to receive sol, so we're just going to transfer into the user's wsol ata
      // from the admin's wsol ata

      await connection.requestAirdrop(
        userMintAuthority.publicKey,
        minOutAmount.toNumber()
      );
      await sleep(3000);

      const userWsolAta = await getAssociatedTokenAddress(
        WRAPPED_SOL_MINT,
        userMintAuthority.publicKey,
        false
      );

      // create wsol ata for admin
      const [wsolAtaForAdmin, createWsolAccountIx] =
        await createAssociatedTokenAccountIdempotentInstruction(
          userMintAuthority.publicKey,
          WRAPPED_SOL_MINT,
          userMintAuthority.publicKey
        );

      const closeWsolAccountIx = !wrapAndUnwrapSol
        ? []
        : [
            Token.createCloseAccountInstruction(
              TOKEN_PROGRAM_ID,
              wsolAtaForAdmin,
              userMintAuthority.publicKey,
              userMintAuthority.publicKey,
              []
            ),
          ];

      const depositIntoWsolAta = getDepositWsolIxns(
        userMintAuthority.publicKey,
        wsolAtaForAdmin,
        minOutAmount
      );

      const transferIx = Token.createTransferCheckedInstruction(
        TOKEN_PROGRAM_ID,
        wsolAtaForAdmin,
        WRAPPED_SOL_MINT,
        userWsolAta,
        userMintAuthority.publicKey,
        [],
        minOutAmount.toNumber(),
        outputMintDecimals
      );

      console.debug(
        `Swapping out ${outputSymbol} ${outputMint.toString()} as wsol ${fromLamports(
          minOutAmount,
          outputMintDecimals
        )} ata ${userWsolAta.toString()}`
      );
      mintToIxns.push(
        createWsolAccountIx,
        ...depositIntoWsolAta,
        transferIx,
        ...closeWsolAccountIx
      );
    } else {
      console.debug(
        `Swapping out ${outputSymbol} ${outputMint.toString()} ${fromLamports(
          minOutAmount,
          outputMintDecimals
        )} ata ${tokenBAta.toString()}`
      );
      mintToIxns.push(
        getMintToIx(
          userMintAuthority.publicKey,
          outputMint,
          tokenBAta,
          minOutAmount.toNumber()
        )
      );
    }

    return {
      computeBudgetIxs: [],
      setupIxs: [],
      swapIxs: [...mintToIxns, ...burnFromIxns],
      cleanupIxs: [],
      swapLookupTableAccounts: [],
      swapOutAmount: outputMintAmountLamports.floor().toString(),
      swapMinOutAmount: minOutAmount.toString(),
    };
  } catch (error) {
    console.error("LocalSwapError");
    console.error(error);
    throw error;
  }
}

export function getDepositWsolIxns(
  owner: PublicKey,
  ata: PublicKey,
  amountLamports: Decimal
) {
  const ixns: TransactionInstruction[] = [];
  ixns.push(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: ata,
      lamports: BigInt(amountLamports.toString()),
    })
  );
  // Sync native
  ixns.push(syncNative(ata));
  return ixns;
}

export function getMintToIx(
  authority: PublicKey,
  mintPubkey: PublicKey,
  tokenAccount: PublicKey,
  amountLamports: number
): TransactionInstruction {
  const ix = Token.createMintToInstruction(
    TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
    mintPubkey, // mint
    tokenAccount, // receiver (sholud be a token account)
    authority, // mint authority
    [], // only multisig account will use. leave it empty now.
    amountLamports // amount. if your decimals is 8, you mint 10^8 for 1 token.
  );

  return ix;
}

export function getBurnFromIx(
  signer: PublicKey,
  mintPubkey: PublicKey,
  tokenAccount: PublicKey,
  amountLamports: Decimal
): TransactionInstruction {
  const ix = Token.createBurnInstruction(
    TOKEN_PROGRAM_ID,
    mintPubkey,
    tokenAccount,
    signer,
    [],
    // eslint-disable-next-line new-cap
    new u64(amountLamports.toString())
  );
  return ix;
}

export function aggregateUserTokenInfo(
  reserveLiquidityMints: LiquidityMintInfo[],
  tokensOracle: TokenOracleData[],
  walletBalances: TokenBalance[],
  wallet: Keypair,
  targets: TokenCount[]
): TokenInfo[] {
  const info: TokenInfo[] = [];
  let finalTargets = [...targets];
  // add all token reserves to target with a weighting of 0
  tokensOracle.forEach((oracleData) => {
    let mappedSymbol = oracleData.symbol;
    // When liquidating reserves, use WSOL
    if (oracleData.symbol === "SOL") {
      mappedSymbol = "WSOL";
    }
    const existingTarget = finalTargets.find((t) => t.symbol === mappedSymbol);
    if (!existingTarget) {
      // Add a dummy allocation of 0 so that we sell all of the token
      finalTargets = [...finalTargets, { symbol: mappedSymbol, target: 0 }];
    }
  });

  finalTargets.forEach((tokenDistribution: TokenCount) => {
    const { symbol, target } = tokenDistribution;
    const tokenOracle = tokensOracle.find((t) =>
      symbol === "WSOL" ? t.symbol === "SOL" : t.symbol === symbol
    );
    const walletBalance = walletBalances.find((b) => b.symbol === symbol);
    const liquidityMint = reserveLiquidityMints.find((m) =>
      m.address.equals(walletBalance?.mint!)
    );
    if (walletBalance && tokenOracle) {
      const usdValue = walletBalance.balance.mul(tokenOracle.price);
      const diff = walletBalance.balance.sub(target);
      info.push({
        symbol,
        target,
        mintAddress: tokenOracle.mintAddress,
        ata: walletBalance.ata,
        balance: walletBalance.balance,
        usdValue,
        price: tokenOracle.price,
        decimals: Decimal.log10(tokenOracle.decimals).toNumber(),
        decimals10Pow: tokenOracle.decimals.toNumber(),
        reserveAddress: tokenOracle.reserveAddress,
        diff,
        diffUsd: diff.mul(tokenOracle.price),
        wrappedTokenType: liquidityMint?.wrappedTokenType,
      });
    }
  });
  return info;
}

export async function jupSwapTx(
  jupiter: Jupiter,
  inputMint: PublicKey,
  outputMint: PublicKey,
  inputAmountLamports: Decimal,
  swapConfig: SwapConfig,
  cluster: Cluster
): Promise<SwapResponse> {
  const swapResponse = await jupiter.swapTx(
    inputMint,
    outputMint,
    inputAmountLamports,
    swapConfig,
    cluster
  );
  return swapResponse;
}
