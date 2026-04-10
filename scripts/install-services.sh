#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Yardmaster Service Installer ==="
echo

# 1. Ensure Redis is configured to start on boot
echo "[1/5] Configuring Redis..."
if command -v redis-server &>/dev/null; then
    # Set noeviction policy (required by BullMQ)
    redis-cli CONFIG SET maxmemory-policy noeviction 2>/dev/null || true
    redis-cli CONFIG SET maxmemory 64mb 2>/dev/null || true
    echo "  Redis configured (maxmemory 64mb, noeviction)"
else
    echo "  ERROR: redis-server not found. Install with: brew install redis"
    exit 1
fi

# 2. Ensure vm.overcommit_memory is set
echo "[2/5] Checking vm.overcommit_memory..."
current=$(cat /proc/sys/vm/overcommit_memory)
if [ "$current" != "1" ]; then
    echo "  Setting vm.overcommit_memory=1..."
    sudo sysctl vm.overcommit_memory=1
    if ! grep -q "vm.overcommit_memory" /etc/sysctl.conf 2>/dev/null; then
        echo "vm.overcommit_memory = 1" | sudo tee -a /etc/sysctl.conf >/dev/null
        echo "  Added to /etc/sysctl.conf for persistence"
    fi
else
    echo "  Already set"
fi

# 3. Install systemd units
echo "[3/5] Installing systemd units..."
sudo cp "$PROJECT_DIR/yardmaster.service" /etc/systemd/system/
sudo cp "$PROJECT_DIR/yardmaster-scan.service" /etc/systemd/system/
sudo cp "$PROJECT_DIR/yardmaster-scan.timer" /etc/systemd/system/
sudo systemctl daemon-reload
echo "  Units installed"

# 4. Enable and start services
echo "[4/5] Enabling services..."
sudo systemctl enable yardmaster.service
sudo systemctl start yardmaster.service
echo "  yardmaster worker: enabled and started"

sudo systemctl enable yardmaster-scan.timer
sudo systemctl start yardmaster-scan.timer
echo "  yardmaster scan timer: enabled and started (every 2 hours)"

# 5. Verify
echo "[5/5] Verifying..."
echo
echo "Worker status:"
systemctl status yardmaster.service --no-pager -l 2>&1 | head -5
echo
echo "Scan timer status:"
systemctl status yardmaster-scan.timer --no-pager -l 2>&1 | head -5
echo
echo "Next scan:"
systemctl list-timers yardmaster-scan.timer --no-pager 2>&1 | head -3
echo
echo "=== Installation complete ==="
echo "  Worker:     systemctl status yardmaster"
echo "  Scan timer: systemctl status yardmaster-scan.timer"
echo "  Logs:       journalctl -u yardmaster -f"
echo "  Queue:      ym queue show"
