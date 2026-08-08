import { useEffect, useState } from 'react';
import { encodeFunctionData, formatUnits, parseUnits, type Hex } from 'viem';
import type { Session } from '@/App';
import {
  BRIDGE_ASSETS,
  CONTRACTS,
  INBOUND_ASSETS,
  MINA,
  explorerTx,
  minaQuery,
} from '@/lib/config';
import {
  assetVaultAbi,
  bridgeAbi,
  erc20Abi,
  nextNonce,
  readBalances,
  submit,
  type Balance,
} from '@/lib/flare';
import {
  PURPOSE,
  batchHash,
  depositActionHash,
  depositCommitment,
  releaseActionHash,
  signAuthorization,
} from '@/lib/mina';

/**
 * Deposit status, as the API reports it.
 *
 * A deposit needs two authorisations. The user's signature binds the recipient
 * and the amount; the attestor confirms the escrow landed on Mina. Neither party
 * can produce the mint alone, so the UI has to show which half is outstanding
 * rather than a single opaque spinner.
 */
type DepositStatus = 'built' | 'submitted' | 'attested' | 'claimed' | 'failed' | 'aborted';

/**
 * A wrapped asset on its way back to Flare.
 *
 * The mirror of a deposit, and the same 2-of-2: the burn happens on Mina, the
 * attestor says it landed, and the holder's signature says which token, to
 * whom, and how much.
 */
type Release = {
  id: string;
  token: string;
  recipient: string;
  amount: string;
  nonce: string;
  status: 'built' | 'submitted' | 'attested' | 'released' | 'failed' | 'aborted';
  attestation: string | null;
  mina_tx_hash: string | null;
  flare_tx_hash: string | null;
};

type Deposit = {
  id: string;
  status: DepositStatus;
  amountNanomina: string;
  recipient: string;
  nonce: string;
  minaTxHash: string | null;
  flareTxHash: string | null;
  /** The attestor's half. Useless on its own — the depositor still has to sign. */
  attestation: string | null;
  reason: string | null;
};

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

/**
 * Held back from MAX on a deposit. The escrow transaction itself costs a fee,
 * so offering the whole balance produces a transaction the wallet cannot send.
 */
const MINA_FEE_BUFFER = 200_000_000n; // 0.2 MINA

/**
 * What each stage is waiting on.
 *
 * "pending" used to cover three different waits — the state not yet published,
 * the release proof not yet built, the Mina block not yet mined — so a user
 * watching a stuck withdrawal had no way to tell which.
 */
/**
 * What each stage of a locked asset is waiting on.
 *
 * Its own vocabulary, not the withdrawal one: a lock is minting a new wrapped
 * token against collateral in the vault, where a withdrawal is releasing MINA
 * the escrow already holds. Reusing "released" for a mint would name the wrong
 * machine.
 */
const LOCK_STAGE: Record<string, { tag: string; detail: string }> = {
  seen: {
    tag: 'waiting for FDC',
    detail: 'locked on Flare; its chain head reaches Mina at the next publication',
  },
  published: {
    tag: 'proving',
    detail: 'the head is on Mina; the mint proof replays the chain up to this lock',
  },
  minting: { tag: 'minting', detail: 'authorised, waiting for the mint to be included' },
  minted: { tag: 'minted', detail: 'the wrapped token is in your Mina account' },
  failed: { tag: 'failed', detail: 'see the reason below' },
};

const WITHDRAWAL_STAGE: Record<string, { tag: string; detail: string }> = {
  seen: {
    tag: 'waiting for FDC',
    detail: 'the burn is on Flare; its chain state reaches Mina at the next publication',
  },
  published: {
    tag: 'proving',
    detail: 'Mina accepted a state covering this burn — building the release proof',
  },
  releasing: { tag: 'releasing', detail: 'release sent, waiting for a Mina block' },
  released: { tag: 'released', detail: 'MINA delivered to your wallet' },
  failed: { tag: 'failed', detail: 'the release did not go through' },
};

