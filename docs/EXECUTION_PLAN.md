# Web 发布工具可落地执行文档

## 1. 目标与范围

### 1.1 项目目标
构建一款基于 Electron 的桌面发布工具，支持安装后选择角色：
- 发布端（Sender）：本地执行打包、压缩、发包、查看部署结果。
- 接收端（Receiver）：远程机常驻运行，接收 zip，解压并部署到 Cloudflare Pages。

### 1.2 成功标准
- 发布端可一键完成：构建 -> 打包 -> 上传 -> 触发部署 -> 查看部署 URL。
- 接收端可稳定执行部署任务并返回可追踪状态。
- 凭据安全（不明文泄露）、任务可审计（日志/状态可查询）。

### 1.3 非目标（第一期不做）
- 多云发布（仅 Cloudflare Pages）。
- 复杂审批流（仅基础 RBAC/单租户密钥）。
- 高可用集群（单接收端实例优先）。

## 2. 角色与运行模式

### 2.1 运行模式
首次安装启动时选择：
1. `Sender`：仅显示发布功能。
2. `Receiver`：仅显示接收服务状态与日志。
3. `Both`：本机同时启用两者（开发调试用途）。

### 2.2 角色职责
- Sender
  - 本地构建项目
  - 打包 `dist` 目录为 zip
  - 生成校验信息（SHA256）
  - 上传 zip 到 Receiver
  - 轮询任务状态并展示结果
- Receiver
  - 鉴权与限流
  - 校验 zip、解压到临时目录
  - 执行 `wrangler pages deploy`
  - 记录日志和审计信息
  - 清理临时文件

## 3. 总体架构

```text
[Electron Sender UI]
   -> [Sender Core]
      -> build command
      -> zip + sha256
      -> HTTPS POST /api/v1/deployments
             |
             v
       [Receiver API + Worker Queue]
             -> verify/signature
             -> unzip to /tmp/jobs/<id>
             -> wrangler pages deploy <dir>
             -> save logs/status
             -> callback/poll result
```

## 4. 技术选型（建议）

### 4.1 客户端
- Electron + TypeScript
- UI：React + Vite（或你熟悉的前端框架）
- 持久化：SQLite（better-sqlite3）
- 安全存储：
  - macOS Keychain
  - Windows Credential Manager
  - Linux Secret Service

### 4.2 接收端服务
- Node.js 20 LTS + TypeScript
- HTTP 框架：Fastify（性能好，插件化清晰）
- 队列：BullMQ + Redis（或首版内存队列，单实例可先简化）
- 压缩处理：`unzipper` 或系统 `unzip`
- 命令执行：`execa`

### 4.3 Cloudflare 交互
- 通过 `wrangler pages deploy` 上传解压目录。
- 凭据采用最小权限 API Token（Pages 部署所需权限）。

## 5. 配置设计

## 5.1 Sender 配置

```json
{
  "profileName": "my-site-prod",
  "projectPath": "/Users/me/work/web-app",
  "buildCommand": "npm run build",
  "buildOutputDir": "dist",
  "gitBranch": "main",
  "receiverBaseUrl": "https://deploy.example.com",
  "receiverToken": "***",
  "deploy": {
    "projectName": "my-pages-project",
    "branch": "main"
  },
  "zip": {
    "exclude": ["**/*.map"],
    "maxSizeMB": 500
  },
  "retry": {
    "maxAttempts": 2,
    "backoffMs": 3000
  }
}
```

### 5.2 Receiver 配置

```json
{
  "listenHost": "0.0.0.0",
  "listenPort": 17777,
  "auth": {
    "mode": "bearer",
    "token": "***"
  },
  "storage": {
    "jobRoot": "/opt/web-publisher/jobs",
    "logRoot": "/opt/web-publisher/logs",
    "retainDays": 14
  },
  "cloudflare": {
    "accountId": "***",
    "apiToken": "***",
    "wranglerBin": "wrangler"
  },
  "limits": {
    "maxUploadMB": 500,
    "concurrency": 1,
    "timeoutSec": 900
  },
  "network": {
    "allowedCidrs": ["10.0.0.0/8"]
  }
}
```

### 5.3 建议补充配置项
- Node/Wrangler 最低版本约束。
- 任务并发策略（按 project 串行锁）。
- 失败重试与人工回滚策略。
- Webhook 回调地址（可选）。

## 6. API 设计（Receiver）

### 6.1 `POST /api/v1/deployments`
用途：创建部署任务并上传 zip。

请求头：
- `Authorization: Bearer <token>`
- `X-Checksum-SHA256: <hex>`
- `X-Request-Id: <uuid>`

请求体（multipart/form-data）：
- `file`: zip 文件
- `metadata`: JSON 字符串

`metadata` 示例：
```json
{
  "projectName": "my-pages-project",
  "branch": "main",
  "commitSha": "abc123",
  "buildCommand": "npm run build",
  "buildAt": "2026-03-11T18:00:00+08:00"
}
```

响应：
```json
{
  "deploymentId": "dep_20260311_xxx",
  "status": "queued"
}
```

### 6.2 `GET /api/v1/deployments/:id`
用途：查询部署状态。

响应：
```json
{
  "deploymentId": "dep_20260311_xxx",
  "status": "running",
  "startedAt": "2026-03-11T18:01:00+08:00",
  "finishedAt": null,
  "url": null,
  "error": null
}
```

状态机：
- `queued` -> `running` -> `success`
- `queued` -> `running` -> `failed`
- `queued` -> `canceled`

