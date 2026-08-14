# Mesa

Preparation for Mina's Mesa testnet, on the `mesa` branch. **Not deployed** —
`main` and the live server stay on devnet.

| | |
|---|---|
| Node | `https://mesa.minataur.net/graphql` |
| Archive | `https://archive-node-api.mesa-rc.minaprotocol.com/` |
| Local node | `http://127.0.0.1:8080/graphql` |
| Explorer | `https://minascan.io/mesa` |
| Chain id | `3d7e786be10344e6f143448df5b31d0e1fcb230503a9c4ddf20f61f6d8fe6ba4` |

Both endpoints answered when this was written: the node reports `SYNCED`, the
archive returns 200.

## What the code needed

Endpoints were a default string repeated across eight files, so the network was
not a setting — it was a search-and-replace. They now resolve through
[`apps/relayer/src/minaNetwork.ts`](../apps/relayer/src/minaNetwork.ts) from
`MINA_NETWORK=devnet|mesa`, with every individual endpoint still overridable.

`MINA_DEVNET_GRAPHQL` is still honoured, because that is what the running server
sets and renaming it would have broken production for no gain.

The prover worker resolves the same thing inline. It is a worker entry, and its
loader does not rewrite `.js` specifiers — the same constraint that forced
`resilientFetch` to be duplicated there. **Keep the two in step.**

The frontend switches on `VITE_MINA_NETWORK=mesa`. Minascan serves Mesa at
`/mesa`, so links work there — but `MinaLink` still guards on the base being
set, because interpolating an empty one builds `/account/B62…`, a relative link
onto the app's own 404, and the next network may arrive before its explorer.

## The blocker: o1js must move to 3.0.0-mesa

Deploying the escrow fails at `send()` with a bare `502 Bad Gateway`, and the
error is misleading — nothing is wrong with the endpoint.

What was ruled out, in order:

| Hypothesis | Test | Result |
|---|---|---|
| Endpoint down | `{ syncStatus }` | `SYNCED`, height 306818 |
| Mutations unsupported | `sendZkapp` with an empty input | GraphQL validation error, HTTP 200 — the field exists |
| Body too large | 200 KB POST | HTTP 200 |
| That one provider | Retried on `api.minascan.io/node/mesa/v1/graphql` | identical 502 |
| Transaction landed anyway | account lookup, payer nonce | account null, nonce still 0, balance untouched |

Two independent providers rejecting the same payload is not an infrastructure
problem. **Mesa is a protocol change, and o1js 2.15.0 (May 2026) predates it.**
npm carries a whole `3.0.0-mesa.*` line, `@o1js/native` included:

```
o1js          3.0.0-mesa.final, 3.0.0-mesa.rc2, 3.0.0-mesa.89164, …
@o1js/native  3.0.0-mesa.final, 3.0.0-mesa.rc2, …
```

The node is handed a zkApp command in the old format and refuses it in a way the
gateway reports as 502.

So the Mina half of this branch is blocked on a **major version upgrade**, not a
configuration change:

- `o1js` 2.15 → 3.0.0-mesa across `packages/mina-contracts` and the relayer
- `@o1js/native` in step, or the prover loses its backend
- `mina-fungible-token` 1.1.0 is built against o1js 2.x and has published nothing
  for Mesa — the three `AssetPort`s depend on it, so the asset rail may need it
  vendored or replaced
- every circuit recompiles, so the 7 GB proving-key cache is rebuilt from zero
- the verification keys change, which is what `deployBridge` writes on chain

None of that is hard, but it is a day's work with real regression risk, and it
touches the code that is currently live on devnet. It does not belong in the
same push as a hackathon deadline.

## What still has to happen, and cannot be done from a config file

**Every zkApp must be redeployed.** A zkApp is an account on one chain; escrow,
the three `AssetPort`s and the three `FungibleToken`s do not exist on Mesa until
they are deployed there. New addresses everywhere:

```
packages/mina-contracts/scripts/deployBridge.ts
packages/mina-contracts/scripts/deployWrappedAsset.ts   # once per asset
```

Then fill `MINA_BRIDGE_ACCOUNT` and `MINA_ASSET_PORTS` in `.env.mesa`, and
`VITE_MINA_BRIDGE_ACCOUNT` for the frontend.

**The fee payer needs Mesa MINA.** The devnet faucet will not fund it.

**Auro has to support Mesa**, or nobody can sign. Unverified — check before
assuming the frontend works end to end. If it does not, the demo path is a local
node plus a script, not a wallet.

**The Flare side moves too — most of it.** An earlier draft of this file said it
did not, and that was wrong. Two relayers cannot share one `TransferChain`: both
read the same `Transferred` events, both try to settle them against their own
Mina network, and each advances a cursor the other never sees. The Mesa
environment needs its own chain, vault and bridge:

```bash
export COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc
export PRIVATE_KEY=0x...        # ~25 C2FLR
bash scripts/deploy-mesa-flare.sh
```

`MinaAuthRegistry` and `MinaAccountFactory` are deliberately **not** redeployed.
The factory derives an account address with `CREATE2` over a Mina public key, so
a second factory would hand every user a different Flare account for the same
key, with their funds on the other one. The registry only consumes nonces per
key, which two environments can share.

### Deployed, 14 August 2026

| Contract | Address |
|---|---|
| `MinaPortBridge` (proxy) | [`0x06E584e7…3517`](https://coston2-explorer.flare.network/address/0x06E584e72b36494Bb84A2C1df34E665Cf7673517) |
| `FMINA` | [`0x05b5e850…1C7f`](https://coston2-explorer.flare.network/address/0x05b5e8505e35505233955080f02b7351747B1C7f) |
| `AssetVault` (proxy) | [`0x669BDaa9…3EeC`](https://coston2-explorer.flare.network/address/0x669BDaa9B9802Ca92A4Ed5a29933805B09E33EeC) |
| `TransferChain` | [`0x56Ae0044…57E1`](https://coston2-explorer.flare.network/address/0x56Ae0044E5115A84137908006eC24994896157E1) |
| `BridgeWrapperFactory` | [`0x45d401A5…Fe38`](https://coston2-explorer.flare.network/address/0x45d401A560853b71C6546124F0AA8553cE59Fe38) |
| `MockSettlementVerifier` | `0x1BCb4d07dCa6d07402d6b6395B350777DE4CEb4D` ⚠️ |

9.13 C2FLR for the three deployments. Bytecode verified present at every
address afterwards — which matters, because the first attempt printed all five
addresses and deployed nothing.

**`--private-key` is not optional.** The scripts call `vm.startBroadcast()` with
no argument, so without it forge signs with its default sender, prints the
addresses it *would* have used, exits 1, and broadcasts nothing. The simulated
addresses are indistinguishable from real ones until you check `eth_getCode`.

Order is forced by the wiring: `TransferChain` reads the bridge and the vault to
register each as an appender for the tokens it may record, so both exist first.

## What does not break

Signature verification. `mina-signer` hardcodes the devnet domain in
`signFields` on every network, so nothing about Mesa changes what is signed —
and an authorization is bound to its chain by the `chainId` field inside the
message, not by the Mina network domain. See the note in the README.

## Worth doing while here

Mesa publishes an archive node; devnet's public ones were unreachable. That is
what `releases.ts` wanted: it currently infers a burn landed from the holder's
balance falling, because reading the event back needs archive access. With
`MINA_ARCHIVE` set, that heuristic could become the precise signal.

Not done — the heuristic works, and changing a settlement path deserves its own
branch.
