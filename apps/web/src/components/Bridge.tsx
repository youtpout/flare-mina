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
  unwrapAbi,
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
  created_at: string;
};

/** What each release status means to someone waiting on their asset. */
const RELEASE_LABEL: Record<Release['status'], string> = {
  built: 'not sent',
  submitted: 'sending on Mina',
  attested: 'ready to claim',
  released: 'released',
  failed: 'failed',
  aborted: 'abandoned',
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
  createdAt: string;
};

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

/**
 * Held back from MAX on a deposit. The escrow transaction itself costs a fee,
 * so offering the whole balance produces a transaction the wallet cannot send.
 */
/**
 * How often balances are re-read on their own.
 *
 * Stabilising the dependencies stopped the pollers re-running these five times
 * a minute, but it also removed the only thing that retried a failed read — so
 * one timed-out token stayed blank forever. Half a minute is often enough to
 * recover, and rare enough not to provoke the stalls in the first place.
 */
/** Rows per page in the transfer list. */
const PAGE_SIZE = 10;

const BALANCE_REFRESH_MS = 30_000;

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
    tag: 'awaiting publication',
    detail: 'locked on Flare; the head reaches this asset’s port on the next publication',
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
    tag: 'awaiting publication',
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
        createdAt: string;
      }[]
    | null
  >(null);
  const [withdrawals, setWithdrawals] = useState<
    { nonce: string; amountNanomina: string; status: string; createdAt: string }[] | null
  >(null);
  /** The return leg for wrapped assets: a burn on Mina, released on Flare. */
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [burningAsset, setBurningAsset] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [claimingRelease, setClaimingRelease] = useState<string | null>(null);
  const [transferPage, setTransferPage] = useState(0);
  const [outboundPage, setOutboundPage] = useState(0);
  const [unwrapping, setUnwrapping] = useState<string | null>(null);

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
    const read = () =>
      readBalances(session.account)
        .then((b) => live && setFlareBalances(b))
        .catch(() => undefined);

    void read();
    const timer = setInterval(read, BALANCE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session.account, settlementKey]);

  useEffect(() => {
    let live = true;
    const read = async () => {
      const data = await minaQuery<{ account?: { balance?: { total?: string } } }>(
        `{ account(publicKey: "${session.minaAddress}") { balance { total } } }`,
      );
      // A failed read leaves the last known value alone rather than blanking it.
      if (!live || data === null) return;
      const total = data.account?.balance?.total;
      // Already nanomina. Scaling it again showed a balance a billion times
      // too large, and MAX offered an amount no wallet could ever send.
      setMinaBalance(total === undefined ? null : BigInt(total));
    };

    void read();
    const timer = setInterval(read, BALANCE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
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

    const read = () =>
      Promise.all(
      wrapped.map(async (asset) => {
        const data = await minaQuery<{ account?: { balance?: { total?: string } } }>(
          `{ account(publicKey: "${session.minaAddress}", token: "${asset.tokenId}") { balance { total } } }`,
        );
        // `null` is a failed read, and must not be rendered as a zero balance:
        // the form would then refuse a burn the holder can afford. An account
        // that genuinely holds nothing answers with a balance of zero, and one
        // that never existed answers with no account at all — which is also a
        // real zero, and the only case worth turning into one.
        if (data === null) return null;
        return [asset.symbol, BigInt(data.account?.balance?.total ?? '0')] as const;
      }),
    )
        .then((entries) => {
          if (!live) return;
          const got = entries.filter((e) => e !== null);
          // Merged, not replaced: a token whose read failed keeps whatever was
          // last known rather than disappearing.
          setMinaTokenBalances((previous) => ({ ...previous, ...Object.fromEntries(got) }));
        })
        .catch(() => undefined);

    void read();
    const timer = setInterval(read, BALANCE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
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

  /**
   * Both rails to Flare, newest first.
   *
   * One list, because a user does not think in rails: they sent something to
   * Flare and want to know where it is. Which contract it went through is our
   * problem, not theirs.
   *
   * Rows never signed on Mina are left out — a deposit or burn that was built
   * and abandoned is not a transfer, and listing it as one makes an idle bridge
   * look like a failing one.
   */
  const transfers =
    deposits === null && releases === null
      ? null
      : [
          ...(deposits ?? [])
            .filter((d) => d.status !== 'built' && d.status !== 'aborted')
            .map((deposit) => ({
              kind: 'deposit' as const,
              deposit,
              at: deposit.createdAt ?? '',
            })),
          ...(releases ?? [])
            .filter((r) => r.status !== 'built' && r.status !== 'aborted')
            .map((release) => ({
              kind: 'release' as const,
              release,
              asset: INBOUND_ASSETS.find(
                (a) => a.flareToken?.toLowerCase() === release.token.toLowerCase(),
              ),
              at: release.created_at ?? '',
            })),
        ].sort((x, y) => (x.at < y.at ? 1 : -1));

  /**
   * The other direction, also as one list.
   *
   * Burns and locks were rendered as two blocks, so every MINA row sat below
   * every asset row whatever their dates — which reads as an ordering rather
   * than as two lists, and a wrong one.
   */
  const outboundTransfers =
    withdrawals === null && locks === null
      ? null
      : [
          ...(locks ?? []).map((lock) => ({
            kind: 'lock' as const,
            lock,
            label:
              BRIDGE_ASSETS.find((a) => a.address.toLowerCase() === lock.token.toLowerCase()) ??
              // The vault keys C2FLR's chain by its wrapper, so the address in
              // the event is the wrapper's, not the one the asset list carries.
              BRIDGE_ASSETS.find((a) => a.native === true)!,
            at: lock.createdAt ?? '',
          })),
          ...(withdrawals ?? []).map((withdrawal) => ({
            kind: 'withdrawal' as const,
            withdrawal,
            at: withdrawal.createdAt ?? '',
          })),
        ].sort((x, y) => (x.at < y.at ? 1 : -1));

  const outboundPageCount = Math.max(1, Math.ceil((outboundTransfers?.length ?? 0) / PAGE_SIZE));
  const outboundRows = (outboundTransfers ?? []).slice(
    Math.min(outboundPage, outboundPageCount - 1) * PAGE_SIZE,
    Math.min(outboundPage, outboundPageCount - 1) * PAGE_SIZE + PAGE_SIZE,
  );

  const pageCount = Math.max(1, Math.ceil((transfers?.length ?? 0) / PAGE_SIZE));
  const page = Math.min(transferPage, pageCount - 1);
  const pageRows = (transfers ?? []).slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

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
  // Advisory until it loads. Refusing on an unread balance blocks a burn the
  // holder can afford, which is worse than letting the relayer say no a moment
  // later — it checks the same thing against the chain.
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
   * Turn held bWC2FLR back into native C2FLR.
   *
   * Releases from before the vault learned to unwrap handed the wrapper over
   * directly, leaving holders with an accounting artefact. `unwrap` is
   * permissionless, so this needs nobody's cooperation — but it is two calls,
   * and they go in one signed batch so an unwrap cannot survive a failed
   * withdrawal.
   */
  async function unwrapNative() {
    const held = flareBalances?.find((b) => b.token.symbol === 'bWC2FLR')?.raw;
    if (held === undefined || held === 0n) return;

    setBurnError(null);
    setUnwrapping('Waiting for your Mina wallet…');
    try {
      const nonce = await nextNonce(session.x, session.isOdd);
      const expiry = BigInt('18446744073709551615');
      // 9 decimals to 18: what `BridgeWrapper.SCALE` returns for this pair.
      const underlying = held * 1_000_000_000n;

      const calls = [
        {
          target: CONTRACTS.wrappedC2flr,
          value: 0n,
          data: encodeFunctionData({ abi: unwrapAbi, functionName: 'unwrap', args: [held] }),
        },
        {
          target: CONTRACTS.wnat,
          value: 0n,
          data: encodeFunctionData({
            abi: unwrapAbi,
            functionName: 'withdraw',
            args: [underlying],
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

      setUnwrapping('Submitting…');
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
    } catch (e) {
      setBurnError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnwrapping(null);
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
          Send an asset from {MINA.network} to your Flare account. MINA is escrowed and arrives as
          FMINA; a bridged asset returns as the original. The proof is built for you — your wallet
          only signs.
        </p>

        <div className="swapcard" style={{ marginBottom: 14 }}>
          <div className="swapcard-head">
            <span>You deposit</span>
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
              : (burningAsset ?? 'Deposit')}
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
            {inbound.symbol} is {inbound.flareSymbol} held in the vault on Flare, so sending it
            back returns the original. You sign once now, and once more to release it.
          </p>
        )}
        {depositError !== null && <p className="status err">{depositError}</p>}
        {releaseError !== null && <p className="status err">{releaseError}</p>}
      </div>

      <div className="panel">
        <h2>Your transfers to Flare</h2>

        {error && (
          <p className="status err">
            Cannot reach the attestor API ({error}). Transfers already on-chain are unaffected —
            neither the escrow nor the vault depends on this service being up.
          </p>
        )}

        {transfers === null && !error && <p className="muted small">Loading…</p>}
        {transfers?.length === 0 && (
          <p className="muted small">Nothing yet. Send something above and it will appear here.</p>
        )}

        {claimError && <p className="status err">{claimError}</p>}
        {releaseError !== null && <p className="status err">{releaseError}</p>}

        {/* Releases from before the vault learned to unwrap handed the wrapper
            over directly. It is 1:1 with C2FLR and reversible by anyone holding
            it, so this is a leftover to clear rather than a loss. */}
        {(flareBalances?.find((b) => b.token.symbol === 'bWC2FLR')?.raw ?? 0n) > 0n && (
          <div className="row">
            <span className="small">
              {flareBalances?.find((b) => b.token.symbol === 'bWC2FLR')?.formatted} still wrapped
              <span className="muted"> · bridged before the unwrap was automatic</span>
            </span>
            <button className="ghost" disabled={unwrapping !== null} onClick={unwrapNative}>
              {unwrapping ?? 'Unwrap to C2FLR'}
            </button>
          </div>
        )}

        {pageRows.map((t) =>
          t.kind === 'deposit' ? (
            <div className="row" key={`d${t.deposit.id}`}>
              <span>
                <span className="mono">
                  {(Number(t.deposit.amountNanomina) / 1e9).toFixed(4)} MINA
                </span>
                {t.deposit.reason && <span className="muted small"> · {t.deposit.reason}</span>}
              </span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span
                  className={`tag ${t.deposit.status === 'claimed' ? 'ok' : t.deposit.status === 'failed' ? 'warn' : ''}`}
                >
                  {LABEL[t.deposit.status]}
                </span>
                {t.deposit.status === 'attested' && (
                  <button
                    className="ghost"
                    disabled={claiming === t.deposit.id || submitting.includes(t.deposit.id)}
                    onClick={() => claim(t.deposit)}
                  >
                    {claiming === t.deposit.id
                      ? 'Signing…'
                      : submitting.includes(t.deposit.id)
                        ? 'Confirming…'
                        : 'Claim'}
                  </button>
                )}
                {t.deposit.flareTxHash && (
                  <a
                    className="small"
                    href={explorerTx(t.deposit.flareTxHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx
                  </a>
                )}
              </span>
            </div>
          ) : (
            <div className="row" key={`r${t.release.id}`}>
              <span className="mono">
                {formatUnits(BigInt(t.release.amount), t.asset?.decimals ?? 9)}{' '}
                {t.asset?.flareSymbol ?? 'token'}
              </span>
              <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className={`tag ${t.release.status === 'released' ? 'ok' : ''}`}>
                  {RELEASE_LABEL[t.release.status]}
                </span>
                {t.release.status === 'attested' && (
                  <button
                    className="ghost"
                    disabled={claimingRelease === t.release.id}
                    onClick={() => void claimRelease(t.release)}
                  >
                    {claimingRelease === t.release.id ? 'Signing…' : 'Claim'}
                  </button>
                )}
                {t.release.flare_tx_hash && (
                  <a
                    className="small"
                    href={explorerTx(t.release.flare_tx_hash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx
                  </a>
                )}
              </span>
            </div>
          ),
        )}

        {pageCount > 1 && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <span className="small muted" style={{ marginRight: 'auto' }}>
              {page * PAGE_SIZE + 1}–
              {Math.min((page + 1) * PAGE_SIZE, transfers?.length ?? 0)} of{' '}
              {transfers?.length ?? 0}
            </span>
            <button
              className="ghost"
              onClick={() => setTransferPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              Previous
            </button>
            <button
              className="ghost"
              onClick={() => setTransferPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
            >
              Next
            </button>
          </div>
        )}
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

        {outboundTransfers?.length === 0 && (
          <p className="muted small">
            Nothing yet. A burn or a lock appears here once the relayer has seen the event on
            Flare.
          </p>
        )}

        {outboundRows.map((t) =>
          t.kind === 'lock' ? (
            <div className="row" key={`l${t.lock.token}-${t.lock.claimId}`}>
              <span>
                <span className="mono small">
                  {formatUnits(BigInt(t.lock.amount), t.label.minaDecimals)} {t.label.minaSymbol}
                </span>
                <span className="muted small">
                  {' · '}
                  {LOCK_STAGE[t.lock.status]?.detail ?? t.lock.status}
                </span>
              </span>
              <span
                className={`tag ${
                  t.lock.status === 'minted' ? 'ok' : t.lock.status === 'failed' ? 'warn' : ''
                }`}
              >
                {LOCK_STAGE[t.lock.status]?.tag ?? t.lock.status}
              </span>
            </div>
          ) : (
            <div className="row" key={`w${t.withdrawal.nonce}`}>
              <span>
                <span className="mono small">
                  {Number(t.withdrawal.amountNanomina) / 1e9} MINA
                </span>
                <span className="muted small">
                  {' · '}
                  {WITHDRAWAL_STAGE[t.withdrawal.status]?.detail ?? t.withdrawal.status}
                </span>
              </span>
              <span
                className={`tag ${
                  t.withdrawal.status === 'released'
                    ? 'ok'
                    : t.withdrawal.status === 'failed'
                      ? 'warn'
                      : ''
                }`}
              >
                {WITHDRAWAL_STAGE[t.withdrawal.status]?.tag ?? t.withdrawal.status}
              </span>
            </div>
          ),
        )}

        {outboundPageCount > 1 && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <span className="small muted" style={{ marginRight: 'auto' }}>
              {outboundPage * PAGE_SIZE + 1}–
              {Math.min((outboundPage + 1) * PAGE_SIZE, outboundTransfers?.length ?? 0)} of{' '}
              {outboundTransfers?.length ?? 0}
            </span>
            <button
              className="ghost"
              onClick={() => setOutboundPage((p) => Math.max(0, p - 1))}
              disabled={outboundPage === 0}
            >
              Previous
            </button>
            <button
              className="ghost"
              onClick={() => setOutboundPage((p) => Math.min(outboundPageCount - 1, p + 1))}
              disabled={outboundPage >= outboundPageCount - 1}
            >
              Next
            </button>
          </div>
        )}
      </div>
      </>
      )}
    </>
  );
}
