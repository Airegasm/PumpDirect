#!/usr/bin/env bash
# PumpDirect launcher (Linux / macOS)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "========================================"
echo "  PumpDirect"
echo "========================================"
echo ""

# Node check
if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 20+ (https://nodejs.org or via nvm) and re-run."
  exit 1
fi

# Python check (optional — only needed for some device protocols)
if ! command -v python3 >/dev/null 2>&1; then
  echo "Warning: python3 not found. Some device protocols (Wyze, Matter, Kasa) will be unavailable."
fi

# Install node deps if missing
if [ ! -d node_modules ]; then
  echo "Installing Node dependencies..."
  npm install --no-audit --no-fund --loglevel=error
fi

# Python venv (optional — only build if requirements.txt is present)
if [ -f requirements.txt ] && command -v python3 >/dev/null 2>&1; then
  if [ ! -d .venv ]; then
    echo "Creating Python venv..."
    python3 -m venv .venv
  fi
  if [ ! -f .venv/.deps-installed ] || [ requirements.txt -nt .venv/.deps-installed ]; then
    echo "Installing Python dependencies..."
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r requirements.txt
    touch .venv/.deps-installed
  fi
fi

OWNER_URL="http://localhost:${OWNER_PORT:-3001}"
echo ""
echo "Owner GUI: $OWNER_URL"
echo "Public server (loopback): http://localhost:${PORT:-3000}"
echo ""

# Open the owner URL once the server is reachable
(
  for _ in $(seq 1 30); do
    if curl -sf "$OWNER_URL/" >/dev/null 2>&1; then
      if command -v xdg-open >/dev/null 2>&1; then xdg-open "$OWNER_URL" >/dev/null 2>&1 || true
      elif command -v open >/dev/null 2>&1; then open "$OWNER_URL" >/dev/null 2>&1 || true
      fi
      exit 0
    fi
    sleep 1
  done
) &

exec node server.js
