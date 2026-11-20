---
kind: upgrade-guide
description: "AltoaiH replaces the DSH desktop identifiers and user-data root."
---

# AltoaiH runtime identifiers

English | [中文](guide.zh.md)

## Change

The desktop application now uses the AltoaiH product identity. It registers the `altoaih` protocol, uses `ALTOAIH_*` desktop environment variables, and stores new local data under `~/.altoaih` or `ALTOAIH_HOME`. Existing `DSH_HOME` data is not read or migrated.

## Migration

1. Replace `DSH_HOME` with `ALTOAIH_HOME` in launch scripts, service definitions, and local environment files.
2. Replace `DSH_DESKTOP_*` variables with the corresponding `ALTOAIH_DESKTOP_*` variables in packaging and update jobs.
3. Install AltoaiH as a new application. Its new user-data root starts empty; copy only files you explicitly need from the previous DSH root.
4. Confirm `altoaih://open` focuses the installed application and that its data root is `~/.altoaih` when `ALTOAIH_HOME` is unset.
