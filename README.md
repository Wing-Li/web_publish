# Web Publish Tool

一个基于 Electron 的桌面发布工具，用来把本地前端构建产物上传到远程接收端，并由接收端自动部署到 Cloudflare Pages。

项目支持三种运行模式：

- `Sender`：本地构建、打包、上传、轮询部署结果
- `Receiver`：常驻接收 zip 包，解压并执行部署
- `Both`：同机同时启用发送端与接收端，适合本地开发调试

## 功能概览

- 管理多个待发布项目
- 本地执行构建命令并校验产物目录
- 将构建产物压缩为 zip 后上传到接收端
- 接收端按任务状态展示部署进度、日志和结果 URL
- 使用 Bearer Token 对 Sender/Receiver 通信做基础鉴权
- 接收端对接 `wrangler pages deploy` 完成 Cloudflare Pages 部署

## 项目结构

```text
.
├── desktop/              # Electron 主应用
│   ├── src/
│   │   ├── services/     # 发送/接收核心逻辑
│   │   ├── ui/           # 界面模板与组件
│   │   ├── shared/       # 共享类型与工具
│   │   ├── main.ts       # Electron main 进程入口
│   │   ├── preload.ts    # 预加载脚本
│   │   └── renderer.ts   # 渲染层入口
│   └── package.json
├── docs/
│   └── EXECUTION_PLAN.md # 设计与执行方案
└── README.md
```

## 运行环境

- Node.js 20+
- npm 或 pnpm
- macOS / Windows / Linux
- 接收端部署 Cloudflare Pages 时需要可用的 `wrangler`

## 本地开发

进入 Electron 子项目安装依赖并启动：

```bash
cd desktop
npm install
npm start
```

常用命令：

```bash
cd desktop
npm run lint
npm run package
npm run make
```

## 基本使用流程

### 发送端

1. 添加本地项目路径
2. 配置构建命令与构建产物目录
3. 配置接收端地址与鉴权 Token
4. 配置 Cloudflare Pages 项目名和分支
5. 执行打包或直接部署

### 接收端

1. 配置监听地址、端口和鉴权 Token
2. 配置 Cloudflare `API Token`、`Account ID`、`wrangler` 路径
3. 启动接收服务
4. 通过任务列表查看部署状态、日志和结果

## 配置说明

应用会将运行配置保存到 Electron `userData` 目录下的 `config.json`，不在仓库内。

默认配置包括：

- 接收端默认地址：`http://127.0.0.1:17777`
- 默认鉴权占位值：`change-me`
- 默认工作模式：`sender`

公开仓库前请不要提交任何实际 Token、账号、私钥或本地配置文件。

## 安全说明

- 当前仓库中的敏感字段示例均为占位值，不应替换为真实凭证后再提交
- 建议仅为 Cloudflare 创建最小权限 API Token
- 如果需要公网访问接收端，建议配合 HTTPS、Cloudflare Tunnel 或内网/VPN 使用
- 请确保 `.env`、本地产物、缓存文件和个人配置均被 `.gitignore` 排除

## 设计文档

更完整的架构、流程和安全策略见：

- [docs/EXECUTION_PLAN.md](/Users/yyyl/yyy/project/ai/web_publish/docs/EXECUTION_PLAN.md)

## 当前状态

这是一个以 Electron 为核心的桌面发布工具原型，重点覆盖从本地构建到 Cloudflare Pages 部署的完整链路。
