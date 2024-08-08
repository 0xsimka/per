#!/bin/bash

function print_args {
  # jup perps
  echo "--account H4ND9aYttUVLFmNypZqLjZ52FYiGvdEB45GmwNoKEjTj kamino-lending-liquidations-bot/deps/jup/test-perpetuals.json" # singleton PDA - modified with custom admin and no pools - cannot be dynamically created because the init ix requires signing by the program upgrade authority (although test-validator sets the upgrade auth to Pubkey::default(), it still didn't work for me)

  # kamino
  echo "--account GKnHiWh3RRrE1zsNzWxRkomymHc374TvJPSTv2wPeYdB kamino-lending-liquidations-bot/deps/kamino/global-config.json"
  # mainnet version may be out-of-sync with the localnet .so, but to dump the mainnet idl run: `solana account -u m -o "./deps/kamino/idl.json" --output json "7CCg9Pt2QofuDhuMRegeQAmB6CGGozx8E3x8mbZ18m3H"` and update the owner in the json to "E6qbhrt4pFmCotNUSSEh6E5cRQCEJpMcd79Z56EG9KY"
  echo "--account Fh5hZtAxz2iRXhJEkiEEmXDwg9WsytFNsv36UkAbp47n kamino-lending-liquidations-bot/deps/kamino/idl.json" # Add IDL to improve solana explorer ux - use the latest idl to match the dumped program

  # klend
  echo "--account 8qLKwp1fk8WyqmzarkuMeZEX3AzL4VDSmA2UZTKT2aCJ kamino-lending-liquidations-bot/deps/klend/idl-mainnet.json" # Add IDL to improve solana explorer ux - use the latest idl to match the dumped program

  # pyth
  echo "--account Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD kamino-lending-liquidations-bot/deps/pyth/Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD.json"

  # address lookup table
  echo "--account 33EucPaS4a588jJJn1Ld3Ka9ye15VpgRLvjVTEPtZLCa kamino-lending-liquidations-bot/deps/lookup/33EucPaS4a588jJJn1Ld3Ka9ye15VpgRLvjVTEPtZLCa.json"

  # switchboard
  echo "--account Fi8vncGpNKbq62gPo56G4toCehWNy77GgqGkTaAF5Lkk kamino-lending-liquidations-bot/deps/switchboard/idl.json" # required by switchboard sdk
  echo "--account 2bpwkRWDEXHWYNBDddKssz6te82zCqwLR8qhR2acUtep kamino-lending-liquidations-bot/deps/switchboard/2bpwkRWDEXHWYNBDddKssz6te82zCqwLR8qhR2acUtep.json"
  echo "--account GeKKsopLtKy6dUWfJTHJSSjFTuMagFmKyuq2FHUWDkhU kamino-lending-liquidations-bot/deps/switchboard/kUSDH-USDC_orca.json"

  # fake pyth
  echo "--account 2iXCALg1KSPPPj5rymA5UHkjFxzXRg5csui1r7nmfWtt kamino-lending-liquidations-bot/deps/prices/sol-0_01usd.json"
  echo "--account 1111111QLbz7JHiBTspS962RLKV8GndWFwiEaqKM kamino-lending-liquidations-bot/deps/prices/sol-1usd.json"
  echo "--account 1111111ogCyDbaRMvkdsHB3qfdyFYaG1WtRUAfdh kamino-lending-liquidations-bot/deps/prices/sol-2usd.json"
  echo "--account 11111112D1oxKts8YPdTJRG5FzxTNpMtWmq8hkVx3 kamino-lending-liquidations-bot/deps/prices/sol-3usd.json"
  echo "--account 11111112cMQwSC9qirWGjZM6gLGwW69X22mqwLLGP kamino-lending-liquidations-bot/deps/prices/sol-4usd.json"
  echo "--account 111111131h1vYVSYuKP6AhS86fbRdMw9XHiZAvAaj kamino-lending-liquidations-bot/deps/prices/sol-5usd.json"
  echo "--account 11111113R2cuenjG5nFubqX9Wzuukdin2YfGQVzu5 kamino-lending-liquidations-bot/deps/prices/sol-6usd.json"
  echo "--account 11111113pNDtm61yGF8j2ycAwLEPsuWQXobye5qDR kamino-lending-liquidations-bot/deps/prices/sol-7usd.json"
  echo "--account 11111114DhpssPJgSi1YU7hCMfYt1BJ334YgsffXm kamino-lending-liquidations-bot/deps/prices/sol-8usd.json"
  echo "--account 11111114d3RrygbPdAtMuFnDmzsN8T5fYKVQ7FVr7 kamino-lending-liquidations-bot/deps/prices/sol-9usd.json"
  echo "--account 111111152P2r5yt6odmBLPsFCLBrFisJ3aS7LqLAT kamino-lending-liquidations-bot/deps/prices/sol-10usd.json"
  echo "--account 5EFzYTGXnK2h6XJFZ4Mwc9sp7unoGsLLmYszZ3tmyMbi kamino-lending-liquidations-bot/deps/prices/sol-20usd.json"
  echo "--account 3bz4kRRxBuxaTnNPAPrWTYgo5LiTh436wKnW6FhGhU6o kamino-lending-liquidations-bot/deps/prices/sol-25usd.json"
  echo "--account 3rvg4Y4FBixFGSdfsjjopaNDWMBAUiSgrnursnned17m kamino-lending-liquidations-bot/deps/prices/sol-30usd.json"
  echo "--account E1nAW1ZNVu5L2WuUk3jMMbjWjAyvgTfgPDVa9JRw2DHk kamino-lending-liquidations-bot/deps/prices/stsol-10usd.json"
  echo "--account GK7K44YtZ5XccrNZJ2p2Jm3BWbWoX5YVsoPoTADfMY6V kamino-lending-liquidations-bot/deps/prices/stsol-15usd.json"
  echo "--account 111111193m4hAxmCcGXMfnjVPfNhWSjb69sDgffKu kamino-lending-liquidations-bot/deps/prices/stsol-20usd.json"
  echo "--account 3iwSN33wDGRcqJ89XqYNSt1WKusLPwgK7kMsj1zMBWHF kamino-lending-liquidations-bot/deps/prices/stsol-25usd.json"
  echo "--account 2ooNgGUyeidqruskeFBFsCPrex3GAgBtD62TYzooz6tb kamino-lending-liquidations-bot/deps/prices/stsol-30usd.json"
  echo "--account EFzHrtRNoeLiAwd6rRWfeMuEup19UC9UB4rcky8kXsgV kamino-lending-liquidations-bot/deps/prices/usdc-1usd.json"

  # farms
  echo "--account 6UodrBjL2ZreDy7QdR4YV1oxqMBjVYSEyrFpctqqwGwL kamino-lending-liquidations-bot/deps/farms/global-config.json"
  echo "--account Ey7rZRLbKdhDqcUuSpAkApk3S3dK7RHoKPJST1RRVJAp kamino-lending-liquidations-bot/deps/farms/idl-mainnet.json" # Add IDL to improve solana explorer ux - use the latest idl to match the dumped program

  # scope
  echo "--account 3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C kamino-lending-liquidations-bot/deps/scope/3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C.json"
  echo "--account AWUuZ6o4ZJX2fDqjUqDaA1pfHenZ6XEbmuTamMgM911E kamino-lending-liquidations-bot/deps/scope/idl-mainnet.json" # Add IDL to improve solana explorer ux - use the latest idl to match the dumped program

  # other programs
  echo "--bpf-program E6qbhrt4pFmCotNUSSEh6E5cRQCEJpMcd79Z56EG9KY ./kamino-lending-liquidations-bot/deps/kamino/kamino.so" # built with devnet and integration_test features
  echo "--bpf-program FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr ./kamino-lending-liquidations-bot/deps/farms/farms.so"
  echo "--bpf-program HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ ./kamino-lending-liquidations-bot/deps/scope/scope.so"
  echo "--bpf-program KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD ./kamino-lending-liquidations-bot/deps/programs/kamino_lending.so"
  echo "--bpf-program PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu ./kamino-lending-liquidations-bot/deps/jup/perps.so"
  echo "--bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s ./kamino-lending-liquidations-bot/deps/programs/metaplex.so"
  echo "--bpf-program devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH ./kamino-lending-liquidations-bot/deps/programs/raydium.so" # taken from hubble-common
  echo "--bpf-program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc ./kamino-lending-liquidations-bot/deps/programs/whirlpool.so"

  # express relay programs
  echo "--bpf-program 26HRYgUNuW9zckjghRLzQuBfVoZtKhkVHfPRdYPZW3bz ./target/deploy/express_relay.so"
  echo "--bpf-program D8WXCtJnRkGpGHHeHmUHAKsdtMEFRR7T5LqAXB4BzieS ./target/deploy/ez_lend.so"
  echo "--bpf-program 9K9LArmVbg1zjafXGf1rSt2kNgR4mSwRbGiDyNSnrNTi ./target/deploy/express_relay_minified.so"

  # options
  echo "--reset"
}

print_args
