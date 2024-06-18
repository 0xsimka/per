import {
  createJupiterApiClient,
  DefaultApi,
  Instruction,
  QuoteGetRequest,
  ResponseError,
  SwapInstructionsPostRequest,
  SwapMode,
} from "@jup-ag/api";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import Decimal from "decimal.js";
import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  uniqueAccounts,
  maxLockedAccounts,
  MAX_LOCKED_ACCOUNTS,
  constructAndSendVersionedTransaction,
} from "./utils";
import { Connection } from "@solana/web3.js";
import { WRAPPED_SOL_MINT } from "@kamino-finance/klend-sdk";
import { getLookupTableAccountsFromKeys } from "../helpers/lookupTable";
import { createTokenAccountInstructions } from "./token";
import { Cluster, Env } from "./types";

const JUP_V6_BASE_URL = "https://quote-api.jup.ag/v6";
// Our private jup instance contains a token in the url, so we print the default url in the logs
const JUP_V6_DEBUG_BASE_URL = JUP_V6_BASE_URL;

const DEFAULT_MAX_ACCOUNTS_BUFFER = 2;

export type SwapConfig = {
  txAccounts?: Set<string>;
  txAccountsBuffer?: number;
  onlyDirectRoutes?: boolean;
  wrapAndUnwrapSol?: boolean;
  slippageBps: number;
  destinationTokenAccount?: PublicKey;
  feePerCULamports?: Decimal;
};

export type SwapResponse = {
  computeBudgetIxs: TransactionInstruction[];
  setupIxs: TransactionInstruction[];
  swapIxs: TransactionInstruction[];
  cleanupIxs: TransactionInstruction[];
  swapLookupTableAccounts: AddressLookupTableAccount[];
  swapOutAmount: string;
  swapMinOutAmount: string;
};

export class Jupiter {
  payer: Keypair;
  c: Connection;
  quoteApi: DefaultApi;
  env: Env;

  constructor(payer: Keypair, c: Connection, env?: Env, quoteApi?: DefaultApi) {
    this.payer = payer;
    this.c = c;
    this.quoteApi =
      quoteApi ??
      createJupiterApiClient({
        basePath: JUP_V6_BASE_URL,
      });
    this.env = env;
  }

  async swap(
    inputMint: PublicKey,
    outputMint: PublicKey,
    inputAmountLamports: Decimal,
    swapConfig: SwapConfig,
    description: string = "JupSwap",
    cluster: Cluster
  ): Promise<string> {
    let { destinationTokenAccount } = swapConfig;
    const solAccountSetupIxs: TransactionInstruction[] = [];
    const additionalSigners: Keypair[] = [];
    const solAccountCleanupIxs: TransactionInstruction[] = [];
    let finalSwapConfig = { ...swapConfig };
    // If we are swapping to SOL and unwrapping, we don't want to use our ATA because it will be emptied completely when close account is called. Instead, we create a temporary account and use that.
    // By specifying a destinationTokenAccount, jup will no longer return the cleanup ix to close the account, so we need to add it manually.
    if (
      outputMint.equals(WRAPPED_SOL_MINT) &&
      swapConfig?.wrapAndUnwrapSol &&
      !destinationTokenAccount
    ) {
      const tempSolAcc = Keypair.generate();
      console.debug(
        `Using temporary WSOL account ${tempSolAcc.publicKey.toBase58()}`
      );
      destinationTokenAccount = tempSolAcc.publicKey;
      const tempSolSetupAccIxs = await createTokenAccountInstructions(
        this.c,
        destinationTokenAccount,
        outputMint,
        this.payer.publicKey
      );
      solAccountSetupIxs.push(...tempSolSetupAccIxs);
      additionalSigners.push(tempSolAcc);
      finalSwapConfig = {
        ...swapConfig,
        wrapAndUnwrapSol: undefined, // this is ignored by jup anyway when we define a destinationTokenAccount
        destinationTokenAccount,
      };
      const tempSolCleanupIx = Token.createCloseAccountInstruction(
        TOKEN_PROGRAM_ID,
        destinationTokenAccount,
        this.payer.publicKey,
        this.payer.publicKey,
        []
      );
      solAccountCleanupIxs.push(tempSolCleanupIx);
    }
    const {
      computeBudgetIxs,
      setupIxs,
      swapIxs,
      cleanupIxs,
      swapLookupTableAccounts,
    } = await this.swapTx(
      inputMint,
      outputMint,
      inputAmountLamports,
      finalSwapConfig,
      cluster
    );
    let sanitizedCleanupIxs: TransactionInstruction[] = [];
    if (inputMint.equals(WRAPPED_SOL_MINT) && swapConfig?.wrapAndUnwrapSol) {
      // We don't want to close the SOL ATA when selling SOL and wrapping, because it will be emptied completely when close account is called.
      console.debug(
        `Filtered out jup cleanup ix: ${JSON.stringify(cleanupIxs)}`
      );
    } else {
      sanitizedCleanupIxs = cleanupIxs;
    }

    const tx = new Transaction();
    tx.add(...computeBudgetIxs);
    tx.add(...solAccountSetupIxs);
    tx.add(...setupIxs);
    tx.add(...swapIxs);
    tx.add(...sanitizedCleanupIxs);
    tx.add(...solAccountCleanupIxs);

    return constructAndSendVersionedTransaction(
      this.env,
      tx,
      additionalSigners
    );
    //   return sendAndConfirmTransactionV0(
    //     this.c,
    //     this.payer,
    //     [
    //       ...computeBudgetIxs,
    //       ...solAccountSetupIxs,
    //       ...setupIxs,
    //       ...swapIxs,
    //       ...sanitizedCleanupIxs,
    //       ...solAccountCleanupIxs,
    //     ],
    //     swapLookupTableAccounts,
    //     additionalSigners,
    //     description,
    //     logger.info
    //   );
  }

