import { Keypair } from "@solana/web3.js";
import * as fs from "fs";

export function saveKeypair(keypair: Keypair, name: string) {
  const secretKey = Array.from(keypair.secretKey);
  const outputFilePath = `../../keypairs/${name}.json`;
  fs.writeFileSync(outputFilePath, JSON.stringify(secretKey, null, 2));
  console.log("Keypair saved to:", outputFilePath);
}

export function loadKeypair(filepath: string): Keypair {
  const keypairData = fs.readFileSync(filepath, "utf-8");
  const secretKeyArray = JSON.parse(keypairData) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secretKeyArray));
}
