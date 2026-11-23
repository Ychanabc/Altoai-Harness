# Altoai Harness

[English](README.md) | 中文

Altoai Harness 是 [Altoai](https://ai.vpss.eu.cc) 的官方桌面客户端。客户端通过浏览器设备授权连接 Altoai 账号，可选择该账号可用的模型，并检查客户端更新。

- 源码：<https://github.com/Ychanabc/Altoai-Harness.git>
- 服务：<https://ai.vpss.eu.cc>

<a id="use-the-client"></a>
## 使用客户端

1. 从 Altoai 部署渠道获取 Windows 安装包并完成安装。
2. 启动 Altoai Harness，选择“登录”。
3. 在浏览器中访问 <https://ai.vpss.eu.cc>，批准设备授权请求。
4. 授权完成后返回客户端。
5. 在模型选择器中选择可用模型，然后开始对话。

模型列表、账号信息和设备授权状态由 Altoai 提供。模型未显示时，表示当前账号或部署未提供该模型。

<a id="ssh-workspaces"></a>
### SSH 工作区

首次连接 Linux x64 或 arm64 服务器时，桌面客户端会通过 SSH 上传自带的运行时，并安装到登录账号的主目录。之后连接会复用已安装的运行时。SSH 服务需允许回环 TCP 转发和终端分配，登录账号需具备可写的主目录及标准 Linux Shell、解压和校验工具。

添加工作区时，填写服务器 IP、端口、账号、密码和远端绝对目录，例如 `/srv/project`。在该工作区点击「新建会话」打开远端窗口，再配置模型。对话和工具在服务器上运行，会话历史也保存在服务器上。删除 Windows 上的工作区登记会清除本地记录，并保留服务器上的项目和会话历史。

<a id="build-from-source"></a>
## 从源码构建

需要 Node.js 24.9.0 或更高版本、pnpm 11.28.5 和 Git。

```sh
git clone https://github.com/Ychanabc/Altoai-Harness.git
cd Altoai-Harness
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:desktop
```

开发时可运行 `pnpm run dev:web` 启动浏览器客户端；本地服务器启动后会打印访问地址。

## Windows 安装包

请在 Windows x64 上生成 Windows x64 安装包。前置条件、本站配置、产物位置和验收方式见 [Windows 构建指南](SITE-WINDOWS-BUILD.md)。

```powershell
pnpm run package:desktop:win:x64:unsigned --check
pnpm run package:desktop:win:x64:unsigned
```

## 更新与故障排查

客户端检查 Altoai 更新渠道；有已批准的新安装包时，会在浏览器中打开下载页面。客户端不会切换到其他厂商的下载服务。

- **浏览器授权未完成：** 确认浏览器已登录 <https://ai.vpss.eu.cc>，批准当前设备请求后返回客户端。
- **没有可选模型：** 退出后重新登录，再确认账号已开通 Altoai 服务权限。
- **连接失败：** 检查网络能否访问 <https://ai.vpss.eu.cc>，并确认客户端使用了下方的本站配置构建。
- **没有更新提示：** 已安装客户端可能已是最新版本，或部署尚未发布新的客户端安装包。

## 许可证

[MIT](LICENSE)

第三方许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
