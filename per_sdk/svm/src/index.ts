import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Decimal } from "decimal.js";
import bs58 from "bs58";

import * as limo from "@kamino-finance/limo-sdk";
import { loadKeypair, saveKeypair } from "./utils";

const LIMO_PID = "LiMoM9rMhrdYrfzUCxQppvxCSG1FcrUK9G8uLq4A1GF";

const argv = yargs(hideBin(process.argv))
  .option("filepath-sk-admin", {
    description:
      "Filepath of JSON containing secret key of admin authority of limo global config",
    type: "string",
    demandOption: true,
  })
  .option("filepath-sk-searcher", {
    description:
      "Filepath of JSON containing secret key of searcher authority of limo global config",
    type: "string",
    demandOption: true,
  })
  .option("filepath-mint-input", {
    description: "Filepath of JSON containing secret key of input token mint",
    type: "string",
    demandOption: true,
  })
  .option("filepath-mint-output", {
    description: "Filepath of JSON containing secret key of output token mint",
    type: "string",
    demandOption: true,
  })
  .option("endpoint-svm", {
    description: "SVM RPC endpoint",
    type: "string",
    demandOption: true,
  })
  .help()
  .alias("help", "h")
  .parseSync();
async function run() {
  const connection = new Connection(argv.endpointSvm, "confirmed");
  let limoClient = new limo.LimoClient(connection, undefined);

  const globalConfigKp = Keypair.generate();
  const adminKp = loadKeypair(argv.filepathSkAdmin);
  const searcherKp = loadKeypair(argv.filepathSkSearcher);
  const mintInput = loadKeypair(argv.filepathMintInput);
  let sigInitializeGlobalConfig = await limoClient.createGlobalConfig(
    adminKp,
    globalConfigKp,
    searcherKp.publicKey,
    mintInput.publicKey
  );
  console.log(
    `Submitted InitializeGlobalConfig transaction with signature: ${sigInitializeGlobalConfig}`
  );

  limoClient.setGlobalConfig(globalConfigKp.publicKey);

  let sigInitializeVault = await limoClient.initializeVault(
    adminKp,
    mintInput.publicKey
  );
  console.log(
    `Submitted InitializeVault transaction with signature: ${sigInitializeVault}`
  );

  let sigInitializeTipVault = await limoClient.initializeTipVault(
    adminKp,
    mintInput.publicKey
  );
  console.log(
    `Submitted InitializeTipVault transaction with signature: ${sigInitializeTipVault}`
  );

  const mintOutput = loadKeypair(argv.filepathMintOutput);
  const [sigCreateOrder, orderKp] = await limoClient.createOrderGeneric(
    adminKp,
    mintInput.publicKey,
    mintOutput.publicKey,
    new Decimal(1000),
    new Decimal(2000)
  );
  console.log(
    `Submitted CreateOrder transaction with signature: ${sigCreateOrder}, order account: ${orderKp.publicKey.toBase58()}`
  );

  saveKeypair(globalConfigKp, "global_config");
  saveKeypair(orderKp, "order");
}

run();