### 6.3 `GET /api/v1/deployments/:id/logs`
用途：查看任务日志（分页/尾部）。

### 6.4 `GET /healthz`
用途：健康检查。

## 7. 安全方案

### 7.1 鉴权
- 第一版：Bearer Token。
- 第二版：HMAC（签名内容包含时间戳与请求体 hash，防重放）。

### 7.2 传输安全
- 必须启用 HTTPS（反向代理 Nginx/Caddy + TLS）。
- 限制来源 IP 或内网接入（VPN/Zero Trust）。

### 7.3 密钥安全
- Sender/Receiver 均不明文展示 token。
- Receiver 上 Cloudflare token 存系统安全存储或加密文件（最少 600 权限）。
- Token 最小权限、可轮换、可吊销。

### 7.4 执行安全
- 不接受任意 shell 命令透传。
- 仅允许白名单部署动作：`wrangler pages deploy`。
- 解压时校验路径，阻止 zip slip（`../`）。

## 8. 远程机部署要求

### 8.1 依赖
- Linux x86_64（Ubuntu 22.04+）
- Node.js 20+
- Wrangler 最新稳定版
- 可选：Redis（若用 BullMQ）

### 8.2 systemd 服务
建议两个服务：
- `web-publisher-receiver.service`
- `web-publisher-receiver-cleaner.timer`（清理旧任务）

### 8.3 目录结构
```text
/opt/web-publisher/
  config/
  jobs/
  logs/
  bin/
```

## 9. Sender 执行流程

1. 读取 profile 配置。
2. 检查 git 分支是否匹配（可配置“只警告/阻断”）。
3. 执行 build 命令。
4. 校验 `buildOutputDir` 存在且非空。
5. 压缩为 zip 并计算 SHA256。
6. 上传到 Receiver 并获取 `deploymentId`。
7. 轮询状态直到 success/failed。
8. 展示部署 URL、日志、耗时。

## 10. Receiver 执行流程

1. 鉴权通过后保存上传文件。
2. 校验大小/sha256。
3. 入队并返回 `queued`。
4. Worker 取任务，解压到隔离目录。
5. 执行部署命令：

```bash
CLOUDFLARE_API_TOKEN=*** CLOUDFLARE_ACCOUNT_ID=*** \
wrangler pages deploy /opt/web-publisher/jobs/<id>/dist \
  --project-name=<projectName> \
  --branch=<branch>
```

6. 解析命令输出提取 URL。
7. 更新状态并持久化日志。
8. 清理临时目录（保留失败现场可配置）。

## 11. 数据模型（最小）

### 11.1 deployments
- `id` (PK)
- `project_name`
- `branch`
- `commit_sha`
- `status`
- `artifact_path`
- `artifact_sha256`
- `result_url`
- `error_message`
- `created_at`
- `started_at`
- `finished_at`

### 11.2 deployment_logs
- `id`
- `deployment_id`
- `level`
- `message`
- `ts`

## 12. UI 页面清单

### 12.1 通用
- 启动向导（选择模式）
- 设置页（基础/安全/高级）

### 12.2 Sender 页面
- Profile 列表与编辑
- 发布控制台（执行、进度、日志）
- 历史记录（筛选、重试）

### 12.3 Receiver 页面
- 服务状态（端口、健康）
- 任务队列（运行中/历史）
- 凭据状态（是否配置，不显示明文）

## 13. 分阶段实施计划

### Phase 0（1-2 天）
- 初始化 mono-repo：`apps/sender`, `apps/receiver`, `packages/shared`
- 定义配置 schema、API DTO、状态机

### Phase 1（3-5 天）
- Sender：构建、打包、上传、轮询
- Receiver：上传接口、入队、执行 wrangler
- 最小可用链路打通（手工配置）

### Phase 2（3-4 天）
- 安全增强（TLS、签名、限流、IP 白名单）
- 任务历史与日志持久化
- 错误码标准化

### Phase 3（2-4 天）
- UI 完整化（向导、配置校验、历史）
- 安装包与系统服务脚本
- 文档与运维手册

总计预估：约 2-3 周（1-2 人）

## 14. 测试与验收

### 14.1 功能验收
- 正常路径：构建成功并返回 Pages URL。
- 异常路径：构建失败、上传超限、鉴权失败、部署超时。

### 14.2 安全验收
- 无 token 明文日志。
- 非法来源请求被拒绝。
- 重放请求被拒绝（启用 HMAC 后）。

### 14.3 性能验收
- 200MB zip 上传与部署全流程 < 10 分钟（按网络情况调整）。
- 并发 1 时任务顺序正确，无相互污染。

## 15. 风险与应对

- 风险：Wrangler 版本变动影响输出解析。
  - 应对：固定版本，输出解析加回退逻辑。
- 风险：部署凭据泄露。
  - 应对：最小权限 + 定期轮换 + 审计日志。
- 风险：大包上传超时。
  - 应对：分片上传（后续）、Nginx 超时调优、断点续传预研。

## 16. MVP 明确交付物

1. Sender 可配置 1 个 profile 并完成一键发布。
2. Receiver 可接收 zip 并部署到指定 Pages 项目。
3. 可看到任务状态、日志、部署 URL。
4. 提供安装说明与基本排障文档。

## 17. 下一步建议（立即执行）

1. 按本文档先落 `Phase 0` 的仓库结构与共享 schema。
2. 先实现不依赖 Redis 的单进程队列版本，降低复杂度。
3. 先打通一条真实 Cloudflare Pages 项目链路，再补全 UI。

