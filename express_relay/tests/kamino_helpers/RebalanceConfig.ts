import { TokenCount } from "./types";
export class RebalanceConfig {
  /**
   * The target wallet distribution
   */
  targets: TokenCount[];
  /**
   * Padding so we rebalance only when abs(target-actual)/target is greater than padding (in usd)
   */
  paddingUsd: number;
  /**
   * Padding for specific tokens in the token amount
   * Useful for SOL because it is continuously spent on tx fees
   */
  tokenPadding: Map<string, number>;

  constructor(
    baseToken: string,
    targets: TokenCount[],
    paddingUsd: number,
    tokenPadding: Map<string, number>
  ) {
    let finalTargets = [...targets];
    if (finalTargets.length !== 0) {
      // if no base token in target, add it
      const actualBaseToken = baseToken === "SOL" ? "WSOL" : baseToken;
      if (!finalTargets.find(({ symbol }) => symbol === actualBaseToken)) {
        finalTargets = [
          ...finalTargets,
          { symbol: actualBaseToken, target: -1 },
        ];
      }
      if (!finalTargets.find(({ symbol }) => symbol === "SOL")) {
        // Keep some SOL for transaction fees
        finalTargets = [...finalTargets, { symbol: "SOL", target: 0.2 }];
      }
    }

    this.targets = finalTargets;
    this.paddingUsd = paddingUsd;
    this.tokenPadding = tokenPadding;
  }

  public isEnabled(): boolean {
    return this.targets.length > 0;
  }

  static parseWalletDistTarget(targetRaw: string, baseToken: string) {
    const targets: TokenCount[] = [];

    if (targetRaw === "") {
      return targets;
    }

    const targetDistributions = targetRaw
      .replace(/\s+(#.+)?$/, "")
      .replace(/\s/g, ",")
      .split(",");
    for (const dist of targetDistributions) {
      const tokens = dist.split(":");
      const asset = tokens[0];
      const unitAmount = tokens[1];

      targets.push({ symbol: asset, target: parseFloat(unitAmount) });
    }
    const actualBaseToken = baseToken === "SOL" ? "WSOL" : baseToken;
    const baseTokenTarget = targets.find((t) => t.symbol === actualBaseToken);
    if (!baseTokenTarget) {
      throw new Error(
        `No rebalance target found for base token ${actualBaseToken}${
          actualBaseToken === baseToken ? "" : ` (overridden from ${baseToken})`
        }. Please specify a target for ${actualBaseToken} in the TARGETS environment variable.`
      );
    }
    return targets;
  }

  public static getRebalancePaddingConfig(): Map<string, number> {
    const paddingConfig = new Map<string, number>();
    for (const key in process.env) {
      if (key.startsWith("REBALANCE_PADDING_AMOUNT_")) {
        const value = process.env[key]!;
        const s = key.split("_");
        let name = `${s[3].toUpperCase()}`;
        for (let i = 4; i < s.length; i++) {
          name = `${name}-${s[i].toUpperCase()}`;
        }
        paddingConfig.set(name, Number(value));
      }
    }
    if (paddingConfig.get("SOL") === undefined) {
      paddingConfig.set("SOL", 0.15);
    }
    return paddingConfig;
  }
}
