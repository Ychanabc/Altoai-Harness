---
description: "Web 与 Desktop 使用本站设备授权、设备账号元数据和手动本站版本检查。"
kind: upgrade-guide
---

# 本站账号部署

[English](guide.md) | 中文

## 变更

Web 与 Desktop 组合包应用 `site.overlay.yml`，配置为 `authProtocol: site-device`、`catalogProtocol: site` 以及本站账号源和推理源。旧的未标记本站凭据会在启动时删除。设备 relay key 永远不是 dashboard session。

设备账号读取使用 `/api/client/v1/device/session` 和 `/api/client/v1/device/billing`，不是不带 `/device` 的 dashboard token 接口。账号分组、设备有效分组、钱包额度和各个套餐是独立值。套餐金额为原始 quota，不是货币或 token 数。

Desktop 本站模式检查本站明确发布的客户端版本并提供浏览器下载。它不使用上游强制更新，也不自动安装更新。缺少发布记录不表示应使用 API 服务器版本或上游下载。

## 迁移

1. 配套部署同批 new-api 后端、数据库迁移和网站设备批准页。保留现有持久化数据和会话密钥。[后端部署参考](../../../../../docs/client-device.md)说明设备接口、分组语义、额度单位和 `CLIENT_RELEASES_JSON`。
2. 通过网站设备批准页登录；Host 轮询获取与 verifier 绑定的 key。确认设备 session 和 billing 可读，再使用 `/v1/models` 返回且 `supported_endpoint_types` 包含 `anthropic` 的模型发起 Messages 请求。设置 `DSH_SITE_MODEL` 或保存模型选择；初始默认 `deepseek-chat` 不可用时会被拒绝。
3. Windows x64 按[本地未签名构建说明](../../../../SITE-WINDOWS-BUILD.md)操作。仅在 `apps/desktop/.env.windows` 不存在时复制[本站模板](../../../../.env.site-windows.example)。使用文件中的 `DSH_DESKTOP_AUTH_PROTOCOL=site-device` 和 `DSH_DESKTOP_SITE_ORIGIN=https://ai.vpss.eu.cc`；不要保留上游强制更新设置。先检查，再构建：

```powershell
pnpm run package:desktop:win:x64:unsigned --check
pnpm run package:desktop:win:x64:unsigned
```

4. 实际托管并明确发布安装器前，保持 `CLIENT_RELEASES_JSON` 未设置或为 `{}`。本地未签名打包不会上传、发布，也不能证明安装验收通过。在 Windows 上分别验证安装和手动版本检查。
5. 确认退出后本地访问被移除。服务器吊销需要网站所有者认证的设备吊销 API 或删除配对 token；本地退出不会吊销服务器 token。
6. 使用上游部署时，覆盖账号、推理目录和默认模型的 profile 行，设置上游源、`authProtocol: platform`、`catalogProtocol: deepseek` 与上游模型。Desktop 保留 `desktopPlatform`。移除本站更新模式并恢复独立的上游[打包配置](../../../../apps/desktop/packaging/README.zh.md)。
