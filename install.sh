#!/usr/bin/env bash
# Larder installer: asks a few questions, writes .env, builds and starts Larder with Docker.
# Run it from the Larder folder:  ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local reply; read -r -p "$1 " reply; printf '%s' "${reply:-$2}"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

bold "Larder installer"

command -v docker >/dev/null || die "Docker isn't installed. Get it from https://docs.docker.com/get-docker/ and run this again."
docker compose version >/dev/null 2>&1 || die "Docker is installed but 'docker compose' isn't working. Update Docker, then run this again."
docker info >/dev/null 2>&1 || die "Docker isn't running (or needs sudo). Start Docker Desktop, or try: sudo ./install.sh"

if [ -f .env ]; then
  keep=$(ask "Larder is already set up here. Keep your current settings and just update? [Y/n]" y)
  if [[ "$keep" =~ ^[Yy] ]]; then
    domain=$(grep -E '^LARDER_DOMAIN=.+' .env | cut -d= -f2- || true)
    bold "Building and starting Larder..."
    if [ -n "$domain" ]; then docker compose --profile cloud up -d --build; else docker compose up -d --build; fi
    bold "Done. Your diary and settings are untouched."
    exit 0
  fi
fi

echo "Building Larder (the first time takes a few minutes)..."
docker compose build

bold "1. Signing in to Claude"
cat <<'EOF'
Larder uses Claude to read what you eat. Pick how to pay for that:
  1) A Claude Pro or Max subscription you already have (no extra cost)
  2) An API key from console.anthropic.com (pay per message, usually pennies)
EOF
how=$(ask "Choose 1 or 2 [1]:" 1)
token="" key=""
if [ "$how" = "2" ]; then
  read -r -s -p "Paste your API key (starts sk-ant-api, hidden as you paste): " key; echo
  [ -n "$key" ] || die "No key given. Run ./install.sh again when you have one."
else
  cat <<'EOF'

You need a long-lived token for your subscription. If you have Claude Code on a computer,
run `claude setup-token` there and paste the token below.
Or just press Enter and the installer runs it for you: it shows a link, you sign in to
Claude in your browser, paste the code it gives you back here, and it prints your token.
EOF
  read -r -s -p "Paste your token (starts sk-ant-oat, hidden), or press Enter: " token; echo
  if [ -z "$token" ]; then
    docker compose run --rm --no-deps -e CLAUDE_CODE_OAUTH_TOKEN= larder claude setup-token || true
    read -r -s -p "Now paste the token it printed (hidden): " token; echo
  fi
  [ -n "$token" ] || die "No token given. Run ./install.sh again when you have one."
fi

bold "2. Where will you use it?"
cat <<'EOF'
  1) At home: on your own Wi-Fi, or anywhere through Tailscale (simplest, recommended)
  2) On the internet: a cloud server with your own domain name (needs a password)
EOF
where=$(ask "Choose 1 or 2 [1]:" 1)

tz=$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||') | head -1 || true)
tz=$(ask "Your time zone [${tz:-Europe/London}]:" "${tz:-Europe/London}")

port="8080" domain="" password=""
if [ "$where" = "2" ]; then
  domain=$(ask "Your domain name, already pointing at this server (e.g. food.example.com):" "")
  [ -n "$domain" ] || die "A cloud install needs a domain name so it can have HTTPS. Set one up and run this again."
  password=$(ask "Household password (press Enter to make one up):" "")
  # (head closing the pipe early makes tr "fail", hence the || true)
  [ -n "$password" ] || password=$(LC_ALL=C tr -dc 'a-km-np-z2-9' </dev/urandom | head -c 16 || true)
  # Only Caddy (HTTPS) faces the internet; Larder itself listens on this machine only
  port="127.0.0.1:8080"
else
  port=$(ask "Port to use [8080]:" 8080)
fi

umask 077
cat > .env <<EOF
CLAUDE_CODE_OAUTH_TOKEN=$token
ANTHROPIC_API_KEY=$key
TZ=$tz
LARDER_PORT=$port
LARDER_PASSWORD=$password
LARDER_DOMAIN=$domain
EOF
mkdir -p data

bold "Starting Larder..."
if [ -n "$domain" ]; then docker compose --profile cloud up -d; else docker compose up -d; fi

bold "Larder is running."
if [ -n "$domain" ]; then
  echo "Open https://$domain (the certificate can take a minute on first start)."
  echo "Household password: $password"
  echo "Write that down; it's also in the .env file in this folder."
else
  ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  echo "On this computer:      http://localhost:$port"
  [ -n "$ip" ] && echo "On your home network:  http://$ip:$port"
  command -v tailscale >/dev/null && echo "Over Tailscale:        http://$(hostname):$port  (see SETUP.md for HTTPS)"
fi
echo "The first person to open it sets themselves up. Your diary lives in the 'data' folder here."
