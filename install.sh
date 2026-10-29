#!/usr/bin/env bash
# Plateful installer: asks a few questions, writes .env, builds and starts Plateful with Docker.
# Run it from the Plateful folder:  ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local reply; read -r -p "$1 " reply; printf '%s' "${reply:-$2}"; }
secret() { local reply; read -r -s -p "$1 " reply; echo >&2; printf '%s' "$reply"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }

bold "Plateful installer"

command -v docker >/dev/null || die "Docker isn't installed. Get it from https://docs.docker.com/get-docker/ and run this again."
docker compose version >/dev/null 2>&1 || die "Docker is installed but 'docker compose' isn't working. Update Docker, then run this again."
docker info >/dev/null 2>&1 || die "Docker isn't running (or needs sudo). Start Docker Desktop, or try: sudo ./install.sh"

if [ -f .env ]; then
  keep=$(ask "Plateful is already set up here. Keep your current settings and just update? [Y/n]" y)
  if [[ "$keep" =~ ^[Yy] ]]; then
    domain=$(grep -E '^(PLATEFUL|LARDER)_DOMAIN=.+' .env | cut -d= -f2- || true)
    bold "Building and starting Plateful..."
    if [ -n "$domain" ]; then docker compose --profile cloud up -d --build; else docker compose up -d --build; fi
    bold "Done. Your diary and settings are untouched."
    exit 0
  fi
fi

bold "1. Which AI should read your food?"
cat <<'EOF'
Plateful sends what you type or photograph to an AI, which turns it into calories.
Use whichever you already have:
  1) Claude, with a Pro or Max subscription (no extra cost)
  2) Claude, with an API key from console.anthropic.com (pay per message)
  3) OpenAI, through the Codex CLI (an OpenAI API key, or your ChatGPT sign-in)
  4) Google Gemini, through the Gemini CLI (a key from Google AI Studio)
  5) opencode, which can use almost any provider you've signed in to
  6) Ollama, running models on your own computer (free, private, needs a decent machine)
  7) Another server that speaks the OpenAI API (llama.cpp, LM Studio, vLLM, OpenRouter...)
  8) My own command (advanced, see SETUP.md)
EOF
choice=$(ask "Choose 1 to 8 [1]:" 1)

ai=claude clis=claude token="" key="" codex_key="" gemini_key="" text_model="" photo_model=""
ollama_host="" ai_url="" ai_key="" ai_command="" images="" login=""
case "$choice" in
  1)
    cat <<'EOF'

