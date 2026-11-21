# BlackBlade Hub

工作室统一工作台，用于集中管理游戏/编辑器启动、Jenkins / Horde / UGS 等研发工具入口、HordeAgent 生命周期管理，并支持一键环境配置。基于 Electron + TypeScript 构建。

## 功能概览

| 区域 | 功能 | 说明 |
|------|------|------|
| **Launch** | 启动游戏 / 编辑器 | 配置 exe 路径后一键启动 |
| **Launch** | 生产工具 | 自定义工具列表，快速启动任意 exe / 脚本 |
| **Studio** | BUILDER | 浏览、搜索已发布的工作室站点，点击卡片在默认浏览器打开 |
| **Pipeline** | Jenkins | 打开 Jenkins Web UI |
| **Pipeline** | Horde | 打开 Horde Web UI |
| **Pipeline** | UGS | 打开 UGS（支持 URL 或本地路径） |
| **Toolbox** | 环境配置 | 一键执行工作站环境配置脚本 |
| **Toolbox** | HordeAgent 管理 | 安装 / 启动 / 停止 / 查看状态 |
| **Toolbox** | Unreal Toolbox | 从 Horde 一键下载安装 |

---

## 架构设计

### 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 运行时 | Electron 33 | Chromium + Node.js 桌面容器 |
| 语言 | TypeScript 5 | 全栈类型安全 |
| 主进程编译 | tsc | `src/main/` + `src/preload/` → `dist/` (CommonJS) |
| 渲染进程打包 | esbuild | `src/renderer/` → `dist/renderer/app.js` (单文件 bundle) |
| 打包分发 | electron-builder | NSIS 安装包 / 解压版 |

### 进程模型

```
┌─────────────────────────────────────────────────────┐
│  Main Process (Node.js)                             │
│  src/main/index.ts                                  │
│  ├─ config.ts         配置文件读写                    │
│  ├─ utils.ts          路径解析（dev/prod 自适应）      │
│  └─ ipc/              IPC Handler 模块               │
│     ├─ config.ts      get-config / save-config       │
│     ├─ launch.ts      launch-app / open-url          │
│     ├─ script.ts      run-script（流式日志）           │
│     ├─ horde.ts       HordeAgent 状态/启停            │
│     └─ window.ts      窗口最小化/最大化/关闭           │
├─────────────────────────────────────────────────────┤
│  Preload (contextBridge)                            │
│  src/preload/index.ts                               │
│  暴露 window.studioHub API，类型由 StudioHubAPI 约束  │
├─────────────────────────────────────────────────────┤
│  Renderer Process (Chromium)                        │
│  src/renderer/app.ts                                │
│  ├─ modules/launch.ts       启动游戏/编辑器/工具      │
│  ├─ modules/pipeline.ts     Pipeline 卡片交互         │
│  ├─ modules/toolbox.ts      HordeAgent + Toolbox     │
│  ├─ modules/config-modal.ts 配置面板                  │
│  ├─ modules/log-panel.ts    脚本日志面板               │
│  └─ utils.ts                toast / status / escHtml  │
└─────────────────────────────────────────────────────┘
```

### 类型系统

`src/types/` 定义主进程与渲染进程之间的类型契约：

- **`config.ts`** — `AppConfig`、`ToolEntry` 接口 + `DEFAULT_CONFIG` 常量
- **`ipc.ts`** — `StudioHubAPI`（preload 暴露给 renderer 的完整 API 签名）、`ScriptResult`、`LaunchResult`、`HordeAgentStatus`、`ScriptLogMessage`

Preload 和 Renderer 都引用同一份类型定义，确保 IPC 通信两端类型一致。

---

## 项目结构

