import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";

export type Env = {
  provider: anchor.Provider;
  // pool: ConnectionPool;
  programId: PublicKey;
  admin: Keypair;
  wallet: anchor.Wallet;
  testCase: string;
  // jupPerpsAdmin: Keypair;
};

export type AssetQuantityTuple = [string, string];
export type ReserveInitArgs = [string, string] | [string, string, ConfigArgs];
export type ConfigArgs = {
  depositLimit?: BN;
  borrowLimit?: BN;
};