const LABEL: Record<DepositStatus, string> = {
  // The row is written before the proof exists, so the relayer can pick a
  // deposit back up if it restarts mid-flight. This label therefore covers two
  // phases — the relayer still proving, and the proof waiting to be signed —
  // and must not claim the first one is over.
  built: 'Preparing — your wallet will ask you to sign',
  submitted: 'Broadcast — waiting for inclusion on Mina',
  attested: 'Attested — ready to claim',
  claimed: 'Claimed',
  failed: 'Failed',
  aborted: 'Superseded — from an earlier deployment',
};

export function Bridge({ session }: { session: Session }) {
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [direction, setDirection] = useState<'toFlare' | 'toMina'>('toFlare');
  const [claiming, setClaiming] = useState<string | null>(null);
  /**
   * Claims whose transaction is on its way but not yet mined.
   *
   * The claim call returns once the transaction is *submitted*, so clearing the
   * button there re-enabled it while the deposit was still `attested` — and a
   * second click sent a second claim, which the bridge rejects as a consumed
   * intent. No funds at risk, just an error where there was no problem.
   */
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [depositSymbol, setDepositSymbol] = useState('MINA');
  const [depositing, setDepositing] = useState<string | null>(null);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [burnAmount, setBurnAmount] = useState('');
  const [burnSymbol, setBurnSymbol] = useState('FMINA');
  const [burning, setBurning] = useState<string | null>(null);
  const [burnError, setBurnError] = useState<string | null>(null);
  /** FMINA held on Flare — what a withdrawal spends. */
  const [flareBalances, setFlareBalances] = useState<Balance[] | null>(null);
  /** Native MINA held on devnet — what a deposit escrows. */
  const [minaBalance, setMinaBalance] = useState<bigint | null>(null);
  /** Wrapped-asset balances on Mina, by symbol. A missing key means "not read yet". */
  const [minaTokenBalances, setMinaTokenBalances] = useState<Record<string, bigint>>({});
  const [locks, setLocks] = useState<
    | {
        token: string;
        claimId: string;
        amount: string;
        status: string;
        flareTxHash: string;
        minaTxHash: string | null;
      }[]
    | null
  >(null);
  const [withdrawals, setWithdrawals] = useState<
    { nonce: string; amountNanomina: string; status: string }[] | null
  >(null);
  /** The return leg for wrapped assets: a burn on Mina, released on Flare. */
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [burningAsset, setBurningAsset] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [claimingRelease, setClaimingRelease] = useState<string | null>(null);

  /**
   * What the balance queries actually depend on.
   *
   * Not the arrays themselves: the pollers replace them every eight seconds
   * with fresh objects holding identical data, so depending on their identity
   * re-ran every balance query five times a minute forever. That is what
   * eventually gets a public node to stall — one such stall was measured at 61
   * seconds, which is the whole of "why are balances so slow".
   */
  const settlementKey = [
    deposits?.map((d) => `${d.id}:${d.status}`).join(),
    withdrawals?.map((w) => `${w.nonce}:${w.status}`).join(),
    releases?.map((r) => `${r.id}:${r.status}`).join(),
  ].join('|');

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const res = await fetch(`${API}/deposits/${session.packed}`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const body = (await res.json()) as { deposits: Deposit[] };
        if (live) {
          setDeposits(body.deposits);
          setError(null);
          // Drop markers for deposits the chain has now settled, so a claim
          // that genuinely failed becomes clickable again and one that landed
          // does not.
          const settled = new Set(
            body.deposits.filter((d) => d.status !== 'attested').map((d) => d.id),
          );
          setSubmitting((ids) => ids.filter((id) => !settled.has(id)));
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.packed]);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const [w, l, r] = await Promise.all([
          fetch(`${API}/withdrawals/${session.minaAddress}`),
          fetch(`${API}/locks/${session.minaAddress}`),
          fetch(`${API}/releases/${session.account}`),
        ]);
        if (r.ok) {
          const body = (await r.json()) as { releases: Release[] };
          if (live) setReleases(body.releases);
        }
        if (w.ok) {
          const body = (await w.json()) as { withdrawals: typeof withdrawals };
          if (live) setWithdrawals(body.withdrawals);
        }
        if (l.ok) {
          const body = (await l.json()) as { locks: typeof locks };
          if (live) setLocks(body.locks);
        }
      } catch {
        // The deposit poll already surfaces an unreachable API.
      }
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.minaAddress]);

  /**
   * Balances for both sides, refreshed whenever a transfer completes.
   *
   * Neither form could tell the user whether they hold the thing they are about
   * to send: a deposit with no MINA fails in the wallet, and a burn with no
   * FMINA reverts on Flare. Both only after a signature.
   */
  useEffect(() => {
    let live = true;
    readBalances(session.account)
      .then((b) => live && setFlareBalances(b))
      .catch(() => live && setFlareBalances(null));
    return () => {
      live = false;
    };
  }, [session.account, settlementKey]);

  useEffect(() => {
    let live = true;
    minaQuery<{ account?: { balance?: { total?: string } } }>(
      `{ account(publicKey: "${session.minaAddress}") { balance { total } } }`,
    ).then((data) => {
      const total = data?.account?.balance?.total;
      // Already nanomina. Scaling it again showed a balance a billion times
      // too large, and MAX offered an amount no wallet could ever send.
      if (live) setMinaBalance(total === undefined ? null : BigInt(total));
    });
    return () => {
      live = false;
    };
  }, [session.minaAddress, settlementKey]);

  /**
   * Wrapped assets held on Mina, one query per token account.
   *
   * A token balance lives in its own account, keyed by token id — the plain
   * `account(publicKey)` used above only ever returns MINA, which is why every
   * wrapped asset read as empty. An account that has never held the token does
   * not exist at all, and that is a zero rather than an error.
   */
  useEffect(() => {
    let live = true;
    const wrapped = INBOUND_ASSETS.filter((a) => a.tokenId !== undefined);

    Promise.all(
      wrapped.map(async (asset) => {
        const data = await minaQuery<{ account?: { balance?: { total?: string } } }>(
          `{ account(publicKey: "${session.minaAddress}", token: "${asset.tokenId}") { balance { total } } }`,
        );
        return [asset.symbol, BigInt(data?.account?.balance?.total ?? '0')] as const;
      }),
    )
      .then((entries) => live && setMinaTokenBalances(Object.fromEntries(entries)))
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [session.minaAddress, settlementKey]);

  /**
   * Claim an attested deposit.
   *
   * This is the depositor's half of the 2-of-2. The attestor has already said
   * the escrow exists; this signature says where the FMINA goes and how much.
   * Neither is sufficient alone, which is why the attestor cannot pay itself.
   */
  async function claim(d: Deposit) {
    setClaimError(null);
    setClaiming(d.id);
    try {
      if (!d.attestation) throw new Error('not attested yet');

      const amount = BigInt(d.amountNanomina);
      const recipient = d.recipient as `0x${string}`;
      const nonce = BigInt(d.nonce);
      const expiry = BigInt('18446744073709551615');

      const signature = await signAuthorization(session.provider, {
        purpose: PURPOSE.depositIntent,
        chainId: 114n,
        target: CONTRACTS.bridge,
        actionHash: depositActionHash(recipient, amount),
        nonce,
        expiry,
      });

      // Hand the signature to the relayer, which pays the gas. It cannot
      // redirect or resize the mint — the bridge recomputes recipient, amount,
      // nonce and expiry from this signature before minting — so submitting is
      // a favour, not an authorisation. This is what lets a Mina user claim
      // without holding an EVM key.
      const res = await fetch(`${API}/deposits/${d.id}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKey: { x: session.x.toString(), isOdd: session.isOdd, y: session.y.toString() },
          signature: { field: signature.field, scalar: signature.scalar },
          recipient,
          amountNanomina: amount.toString(),
          nonce: nonce.toString(),
          expiry: expiry.toString(),
          attestation: d.attestation,
        }),
      });
      const body = (await res.json()) as { flareTxHash?: string; error?: string };

      if (res.status === 501) {
        // No relayer to pay for it, so fall back to the user's own wallet.
        const data = encodeFunctionData({
          abi: bridgeAbi,
          functionName: 'claimWithMinaSignature',
          args: [
            [session.x, session.isOdd, session.y],
            [BigInt(signature.field), BigInt(signature.scalar)],
            recipient,
            amount,
            nonce,
            expiry,
            d.attestation as Hex,
          ],
        });
        const flareTxHash = await submit(CONTRACTS.bridge, data);
        await fetch(`${API}/deposits/${d.id}/claimed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ flareTxHash }),
        }).catch(() => undefined);
      } else if (!res.ok) {
        throw new Error(body.error ?? `relayer returned ${res.status}`);
      }
      // Submitted, not mined. The poll below clears this when the deposit
      // turns `claimed`.
      setSubmitting((ids) => [...ids, d.id]);
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaiming(null);
    }
  }

  /** MINA as typed, in nanomina. Null when it is not a usable number. */
  /** Nine decimals, the unit both sides account in. */
  const formatNano = (v: bigint) =>
    (Number(v) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });

  const inbound = INBOUND_ASSETS.find((a) => a.symbol === depositSymbol)!;
  /** What the selected inbound asset is worth, whichever chain holds it. */
  const inboundBalance =
    inbound.tokenId === undefined ? minaBalance : (minaTokenBalances[inbound.symbol] ?? null);
  const outbound = BRIDGE_ASSETS.find((a) => a.symbol === burnSymbol)!;
  const outboundBalance = flareBalances?.find((b) => b.token.symbol === outbound.symbol) ?? null;

  /** Parse in the selected asset's own decimals, not always nine. */
  const outboundAmount = (() => {
    try {
      const v = parseUnits(burnAmount.trim() || '0', outbound.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  })();

  /**
   * C2FLR crosses through a 9-decimal wrapper, which refuses anything that is
   * not an exact multiple of a gwei rather than silently dropping the dust.
   * Rounding here means the user never sees that error.
   */
  const outboundScale = outbound.decimals > outbound.minaDecimals
    ? 10n ** BigInt(outbound.decimals - outbound.minaDecimals)
    : 1n;
  const outboundValue =
    outboundAmount === null ? null : (outboundAmount / outboundScale) * outboundScale;

  const wanted = nanomina(amount);

  /** MINA is escrowed; everything else on this side is burned and released. */
  const isWrapped = inbound.token !== undefined;
  const inboundValue = (() => {
    try {
      const v = parseUnits(amount.trim() || '0', inbound.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  })();
  const notEnoughWrapped =
    isWrapped && inboundBalance !== null && inboundValue !== null && inboundValue > inboundBalance;

  // Balances are advisory until they load: refusing on `null` would block the
  // form whenever the node is slow, which is worse than letting the wallet say
  // no a moment later.
  const notEnoughMina =
    minaBalance !== null && wanted !== null && wanted + MINA_FEE_BUFFER > minaBalance;
  const notEnoughOutbound =
    outboundBalance !== null && outboundValue !== null && outboundValue > outboundBalance.raw;

  function nanomina(input: string): bigint | null {
    if (!/^\d+(\.\d{1,9})?$/.test(input.trim())) return null;
    const [whole, fraction = ''] = input.trim().split('.');
    const value = BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
    return value > 0n ? value : null;
  }

  /**
   * Build, check, sign, broadcast.
   *
   * The check in the middle is the point: the relayer produced the proof, so
   * this reads the escrowed amount back out of the transaction it returned and
   * refuses to hand it to the wallet if it disagrees with what was asked for.
   * The recipient needs no such check — it is bound by the Schnorr signature at
   * claim time, which only the user can produce.
   */
  async function startDeposit() {
    const value = nanomina(amount);
    if (value === null) return;

    setDepositError(null);
    setDepositing('Building the proof…');
    try {
      const res = await fetch(`${API}/deposits/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: session.minaAddress,
          recipient: session.account,
          amountNanomina: value.toString(),
        }),
      });
      const built = (await res.json()) as {
        id: string;
        transaction: string;
        provingMs: number;
        error?: string;
      };
      if (!res.ok) throw new Error(built.error ?? `relayer returned ${res.status}`);

      const commitment = depositCommitment(built.transaction);
      if (commitment === null) throw new Error('could not read the built transaction');
      if (commitment.escrowedNanomina !== value) {
        throw new Error(
          `the built transaction escrows ${commitment.escrowedNanomina} nanomina, not ${value} — refusing to sign`,
        );
      }

      setDepositing('Waiting for your wallet…');
      const { hash } = await session.provider.sendTransaction({ transaction: built.transaction });

      await fetch(`${API}/deposits/${built.id}/submitted`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minaTxHash: hash }),
      });

      setAmount('');
    } catch (e) {
      setDepositError(e instanceof Error ? e.message : String(e));
    } finally {
      setDepositing(null);
    }
  }

  /**
   * Burn a wrapped asset on Mina, to take the original back on Flare.
   *
   * The relayer builds the transaction — burning through a token contract needs
   * a proof — and the wallet only signs. Nothing is authorised by this step: the
   * release needs the holder's Schnorr signature afterwards, which is what binds
   * the token, the recipient and the amount.
   */
  async function startRelease() {
    if (inbound.token === undefined) return;
    const value = (() => {
      try {
        const v = parseUnits(amount.trim() || '0', inbound.decimals);
        return v > 0n ? v : null;
      } catch {
        return null;
      }
    })();
    if (value === null) return;

    setReleaseError(null);
    setBurningAsset('Building the proof…');
    try {
      const res = await fetch(`${API}/releases/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: session.minaAddress,
          token: inbound.flareToken,
          recipient: session.account,
          amount: value.toString(),
        }),
      });
      const built = (await res.json()) as { id: string; transaction: string; error?: string };
      if (!res.ok) throw new Error(built.error ?? `relayer returned ${res.status}`);

      setBurningAsset('Waiting for your wallet…');
      const { hash } = await session.provider.sendTransaction({ transaction: built.transaction });

      await fetch(`${API}/releases/${built.id}/submitted`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minaTxHash: hash }),
      });

      setAmount('');
    } catch (e) {
      setReleaseError(e instanceof Error ? e.message : String(e));
    } finally {
      setBurningAsset(null);
    }
  }

  /**
   * The holder's half of the return leg.
   *
   * The attestor has already said the burn landed; this signature says which
   * token, to whom and how much. Neither is sufficient alone, which is why the
   * attestor cannot pay itself.
   */
  async function claimRelease(r: Release) {
    setReleaseError(null);
    setClaimingRelease(r.id);
    try {
      if (r.attestation === null) throw new Error('not attested yet');

      const token = r.token as `0x${string}`;
      const recipient = r.recipient as `0x${string}`;
      const amountRaw = BigInt(r.amount);
      const nonce = BigInt(r.nonce);
      const expiry = BigInt('18446744073709551615');

      const signature = await signAuthorization(session.provider, {
        purpose: PURPOSE.releaseIntent,
        chainId: 114n,
        target: CONTRACTS.assetVault,
        actionHash: releaseActionHash(token, recipient, amountRaw),
        nonce,
        expiry,
      });

      const res = await fetch(`${API}/releases/${r.id}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicKey: { x: session.x.toString(), isOdd: session.isOdd, y: session.y.toString() },
          signature: { field: signature.field, scalar: signature.scalar },
          token,
          recipient,
          amount: amountRaw.toString(),
          nonce: nonce.toString(),
          expiry: expiry.toString(),
          attestation: r.attestation,
        }),
      });
      const body = (await res.json()) as { flareTxHash?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
    } catch (e) {
      setReleaseError(e instanceof Error ? e.message : String(e));
    } finally {
      setClaimingRelease(null);
    }
  }

  /**
   * Burn FMINA and let the escrow release the MINA.
   *
   * One signed batch: approve the bridge, then burn. Atomic, so an approval
   * cannot survive a failed burn — and submitted by the relayer, because the
   * Mina key authorises but cannot pay for gas.
   *
   * Nothing else is signed afterwards. The burn *is* the authorisation: the
   * FMINA is gone, and the event carries the recipient and the amount.
   */
  /**
   * Send an asset to Mina.
   *
   * Two rails, chosen by what is being sent. FMINA is bridged MINA, so it burns
   * and the escrow releases the original. Everything else is locked in the
   * vault and minted as a new token — the opposite direction of collateral, and
   * a different contract.
   */
  async function burn() {
    const value = outboundValue;
    if (value === null) return;

    setBurnError(null);
    setBurning('Waiting for your Mina wallet…');
    try {
      const nonce = await nextNonce(session.x, session.isOdd);
      const expiry = BigInt('18446744073709551615');

      const calls =
        outbound.rail === 'escrow'
          ? [
              {
                target: CONTRACTS.fmina,
                value: 0n,
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: 'approve',
                  args: [CONTRACTS.bridge, value],
                }),
              },
              {
                target: CONTRACTS.bridge,
                value: 0n,
                data: encodeFunctionData({
                  abi: bridgeAbi,
                  functionName: 'burnToMina',
                  args: [value, session.packed],
                }),
              },
            ]
          : outbound.native === true
            ? [
                {
                  // The account's own C2FLR pays. `lockNative` wraps it and
                  // rounds it to nine decimals on the way through.
                  target: CONTRACTS.assetVault,
                  value,
                  data: encodeFunctionData({
                    abi: assetVaultAbi,
                    functionName: 'lockNative',
                    args: [session.packed],
                  }),
                },
              ]
            : [
                {
                  target: outbound.address,
                  value: 0n,
                  data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'approve',
                    args: [CONTRACTS.assetVault, value],
                  }),
                },
                {
                  target: CONTRACTS.assetVault,
                  value: 0n,
                  data: encodeFunctionData({
                    abi: assetVaultAbi,
                    functionName: 'lock',
                    args: [outbound.address, value, session.packed],
                  }),
                },
              ];

      const signature = await signAuthorization(session.provider, {
        purpose: PURPOSE.accountBatch,
        chainId: 114n,
        target: session.account,
        actionHash: batchHash(calls),
        nonce,
        expiry,
      });

      setBurning('Submitting…');
      const res = await fetch(`${API}/accounts/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account: session.account,
          publicKey: { x: session.x.toString(), isOdd: session.isOdd, y: session.y.toString() },
          signature: { field: signature.field, scalar: signature.scalar },
          nonce: nonce.toString(),
          expiry: expiry.toString(),
          calls: calls.map((c) => ({
            target: c.target,
            value: c.value.toString(),
            data: c.data,
          })),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);

      setBurnAmount('');
    } catch (e) {
      setBurnError(e instanceof Error ? e.message : String(e));
    } finally {
      setBurning(null);
    }
  }

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      {/* The two directions are separate flows with separate state — one waits
          on a Mina inclusion, the other on a Flare event — so they get separate
          tabs rather than a scroll that mixes both. */}
      <div className="tabs">
        {(['toFlare', 'toMina'] as const).map((d) => (
          <button
            key={d}
            className="tab"
            data-active={direction === d}
            onClick={() => setDirection(d)}
          >
            {d === 'toFlare' ? 'Mina → Flare' : 'Flare → Mina'}
          </button>
        ))}
      </div>

      {direction === 'toFlare' && (
      <>
      <div className="panel">
        <h2>Mina → Flare</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Escrow MINA on {MINA.network} and receive FMINA on Flare. The proof is built for you —
          your wallet only signs.
        </p>

        <div className="swapcard" style={{ marginBottom: 14 }}>
          <div className="swapcard-head">
            <span>{inbound.live ? 'You escrow' : 'You burn'}</span>
            <span>
              Balance{' '}
              {inboundBalance === null
                ? '…'
                : `${formatUnits(inboundBalance, inbound.decimals)} ${inbound.symbol}`}
              {inbound.live && minaBalance !== null && minaBalance > 0n && (
                <button
                  className="maxbtn"
                  // A fee has to be left behind, or the wallet cannot broadcast
                  // the very transaction that escrows the rest.
                  onClick={() =>
                    setAmount(
                      formatNano(minaBalance > MINA_FEE_BUFFER ? minaBalance - MINA_FEE_BUFFER : 0n),
                    )
                  }
                >
                  MAX
                </button>
              )}
            </span>
          </div>
          <div className="swapcard-body">
            <input
              className="amount"
              value={amount}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setAmount(e.target.value)}
            />
            <select
              className="tokensel"
              value={depositSymbol}
              onChange={(e) => setDepositSymbol(e.target.value)}
            >
              {INBOUND_ASSETS.map((a) => (
                <option key={a.symbol}>{a.symbol}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Goes to your Flare account</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={session.account} className="mono" />
            <button className="ghost" onClick={() => copy(session.account)}>
              {copied ? '✓' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Two rails behind one button. MINA is the chain's own coin and gets
            escrowed; a wrapped asset was minted here against something locked
            on Flare, so it burns and the original is released. */}
        {isWrapped ? (
          <button
            className="primary"
            style={{ marginTop: 14 }}
            disabled={burningAsset !== null || inboundValue === null || notEnoughWrapped}
            onClick={startRelease}
          >
            {notEnoughWrapped
              ? `Not enough ${inbound.symbol}`
              : (burningAsset ?? `Burn ${inbound.symbol}`)}
          </button>
        ) : (
          <button
            className="primary"
            style={{ marginTop: 14 }}
            disabled={depositing !== null || nanomina(amount) === null || notEnoughMina}
            onClick={startDeposit}
          >
            {notEnoughMina ? 'Not enough MINA' : (depositing ?? 'Deposit')}
          </button>
        )}
        {isWrapped && (
          <p className="small muted" style={{ marginTop: 10 }}>
            {inbound.symbol} was minted here against {inbound.flareSymbol} locked in the vault on
            Flare. Burning it releases the original — you sign once now, and once more to direct
            where it goes.
          </p>
        )}
        {depositError !== null && <p className="status err">{depositError}</p>}
        {releaseError !== null && <p className="status err">{releaseError}</p>}
      </div>

      {isWrapped && (
        <div className="panel">
          <h2>Your burns</h2>
          {releases === null && <p className="muted small">Loading…</p>}
          {releases?.length === 0 && (
            <p className="muted small">
              Nothing yet. Burn a wrapped asset above and it will appear here.
            </p>
          )}
          {releases?.map((r) => {
            const asset = INBOUND_ASSETS.find(
              (a) => a.flareToken?.toLowerCase() === r.token.toLowerCase(),
            );
            return (
              <div className="row" key={r.id}>
                <span className="small">
                  {formatUnits(BigInt(r.amount), asset?.decimals ?? 9)}{' '}
                  {asset?.flareSymbol ?? 'token'}
                  <span className="muted"> · {r.status}</span>
                </span>
                <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {r.flare_tx_hash && (
                    <a
                      className="mono small"
                      href={explorerTx(r.flare_tx_hash)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Flare
                    </a>
                  )}
                  {r.status === 'attested' && (
                    <button
                      className="primary"
                      disabled={claimingRelease === r.id}
                      onClick={() => void claimRelease(r)}
                    >
                      {claimingRelease === r.id ? 'Signing…' : 'Claim'}
                    </button>
                  )}
                  {r.status === 'submitted' && (
                    <span className="small muted">waiting for the burn to land</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="panel">
        <h2>Your deposits</h2>

        {error && (
          <p className="status err">
            Cannot reach the attestor API ({error}). Deposits already on-chain are unaffected — the
            escrow does not depend on this service being up.
          </p>
        )}

        {!deposits && !error && <p className="muted small">Loading…</p>}
        {deposits?.length === 0 && (
          <p className="muted small">Nothing yet. Send a payment above and it will appear here.</p>
        )}

        {claimError && <p className="status err">{claimError}</p>}

        {deposits?.map((d) => (
          <div className="row" key={d.id}>
            <span>
              <span className="mono">{(Number(d.amountNanomina) / 1e9).toFixed(4)} MINA</span>
              {d.reason && <span className="muted small"> · {d.reason}</span>}
            </span>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className={`tag ${d.status === 'claimed' ? 'ok' : d.status === 'failed' ? 'warn' : ''}`}>
                {LABEL[d.status]}
              </span>
              {d.status === 'attested' && (
                <button
                  className="ghost"
                  disabled={claiming === d.id || submitting.includes(d.id)}
                  onClick={() => claim(d)}
                >
                  {claiming === d.id
                    ? 'Signing…'
                    : submitting.includes(d.id)
                      ? 'Confirming…'
                      : 'Claim'}
                </button>
              )}
              {d.flareTxHash && (
                <a className="small" href={explorerTx(d.flareTxHash)} target="_blank" rel="noreferrer">
                  tx
                </a>
              )}
            </span>
          </div>
        ))}
      </div>
      </>
      )}

      {direction === 'toMina' && (
      <>
      <div className="panel">
        <h2>Flare → Mina</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Burn FMINA and the escrow releases the same amount of MINA to your wallet. The burn is
          the authorisation — there is nothing else to sign.
        </p>

        <div className="swapcard" style={{ marginBottom: 14 }}>
          <div className="swapcard-head">
            <span>{outbound.rail === 'escrow' ? 'You burn' : 'You lock'}</span>
            <span>
              Balance {outboundBalance === null ? '…' : outboundBalance.formatted}
              {outboundBalance !== null && outboundBalance.raw > 0n && (
                <button
                  className="maxbtn"
                  onClick={() =>
                    setBurnAmount(formatUnits(outboundBalance.raw, outbound.decimals))
                  }
                >
                  MAX
                </button>
              )}
            </span>
          </div>
          <div className="swapcard-body">
            <input
              className="amount"
              value={burnAmount}
              inputMode="decimal"
              placeholder="0"
              onChange={(e) => setBurnAmount(e.target.value)}
            />
            <select
              className="tokensel"
              value={burnSymbol}
              onChange={(e) => setBurnSymbol(e.target.value)}
            >
              {BRIDGE_ASSETS.map((a) => (
                <option key={a.symbol}>{a.symbol}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Goes to your Mina account</label>
          <input readOnly value={session.minaAddress} className="mono" />
        </div>

        <button
          className="primary"
          style={{ marginTop: 14 }}
          disabled={burning !== null || outboundValue === null || notEnoughOutbound}
          onClick={burn}
        >
          {notEnoughOutbound
            ? `Not enough ${outbound.symbol}`
            : (burning ?? (outbound.rail === 'escrow' ? 'Withdraw' : 'Bridge'))}
        </button>
        {burnError !== null && <p className="status err">{burnError}</p>}
      </div>

      {/* Its own panel, with an empty state: rendering nothing when the list is
          empty leaves no way to tell "none yet" from "the API is down". */}
      <div className="panel">
        <h2>Your transfers to Mina</h2>

        {withdrawals === null && locks === null && <p className="muted small">Reading…</p>}

        {withdrawals?.length === 0 && locks?.length === 0 && (
          <p className="muted small">
            Nothing yet. A burn or a lock appears here once the relayer has seen the event on
            Flare.
          </p>
        )}

        {/* Locked assets, which mint a wrapped token rather than releasing MINA. */}
        {locks?.map((l) => {
          const asset = BRIDGE_ASSETS.find(
            (a) => a.address.toLowerCase() === l.token.toLowerCase(),
          );
          // The vault keys C2FLR's chain by its wrapper, so the address in the
          // event is the wrapper's, not the one the asset list carries.
          const label = asset ?? BRIDGE_ASSETS.find((a) => a.native === true)!;
          return (
            <div className="row" key={`${l.token}-${l.claimId}`}>
              <span>
                <span className="mono small">
                  {formatUnits(BigInt(l.amount), label.minaDecimals)} {label.minaSymbol}
                </span>
                <span className="muted small">
                  {' · '}
                  {LOCK_STAGE[l.status]?.detail ?? l.status}
                </span>
              </span>
              <span
                className={`tag ${
                  l.status === 'minted' ? 'ok' : l.status === 'failed' ? 'warn' : ''
                }`}
              >
                {LOCK_STAGE[l.status]?.tag ?? l.status}
              </span>
            </div>
          );
        })}

        {withdrawals !== null &&
          withdrawals.map((w) => (
            <div className="row" key={w.nonce}>
              <span>
                <span className="mono small">{Number(w.amountNanomina) / 1e9} MINA</span>
                <span className="muted small">
                  {' · '}
                  {WITHDRAWAL_STAGE[w.status]?.detail ?? w.status}
                </span>
              </span>
              <span
                className={`tag ${
                  w.status === 'released' ? 'ok' : w.status === 'failed' ? 'warn' : ''
                }`}
              >
                {WITHDRAWAL_STAGE[w.status]?.tag ?? w.status}
              </span>
            </div>
          ))}
      </div>
      </>
      )}
    </>
  );
}