You need a long-lived token for your subscription. If you have Claude Code on a computer,
run `claude setup-token` there and paste the token below. Or press Enter and the installer
runs it for you once Plateful is built: it shows a link, you sign in to Claude in your browser,
and paste the code it gives you back here.
EOF
    token=$(secret "Paste your token (starts sk-ant-oat, hidden), or press Enter:")
    [ -n "$token" ] || login=claude ;;
  2)
    key=$(secret "Paste your Anthropic API key (starts sk-ant-api, hidden):")
    [ -n "$key" ] || die "No key given. Run ./install.sh again when you have one." ;;
  3)
    ai=codex clis=codex
    echo
    echo "Paste an OpenAI API key, or press Enter to use your ChatGPT sign-in instead (SETUP.md explains how)."
    codex_key=$(secret "OpenAI API key (hidden), or Enter:")
    text_model=$(ask "Model for typed messages (Enter for Codex's default):" "")
    photo_model=$(ask "Model for photos (Enter for the same):" "") ;;
  4)
    ai=gemini clis=gemini
    gemini_key=$(secret "Paste your Gemini API key from aistudio.google.com (hidden):")
    [ -n "$gemini_key" ] || die "No key given. Run ./install.sh again when you have one."
    text_model=$(ask "Model for typed messages [flash]:" flash)
    photo_model=$(ask "Model for photos [flash]:" flash) ;;
  5)
    ai=opencode clis=opencode
    echo
    echo "opencode models are written provider/model, for example openai/gpt-5 or anthropic/claude-haiku-5-5."
    text_model=$(ask "Model for typed messages (Enter for opencode's default):" "")
    photo_model=$(ask "Model for photos (Enter for the same):" "")
    login=opencode ;;
  6)
    ai=ollama clis=none
    ollama_host=$(ask "Where is Ollama? [http://host.docker.internal:11434, meaning this computer]:" "http://host.docker.internal:11434")
    text_model=$(ask "Model for typed messages, one you've pulled (for example gemma3):" "")
    [ -n "$text_model" ] || die "Plateful needs a model name. Pull one with 'ollama pull gemma3' and run this again."
    photo_model=$(ask "Model for photos (Enter for the same; it must be a vision model):" "")
    sees=$(ask "Can that model see pictures? [y/N]:" n)
    [[ "$sees" =~ ^[Yy] ]] || images=false ;;
  7)
    ai=openai clis=none
    ai_url=$(ask "Server address ending in /v1 (llama-server on this computer: http://host.docker.internal:8081/v1):" "")
    [ -n "$ai_url" ] || die "Plateful needs the server's address. Run this again when you have it."
    ai_key=$(secret "API key if it needs one (hidden), or Enter:")
    text_model=$(ask "Model name (Enter if the server only has one):" "")
    photo_model=$(ask "Model for photos (Enter for the same):" "")
    sees=$(ask "Can it see pictures? [y/N]:" n)
    [[ "$sees" =~ ^[Yy] ]] || images=false ;;
  8)
    ai=custom
    echo
    echo "The command must print the JSON Plateful asks for. Placeholders: {prompt_file} {prompt} {image} {images} {model}."
    ai_command=$(ask "Command:" "")
    [ -n "$ai_command" ] || die "No command given."
    [[ "$ai_command" != *\'* ]] || die "Put a command with single quotes in a script and give the script's path instead."
    clis=$(ask "CLIs to build in (any of: claude codex gemini opencode, or none) [none]:" none) ;;
  *) die "That wasn't 1 to 8." ;;
esac

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
  # Only Caddy (HTTPS) faces the internet; Plateful itself listens on this machine only
  port="127.0.0.1:8080"
else
  port=$(ask "Port to use [8080]:" 8080)
fi

umask 077
cat > .env <<EOF
PLATEFUL_AI=$ai
PLATEFUL_CLIS=$clis
PLATEFUL_TEXT_MODEL=$text_model
PLATEFUL_PHOTO_MODEL=$photo_model
PLATEFUL_AI_IMAGES=$images
CLAUDE_CODE_OAUTH_TOKEN=$token
ANTHROPIC_API_KEY=$key
CODEX_API_KEY=$codex_key
GEMINI_API_KEY=$gemini_key
OLLAMA_HOST=${ollama_host:-http://host.docker.internal:11434}
PLATEFUL_AI_URL=$ai_url
PLATEFUL_AI_KEY=$ai_key
PLATEFUL_AI_COMMAND='$ai_command'
TZ=$tz
PLATEFUL_PORT=$port
PLATEFUL_PASSWORD=$password
PLATEFUL_DOMAIN=$domain
EOF
mkdir -p data/home

bold "Building Plateful (the first time takes a few minutes)..."
docker compose build

if [ "$login" = "claude" ]; then
  bold "Signing in to Claude"
  docker compose run --rm --no-deps plateful claude setup-token || true
  token=$(secret "Now paste the token it printed (hidden):")
  [ -n "$token" ] || die "No token given. Put it in .env as CLAUDE_CODE_OAUTH_TOKEN, then run: docker compose up -d"
  sed -i.bak "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=$token|" .env && rm -f .env.bak
elif [ "$login" = "opencode" ]; then
  bold "Signing opencode in to your provider"
  echo "Pick your provider and paste its key when opencode asks."
  docker compose run --rm --no-deps plateful opencode auth login || echo "Skipped. You can do it later: docker compose exec plateful opencode auth login"
fi

bold "Starting Plateful..."
if [ -n "$domain" ]; then docker compose --profile cloud up -d; else docker compose up -d; fi

bold "Plateful is running."
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
if [ "$ai" = "codex" ] && [ -z "$codex_key" ]; then echo "To use your ChatGPT sign-in, follow 'OpenAI Codex' in SETUP.md before logging food."; fi
echo "The first person to open it sets themselves up. Your diary lives in the 'data' folder here."
