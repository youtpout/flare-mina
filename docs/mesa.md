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

## o1js 3.0.0-mesa.rc2 — resolved

Deploying the escrow first failed at `send()` with a bare `502 Bad Gateway`, and
the error pointed nowhere useful. What was ruled out, in order:

| Hypothesis | Test | Result |
|---|---|---|
| Endpoint down | `{ syncStatus }` | `SYNCED`, height 306818 |
| Mutations unsupported | `sendZkapp` with an empty input | GraphQL validation error, HTTP 200 |
| Body too large | 200 KB POST | HTTP 200 |
| That one provider | retried on `api.minascan.io/node/mesa/v1/graphql` | identical 502 |
| Landed anyway | account lookup, payer nonce | account null, nonce 0, balance untouched |

Two independent providers rejecting the same payload is not infrastructure.
**Mesa is a protocol change and o1js 2.15.0 (May 2026) predates it** — the node
was handed an old-format zkApp command and refused it in a way the gateway
reported as 502.

Upgrading `o1js` and `@o1js/native` to **3.0.0-mesa.rc2** fixed it, and the
transaction went through on the first attempt afterwards.

What the upgrade cost, which was less than feared:

- **No source changes.** `packages/mina-contracts`, `packages/shared` and the
  relayer all typecheck at zero errors against o1js 3.
- **`mina-fungible-token` 1.1.0 still resolves**, with an unmet peer warning
  (`o1js@^2.1.0` against 3.0.0-mesa.rc2) and no observed breakage. If it does
  break, `action-dex` vendors the two files for exactly this reason and that is
  the escape hatch.
- **Verification keys change**, as expected: the bridge went from
  `11711286639348513012986112061990663846097941521680299234457020552929721151304`
  to `11216428838033659006439281404822944761910303879649649802808410393201267236433`.
  Anything holding the old hash on chain is not upgradeable to this — it is a
  fresh deployment, which is what this environment is.
- The proving-key cache rebuilds from zero, so the first prover start is cold.

**This is on the `mesa` branch only.** `main` and the live server stay on
o1js 2.15: the verification keys of the deployed devnet zkApps are the old ones.

## Deployed on Mesa

| | Address |
|---|---|
| Escrow zkApp | [`B62qrethR1rquZpRA19v72jYyWvQq55wkQXCSeNDrR1u4EmC42Xxxic`](https://minascan.io/mesa/account/B62qrethR1rquZpRA19v72jYyWvQq55wkQXCSeNDrR1u4EmC42Xxxic) |

Its state carries the signing-policy root and the Mesa `TransferChain` address,
so the FDC path is wired. The three `AssetPort`s and their `FungibleToken`s are
still to deploy.

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
