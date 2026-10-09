# AssetHive 更新发布

Hub 1.9.7 起兼容 Inno Setup EXE 安装包，并保留旧 MSI 支持。
Hub 从 `blackbladestudio/AssetHive` 的 GitHub 最新正式 Release 获取版本和安装包。

## 安装包约定

Release tag 使用 `vX.Y.Z`。优先选择以下 EXE 文件和对应校验文件：

- `AssetHive-X.Y.Z-setup-win64.exe`
- `AssetHive-X.Y.Z-setup-win64.exe.sha256`

没有 EXE 时兼容原有的 `AssetHive-X.Y.Z-Windows.msi` 及其 `.sha256` 文件。
校验文件采用 `SHA256  文件名` 格式，必须与安装包一一对应。
不要将 EXE 改名为 MSI；旧 Hub 1.9.5 需要先升级到支持 EXE 的版本。

## 安装和检测

Inno Setup 使用静默安装、不自动重启，并在本地临时目录保存安装日志。
首次安装使用当前用户模式；已有 Inno 安装时保留安装模式和目录。
Hub 查询 HKCU/HKLM 卸载注册表，匹配 AssetHive 产品名称（允许带版本号）及 BlackBlade Studio 发布者，读取安装目录或显示图标中的程序路径。
同时存在多个安装版本时，优先选择程序文件存在的最高版本。

## 发布验证

先创建草稿 Release，上传安装包及校验文件，检查资产名称、大小和 SHA-256，再发布为最新正式版本。
可在安装前运行下列命令，仅验证真实下载链路：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/install_assethive.ps1 -DownloadOnly
```

Hub 自身更新由 `http://10.248.15.20/hub_dist/version.json` 提供，与 AssetHive 的 GitHub Release 分开。
新版 Hub 安装包发布到 GitHub 后，还需部署至内网 `hub_dist` 才能通过旧 Hub 的自更新入口分发。
