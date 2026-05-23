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

# Service conflict check — the OS-hardened systemd service binds the same
# ports, so running this launcher alongside it would crash immediately with
# EADDRINUSE. Exit cleanly with a clear message instead.
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet pumpdirect.service 2>/dev/null; then
  echo ""
  echo "========================================"
  echo "  pumpdirect.service is already RUNNING"
  echo "========================================"
  echo ""
  echo "The OS-hardened systemd service is already running PumpDirect, so this"
  echo "launcher cannot start — port 3000/3001 are already bound."
  echo ""
  echo "Either:"
  echo "  1) Use the service directly — open http://localhost:3001 in a browser."
  echo "     To stop it:    sudo systemctl stop pumpdirect"
  echo "     To restart it: sudo systemctl restart pumpdirect"
  echo ""
  echo "  2) Or stop the service and re-run this launcher to take updates:"
  echo "     sudo systemctl stop pumpdirect && ./start.sh"
  echo ""
  exit 1
fi

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

# Auto-update from origin/main (if this is a git checkout and git is available).
# Skipped on dirty trees — users aren't expected to edit code locally; if they
# have, they can recover with: git reset --hard origin/main
NEED_DEPS_REINSTALL=""
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  echo "Checking for updates..."
  if git diff --quiet && git diff --cached --quiet; then
    if git fetch --quiet origin 2>/dev/null; then
      LOCAL_SHA=$(git rev-parse HEAD)
      REMOTE_SHA=$(git rev-parse origin/main 2>/dev/null || echo "$LOCAL_SHA")
      if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
        echo "Updating to latest..."
        if git pull --ff-only --quiet origin main; then
          echo "✓ Updated. Reinstalling dependencies..."
          NEED_DEPS_REINSTALL=1
        else
          echo "⚠ Update failed (diverged history). Launching current version."
        fi
      else
        echo "Already up to date."
      fi
    else
      echo "⚠ Cannot reach git remote (offline?). Launching current version."
    fi
  else
    echo "⚠ Local uncommitted changes — skipping auto-update."
    echo "  To force update, discard local edits: git reset --hard origin/main"
  fi
fi

# Install node deps if missing OR if we just pulled an update
if [ ! -d node_modules ] || [ -n "$NEED_DEPS_REINSTALL" ]; then
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