  async swapTx(
    inputMint: PublicKey,
    outputMint: PublicKey,
    inputAmountLamports: Decimal,
    swapConfig: SwapConfig,
    cluster: Cluster
  ): Promise<SwapResponse> {
    const amount = inputAmountLamports.floor().toNumber();
    if (swapConfig?.txAccounts !== undefined) {
      return this.swapTxMaxAccounts(
        inputMint,
        outputMint,
        amount,
        swapConfig,
        cluster
      );
    }
    let quote;
    try {
      const quoteParameters = {
        inputMint: inputMint.toBase58(),
        outputMint: outputMint.toBase58(),
        amount,
        slippageBps: swapConfig.slippageBps,
        onlyDirectRoutes: swapConfig?.onlyDirectRoutes ?? false,
      };
      console.debug(`Requesting quote ${reconstructQuoteUrl(quoteParameters)}`);
      if (cluster == "localnet") {
        quoteParameters.inputMint =
          "So11111111111111111111111111111111111111112";
        quoteParameters.outputMint =
          "3psH1Mj1f7yUfaD5gh6Zj7epE8hhrMkMETgv5TshQA4o";
      }
      quote = await this.quoteApi.quoteGet(quoteParameters);
    } catch (e) {
      if (e instanceof ResponseError) {
        console.error(
          `1Received ${e.response.statusText} (${
            e.response.status
          }) error response for jup quote. Request url: ${
            e.response.url
          } \nResponse body:\n${JSON.stringify(
            await e.response.json(),
            null,
            2
          )}`
        );
      }
      throw e;
    }
    console.debug(
      `Expected amount from swap is ${quote.outAmount}, min out amount: ${quote.otherAmountThreshold} with slippage: ${quote.slippageBps}`
    );
    let swap;
    try {
      const swapParameters = {
        swapRequest: {
          userPublicKey: this.payer.publicKey.toBase58(),
          quoteResponse: quote,
          computeUnitPriceMicroLamports:
            swapConfig.feePerCULamports
              ?.mul(10 ** 6)
              .ceil()
              .toNumber() ?? 1,
          wrapAndUnwrapSol: swapConfig?.wrapAndUnwrapSol ?? false,
        },
      };
      console.debug(`Requesting swap: ${reconstructSwapUrl(swapParameters)}`);
      swap = await this.quoteApi.swapInstructionsPost(swapParameters);
    } catch (e) {
      if (e instanceof ResponseError) {
        console.error(
          `2Received ${e.response.statusText} (${
            e.response.status
          }) error response for jup swap. Request url: ${
            e.response.url
          } \nResponse body:\n${JSON.stringify(
            await e.response.json(),
            null,
            2
          )}`
        );
      }
      throw e;
    }
    const swapLookupTableAccounts = await getLookupTableAccountsFromKeys(
      this.c,
      swap.addressLookupTableAddresses.map((k) => new PublicKey(k))
    );
    console.debug(
      `Fetched ${swapLookupTableAccounts.length}/${
        swap.addressLookupTableAddresses.length
      } lookup table accounts from swap response: ${swap.addressLookupTableAddresses.toString()}`
    );
    const swapIxs = [transformResponseIx(swap.swapInstruction)];
    console.debug(
      `Received a swap ix with ${
        uniqueAccounts(swapIxs).size
      } accounts, no limit specified`
    );

    return {
      computeBudgetIxs: transformResponseIxs(swap.computeBudgetInstructions),
      setupIxs: transformResponseIxs(swap.setupInstructions),
      swapIxs,
      cleanupIxs: transformResponseIxs(
        swap.cleanupInstruction ? [swap.cleanupInstruction] : []
      ),
      swapLookupTableAccounts,
      swapOutAmount: quote.outAmount,
      swapMinOutAmount: quote.otherAmountThreshold,
    };
  }

