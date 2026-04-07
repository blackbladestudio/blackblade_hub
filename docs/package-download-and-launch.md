# 包体下载与运行

本文档描述 Studio Hub 中包体（游戏构建）下载、安装与运行的完整实现。

---

## 目录

1. [整体架构](#整体架构)
2. [核心模块](#核心模块)
3. [数据结构](#数据结构)
4. [构建发现流程](#构建发现流程)
5. [安装与下载流程](#安装与下载流程)
6. [游戏启动流程](#游戏启动流程)
7. [状态管理](#状态管理)
8. [IPC 接口](#ipc-接口)
9. [MinIO 存储布局](#minio-存储布局)

---

## 整体架构

```
Renderer (UI)
    │  IPC (ipcRenderer.invoke)
    ▼
ipc/launcher.ts           ← IPC handler 注册
    │
    ├─► minio-client.ts   ← 构建检测（MinIO JS SDK，仅读取前缀/manifest）
    │
    └─► game-manager.ts   ← 安装、卸载、启动管理
            │
            └─► mc-downloader.ts  ← 目录形式构建下载（mc.exe CLI）
```

主进程中所有 MinIO 交互均在 `src/main/services/` 下完成，渲染进程通过 IPC 调用，不直接访问 MinIO。

---

## 核心模块

### 1. minio-client.ts

负责与 MinIO 服务器通信，执行构建发现和对象流读取。

**主要功能：**

| 函数 | 功能 |
|------|------|
| `ensureClient()` | 创建/复用 MinIO 客户端单例 |
| `testConnection()` | 测试 MinIO 连通性 |
| `listPrefixes()` | 非递归列出前缀（用于发现构建） |
| `discoverBuilds()` | 两级非递归前缀列表发现构建 |
| `fetchManifest()` | 获取 launcher-manifest.json |
| `getBuilds()` | 优先读 manifest，否则走发现流程 |
| `getObjectStream()` | 获取对象读取流（用于 zip 下载） |

### 2. mc-downloader.ts

负责通过 `mc.exe` CLI 工具下载目录形式的构建。

**主要功能：**

| 函数 | 功能 |
|------|------|
| `findMcBinary()` | 查找 mc.exe 位置（优先 tools/，回退 PATH） |
| `mcMirror()` | 使用 `mc mirror` 下载整个目录前缀 |

### 3. game-manager.ts

负责游戏的安装、卸载、启动和状态管理。

**主要功能：**

| 函数 | 功能 |
|------|------|
| `loadState()` | 加载本地安装状态 |
| `saveState()` | 保存安装状态到文件 |
| `installBuild()` | 安装构建入口（自动选择目录/zip方式） |
| `installDirectoryBuild()` | 目录形式构建安装 |
| `installZipBuild()` | zip 形式构建安装 |
| `findExeInDirectory()` | 自动检测 .exe 可执行文件 |
| `uninstallBuild()` | 卸载构建 |
| `launchBuild()` | 启动已安装构建 |

---

## 数据结构

### BuildInfo

```typescript
interface BuildInfo {
  version: string;           // 语义版本号，如 "1.2.0"
  buildNumber: string;       // CL 号，如 "CL12345"
  variant: GameVariant;      // 'Shipping' | 'Development' | 'Testing'
  objectKey: string;         // zip: 对象键 | directory: 前缀路径
  size: number;              // 包体大小
  timestamp: string;          // ISO 时间戳
  exeRelativePath: string;   // exe 相对路径
  isDirectory?: boolean;     // true = 目录形式，false = zip 形式
}
```

### InstalledBuild

```typescript
interface InstalledBuild {
  version: string;
  buildNumber: string;
  variant: GameVariant;
  installedAt: string;       // ISO 时间戳
  exePath: string;           // 完整 exe 路径
  installDir: string;        // 安装目录
  size: number;
}
```

### DownloadProgress

```typescript
interface DownloadProgress {
  variant: GameVariant;
  phase: 'downloading' | 'extracting' | 'done' | 'error';
  percent: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speed?: number;
  message?: string;
}
```

---

## 构建发现流程

### 发现策略

有两种发现构建的方式，优先使用 manifest 方式：

```
getBuilds()
    │
    ├─► fetchManifest()      ← 尝试获取 launcher-manifest.json
    │       │
    │       └─► 成功且有 builds → 返回
    │
    └─► discoverBuilds()     ← manifest 不存在时自动发现
            │
            ├─► Level 1: listPrefixes()  获取 Variant 前缀
            │       例: "bb/ProjectZion/Win64/Shipping/"
            │
            └─► Level 2: listPrefixes()  获取 Version 前缀
                    例: "bb/ProjectZion/Win64/Shipping/v1.2.0-CL12345/"
```

### 两级非递归列表设计

**问题：** 递归列出含 500+ 文件的构建前缀时，MinIO JS SDK 使用 `fast-xml-parser` 解析 XML，大量 ETag 中的 `"` 实体导致实体展开计数超过 1000，抛出异常。

**解决方案：** 只进行两级非递归前缀列表（获取 `CommonPrefixes`），不返回具体文件的 ETag，彻底规避该限制。

---

## 安装与下载流程

### 流程图

```
installBuild()
    │
    ├─► [isDirectory=true]  installDirectoryBuild()
    │       └─► mcMirror()   通过 mc.exe CLI 镜像整个前缀
    │
    └─► [isDirectory=false] installZipBuild()
            └─► minio.getObjectStream() + extract-zip
```

### 目录构建安装：`mcMirror`

目录形式构建通过 `mc mirror` 命令下载，完全绕过 MinIO JS SDK 的 XML 解析。

**步骤：**

1. 定位 `mc.exe`：优先使用 `tools/mc.exe`，否则回退到系统 PATH
2. 通过环境变量 `MC_HOST_bb` 注入认证信息：
   ```
   MC_HOST_bb=http://<accessKey>:<secretKey>@<host>
   ```
3. 构造远端路径：
   ```
   bb/<bucket>/<normalizedPrefix>/
   ```
4. 在下载前清空并重建本地目录
5. 执行：`mc mirror --overwrite --json --no-color <remotePath> <localDir>`
6. 逐行解析 JSON 输出，统计 `transferredCount`、`errorCount`、`transferredBytes`
7. 将进度通过 IPC 推送到渲染进程

**成功/失败判定：**

| 条件 | 结果 |
|------|------|
| `exitCode == 0` 且 `errorCount == 0` | 成功 |
| `exitCode == 0` 且 `errorCount > 0` 但 `transferredCount > 0` | 警告后成功 |
| `exitCode != 0` 或 `errorCount > 0 且 transferredCount == 0` | 失败，清理本地目录 |

### ZIP 构建安装：`installZipBuild`

1. 通过 `minio.getObjectStream()` 获取对象读取流
2. 流式写入临时 zip 文件，实时计算下载进度
3. 下载完成后解压到安装目录
4. 清理临时 zip 文件

**安装后校验：**

```typescript
const installedFiles = fs.readdirSync(installDir);
if (installedFiles.length === 0) {
  throw new Error('安装目录为空，下载可能未完成或出错');
}
```

### 可执行文件检测

`exeRelativePath` 非空时直接拼接；为空时 `findExeInDirectory()` 递归扫描安装目录：

- 优先选择路径中含 `Binaries` 的 `.exe`（Unreal Engine 约定）
- 否则选择文件体积最大的 `.exe`

---

## 游戏启动流程

```typescript
function launchBuild(variant: GameVariant): void {
  const state = loadState();
  const installed = state.installed[variant];

  // 验证安装状态
  if (!installed) throw new Error('游戏未安装');
  if (!fs.existsSync(installed.installDir)) throw new Error('安装目录不存在');
  if (!fs.existsSync(installed.exePath)) throw new Error('可执行文件不存在');

  // 启动游戏进程
  const child = spawn(installed.exePath, [], {
    cwd: path.dirname(installed.exePath),
    detached: true,    // 脱离父进程
    stdio: 'ignore',   // 忽略标准 IO
    shell: false,
  });
  child.unref();       // 父进程不等待子进程退出
}
```

---

## 状态管理

状态文件路径：`%APPDATA%/BlackBlade Hub/launcher-state.json`

```json
{
  "installBaseDir": "D:/Games",
  "installed": {
    "Shipping": {
      "version": "1.2.0",
      "buildNumber": "CL12345",
      "variant": "Shipping",
      "installedAt": "2026-04-06T10:00:00.000Z",
      "exePath": "D:/Games/Shipping/Game/Binaries/Win64/Game.exe",
      "installDir": "D:/Games/Shipping",
      "size": 0
    }
  }
}
```

### 陈旧记录清理

`loadState()` 在每次读取时校验每个已安装条目的 `installDir` 是否实际存在于磁盘：

```typescript
if (entry && !fs.existsSync(entry.installDir)) {
  delete state.installed[variant];
  dirty = true;
}
```

若有条目被清理，状态文件立即持久化。

---

## IPC 接口

所有接口在 `src/main/ipc/launcher.ts` 中注册，通过 `ipcMain.handle` 暴露。

| Channel | 参数 | 返回 | 说明 |
|---------|------|------|------|
| `launcher:test-connection` | — | `{ success, error? }` | 测试 MinIO 连通性 |
| `launcher:get-manifest` | — | `{ data: LauncherManifest \| null, error? }` | 获取/发现构建列表 |
| `launcher:get-state` | — | `LauncherState` | 获取本地安装状态 |
| `launcher:install` | `variant: GameVariant` | `{ success, error? }` | 安装最新构建 |
| `launcher:launch` | `variant: GameVariant` | `{ success, error? }` | 启动已安装构建 |
| `launcher:uninstall` | `variant: GameVariant` | `{ success, error? }` | 卸载构建 |
| `launcher:select-install-dir` | — | `string \| null` | 打开目录选择对话框 |

### 进度推送

安装进度通过 `launcher-progress` 事件推送（非 handle 请求/响应模式）：

```typescript
// 主进程推送
win.webContents.send('launcher-progress', progress: DownloadProgress);

// 渲染进程监听
ipcRenderer.on('launcher-progress', (_event, progress) => { ... });
```

---

## MinIO 存储布局

### 标准布局

```
<bucket>/
  <prefix>/                     ← LauncherConfig.prefix，如 "ProjectZion/Win64"
    launcher-manifest.json      ← 可选，CI 生成；存在时优先使用
    Shipping/
      v1.2.0-CL12345/
        Game/
          Binaries/
            Win64/
              Game.exe
          Content/
            ...
    Development/
      v1.2.0-CL12345/
        ...
    Testing/
      v1.2.0-CL12345/
        ...
```

### 版本标签格式

版本标签格式：`v{major}.{minor}.{patch}[-CL{changeList}]`

示例：`v1.2.0-CL99999`

### Variant 名称

必须为 `Shipping`、`Development`、`Testing` 之一（大小写敏感）。

---

## 关键设计决策

### 1. 非递归列表替代递归列表

**问题：** 递归列出含 500+ 文件的构建前缀时，MinIO JS SDK 使用 `fast-xml-parser` 解析 XML，大量 ETag 中的 `"` 实体导致实体展开计数超过 1000，抛出异常。

**解决方案：** `discoverBuilds` 只进行两级非递归前缀列表（获取 `CommonPrefixes`），不返回具体文件的 ETag，彻底规避该限制。

### 2. 用 `mc.exe` CLI 下载替代 JS SDK 流式下载

**问题：** 即使修复了发现阶段的问题，安装阶段若使用 `listAllObjects`（递归）仍会触发同样的实体展开错误。

**解决方案：** 安装阶段完全使用 `mc mirror` 命令，该工具有自己的 HTTP 客户端和 XML 解析，与 JS SDK 完全隔离，并内置断点续传、并发控制和重试逻辑。
