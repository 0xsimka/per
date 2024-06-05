import * as path from "path";
import { Env } from "./types";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { execSync } from "child_process";
import { writeFileSync } from "fs";

export async function createKeypair(
  env: Env,
  filename: string
): Promise<[Keypair, string]> {
  const dir = path.join(__dirname, "../../tmp");
  execSync(`mkdir -p ${dir}`);
  const liquidatorFile = `${dir}/${filename}`;

  // Create and fund it
  const liquidator = Keypair.generate();
  await env.provider.connection.requestAirdrop(
    liquidator.publicKey,
    1 * LAMPORTS_PER_SOL
  );

  const x = `[${liquidator.secretKey.toString()}]`;

  writeFileSync(liquidatorFile, x, { encoding: "utf-8" });
  console.log(`Written to ${liquidatorFile}`);
  return [liquidator, liquidatorFile];
}