  private async swapTxMaxAccounts(
    inputMint: PublicKey,
    outputMint: PublicKey,
    inputAmountLamports: number,
    {
      slippageBps,
      txAccounts = new Set<string>(),
      txAccountsBuffer = DEFAULT_MAX_ACCOUNTS_BUFFER,
      onlyDirectRoutes = false,
      wrapAndUnwrapSol = false,
      feePerCULamports = new Decimal("1"),
    }: SwapConfig,
    cluster: Cluster
  ): Promise<SwapResponse> {
    let maxAccounts = maxLockedAccounts(txAccounts.size + txAccountsBuffer);
    while (maxAccounts > 5) {
      console.debug(
        `Requesting swap tx with ${maxAccounts} accounts. Only direct routes: ${onlyDirectRoutes}`
      );
      let quote;
      try {
        let quoteParameters = {
          inputMint: inputMint.toBase58(),
          outputMint: outputMint.toBase58(),
          amount: inputAmountLamports,
          slippageBps,
          onlyDirectRoutes,
          maxAccounts,
        };
        console.debug(
          `Requesting quote ${reconstructQuoteUrl(quoteParameters)}`
        );
        if (cluster == "localnet") {
          // in this case we don't have a live jup instance
          // we just care about tx sizing, can create a dummy quote for two real tokens
          quoteParameters.inputMint =
            "So11111111111111111111111111111111111111112";
          quoteParameters.outputMint =
            "3psH1Mj1f7yUfaD5gh6Zj7epE8hhrMkMETgv5TshQA4o";

          // let swapinfo0 = {
          //     ammKey: Keypair.generate().publicKey.toBase58(),
          //     label: "idk",
          //     inputMint: inputMint.toBase58(),
          //     outputMint: outputMint.toBase58(),
          //     inAmount: "2000",
          //     outAmount: "1000",
          //     feeAmount: "0",
          //     feeMint: inputMint.toBase58(),
          // };
          // quote = {
          //     inputMint: inputMint.toBase58(),
          //     inAmount: "1000",
          //     outputMint: outputMint.toBase58(),
          //     outAmount: "2000",
          //     otherAmountThreshold: "0",
          //     swapMode: SwapMode.ExactIn,
          //     slippageBps: 100,
          //     priceImpactPct: "1",
          //     routePlan: [{
          //         swapInfo: swapinfo0,
          //         percent: 100,
          //     }],
        }
        quote = await this.quoteApi.quoteGet(quoteParameters);
      } catch (e) {
        if (e instanceof ResponseError) {
          console.error(
            `3Received ${e.response.statusText} (${
              e.response.status
            }) error response for jup quote. Request url: ${
              e.response.url
            } \nResponse body:\n${JSON.stringify(
              await e.response.json(),
              null,
              2
            )}`
          );
        }
        throw e;
      }
      console.debug(
        `Expected amount from swap is ${quote.outAmount}, min out amount: ${quote.otherAmountThreshold} with slippage: ${quote.slippageBps}`
      );
      let swap;
      try {
        const swapParameters = {
          swapRequest: {
            userPublicKey: this.payer.publicKey.toBase58(),
            quoteResponse: quote,
            computeUnitPriceMicroLamports: feePerCULamports
              .mul(10 ** 6)
              .ceil()
              .toNumber(),
            wrapAndUnwrapSol,
          },
        };
        console.debug(`Requesting swap: ${reconstructSwapUrl(swapParameters)}`);
        swap = await this.quoteApi.swapInstructionsPost(swapParameters);
      } catch (e) {
        if (e instanceof ResponseError) {
          console.error(
            `4Received ${e.response.statusText} (${
              e.response.status
            }) error response for jup swap. Request url: ${
              e.response.url
            } \nResponse body:\n${JSON.stringify(
              await e.response.json(),
              null,
              2
            )}`
          );
        }
        throw e;
      }

      const swapIxs = [transformResponseIx(swap.swapInstruction)];
      const uniqueSwapAccounts = uniqueAccounts(swapIxs);
      const allAccounts = new Set<string>([
        ...uniqueSwapAccounts,
        ...txAccounts,
      ]);
      console.debug(
        `Received a swap tx with ${uniqueSwapAccounts.size} accounts. Total unique tx accounts: ${allAccounts.size}.`
      );
      if (allAccounts.size > MAX_LOCKED_ACCOUNTS) {
        console.debug(
          `Too many accounts for swap tx: ${allAccounts.size} > ${MAX_LOCKED_ACCOUNTS}`
        );
        maxAccounts -= DEFAULT_MAX_ACCOUNTS_BUFFER;
      } else {
        let swapLookupTableAccounts;
        try {
          swapLookupTableAccounts = await getLookupTableAccountsFromKeys(
            this.c,
            swap.addressLookupTableAddresses.map((k) => new PublicKey(k))
          );
        } catch (e) {
          swapLookupTableAccounts = [];
        }
        console.debug(
          `Fetched ${swapLookupTableAccounts.length}/${
            swap.addressLookupTableAddresses.length
          } lookup table accounts from swap response: ${swap.addressLookupTableAddresses.toString()}`
        );
        const swapIxs = [transformResponseIx(swap.swapInstruction)];

        return {
          computeBudgetIxs: transformResponseIxs(
            swap.computeBudgetInstructions
          ),
          setupIxs: transformResponseIxs(swap.setupInstructions),
          swapIxs,
          cleanupIxs: swap.cleanupInstruction
            ? transformResponseIxs([swap.cleanupInstruction])
            : [],
          swapLookupTableAccounts,
          swapOutAmount: quote.outAmount,
          swapMinOutAmount: quote.otherAmountThreshold,
        };
      }
    }
    throw new Error(
      `Could not find a swap with ${maxLockedAccounts(
        txAccounts.size
      )} accounts`
    );
  }
}

export function transformResponseIx(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: ix.data ? Buffer.from(ix.data, "base64") : undefined,
  });
}

export function transformResponseIxs(
  ixs: Instruction[]
): TransactionInstruction[] {
  return ixs.map((ix) => transformResponseIx(ix));
}

function reconstructQuoteUrl(request: QuoteGetRequest): string {
  return `${JUP_V6_DEBUG_BASE_URL}/quote?${new URLSearchParams(
    request as {}
  ).toString()}`;
}

function reconstructSwapUrl(request: SwapInstructionsPostRequest): string {
  return `curl -L '${JUP_V6_DEBUG_BASE_URL}/swap-instructions' \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json' \\
  -d '${JSON.stringify(request.swapRequest)}'`;
}
