# Mesa

Preparation for Mina's Mesa testnet, on the `mesa` branch. **Not deployed** —
`main` and the live server stay on devnet.

| | |
|---|---|
| Node | `https://mesa.minataur.net/graphql` |
| Archive | `https://archive-node-api.mesa-rc.minaprotocol.com/` |
| Local node | `http://127.0.0.1:8080/graphql` |
| Explorer | none yet |
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

The frontend switches on `VITE_MINA_NETWORK=mesa`, and `MinaLink` renders plain
text instead of a link when the network has no explorer. Interpolating an empty
base produced `/account/B62…`, a relative link landing on the app's own 404 —
which reads as a broken app rather than a young network.

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

**The Flare side does not move.** Same contracts, same chain, same addresses:
only the Mina half is on a new network. The bridge is asymmetric that way, which
is convenient here.

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
