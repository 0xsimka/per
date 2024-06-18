import { Decimal } from "decimal.js";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { KaminoMarket, WRAPPED_SOL_MINT } from "@kamino-finance/klend-sdk";
import { TokenOracleData } from "./oracle";
import { WalletBalances, TokenBalance } from "./types";
import {
  Token,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AccountInfo as TokenAccount,
} from "@solana/spl-token";
import { fromLamports } from "./utils";
import { deserializeTokenAccount } from "./token";

export async function getWalletBalances(
  c: Connection,
  market: KaminoMarket,
  wallet: Keypair,
  tokensOracle: TokenOracleData[]
): Promise<WalletBalances> {
  const cTokenMints: Array<[string, PublicKey, number]> = [];
  const liquidityMints: Array<[string, PublicKey, number]> = [];
  for (const reserve of market.reserves.values()) {
    let { symbol } = reserve.stats;
    if (symbol === "SOL") {
      symbol = "WSOL";
    }
    const decimals = reserve.state.liquidity.mintDecimals.toNumber();
    liquidityMints.push([symbol, reserve.getLiquidityMint(), decimals]);
    cTokenMints.push([`c${symbol}`, reserve.getCTokenMint(), decimals]);
  }
  for (const d of tokensOracle) {
    if (liquidityMints.find((x) => x[1].equals(d.mintAddress)) === undefined) {
      let { symbol } = d;
      if (symbol === "SOL") {
        symbol = "WSOL";
      }
      liquidityMints.push([
        symbol,
        d.mintAddress,
        Decimal.log10(d.decimals).toNumber(),
      ]);
    }
  }
  const allMints = liquidityMints.concat(cTokenMints);
  const allMintKeys = allMints.map((x) => x[1]);
  const allTokenAccKeys = await Promise.all(
    allMintKeys.map(async (mint) =>
      Token.getAssociatedTokenAddress(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        wallet.publicKey
      )
    )
  );
  const allTokenAccInfos = await c.getMultipleAccountsInfo(allTokenAccKeys);
  // if (shouldCreateAccounts) {
  //   await createMissingAtas(c, wallet, allTokenAccKeys, allTokenAccInfos, allMints, averageFeePerCULamports);
  // }

  const allTokenAccs = allTokenAccInfos
    .map((acc, i) => ({
      addr: allTokenAccKeys[i],
      acc,
    }))
    .map(({ addr, acc }) =>
      acc ? deserializeTokenAccount(addr, acc!.data) : null
    );
  const liquidityTokenAccs: Array<
    [string, PublicKey, number, PublicKey, TokenAccount | null]
  > = [];
  const cTokenAccs: Array<
    [string, PublicKey, number, PublicKey, TokenAccount | null]
  > = [];
  allTokenAccs.forEach((acc, i) => {
    if (i >= liquidityMints.length) {
      cTokenAccs.push([...allMints[i], allTokenAccKeys[i], acc]);
    } else {
      liquidityTokenAccs.push([...allMints[i], allTokenAccKeys[i], acc]);
    }
  });
  const liquidityBalances = getBalances(liquidityTokenAccs);
  const cTokenBalances = getBalances(cTokenAccs);

  const solBalance = await c.getBalance(wallet.publicKey);
  liquidityBalances.push({
    mint: WRAPPED_SOL_MINT,
    balance: new Decimal(fromLamports(solBalance, 9)),
    balanceBase: solBalance,
    symbol: "SOL",
    ata: wallet.publicKey,
  });

  const tokensOracleWithWsol = [...tokensOracle];
  const solOracle = tokensOracle.find((x) => x.symbol === "SOL");
  if (solOracle !== undefined) {
    tokensOracleWithWsol.push({
      ...solOracle,
      symbol: "WSOL",
    });
  }

  return {
    liquidityBalances,
    cTokenBalances,
  };
}

function getBalances(
  liquidityTokenAccs: Array<
    [string, PublicKey, number, PublicKey, TokenAccount | null]
  > // symbol, mint, decimals, ata, account
): TokenBalance[] {
  const liquidityBalances: TokenBalance[] = [];
  for (const [
    symbol,
    mint,
    decimals,
    ata,
    tokenAccount,
  ] of liquidityTokenAccs) {
    const tokenBalance = getTokenBalance(
      mint,
      ata,
      symbol,
      decimals,
      tokenAccount
    );
    liquidityBalances.push(tokenBalance);
  }
  return liquidityBalances;
}

function getTokenBalance(
  mintAddress: PublicKey,
  ata: PublicKey,
  symbol: string,
  decimals: number,
  tokenAccount: TokenAccount | null
): TokenBalance {
  if (tokenAccount === null) {
    return {
      mint: mintAddress,
      balance: new Decimal("0"),
      balanceBase: 0,
      symbol,
      ata,
    };
  }
  return {
    mint: mintAddress,
    balance: new Decimal(fromLamports(tokenAccount.amount, decimals)),
    balanceBase: tokenAccount.amount.toNumber(),
    symbol,
    ata,
  };
}
