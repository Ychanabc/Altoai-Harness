# Altoai Harness

English | [中文](README.zh.md)

Altoai Harness is the official desktop client for [Altoai](https://ai.vpss.eu.cc). It connects to your Altoai account through browser-based device authorization, lets you choose models available to that account, and checks for client updates.

- Source: <https://github.com/Ychanabc/Altoai-Harness.git>
- Service: <https://ai.vpss.eu.cc>

## Use the client

1. Obtain a Windows installer from your Altoai deployment channel and install it.
2. Start Altoai Harness and select **Sign in**.
3. Approve the device request in the browser at <https://ai.vpss.eu.cc>.
4. Return to the client after authorization completes.
5. Choose an available model from the model selector, then start a conversation.

The model list, account details, and device authorization state are provided by Altoai. If a model is not listed, it is not available to the current account or deployment.

- Change the color theme from **Settings → General → Appearance**.
- Open **Skill Library** below **Plugins** to search the public catalog used by Altoai. It checks for updates when opened and periodically while the page is open. Select a skill to read its upstream documentation.

### SSH workspaces

On first connection to Linux x64 or arm64, the desktop uploads its bundled runtime over SSH and installs it in the login account's home directory. Later connections reuse the installed runtime. The SSH server must allow loopback TCP forwarding and terminal allocation. The login account needs a writable home directory and the standard Linux shell, archive and checksum tools.

Enter the server IP, port, username, password, and an absolute server path such as `/srv/project`. Select **New session** on the workspace to open the remote window and configure its model. The server runs conversations and tools and stores their history. Deleting the Windows registration clears its local records and preserves the server's project and history.

## Build from source

Use Node.js 24.9.0 or later, pnpm 11.28.5, and Git.

```sh
git clone https://github.com/Ychanabc/Altoai-Harness.git
cd Altoai-Harness
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:desktop
```

For a browser client during development, run `pnpm run dev:web`. The local server prints its address when it starts.

## Windows installer

Build a Windows x64 installer on Windows x64. See [Windows build guide](SITE-WINDOWS-BUILD.md) for prerequisites, the site configuration, output locations, and verification.

```powershell
pnpm run package:desktop:win:x64:unsigned --check
pnpm run package:desktop:win:x64:unsigned
```

## Updates and troubleshooting

The client checks the Altoai update channel and opens the browser when an approved newer installer is available. It does not switch to another vendor's download service.

- **Browser authorization does not finish:** confirm that the browser is signed in to <https://ai.vpss.eu.cc>, approve the current device request, then return to the client.
- **No models appear:** sign out and sign in again; then confirm the account has an active Altoai service entitlement.
- **Connection fails:** check network access to <https://ai.vpss.eu.cc> and confirm the client was built with the site configuration below.
- **No update is offered:** the installed client may already be current, or the deployment may not have published a newer client installer.

## License

[MIT](LICENSE)

Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
