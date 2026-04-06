# 包构建检测与下载

本文档描述 Studio Hub 从 MinIO 检测游戏包构建并将其安装到本地的完整流程，包括各模块的职责、数据结构、关键设计决策及已知限制。

---

## 目录

1. [整体架构](#整体架构)
2. [数据结构](#数据结构)
3. [构建检测流程](#构建检测流程)
4. [安装与下载流程](#安装与下载流程)
5. [状态管理](#状态管理)
6. [IPC 接口](#ipc-接口)
7. [MinIO 存储布局约定](#minio-存储布局约定)
8. [关键设计决策](#关键设计决策)
9. [已知限制](#已知限制)

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
            └─► mc-downloader.ts  ← 实际文件下载（mc.exe CLI）
```

主进程中所有 MinIO 交互均在 `src/main/services/` 下完成，渲染进程通过 IPC 调用，不直接访问 MinIO。

---

## 数据结构

### `BuildInfo`（`src/types/launcher.ts`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `string` | 语义版本号，如 `"1.2.0"` |
| `buildNumber` | `string` | CL 号，如 `"CL12345"`；无则为空字符串 |
| `variant` | `GameVariant` | `"Shipping"` / `"Development"` / `"Testing"` |
| `objectKey` | `string` | MinIO 对象键前缀（目录构建）或 zip 对象键 |
| `size` | `number` | 字节数；目录构建时固定为 `0`（未知） |
| `timestamp` | `string` | ISO 8601；来自目录构建的第一个文件的 `lastModified` |
| `exeRelativePath` | `string` | 相对于安装目录的 `.exe` 路径；为空则自动检测 |
| `isDirectory` | `boolean?` | `true` 表示目录形式构建，`false`/`undefined` 表示 zip |

### `LauncherManifest`

```typescript
interface LauncherManifest {
  game: string;
  platform: string;   // 固定 "Win64"
  builds: BuildInfo[];
}
```

### `InstalledBuild`

记录已安装构建的持久化数据，存储在 `%APPDATA%/BlackBlade Hub/launcher-state.json`。

| 字段 | 类型 | 说明 |
|------|------|------|
| `installDir` | `string` | 本地安装目录绝对路径 |
| `exePath` | `string` | 游戏可执行文件绝对路径 |
| `installedAt` | `string` | 安装时间 ISO 8601 |
| `version` / `buildNumber` / `variant` | — | 同 `BuildInfo` |

---

## 构建检测流程

入口：`minio-client.ts` → `getBuilds(config, prefix, exeRelativePath)`

```
getBuilds
  ├─► fetchManifest()    尝试读取 {prefix}/launcher-manifest.json
  │       成功 → 直接返回 manifest（CI 预发布时使用）
  │
  └─► discoverBuilds()   manifest 不存在或无构建时自动发现
```

### `discoverBuilds` — 两级非递归前缀列表

```
prefix/
  Shipping/              ← Level 1：Variant 前缀
    v1.2.0-CL12345/      ← Level 2：Version 前缀
      ...files...
    v1.1.0/
      ...files...
  Development/
    v1.2.0-CL12345/
      ...files...
```

**步骤：**

1. **Level 1**：`listPrefixes(prefix)` → 获取所有 variant 目录（`Shipping/`、`Development/`、`Testing/`）
2. **Level 2**：对每个已知 variant，`listPrefixes(variantPrefix)` → 获取所有版本目录
3. **Timestamp 探测**：对每个版本前缀调用 `probeTimestamp()`，获取该前缀下第一个文件的 `lastModified`

**版本标签解析：**

`parseVersionLabel("v1.2.0-CL12345")` → `{ version: "1.2.0", buildNumber: "CL12345" }`

#### 为何使用非递归列表

MinIO JS SDK 使用 `fast-xml-parser` 解析 S3 XML 响应。当递归列出包含 500+ 文件的构建时，每个文件的 ETag 中含有 `&quot;` 实体，导致累计实体展开次数超过 `fast-xml-parser` 的默认上限（1000），抛出 `Entity expansion limit exceeded` 错误。

非递归列表（`listObjects(..., false)`）返回的是 `CommonPrefixes`，其响应中不含 ETag，因此不会触发实体展开限制。

---

## 安装与下载流程

入口：`game-manager.ts` → `installBuild(build, minioConfig, launcherConfig, win)`

```
installBuild
  ├─► [isDirectory=true]  installDirectoryBuild()
  │       └─► mcMirror()   通过 mc.exe CLI 镜像整个前缀
  │
  └─► [isDirectory=false] installZipBuild()
          └─► minio.getObjectStream() + extract-zip
```

### 目录构建安装：`mcMirror`（`mc-downloader.ts`）

目录形式构建通过 `mc mirror` 命令下载，完全绕过 MinIO JS SDK 的 XML 解析。

**步骤：**

1. 定位 `mc.exe`：优先使用 `tools/mc.exe`，否则回退到系统 PATH
2. 通过环境变量 `MC_HOST_bb` 注入认证信息（不写入 mc 配置文件）：
   ```
   MC_HOST_bb=http://<accessKey>:<secretKey>@<host>
   ```
3. 构造远端路径：
   ```
   bb/<bucket>/<normalizedPrefix>/
   ```
   其中 `normalizedPrefix` 去掉末尾多余斜杠后补一个斜杠，确保 `mc` 镜像的是**目录内容**而非桶根
4. 在下载前清空并重建本地目录
5. 执行：`mc mirror --overwrite --json --no-color <remotePath> <localDir>`
6. 逐行解析 JSON 输出，统计 `transferredCount`、`errorCount`、`transferredBytes`
7. 将进度通过 IPC 推送到渲染进程

**成功/失败判定：**

`mc mirror` 在部分文件失败时仍会以退出码 `0` 退出。判断逻辑如下：

| 条件 | 结果 |
|------|------|
| `exitCode == 0` 且 `errorCount == 0` | 成功 |
| `exitCode == 0` 且 `errorCount > 0` 但 `transferredCount > 0` | 警告后成功（部分文件失败但有文件下载） |
| `exitCode != 0` 或 `(errorCount > 0 且 transferredCount == 0)` | 失败，清理本地目录 |

**安装后校验：**

`installBuild` 在 `mcMirror` 返回后额外检查：

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

若有条目被清理，状态文件立即持久化。这确保手动删除安装目录后 UI 能正确反映未安装状态。

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

安装进度通过 `launcher-progress` 事件推送（非 handle 请求/响应模式）：

```typescript
// 主进程推送
win.webContents.send('launcher-progress', progress: DownloadProgress);

// 渲染进程监听
ipcRenderer.on('launcher-progress', (_event, progress) => { ... });
```

---

## MinIO 存储布局约定

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

- Variant 名称必须为 `Shipping`、`Development`、`Testing` 之一（大小写敏感）
- 版本标签格式：`v{major}.{minor}.{patch}[-CL{changeList}]`，如 `v1.2.0-CL99999`

---

## 关键设计决策

### 1. 非递归列表替代递归列表

**问题**：递归列出含 500+ 文件的构建前缀时，MinIO JS SDK 使用 `fast-xml-parser` 解析 XML，大量 ETag 中的 `&quot;` 实体导致实体展开计数超过 1000，抛出异常。

**解决方案**：`discoverBuilds` 只进行两级非递归前缀列表（获取 `CommonPrefixes`），不返回具体文件的 ETag，彻底规避该限制。

### 2. 用 `mc.exe` CLI 下载替代 JS SDK 流式下载

**问题**：即使修复了发现阶段的问题，安装阶段若使用 `listAllObjects`（递归）仍会触发同样的实体展开错误。

**解决方案**：安装阶段完全使用 `mc mirror` 命令，该工具有自己的 HTTP 客户端和 XML 解析，与 JS SDK 完全隔离，并内置断点续传、并发控制和重试逻辑。

### 3. 通过环境变量注入 mc 认证信息

`mc alias set` 会将凭证写入用户配置文件，可能与已有 `mc` 配置冲突。通过 `MC_HOST_<alias>` 环境变量注入是 mc 官方支持的无状态认证方式，不产生副作用。

### 4. `mc mirror` 退出码不可靠

`mc mirror` 在部分文件失败时仍以 `0` 退出。因此不能单独依靠退出码判断成功，需要同时分析 JSON 输出中的 `errorCount` 和 `transferredCount`。

---

## 已知限制

| 限制 | 原因 | 影响 |
|------|------|------|
| `BuildInfo.size` 始终为 `0` | 非递归列表不返回文件总大小 | UI 显示 "—" 而非具体大小 |
| Timestamp 仅为近似值 | 来自前缀下第一个文件的 `lastModified`，非构建完成时间 | 排序基本准确，但不是精确的构建时间 |
| 仅支持 Windows（`mc.exe`） | `mc-downloader.ts` 的 `findMcBinary` 只寻找 `mc.exe` | macOS/Linux 需扩展 `findMcBinary` 逻辑 |
| 安装并发：每次只能安装一个 variant | 无安装锁，多次并发安装可能互相覆盖目录 | 当前 UI 不支持并发安装，实际影响较小 |
