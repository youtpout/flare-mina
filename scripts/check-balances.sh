#!/usr/bin/env bash
# Show what the deployer holds on Coston2: native C2FLR, FXRP, USD₮0.
#
# Usage: ./scripts/check-balances.sh
set -euo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env — copy .env.example and fill it in"; exit 1; }
set -a; . ./.env; set +a

# Both verified on-chain; see packages/shared/src/tokens.ts for how.
FXRP=0x0b6A3645c240605887a5532109323A3E12273dc7
USDT0=0xC1A5B41512496B80903D1f32d6dEa3a73212E71F

printf 'address : %s\n' "$DEPLOYER_ADDRESS"
printf 'C2FLR   : %s\n' \
  "$(cast from-wei "$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$COSTON2_RPC_URL")")"

# Both tokens are 6 decimals, so scale by 1e6 rather than the 1e18 `from-wei`
# assumes.
for pair in "FXRP :$FXRP" "USD₮0:$USDT0"; do
  label="${pair%%:*}"; addr="${pair##*:}"
  raw=$(cast call "$addr" "balanceOf(address)(uint256)" "$DEPLOYER_ADDRESS" \
        --rpc-url "$COSTON2_RPC_URL" | awk '{print $1}')
  printf '%s   : %s.%06d\n' "$label" "$((raw / 1000000))" "$((raw % 1000000))"
done

printf '\nFund at https://faucet.flare.network — 100 C2FLR, 10 USD₮0, 10 FXRP per 24h.\n'
