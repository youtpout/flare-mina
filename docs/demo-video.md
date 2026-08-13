# Demo video — shot script

Target length **4:00**. Everything on screen is in English.

Timings below are the ones measured on the live server, not guesses. Where a
step is slower than the film can afford, the script says so and gives the cut.

---

## Before you record

The demo fails in the edit, not in the take, so stage this first.

| | Why |
|---|---|
| Both prover lanes warm | A cold lane costs **237 s** on the first request. `grep "warm in" /var/log/flarexmina/relayer.log` must show two lines. |
| A published head covering nothing pending | So the deposit you film is the only thing moving. |
| Wallet on **Devnet**, funded | Auro starts on Mainnet; a wrong network reads as "account not found". |
| A second Mina account with 0 bC2FLR | The "new account is funded automatically" beat needs a virgin account. |
| Browser at 1280×800, zoom 100% | Wider viewports shrink the text past legibility on a phone. |
| One tab only, no bookmarks bar | Nothing on screen you have to apologise for. |

**Do not film a publication cycle in real time.** The FDC attestation proof takes
**~210 s** on this host and the publisher runs every 15 minutes. Shot 5 covers it
with a cut; the timer in the corner is the honest way to show it.

---

## Shot 1 — The problem (0:00–0:20)

*Screen: title card 1.*

> **On screen:** Mina has assets. It has almost no DeFi.
> Flare has DeFi. It has no MINA.

**Narration:**

> A Mina private key is a Pallas key. It cannot sign an Ethereum transaction —
> not because of a missing library, but because the curve is different. So a Mina
> holder cannot touch Flare's liquidity, and Flare cannot list MINA.
> We fixed both, and the second one is the interesting half.

---

## Shot 2 — The insight (0:20–0:55)

*Screen: title card 2, then the gas table.*

> **On screen:**
> Pallas base field: a 255-bit prime.
> An EVM word: 256 bits.
> → `mulmod` and `addmod` run natively. 8 gas each.

**Narration:**

> The usual answer is a zero-knowledge proof. We don't need one. The Pallas base
> field fits inside a single EVM word, so a Mina Schnorr signature can be
> verified directly in Solidity. We got it to **808,891 gas** — about nine tenths
> of a cent on Flare.

*Cut to the comparison, hold 4 s:*

| | Gas | On Flare | On Ethereum |
|---|---|---|---|
| Reference implementation | ~1.79M | — | ~$107 |
| **This project** | **808,891** | **~$0.009** | ~$48 |

**Narration:**

> The same contract is a product on Flare and an impossibility on Ethereum.
> Flare's economics aren't a convenience here. They're why the simple design is
> the right one.

---

## Shot 3 — A Flare account owned by a Mina key (0:55–1:45)

*Screen: https://flare-mina.labdevn.com, disconnected.*

**Action:** Click **Connect**. Approve in Auro. Land on Portfolio.

**Narration over the click:**

> This is a Mina wallet. There is no EVM key anywhere in this demo.

**Action:** Point at the Flare address. Copy it. Open the explorer in a second tab.

> **On screen caption:** This address is `CREATE2` over the Mina public key.
> It existed before anything was deployed.

**Narration:**

> Connecting is enough to know the address, because it's derived from the public
> key rather than assigned. The contract doesn't exist yet — the address does.

**Action:** Go to **Swap**. Swap 1 USD₮0 → FXRP. Sign in Auro. Show the result.

**Narration:**

> `approve` and `swap`, as one Mina signature over an ordered batch — so no live
> approval ever sits between two transactions. This is BlazeSwap, a real DEX with
> real liquidity, and the account knows nothing about it. It executes a signed
> list of calls, which is why it works with any DEX on Flare with no adapter and
> no allowlist.

---

## Shot 4 — Bridging MINA in (1:45–2:35)

*Screen: Bridge tab.*

**Action:** Enter 3 MINA. Click Deposit.

