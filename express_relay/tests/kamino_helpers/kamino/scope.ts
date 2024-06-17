import { Env } from "../types";
import { Scope } from "@hubbleprotocol/scope-sdk";
import { PublicKey } from "@solana/web3.js";

export async function createScopeFeed(
  env: Env,
  scope: Scope
): Promise<PublicKey> {
  const [txHash, { configuration, oraclePrices, oracleMappings }] =
    await scope.initialise(env.admin, env.testCase);
  console.debug(
    `Created scope feed ${
      env.testCase
    }, config: ${configuration.toBase58()}, prices: ${oraclePrices.toBase58()}, mappings: ${oracleMappings.toBase58()} with tx ${txHash}`
  );
  return oraclePrices;
}