```
studio_hub/
├── package.json                # Electron 项目配置 + electron-builder
├── tsconfig.json               # TypeScript 配置（main + preload）
├── .npmrc                      # npm 镜像源
├── scripts/
│   └── build.mjs               # 构建脚本（tsc + esbuild + 静态资源拷贝）
├── src/
│   ├── types/                  # 共享类型定义
│   │   ├── config.ts           #   AppConfig / ToolEntry / DEFAULT_CONFIG
│   │   └── ipc.ts              #   StudioHubAPI / ScriptResult / ...
│   ├── main/                   # Electron 主进程
│   │   ├── index.ts            #   应用入口 + 窗口创建
│   │   ├── config.ts           #   配置文件管理（bootstrap / load / save）
│   │   ├── utils.ts            #   resolvePath（dev/prod 路径自适应）
│   │   └── ipc/                #   IPC Handler 模块
│   │       ├── index.ts        #     registerAllHandlers() 注册入口
│   │       ├── config.ts       #     配置读写
│   │       ├── launch.ts       #     启动应用 / 打开URL / 文件选择
│   │       ├── script.ts       #     脚本执行 + 日志流
│   │       ├── horde.ts        #     HordeAgent 管理
│   │       └── window.ts       #     窗口控制
│   ├── preload/                # Preload 脚本
│   │   └── index.ts            #   contextBridge → window.studioHub
│   ├── renderer/               # 渲染进程
│   │   ├── index.html          #   HTML 结构（纯标记，无内联脚本）
│   │   ├── styles.css          #   全部样式
│   │   ├── app.ts              #   入口：初始化模块 + 加载配置 + 渲染
│   │   ├── utils.ts            #   UI 工具函数
│   │   ├── tsconfig.json       #   渲染进程独立 TS 配置（IDE 用）
│   │   └── modules/            #   功能模块
│   │       ├── launch.ts       #     Launch 区域
│   │       ├── pipeline.ts     #     Pipeline 卡片
│   │       ├── toolbox.ts      #     Toolbox（HordeAgent / Unreal Toolbox）
│   │       ├── config-modal.ts #     配置面板
│   │       └── log-panel.ts    #     日志面板
│   └── config.default.json     # 默认配置模板
├── tools/                      # 内置 PowerShell 工具脚本
│   ├── horde_config.ps1        #   Horde 服务器连接参数
│   ├── install_horde_agent.ps1 #   HordeAgent 安装
│   ├── initialize_horde_agent.ps1  # HordeAgent 初始化
│   ├── install_unreal_toolbox.ps1  # Unreal Toolbox 安装
│   └── setup_agent_environment.ps1 # 工作站环境一键配置
├── dist/                       # 构建产物（git ignored）
└── dist-package/               # electron-builder 输出（git ignored）
```

---

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9
- Windows x64（目标运行环境）

### 开发调试

```powershell
cd studio_hub
npm install
npm run dev          # 编译 + 启动 Electron
```

### 仅编译（不启动）

```powershell
npm run build        # tsc + esbuild → dist/
```

### 启动已编译的应用

```powershell
npm start            # 直接 electron .（需先 build）
```

---

## 构建产物

### 解压版

```powershell
npm run pack
# 输出: dist-package/win-unpacked/
```

### NSIS 安装包

```powershell
npm run dist
# 输出: dist-package/BlackBlade Hub Setup x.x.x.exe
```

### 绿色版 zip

```powershell
npm run pack
powershell -ExecutionPolicy Bypass -File make-zip.ps1
```

---

## 构建流程

`npm run build` 执行 `scripts/build.mjs`，依次完成：

1. **tsc** — 编译 `src/main/` + `src/preload/` + `src/types/` → `dist/`（CommonJS 模块）
2. **esbuild** — 打包 `src/renderer/app.ts` → `dist/renderer/app.js`（browser bundle）
3. **复制静态资源** — `index.html`、`styles.css`、`config.default.json` → `dist/`

electron-builder 打包时：
- `dist/**/*` 进入 app.asar
- `tools/` 作为 `extraResources` 放在 `resources/tools/`（可执行脚本不能放在 asar 内）

---

## 配置说明

### 配置路径

| 场景 | 路径 |
|------|------|
| 运行时（用户数据） | `%APPDATA%\BlackBlade Hub\config.json` |
| 默认模板（内置） | `src/config.default.json` → 编译后 `dist/config.default.json` |

### 首次启动行为

1. 检查 `%APPDATA%\BlackBlade Hub\config.json` 是否存在
2. 不存在 → 从内置 `config.default.json` 复制一份到用户目录
3. 加载时合并：`DEFAULT_CONFIG ← config.default.json ← 用户 config.json`

### 配置字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `gameExe` | 文件路径 | 游戏可执行文件 |
| `editorExe` | 文件路径 | 编辑器可执行文件 |
| `tools` | `ToolEntry[]` | 自定义生产工具列表 `[{label, path}]` |
| `jenkins` | URL | Jenkins 访问地址 |
| `horde` | URL | Horde 访问地址 |
| `ugs` | URL 或路径 | UGS 入口 |
| `envScript` | 文件路径 | 环境配置脚本（.ps1 / .bat / .cmd） |
| `hordeAgentScript` | 文件路径 | HordeAgent 安装脚本（默认内置） |

