# Express Relay

The Express Relay and Opportunity Adapter contracts are written in anchor and can be found in `/express_relay/programs`. There is also a dummy lending protocol used for testing called EZLend. To run some rust-based unit tests of the Express Relay contract through `solana-program-test`, run `cargo test-sbf`.

Integration tests of the entire end-to-end system (Express Relay, Opportunity Adapter, lending protocol) can be found in `express_relay/tests/express_relay.ts`. These include setup and liquidation of a Kamino protocol obligation, to simulate a Kamino integration with Express Relay. The repo also includes a submodule, for which you will need access to the external repo.

To run the integration tests, first open a local validator manually with `solana-test-validator $(./kamino-lending-liquidations-bot/deps/test-validator-params.sh)`. Then run `anchor build`, `anchor deploy`, and `anchor run test`.
