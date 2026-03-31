# Studio Hub

工作室统一工作台，用于集中管理 Jenkins / Horde / UGS 等研发工具入口，并支持一键环境配置。

## 功能概览

| 入口 | 类型 | 说明 |
|------|------|------|
| **Jenkins** | Web URL | 持续集成 / 构建任务 / 流水线管理 |
| **Horde** | Web URL | 分布式构建集群 / 任务调度 |
| **UGS** | 本地脚本/应用 | 版本控制入口（Perforce / Unity Collaboration） |
| **环境配置** | 本地脚本 | 一键安装工作站依赖（PowerShell / Batch / EXE） |
| **一键全开** | 批量操作 | 同时打开 Jenkins + Horde + UGS（已配置时） |

---

## 项目结构

```
studio_hub/
├── package.json              # Electron 项目配置
├── .npmrc                    # npm 镜像源配置
├── src/
│   ├── main.js               # 主进程（窗口管理 / IPC / 脚本执行）
│   ├── preload.js            # 预加载脚本（安全桥接主进程与渲染进程）
│   ├── index.html            # 工作台 UI 页面
│   └── config.default.json   # 默认配置模板（内置于 app.asar）
├── dist/                     # 构建产物（由 npm run pack / build 生成）
│   ├── win-unpacked/         # 解压版目录
│   └── StudioHub-{version}-win64-portable.zip  # 绿色版压缩包
└── make-zip.ps1              # 辅助脚本：将 win-unpacked 打包为 zip
```

---

## 快速开始

### 开发调试

```powershell
cd d:\workspace\blackblade-utility\studio_hub
npm start
```

### 构建产物

```powershell
# 生成解压版（win-unpacked/）
npm run pack

# 打包为绿色版 zip（输出到 dist/）
# 直接运行 make-zip.ps1，或手动压缩 win-unpacked 目录
powershell -ExecutionPolicy Bypass -File make-zip.ps1
```

### 构建安装包（NSIS）

```powershell
npm run build
# 输出：dist/Studio Hub Setup 1.0.0.exe
```

---

## 配置说明

### 配置路径

| 场景 | 路径 |
|------|------|
| 开发调试（项目目录） | `studio_hub/config.json`（需手动创建） |
| 绿色版 / 安装版 | `%APPDATA%\Studio Hub\config.json` |

### 配置首次引导

应用启动时，如果用户目录下不存在 `config.json`，自动从内置的 `config.default.json` 复制到用户数据目录，并以此作为初始配置。

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `jenkins` | URL | Jenkins 访问地址 |
| `horde` | URL | Horde 访问地址 |
| `ugs` | 路径 | UGS 本地脚本或可执行文件路径 |
| `envScript` | 路径 | 环境配置脚本路径（.ps1 / .bat / .cmd / .exe） |

### 示例（config.default.json）

```json
{
  "jenkins": "http://10.248.15.20:8080/",
  "horde": "http://10.248.15.20:13340",
  "ugs": "",
  "envScript": ""
}
```

---

## 分发指南

### 绿色版（推荐内网分发）

1. 构建：`npm run pack`
2. 打包：`powershell -ExecutionPolicy Bypass -File make-zip.ps1`
3. 上传产物 `dist/StudioHub-{version}-win64-portable.zip` 至内网软件门户
4. 用户解压后直接运行 `Studio Hub.exe` 即可

**首次运行行为：**
- 自动在 `%APPDATA%\Studio Hub\` 下创建 `config.json`
- 如果 `config.default.json` 存在于 app.asar 内，先复制其内容作为默认值
- 已存在配置时不做覆盖

### 预置配置（批量部署场景）

如果需要在分发时统一预置 UGS / 环境脚本路径，可以：

1. 在内网共享目录准备好一份 `config.json`
2. 在部署脚本中将其复制到目标机器的 `%APPDATA%\Studio Hub\config.json`
3. 这样用户首次启动时即拥有完整配置，无需手动填写

### 代码签名（内网 CA）

建议对 `win-unpacked/Studio Hub.exe` 进行签名后再发布，减少 Windows SmartScreen 警告：

```powershell
# signtool 签名（需内网 CA 证书）
signtool sign /f 证书.pfx /p 密码 /tr http://timestamp.example.com/tsa /td SHA256 /fd SHA256 "dist\win-unpacked\Studio Hub.exe"
```

---

## 技术栈

- **运行时**：Electron 33.4.0
- **构建工具**：electron-builder 25.1.8
- **Node.js**：>= 18（已在 `C:\Program Files\nodejs` 下验证 v24.14.1）
- **npm**：>= 9（已在 v11.11.0 下验证）
- **镜像**：registry=https://registry.npmmirror.com/

---

## 常见问题

**Q：启动提示 "node 无法识别"？**
确保 `C:\Program Files\nodejs` 在系统 PATH 中。Electron 子进程需要调用 node.exe。

**Q：点击 UGS / 环境配置无反应？**
检查「配置」中对应路径是否填写，且文件存在。脚本类支持 `.ps1` `.bat` `.cmd`，应用类支持 `.exe`。

**Q：配置保存后不生效？**
绿色版配置写入 `%APPDATA%\Studio Hub\config.json`，不是项目根目录的 `config.json`。

**Q：想修改默认 URL（ Jenkins / Horde）？**
直接编辑 `src/config.default.json` 后重新 `npm run pack` 即可。
