const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Hardening');
const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(__dirname, '..');
const SYSTEMD_UNIT_NAME = 'pumpdirect.service';
const SYSTEMD_UNIT_PATH = '/etc/systemd/system/' + SYSTEMD_UNIT_NAME;
const LOCAL_UNIT_PATH = path.join(PROJECT_DIR, SYSTEMD_UNIT_NAME);
const WIN_SERVICE_NAME = 'PumpDirect';

function generateLinuxUnit() {
  const user = os.userInfo().username;
  const nodePath = process.execPath;
  const cfDir = path.join(os.homedir(), '.cloudflared');
  const readWritePaths = [PROJECT_DIR, cfDir].join(' ');
  return `[Unit]
Description=PumpDirect
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${nodePath} server.js
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

# --- Hardening ---
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${readWritePaths}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK AF_PACKET
PrivateDevices=yes
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

function writeLinuxUnit() {
  fs.writeFileSync(LOCAL_UNIT_PATH, generateLinuxUnit());
  return LOCAL_UNIT_PATH;
}

function linuxInstallCommand() {
  return `sudo cp ${LOCAL_UNIT_PATH} ${SYSTEMD_UNIT_PATH} && sudo systemctl daemon-reload && sudo systemctl enable --now ${SYSTEMD_UNIT_NAME}`;
}

function linuxUninstallCommand() {
  return `sudo systemctl disable --now ${SYSTEMD_UNIT_NAME} && sudo rm ${SYSTEMD_UNIT_PATH} && sudo systemctl daemon-reload`;
}

async function linuxStatus() {
  const installed = fs.existsSync(SYSTEMD_UNIT_PATH);
  if (!installed) return { installed: false };
  let active = false;
  let sub = null;
  let since = null;
  try {
    const { stdout } = await execFileP('systemctl', ['show', SYSTEMD_UNIT_NAME, '--property=ActiveState,SubState,ActiveEnterTimestamp']);
    for (const line of stdout.trim().split('\n')) {
      const [k, ...rest] = line.split('=');
      const v = rest.join('=');
      if (k === 'ActiveState') active = v === 'active';
      if (k === 'SubState') sub = v;
      if (k === 'ActiveEnterTimestamp') since = v || null;
    }
  } catch (e) {
    logger.error('systemctl show failed', e.message);
  }
  return { installed: true, active, sub, since, unitPath: SYSTEMD_UNIT_PATH };
}

async function windowsStatus() {
  try {
    const { stdout } = await execFileP('sc', ['query', WIN_SERVICE_NAME]);
    const installed = /SERVICE_NAME/.test(stdout);
    const active = /RUNNING/.test(stdout);
    return { installed, active, serviceName: WIN_SERVICE_NAME };
  } catch {
    return { installed: false };
  }
}

const WIN_INSTALL_SCRIPT_PATH = path.join(PROJECT_DIR, 'install-service.ps1');
const WIN_UNINSTALL_SCRIPT_PATH = path.join(PROJECT_DIR, 'uninstall-service.ps1');

function generateWindowsInstallScript() {
  const nodePath = process.execPath;
  return `# PumpDirect — Windows Service installer (run from an admin PowerShell)
$ErrorActionPreference = "Stop"
$proj = "${PROJECT_DIR.replace(/\\/g, '\\\\')}"
$bin  = "$proj\\bin"
$nssm = "$bin\\nssm.exe"

if (-not (Test-Path $nssm)) {
  New-Item -ItemType Directory -Force $bin | Out-Null
  $tmp = "$env:TEMP\\nssm-2.24.zip"
  Write-Host "Downloading NSSM..."
  Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $tmp
  Expand-Archive -Path $tmp -DestinationPath $env:TEMP -Force
  Copy-Item "$env:TEMP\\nssm-2.24\\win64\\nssm.exe" $nssm
  Remove-Item $tmp -Force
  Remove-Item "$env:TEMP\\nssm-2.24" -Recurse -Force
}

& $nssm install ${WIN_SERVICE_NAME} "${nodePath.replace(/\\/g, '\\\\')}" "server.js"
& $nssm set ${WIN_SERVICE_NAME} AppDirectory $proj
& $nssm set ${WIN_SERVICE_NAME} AppEnvironmentExtra NODE_ENV=production PORT=3000 HOST=127.0.0.1
& $nssm set ${WIN_SERVICE_NAME} Start SERVICE_AUTO_START
& $nssm set ${WIN_SERVICE_NAME} AppStdout "$proj\\logs\\stdout.log"
& $nssm set ${WIN_SERVICE_NAME} AppStderr "$proj\\logs\\stderr.log"
New-Item -ItemType Directory -Force "$proj\\logs" | Out-Null
& $nssm start ${WIN_SERVICE_NAME}

# Firewall rule: PumpDirect binds 127.0.0.1, this rule documents/enforces it.
New-NetFirewallRule -DisplayName "PumpDirect (loopback only)" -LocalAddress 127.0.0.1 -Direction Inbound -LocalPort 3000,3001 -Action Allow -Protocol TCP -ErrorAction SilentlyContinue | Out-Null

Write-Host "PumpDirect service installed and started."
`;
}

function generateWindowsUninstallScript() {
  return `# PumpDirect — Windows Service uninstaller (run from an admin PowerShell)
$ErrorActionPreference = "SilentlyContinue"
$proj = "${PROJECT_DIR.replace(/\\/g, '\\\\')}"
$nssm = "$proj\\bin\\nssm.exe"

if (Test-Path $nssm) {
  & $nssm stop ${WIN_SERVICE_NAME}
  & $nssm remove ${WIN_SERVICE_NAME} confirm
}
Remove-NetFirewallRule -DisplayName "PumpDirect (loopback only)"
Write-Host "PumpDirect service removed."
`;
}

function writeWindowsScripts() {
  fs.writeFileSync(WIN_INSTALL_SCRIPT_PATH, generateWindowsInstallScript());
  fs.writeFileSync(WIN_UNINSTALL_SCRIPT_PATH, generateWindowsUninstallScript());
  return { installPath: WIN_INSTALL_SCRIPT_PATH, uninstallPath: WIN_UNINSTALL_SCRIPT_PATH };
}

function windowsInstallCommand() {
  return `powershell -ExecutionPolicy Bypass -File "${WIN_INSTALL_SCRIPT_PATH}"`;
}

function windowsUninstallCommand() {
  return `powershell -ExecutionPolicy Bypass -File "${WIN_UNINSTALL_SCRIPT_PATH}"`;
}

async function detectStatus() {
  if (process.platform === 'linux') {
    return { platform: 'linux', method: 'systemd', ...(await linuxStatus()) };
  }
  if (process.platform === 'win32') {
    return { platform: 'win32', method: 'nssm', ...(await windowsStatus()) };
  }
  return { platform: process.platform, method: null, installed: false, unsupported: true };
}

module.exports = {
  detectStatus,
  generateLinuxUnit,
  writeLinuxUnit,
  linuxInstallCommand,
  linuxUninstallCommand,
  generateWindowsInstallScript,
  generateWindowsUninstallScript,
  writeWindowsScripts,
  windowsInstallCommand,
  windowsUninstallCommand,
  LOCAL_UNIT_PATH,
  SYSTEMD_UNIT_PATH,
  SYSTEMD_UNIT_NAME,
  WIN_INSTALL_SCRIPT_PATH,
  WIN_UNINSTALL_SCRIPT_PATH,
};