> **On screen caption:** The relayer builds and proves the zkApp transaction.
> It returns it **unsigned**.

**Narration:**

> The relayer proves so the browser doesn't have to. It can't steal anything: the
> transaction comes back unsigned, and the deposit pulls funds through an account
> update the user's own wallet has to sign. A dishonest relayer can build
> something you refuse to sign, and that is the whole of its power.

**Action:** Auro opens. **Pause on the signature screen for 3 s** — the recipient
and amount are visible there. Sign.

*This is the real timing, no cut needed:*

```
fetch sender   236 ms
fetch bridge    93 ms
build          309 ms
prove        9 720 ms
────────────────────
                ~10 s
```

**Narration:**

> Ten seconds, on a server also running the heavy prover — because deposits and
> publications run on separate lanes, and the background lane is capped at eight
> of twelve cores so a user is never queued behind four minutes of arithmetic.

**Action:** Show FMINA arriving in the Portfolio.

---

## Shot 5 — The return path, and Flare's attestation layer (2:35–3:20)

*Screen: Bridge tab, withdraw form.*

**Action:** Burn 1 FMINA to a Mina address. Sign on Flare.

**Narration:**

> Burning emits a canonical event. Now Mina has to learn about it — and this is
> where Flare does the work that makes the return path tractable.

*Screen: title card 3 — the chain diagram.*

> **On screen:**
> One append-only chain on Flare, four ports on Mina.
> One FDC attestation proves the head. Every asset reads the same proof.

**Narration:**

> Every transfer — MINA, FXRP, USD₮0, C2FLR — appends to one chain. The Flare
> Data Connector attests to its head once, and that single proof is reused by the
> escrow and all three token ports. Proving it costs about three and a half
> minutes; paying that once instead of four times is the difference between a
> four-minute cycle and a fifteen-minute one.

**Action:** **Cut.** Return with the release visible on screen.

> **On screen caption:** attestation proof 209.5 s · reused ×4 · elapsed 6 min

**Narration:**

> The MINA is released from the escrow. Nothing here trusts the relayer with the
> amount or the recipient: both are inside the record whose hash the zkApp
> checks.

---

## Shot 6 — What is actually new, and where it runs (3:20–4:00)

*Screen: title card 4.*

> **On screen:** Built during the program
> • Signature verification 1.79M → **808,891 gas** (2.2×)
> • A Flare account owned by a Mina key — deployed, funded, swapping
> • One shared transfer chain serving four assets
> • Four wrapped assets live on Mina devnet
> • Deployed, public, running: flare-mina.labdevn.com

**Narration:**

> Everything in the repository was built during the program. The verifier is
> two-point-two times faster than the implementation we started from, and every
> step of that is measured — including two optimisations we tried and rejected,
> which are written down so nobody repeats them.

*Screen: the live site, Network tab, showing state.*

**Narration:**

> It's deployed and public. Both directions work, on four assets, on Coston2 and
> Mina devnet. The link is in the description, and the state on that page is read
> from the two chains, not from a database.

> **Final card:** flare-mina.labdevn.com · github.com/youtpout/flare-mina

---

## If you only have 90 seconds

Cut shots 2 and 6 to their title cards, drop shot 5 entirely, and keep the two
things a judge cannot get from the README: **the swap authorised by a Mina
signature** (shot 3) and **the ten-second deposit** (shot 4).

---

## Numbers, so nothing is overstated

Every figure below was measured on the deployment host and can be reproduced from
the log.

| | |
|---|---|
| Signature verification | 808,891 gas |
| Full account operation vs live Coston2 | 865,845 gas — 3% of a block |
| Deposit, end to end | ~10.4 s |
| FDC attestation proof | 209–225 s, reused across 4 consumers |
| Publication interval | 15 min |
| Mint after a port accepts the head | ~420 s |
| Prover lane compile, warm cache | 237 s (paid at boot, not per request) |

Do not round these upward on screen. A judge who checks one and finds it
generous stops believing the rest.