---

## 扩展指南：添加新工具

Hub 的设计目标是持续为项目提供更多工具入口。添加一个新工具模块的典型步骤：

### 1. 定义 IPC 接口（如需后端逻辑）

在 `src/types/ipc.ts` 中添加返回类型，并在 `StudioHubAPI` 接口中声明新方法：

```typescript
// src/types/ipc.ts
export interface StudioHubAPI {
  // ... 现有方法
  myNewTool(): Promise<{ success: boolean; data?: string }>;
}
```

### 2. 实现主进程 Handler

创建 `src/main/ipc/my-new-tool.ts`：

```typescript
import { ipcMain } from 'electron';

export function registerMyNewToolHandlers(): void {
  ipcMain.handle('my-new-tool', async () => {
    // 实现逻辑
    return { success: true, data: 'hello' };
  });
}
```

在 `src/main/ipc/index.ts` 中注册：

```typescript
import { registerMyNewToolHandlers } from './my-new-tool';

export function registerAllHandlers(getMainWindow) {
  // ... 现有注册
  registerMyNewToolHandlers();
}
```

### 3. 更新 Preload

在 `src/preload/index.ts` 的 `api` 对象中添加方法：

```typescript
myNewTool: () => ipcRenderer.invoke('my-new-tool'),
```

### 4. 添加渲染进程模块

创建 `src/renderer/modules/my-new-tool.ts`：

```typescript
import { toast, setStatus } from '../utils';

export function initMyNewTool(): void {
  document.getElementById('card-my-tool')!.addEventListener('click', handleClick);
}

async function handleClick(): Promise<void> {
  const result = await window.studioHub.myNewTool();
  toast(result.success ? '成功' : '失败');
}
```

在 `src/renderer/app.ts` 中初始化：

```typescript
import { initMyNewTool } from './modules/my-new-tool';
// ... 在 DOMContentLoaded 回调中
initMyNewTool();
```

### 5. 添加 HTML 卡片

在 `src/renderer/index.html` 对应区域添加 UI 元素（Pipeline / Toolbox zone）。

### 6. 编译验证

```powershell
npm run dev
```

---

## 分发指南

### 绿色版（推荐内网分发）

1. `npm run pack`
2. `powershell -ExecutionPolicy Bypass -File make-zip.ps1`
3. 上传 `dist-package/` 产物至内网软件门户
4. 用户解压后直接运行 `BlackBlade Hub.exe`

### 预置配置（批量部署）

将统一的 `config.json` 复制到目标机器的 `%APPDATA%\BlackBlade Hub\config.json`，用户首次启动即拥有完整配置。

### 代码签名

```powershell
signtool sign /f cert.pfx /p PASSWORD /tr http://timestamp.example.com/tsa /td SHA256 /fd SHA256 "dist-package\win-unpacked\BlackBlade Hub.exe"
```

---

## 常见问题

**Q: 启动提示 "node 无法识别"？**
确保 Node.js 在系统 PATH 中。

**Q: 点击 Pipeline / Toolbox 卡片无反应？**
检查配置面板中对应路径是否已填写且文件存在。

**Q: 配置保存后不生效？**
配置写入 `%APPDATA%\BlackBlade Hub\config.json`，不是项目源码目录。

**Q: 修改默认 URL（Jenkins / Horde）？**
编辑 `src/config.default.json` 后重新 `npm run pack`。

**Q: tools/ 脚本在打包后无法执行？**
`tools/` 通过 `extraResources` 打包到 `resources/tools/`，不在 asar 内。`resolvePath()` 会在 `app.isPackaged` 时自动切换到 `process.resourcesPath`。

### Hub 自动更新

Hub 从 GitHub Release 检测稳定版本并下载 Windows 安装包。访问私有仓库时，在启动 Hub 前设置用户环境变量 `STUDIO_HUB_GITHUB_TOKEN`，使用仅有 Hub 仓库 Contents: Read 权限的个人令牌。设置后请彻底退出并重新启动 Hub。令牌不写入项目配置，也不随安装包分发。

旧版 Hub 仍使用内网更新地址，首次切换需要手动安装包含新更新器的版本。
