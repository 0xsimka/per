import { Router, RouterOutput } from "../types";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createJupiterApiClient,
  DefaultApi,
  Instruction as JupiterInstruction,
} from "@jup-ag/api";

const MAX_SLIPPAGE_BPS = 50;

export class JupiterRouter implements Router {
  private chainId: string;
  private executor: PublicKey;
  private maxAccounts: number;
  private jupiterClient: DefaultApi;
  private quoteurl: URL;

  constructor(
    chainId: string,
    executor: PublicKey,
    maxAccounts: number,
    basePath: string,
    apiKey?: string
  ) {
    this.chainId = chainId;
    this.executor = executor;
    this.maxAccounts = maxAccounts;
    if (apiKey) {
      this.jupiterClient = createJupiterApiClient({
        basePath,
        apiKey: apiKey,
      });
      console.log(`Jupiter client created with API key`);
      console.log(`base path: ${basePath}`);
      console.log(`API key: ${apiKey}`);
    } else {
      this.jupiterClient = createJupiterApiClient({
        basePath,
      });
    }
    this.quoteurl = new URL(`${basePath}/quote`);
  }

  async route(
    tokenIn: PublicKey,
    tokenOut: PublicKey,
    amountIn: bigint
  ): Promise<RouterOutput> {
    if (!["mainnet-beta-solana", "development-solana"].includes(this.chainId)) {
      throw new Error("Jupiter error: chain id not supported");
    }

    console.log(`tokenIn: ${tokenIn.toBase58()}`);
    console.log(`tokenOut: ${tokenOut.toBase58()}`);
    console.log(`amountIn: ${amountIn}`);
    console.log(`url: ${this.quoteurl.toString()}`);
    console.log(`debugging, does this msg show up?`);
    console.log(`once more version 1`);

    const quoteResponseDumb = await fetch(
      `${this.quoteurl.toString()}?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=50000000&autoSlippage=true&maxAutoSlippageBps=50&maxAccounts=${
        this.maxAccounts
      }`
    );
    console.log(
      `quoteResponseDumb: ${quoteResponseDumb.status}, ${quoteResponseDumb.statusText}, ${quoteResponseDumb.body}`
    );
    console.log(`quoteResponseDumb: ${quoteResponseDumb}`);

    const quoteResponse = await this.jupiterClient.quoteGet({
      inputMint: tokenIn.toBase58(),
      outputMint: tokenOut.toBase58(),
      amount: Number(amountIn),
      autoSlippage: true,
      maxAutoSlippageBps: MAX_SLIPPAGE_BPS,
      maxAccounts: this.maxAccounts,
    });

    // console.log(`Jupiter quote response: ${JSON.stringify(quoteResponse)}`);

    const instructions = await this.jupiterClient.swapInstructionsPost({
      swapRequest: {
        userPublicKey: this.executor.toBase58(),
        quoteResponse,
      },
    });

    // console.log(`Jupiter swap instructions: ${JSON.stringify(instructions)}`);

    const { setupInstructions, swapInstruction, addressLookupTableAddresses } =
      instructions;

    const ixsSetupJupiter = setupInstructions.map((ix) =>
      this.convertInstruction(ix)
    );
    const ixsJupiter = [
      ...ixsSetupJupiter,
      this.convertInstruction(swapInstruction),
    ];

    return {
      ixsRouter: ixsJupiter,
      amountIn,
      amountOut: BigInt(quoteResponse.outAmount),
      lookupTableAddresses: addressLookupTableAddresses.map(
        (addr) => new PublicKey(addr)
      ),
    };
  }

  private convertInstruction(
    instruction: JupiterInstruction
  ): TransactionInstruction {
    return new TransactionInstruction({
      programId: new PublicKey(instruction.programId),
      keys: instruction.accounts.map((key) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      data: Buffer.from(instruction.data, "base64"),
    });
  }
}

// function quoteGetRaw(requestParameters: QuoteGetRequest, queryParameters: any) {
//   const headerParameters = {};
//   const response = fetch({
//     path: `/quote`,
//     method: "GET",
//     headers: headerParameters,
//     query: queryParameters
//   });
//   return new JSONApiResponse(response, (jsonValue) => QuoteResponseFromJSON(jsonValue));
// }
