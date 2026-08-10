# Deployment

Live at **https://labdevn.com** on `159.195.202.103` — Debian 13, 12 vCPU
(EPYC 9645), 32 GB, 1 TB.

No Docker, no CI. The code comes from GitHub, the secrets come from `scp`, and
systemd keeps it up. At hackathon scale every extra layer is a layer that can
break on a Sunday night.

## Layout

| What | Where |
|---|---|
| Repo | `/home/flarexmina/app`, owned by the `flarexmina` user |
| Secrets | `apps/relayer/.env`, mode 600, never in git |
| o1js key cache | `/home/flarexmina/cache` |
| Logs | `/var/log/flarexmina/relayer.log` |
| Service | `flarexmina-relayer.service` |
| Web root | `apps/web/dist`, served by Caddy |
| Database | Postgres 17, `flarexmina/flarexmina`, localhost only |

Caddy serves the SPA and proxies `/api/*` to `127.0.0.1:8787`, stripping the
prefix. Same origin for both, which removes CORS entirely. It holds the
Let's Encrypt certificate and renews it unattended; `www` and the bare IP
redirect to the apex, so old links keep working.

## Updating

```bash
ssh root@159.195.202.103 'bash /home/flarexmina/app/scripts/deploy.sh'
```

`VITE_API_URL` is read **at build time**, so the web bundle must be rebuilt on
the server whenever that URL changes. The deploy script does it every run.

## Memory and cores

This host has 32 GB, not the 64 GB the two prover lanes were sized for, so
`PROVER_HEAP_MB=8192` instead of 12288 — two lanes at 8 GB leaves ~15 GB for the
OS, Postgres and the page cache holding the 2.6 GB proving keys. Do not add swap
as a safety net: proving that pages costs a measured 20x (43s -> 839s), so an
honest OOM beats a demo that crawls.

`PROVER_BACKGROUND_THREADS=8` caps the FDC/publication lane's rayon pool at 8 of
12 cores, leaving the rest for the deposit lane a user is watching.

## Only one relayer at a time

The relayer signs Mina transactions with a single fee-payer key, and Mina demands
strictly sequential nonces. Two instances — the server and a laptop, say — race
for the same nonce and produce `Insufficient_replace_fee` and permanent gaps.
Before starting one anywhere, stop the other.

## Still to do

- Postgres backups. Nothing is backed up, and the DB is rebuildable from chain
  only within `*_LOOKBACK_BLOCKS`.
