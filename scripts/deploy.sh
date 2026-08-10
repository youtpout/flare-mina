#!/usr/bin/env bash
# Update a running deployment in place. Run on the server as root.
#
# Idempotent: safe to run twice, and safe to run when nothing changed. It never
# touches .env -- secrets are copied by hand, once, and outlive every deploy.
set -euo pipefail

APP=/home/flarexmina/app
USER=flarexmina
RUN="sudo -u $USER env HOME=/home/$USER"

cd "$APP"

echo "==> pulling"
$RUN git pull --ff-only

echo "==> dependencies"
$RUN pnpm install --frozen-lockfile

echo "==> building packages and web"
$RUN pnpm build
$RUN pnpm --filter @flarexmina/web build

echo "==> restarting"
systemctl restart flarexmina-relayer
sleep 5
systemctl is-active flarexmina-relayer

echo "==> health"
curl -fsS http://127.0.0.1:8787/health && echo
echo "deployed: $($RUN git log --oneline -1)"
