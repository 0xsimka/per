## Minified express relay

### How to run the benchmark

`anchor run test`

### Inspect transactions:

Run the tests with the `--detach` flag:

```shell
anchor run test --detach
```

Publish the idl files:

```shell
anchor idl init -f target/idl/solana_per.json 3qiTuH24j5XUYtiEoidyCaJi8tb8LPD9oXecJrRR1m2K
anchor idl init -f target/idl/limit_order.json 6Pv94K3DycMf9nGJumN7z7SrydGErEjVjsYVXC5b31RN
```

Use explorer to inspect the transactions.
