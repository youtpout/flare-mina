#!/usr/bin/env bash
# Deploy a second, isolated set of Flare contracts for the Mesa environment.
#
#   export COSTON2_RPC_URL=https://coston2-api.flare.network/ext/C/rpc
#   export PRIVATE_KEY=0x...        # ~25 C2FLR: https://faucet.flare.network
#   bash scripts/deploy-mesa-flare.sh
#
# # Why a second set at all
#
# Two relayers cannot share one TransferChain. Both would read the same
# `Transferred` events, both would try to settle them against their own Mina
# network, and each would advance a cursor the other never sees. The Mesa
# relayer must watch its own chain, its own vault and its own bridge.
#
# # Including the auth pair
#
# MinaAuthRegistry and MinaAccountFactory are redeployed too. Sharing them would
# keep one Flare address per Mina key across both environments, which is
# convenient — but testing here would then consume the production registry's
# nonces, and a test environment must not be able to disturb the one being
# judged. The cost is that a Mina key derives a different Flare address on each.
set -euo pipefail

cd "$(dirname "$0")/../packages/flare-contracts"

: "${COSTON2_RPC_URL:?set COSTON2_RPC_URL}"
: "${PRIVATE_KEY:?set PRIVATE_KEY to a funded deployer}"
: "${ESCROW_ATTESTOR:?set ESCROW_ATTESTOR — DeployBridge reads it}"

# --private-key explicitly: the scripts call vm.startBroadcast() with no
# argument, so without it forge signs with its default sender, prints the
# addresses it *would* have used, and exits 1 having broadcast nothing. The
# simulated addresses look exactly like real ones.
#
# The other two flags are required on Coston2. Without --with-gas-price forge
# estimates at roughly four times the real cost and refuses to broadcast on an
# ample balance; without --legacy the send fails with "max priority fee per gas
# higher than max fee per gas", because --with-gas-price caps the max fee only.
FLAGS="--rpc-url $COSTON2_RPC_URL --private-key $PRIVATE_KEY \
  --with-gas-price 700gwei --legacy --broadcast"

# Order is forced by the wiring: TransferChain reads the bridge and the vault to
# register each as an appender for the tokens it may record, so both must exist
# and be owned by this deployer first.

echo "==> MinaAuthRegistry + MinaAccountFactory"
forge script script/DeployAuth.s.sol $FLAGS

echo
echo "==> MinaPortBridge + FMINA + wrapper factory"
forge script script/DeployBridge.s.sol $FLAGS

echo
echo "==> AssetVault"
forge script script/DeployAssetVault.s.sol $FLAGS

echo
echo "==> TransferChain (needs FLARE_BRIDGE_ADDRESS and FLARE_ASSET_VAULT_ADDRESS"
echo "    from the two above — export them, then run this last step)"
if [[ -n "${FLARE_BRIDGE_ADDRESS:-}" && -n "${FLARE_ASSET_VAULT_ADDRESS:-}" ]]; then
  forge script script/DeployTransferChain.s.sol $FLAGS
else
  echo "    skipped: export both and re-run."
fi

cat <<'NEXT'

Done. Collect the addresses from the broadcast logs under
packages/flare-contracts/broadcast/ and put them in apps/relayer/.env.mesa:

  FLARE_TRANSFER_CHAIN_ADDRESS=
  FLARE_BRIDGE_ADDRESS=            # the proxy, never the implementation
  FLARE_FMINA_ADDRESS=
  FLARE_ASSET_VAULT_ADDRESS=       # the proxy

  FLARE_ACCOUNT_FACTORY=           # this environment's own, from DeployAuth

Then the Mina side on Mesa — see docs/mesa.md.
NEXT
