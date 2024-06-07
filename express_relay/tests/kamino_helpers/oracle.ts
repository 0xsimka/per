import { Connection, PublicKey } from "@solana/web3.js";
import Decimal from "decimal.js";
import {
  KaminoMarket,
  KaminoReserve,
  PubkeyHashMap,
} from "@kamino-finance/klend-sdk";
import { getTokenOracleData as getTokenOracleDataSdk } from "@kamino-finance/klend-sdk/dist/utils/oracle";

export type TokenOracleData = {
  symbol: string;
  reserveAddress: PublicKey;
  mintAddress: PublicKey;
  /**
   * 10 ** number of decimals of the token, e.g. 1_000_000 for 6 decimals
   */
  decimals: Decimal;
  price: Decimal;
};

function getTokenOracleData(reserve: KaminoReserve): TokenOracleData {
  return {
    symbol: reserve.stats.symbol,
    reserveAddress: reserve.address,
    mintAddress: reserve.tokenOraclePrice.mintAddress,
    decimals: reserve.tokenOraclePrice.decimals,
    price: reserve.tokenOraclePrice.price,
  };
}

export function getTokensOracleData(
  market: KaminoMarket,
  ...additionalTokensOracleData: TokenOracleData[]
): TokenOracleData[] {
  const tokens: TokenOracleData[] = new Array<TokenOracleData>(
    ...additionalTokensOracleData
  );
  for (const reserve of market.reserves.values()) {
    tokens.push(getTokenOracleData(reserve));
  }
  return tokens;
}

/**
 * Get oracle prices for additional tokens, not included in the market reserves, by passing in reserves from other markets
 * @param c
 * @param additionalTokenInfos - reserves not belonging to the current market that we want prices from
 */
export async function getAdditionalOraclePrices(
  c: Connection,
  additionalTokenInfos: KaminoReserve[]
): Promise<Array<TokenOracleData>> {
  const byLiqMint = new PubkeyHashMap<PublicKey, KaminoReserve>();
  const res = additionalTokenInfos.map((r) => {
    byLiqMint.set(r.getLiquidityMint(), r);
    return r.state;
  });
  const d = await getTokenOracleDataSdk(c, res);
  return d
    .map(([r, d]) => {
      if (!d) {
        throw new Error(
          `Failed to load oracle data for ${
            byLiqMint.get(r.liquidity.mintPubkey)!.symbol
          }`
        );
      }
      return d;
    })
    .map((d) => ({
      reserveAddress: PublicKey.default, // use a placeholder, the source reserve does not belong to the market
      mintAddress: d.mintAddress,
      decimals: d.decimals,
      price: d.price,
      symbol: byLiqMint.get(d.mintAddress)!.symbol,
    }));
}
