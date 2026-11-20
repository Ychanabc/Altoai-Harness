---
description: "Web and Desktop use site device authorization, device account metadata, and manual site release checks."
kind: upgrade-guide
---

# Site account deployment

English | [中文](guide.zh.md)

## Change

The Web and Desktop bundles apply `site.overlay.yml` with `authProtocol: site-device`, `catalogProtocol: site`, and site account and inference origins. Old untagged site grants are removed at startup. Device relay keys are never dashboard sessions.

Device account reads use `/api/client/v1/device/session` and `/api/client/v1/device/billing`, not the dashboard-token endpoints without `/device`. Account group, device effective group, wallet quota, and each subscription are separate values. Subscription amounts are raw quota, not currency or token counts.

Desktop site mode checks the site's explicitly published client release and offers a browser download. It does not use upstream mandatory updates or automatically install updates. Missing publication is not an API server version or an upstream download.

## Migration

1. Deploy the matching new-api backend, database migrations, and website device approval page together. Preserve existing persistent data and the session secret. Follow the [backend deployment reference](../../../../../docs/client-device.md) for device endpoints, group semantics, quota units, and `CLIENT_RELEASES_JSON`.
2. Sign in through the website's device approval page; the Host polls for a verifier-bound key. Confirm device session and billing reads, then a Messages request using a model returned by `/v1/models` whose `supported_endpoint_types` includes `anthropic`. Set `DSH_SITE_MODEL` or save a model selection; the initial `deepseek-chat` default is refused when unavailable.
3. For Windows x64, follow the [local unsigned build instructions](../../../../SITE-WINDOWS-BUILD.md). Copy the [site template](../../../../.env.site-windows.example) only when `apps/desktop/.env.windows` does not exist. Use file-owned `DSH_DESKTOP_AUTH_PROTOCOL=site-device` and `DSH_DESKTOP_SITE_ORIGIN=https://ai.vpss.eu.cc`; do not retain upstream mandatory-update settings. Check first, then build:

```powershell
pnpm run package:desktop:win:x64:unsigned --check
pnpm run package:desktop:win:x64:unsigned
```

4. Leave `CLIENT_RELEASES_JSON` unset or `{}` until an installer is actually hosted and explicitly published. Local unsigned packaging does not upload, publish, or establish installation acceptance. Verify installation and manual release checks separately on Windows.
5. Confirm sign-out removes local access. Server-side revocation requires the website owner-authenticated device revocation API or paired token deletion; local sign-out does not revoke the server token.
6. For upstream deployment, override the account, inference catalog, and default-model profile rows with upstream origins, `authProtocol: platform`, `catalogProtocol: deepseek`, and an upstream model. Retain `desktopPlatform` on Desktop. Remove site update mode and restore the separate upstream [packaging configuration](../../../../apps/desktop/packaging/README.md).
