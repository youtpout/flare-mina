import { COSTON2, MINA } from '@/lib/config';

/**
 * Where to refill, on both chains.
 *
 * Shown connected or not, because running dry is not announced: a transaction
 * simply refuses. The two are not interchangeable — MINA pays fees on Mina,
 * C2FLR pays them on Flare — so each row says what its coin is for rather than
 * leaving the reader to guess which faucet they need.
 */
export function Faucets() {
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h2>Out of testnet funds?</h2>
      <div className="row">
        <span className="muted small">MINA on {MINA.network}, to pay Mina fees</span>
        <a href="https://faucet.minaprotocol.com/" target="_blank" rel="noreferrer">
          faucet.minaprotocol.com
        </a>
      </div>
      <div className="row">
        <span className="muted small">
          C2FLR on {COSTON2.name}, for the Flare account your Mina key owns
        </span>
        <a href="https://faucet.flare.network/coston2" target="_blank" rel="noreferrer">
          faucet.flare.network
        </a>
      </div>
    </div>
  );
}
