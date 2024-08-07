# Express Relay

The Express Relay and Opportunity Adapter contracts are written in anchor and can be found in `/express_relay/programs`. There is also a dummy lending protocol used for testing called EZLend. To run some rust-based unit tests of the Express Relay contract through `solana-program-test`, run `cargo test-sbf`.

Integration tests of the entire end-to-end system (Express Relay, Opportunity Adapter, lending protocol) can be found in `express_relay/tests/express_relay.ts`. These include setup and liquidation of a Kamino protocol obligation, to simulate a Kamino integration with Express Relay. The repo also includes a submodule, for which you will need access to the external Kamino repo.

Note that you may first have to `anchor build` and then `anchor deploy` with `solana-test-validator --reset` and ensure that the Typescript IDLs all have the correct program address. This was a bug I encountered, and while I'm not sure why the address field was sometimes empty, these steps address it for now.

To run the integration tests, first open a local validator manually with `solana-test-validator $(./test-validator-params-kamino.sh)`. You may need to permission the bash file first with `chmod +x test-validator-params-kamino.sh`. Then run `anchor run test`. The `anchor run test` command is set in `Anchor.toml` and contains a few CLI args that you can vary. These CLI args are:

- `log-level`: options, in increasing order of pruning of logged messages, are `debug` (helpful if you want to see some details on transaction size breakdown), `log` (just see overall transaction sizes), `warn`, `error`, `none`
- `kamino-elim-ixs`: this allows you to set which instructions in the constructed Kamino liquidate transaction are removed. Options are `none` (keeps all instructions), `initFarm` (removes just the instructions that initialize farms for the collateral/debt assets), `farm` (removes all farm-related instructions).

The anchor tests create Express Relay transactions of three kinds: "empty" ones containing no protocol liquidation instructions, just the Express Relay `permission`/`depermission` instructions; transactions containing EzLend (a dummy program created for testing purposes) liquidation instructions; and transactions containing Kamino Lend liquidation instructions. For each of these three, we test sizing of the transaction with and without the Opportunity Adapter (which add some accounts in the Express Relay transaction and potentially decreases the number of signatures). The tests run EzLend transactions to make sure the liquidations actually take place.
