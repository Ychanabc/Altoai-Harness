---
kind: upgrade-guide
description: "AltoaiH replaces the DSH desktop identifiers and user-data root."
---

# AltoaiH 运行时标识

[English](guide.md) | 中文

## 变更

桌面应用现使用 AltoaiH 产品标识。它注册 `altoaih` 协议，使用 `ALTOAIH_*` 桌面环境变量，并将新本地数据存入 `~/.altoaih` 或 `ALTOAIH_HOME`。不会读取或迁移已有的 `DSH_HOME` 数据。

## 迁移

1. 在启动脚本、服务定义和本地环境文件中，将 `DSH_HOME` 替换为 `ALTOAIH_HOME`。
2. 在打包和更新任务中，将 `DSH_DESKTOP_*` 变量替换为对应的 `ALTOAIH_DESKTOP_*` 变量。
3. 将 AltoaiH 作为新应用安装。新的数据根目录初始为空；仅从原 DSH 根目录复制确有需要的文件。
4. 在未设置 `ALTOAIH_HOME` 时，确认 `altoaih://open` 会聚焦已安装应用，且数据根目录为 `~/.altoaih`。
