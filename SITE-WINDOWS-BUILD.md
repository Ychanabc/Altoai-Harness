# Altoai Harness Windows x64 Build Guide

This guide builds an unsigned Altoai Harness installer for local Windows x64 testing. It does not publish an installer or modify an Altoai server.

- Source: <https://github.com/Ychanabc/Altoai-Harness.git>
- Service: <https://ai.vpss.eu.cc>

## Prerequisites

Build on Windows x64 in PowerShell 7. Use a short source path such as `C:\src\Altoai-Harness`; do not build in Linux or WSL.

Install Node.js 24.9.0 or later, pnpm 11.28.5, Git, Python, `tar`, and Visual Studio Build Tools with the **Desktop development with C++** workload and Windows SDK. The native modules and installer helper require the C++ toolchain.

```powershell
Set-Location C:\src\Altoai-Harness
node --version
node -p "process.platform + '-' + process.arch"
npm install --global pnpm@11.28.5
pnpm --version
git --version
python --version
pnpm install --frozen-lockfile
```

Confirm that the platform command prints `win32-x64`. Keep the source tree, `pnpm-lock.yaml`, workspace files, `patches/`, `vendor/`, and `native/` together. Do not reuse `node_modules` from another operating system.

## Configure Altoai

The desktop packager reads `apps/desktop/.env.windows`. Create it only when it does not already exist:

```powershell
if (-not (Test-Path apps/desktop/.env.windows)) {
  Copy-Item .env.site-windows.example apps/desktop/.env.windows
}
```

Verify these values in `apps/desktop/.env.windows`:

```dotenv
DSH_DESKTOP_AUTH_PROTOCOL=site-device
DSH_DESKTOP_SITE_ORIGIN=https://ai.vpss.eu.cc
```

Do not add account tokens, API keys, signing credentials, or upload credentials. The installed client opens the system browser for Altoai device authorization. The site supplies the signed-in account details and available models.

## Build the installer

Run the configuration check first, then create the unsigned installer:

```powershell
pnpm run package:desktop:win:x64:unsigned --check
pnpm run package:desktop:win:x64:unsigned
```

The installer is written to:

```text
apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/
```

Packaging logs are written to:

```text
apps/desktop/.desktop-build/packaging-runs/
```

## Verify the client

Install the generated package on Windows, then complete this acceptance check:

1. Start Altoai Harness and confirm the Altoai identity is shown.
2. Select **Sign in**, approve the browser device request at <https://ai.vpss.eu.cc>, and return to the client.
3. Confirm the account and its available models load.
4. Select a model and send a test request.
5. Use the client update check; when a newer approved installer exists, the browser opens the Altoai download page.

## Troubleshooting

- **`pnpm install` fails:** confirm Node.js, pnpm, Git, Python, and the C++ Build Tools are available in the current PowerShell session.
- **Packaging check fails:** verify the build runs on Windows x64 and that `apps/desktop/.env.windows` contains the Altoai device authorization settings.
- **Authorization does not complete:** sign in to <https://ai.vpss.eu.cc> in the browser, approve the displayed device request, then return to the client.
- **Models do not load:** sign out and sign in again; confirm the Altoai account has access to at least one model.
- **No update appears:** a newer client installer may not be published for the deployment yet.

## Local build scope

An unsigned installer is for local testing. Build outputs and local configuration remain on the build machine. Do not place server configuration, databases, logs, sessions, account tokens, API keys, signing keys, or upload credentials in the source tree or installer.
