import './index.css';
import {
  AppConfig,
  AppMode,
  BatchBuildAndDeployResult,
  BatchBuildLocalResult,
  DeploymentTask,
  ReceiverRuntimeStatus,
  SenderProject,
} from './shared/types';
import type { DesktopApi } from './preload';

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

// ─── 类型 ───────────────────────────────────────────────────────────────────

interface BranchRuntime {
  branches: string[];
  current: string;
  error?: string;
}

type StepStatus = 'pending' | 'running' | 'done' | 'failed';

interface DeployStep {
  id: string;
  label: string;
  status: StepStatus;
}

// ─── 全局状态 ────────────────────────────────────────────────────────────────

let config: AppConfig;
const branchRuntimeMap = new Map<string, BranchRuntime>();
const recentDeploymentMap = new Map<string, string>();       // projectId → deploymentId
const localBuildArtifactMap = new Map<string, string>();     // projectId → zipPath
const projectDeployStepsMap = new Map<string, DeployStep[]>(); // projectId → steps
const projectBusyMap = new Map<string, boolean>();           // projectId → busy

let pollTimer: ReturnType<typeof setInterval> | null = null;
let receiverPollTimer: ReturnType<typeof setInterval> | null = null;

// projectId → 日志文本（含历史，上限 50KB）
const projectLogMap = new Map<string, string>();
const LOG_MAX_BYTES = 50 * 1024;

// ─── 工具函数 ────────────────────────────────────────────────────────────────

const esc = (v: string): string =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
   .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const getVal = (id: string): string => ($<HTMLInputElement>(id)?.value ?? '').trim();
const setVal = (id: string, v: string | number): void => {
  const el = $<HTMLInputElement>(id);
  if (el) el.value = String(v);
};
const getSelectVal = (id: string): string => ($<HTMLSelectElement>(id)?.value ?? '').trim();

const projectInputId = (pid: string, field: keyof SenderProject): string =>
  `p__${pid}__${field}`;
const projectBranchSelectId = (pid: string): string => `p__${pid}__branchSel`;

const newProjectTemplate = (): SenderProject => ({
  id: `project_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
  name: '新项目',
  projectPath: '',
  buildCommand: 'npm run build',
  buildOutputDir: 'dist',
  artifactOutputDir: '',
  gitBranch: 'main',
  receiverBaseUrl: 'http://127.0.0.1:17777',
  receiverToken: 'change-me',
  pagesProjectName: '',
  deployBranch: 'main',
});

const makeSteps = (): DeployStep[] => [
  { id: 'build',  label: '构建',     status: 'pending' },
  { id: 'zip',    label: '压缩',     status: 'pending' },
  { id: 'upload', label: '上传',     status: 'pending' },
  { id: 'deploy', label: '远端部署', status: 'pending' },
  { id: 'done',   label: '完成',     status: 'pending' },
];

// ─── Toast ───────────────────────────────────────────────────────────────────

const toastWrap = document.createElement('div');
toastWrap.className = 'fixed top-4 right-4 flex flex-col gap-2 z-50';
document.body.appendChild(toastWrap);

const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'info'): void => {
  const colors = {
    success: 'bg-emerald-700',
    error:   'bg-rose-700',
    info:    'bg-slate-700',
  };
  const icons = { success: '✓', error: '✕', info: 'ℹ' };

  const el = document.createElement('div');
  el.className = `toast-enter flex items-start gap-2 min-w-56 max-w-sm px-3.5 py-2.5 rounded-xl
                  text-white text-sm shadow-lg ${colors[kind]}`;
  el.innerHTML = `<span class="mt-0.5 shrink-0 font-bold">${icons[kind]}</span>
                  <span class="break-words">${esc(msg)}</span>`;
  toastWrap.appendChild(el);

  setTimeout(() => {
    el.classList.remove('toast-enter');
    el.classList.add('toast-leave');
    setTimeout(() => el.remove(), 200);
  }, 3000);
};

// ─── 主体 HTML ───────────────────────────────────────────────────────────────

document.body.innerHTML += `
<main id="app" class="max-w-5xl mx-auto px-5 py-6 flex flex-col gap-4 fade-up">

  <!-- 标题栏 -->
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-slate-800 tracking-tight">网页发布工具</h1>
      <p class="text-sm text-slate-500 mt-0.5">本地构建 → 压缩 → 上传 → Cloudflare Pages 自动部署</p>
    </div>
    <span id="configPathTip" class="text-xs text-slate-400 max-w-xs truncate text-right"></span>
  </header>

  <!-- 运行模式 -->
  <section class="card">
    <h2 class="text-sm font-semibold text-slate-700 mb-3">运行模式</h2>
    <div class="flex gap-6">
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="radio" name="mode" value="sender" class="accent-teal-600" />
        <span class="text-sm font-medium">发送端</span>
        <span class="text-xs text-slate-400">（本地打包 → 上传）</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="radio" name="mode" value="receiver" class="accent-teal-600" />
        <span class="text-sm font-medium">接收端</span>
        <span class="text-xs text-slate-400">（远程机接收部署）</span>
      </label>
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="radio" name="mode" value="both" class="accent-teal-600" />
        <span class="text-sm font-medium">双模式</span>
        <span class="text-xs text-slate-400">（本机调试用）</span>
      </label>
    </div>
  </section>

  <!-- 发送端：项目列表 -->
  <section id="senderSection" class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold text-slate-700">项目列表</h2>
      <button id="addProjectBtn" class="btn-ghost btn-sm">＋ 新增项目</button>
    </div>
    <div id="projectsWrap" class="flex flex-col gap-3"></div>
    <div class="card flex flex-wrap gap-3">
      <button id="buildAllBtn" class="btn-ghost btn-sm">批量本地打包</button>
      <button id="deployAllBtn" class="btn-primary btn-sm">一键发布全部项目</button>
    </div>
  </section>

  <!-- 接收端配置 -->
  <section id="receiverSection" class="card">
    <h2 class="text-sm font-semibold text-slate-700 mb-4">接收端配置</h2>
    <div class="grid grid-cols-2 gap-x-6 gap-y-3">
      <div><label class="form-label">监听地址</label><input id="receiverHost" class="form-input" /></div>
      <div><label class="form-label">监听端口</label><input id="receiverPort" type="number" class="form-input" /></div>
      <div><label class="form-label">鉴权 Token</label><input id="authToken" type="password" class="form-input" /></div>
      <div><label class="form-label">最大上传（MB）</label><input id="maxUploadMb" type="number" class="form-input" /></div>
      <div><label class="form-label">工作目录名（位于用户主目录）</label><input id="workRootName" class="form-input" /></div>
      <div><label class="form-label">Wrangler 命令</label><input id="wranglerBin" class="form-input" /></div>
      <div><label class="form-label">Cloudflare API Token</label><input id="cfToken" type="password" class="form-input" /></div>
      <div><label class="form-label">Cloudflare Account ID</label><input id="cfAccountId" class="form-input" /></div>
    </div>

    <!-- 接收服务控制 -->
    <div class="mt-4 flex items-center gap-3">
      <span id="receiverStatusDot" class="w-2.5 h-2.5 rounded-full bg-slate-300 shrink-0"></span>
      <span id="receiverStatusText" class="text-sm text-slate-500">服务未启动</span>
      <button id="startReceiverBtn" class="btn-primary btn-sm ml-auto">启动服务</button>
      <button id="stopReceiverBtn" class="btn-ghost btn-sm">停止服务</button>
    </div>
  </section>

  <!-- 接收端任务列表（receiver/both 模式） -->
  <section id="receiverTasksSection" class="card hidden">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold text-slate-700">部署任务记录</h2>
      <span class="text-xs text-slate-400">每次启动后清空，重启应用后重置</span>
    </div>
    <div id="receiverTasksWrap" class="flex flex-col gap-2 text-sm text-slate-500 italic">暂无任务</div>
  </section>

  <!-- 保存按钮 -->
  <div class="flex justify-end">
    <button id="saveBtn" class="btn-primary px-6">保存全部配置</button>
  </div>

</main>
`;

// ─── DOM 引用 ─────────────────────────────────────────────────────────────────

const senderSection   = $<HTMLElement>('senderSection');
const receiverSection = $<HTMLElement>('receiverSection');
const receiverTasksSection = $<HTMLElement>('receiverTasksSection');
const projectsWrap    = $<HTMLDivElement>('projectsWrap');

// ─── 模式显示控制 ─────────────────────────────────────────────────────────────

const getModeRadio = (): AppMode => {
  const v = (Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'))
    .find(r => r.checked))?.value;
  return (v === 'receiver' || v === 'both') ? v : 'sender';
};

const setModeRadio = (mode: AppMode): void => {
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(r => {
    r.checked = r.value === mode;
  });
};

const applyModeVisibility = (mode: AppMode): void => {
  const showSender   = mode === 'sender'   || mode === 'both';
  const showReceiver = mode === 'receiver' || mode === 'both';
  senderSection.classList.toggle('hidden', !showSender);
  receiverSection.classList.toggle('hidden', !showReceiver);
  receiverTasksSection.classList.toggle('hidden', !showReceiver);
};

// ─── 接收端状态指示 ──────────────────────────────────────────────────────────

const updateReceiverStatusUI = (status: ReceiverRuntimeStatus): void => {
  const dot  = $<HTMLSpanElement>('receiverStatusDot');
  const text = $<HTMLSpanElement>('receiverStatusText');
  if (status.running) {
    dot.className  = 'w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0';
    text.textContent = `运行中 — 监听 ${status.host}:${status.port}`;
    text.className = 'text-sm text-emerald-700';
  } else {
    dot.className  = 'w-2.5 h-2.5 rounded-full bg-slate-300 shrink-0';
    text.textContent = '服务未启动';
    text.className = 'text-sm text-slate-500';
  }
};

// ─── 接收端任务列表 ───────────────────────────────────────────────────────────

const statusBadge = (status: string): string => {
  const map: Record<string, string> = {
    queued:  '等待中',
    running: '部署中',
    success: '成功',
    failed:  '失败',
  };
  return `<span class="badge-${status}">${map[status] ?? status}</span>`;
};

const renderReceiverTasks = (tasks: DeploymentTask[]): void => {
  const wrap = $<HTMLDivElement>('receiverTasksWrap');
  if (tasks.length === 0) {
    wrap.innerHTML = '<p class="text-sm text-slate-400 italic">暂无任务</p>';
    return;
  }
  wrap.innerHTML = tasks.map(t => `
    <div class="flex flex-col gap-1 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
      <div class="flex items-center gap-3 flex-wrap">
        ${statusBadge(t.status)}
        <span class="font-medium text-slate-700">${esc(t.projectName)}</span>
        <span class="text-xs text-slate-400">分支: ${esc(t.branch)}</span>
        <span class="text-xs text-slate-300 ml-auto">${t.createdAt.slice(0, 19).replace('T', ' ')}</span>
      </div>
      ${t.url ? `<a href="${esc(t.url)}" class="text-xs text-teal-600 hover:underline break-all" title="点击复制"
                    onclick="navigator.clipboard.writeText('${esc(t.url)}');event.preventDefault();">
                  🔗 ${esc(t.url)}
                 </a>` : ''}
      ${t.error ? `<p class="text-xs text-rose-600 break-all">${esc(t.error.slice(0, 300))}</p>` : ''}
    </div>
  `).join('');
};

// ─── 部署进度步骤 ─────────────────────────────────────────────────────────────

const stepIcon = (status: StepStatus): string => {
  if (status === 'done')    return '<span class="text-emerald-600 font-bold">✓</span>';
  if (status === 'failed')  return '<span class="text-rose-600 font-bold">✕</span>';
  if (status === 'running') return '<span class="spinner text-teal-600"></span>';
  return '<span class="text-slate-300">○</span>';
};

const renderDeploySteps = (steps: DeployStep[]): string => {
  const items = steps.map((s, i) => {
    const isActive = s.status === 'running';
    const isDone   = s.status === 'done';
    const isFailed = s.status === 'failed';
    const labelColor = isActive ? 'text-teal-700 font-semibold'
                     : isDone   ? 'text-emerald-700'
                     : isFailed ? 'text-rose-600'
                     : 'text-slate-400';
    const connector = i < steps.length - 1
      ? `<div class="step-connector ${isDone ? 'done' : ''}"></div>`
      : '';
    return `
      <div class="flex items-center">
        <div class="flex flex-col items-center gap-1">
          <div class="w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs
            ${isDone   ? 'border-emerald-500 bg-emerald-50'
            : isFailed ? 'border-rose-400 bg-rose-50'
            : isActive ? 'border-teal-500 bg-teal-50'
                       : 'border-slate-200 bg-white'}">
            ${stepIcon(s.status)}
          </div>
          <span class="text-xs ${labelColor} whitespace-nowrap">${s.label}</span>
        </div>
        ${connector}
      </div>
    `;
  }).join('');
  return `<div class="flex items-start gap-0 mt-3 px-1">${items}</div>`;
};

// ─── 项目卡片渲染 ─────────────────────────────────────────────────────────────

const branchOptions = (project: SenderProject): string[] => {
  const rt = branchRuntimeMap.get(project.id);
  const opts = rt?.branches ?? [];
  return opts.length > 0 ? opts : (project.gitBranch ? [project.gitBranch] : []);
};

const renderBranchSelect = (project: SenderProject): string => {
  const opts = branchOptions(project);
  const disabled = project.projectPath.trim() ? '' : 'disabled';
  if (opts.length === 0) {
    return `<select id="${projectBranchSelectId(project.id)}" class="form-select" ${disabled}>
              <option value="">请先选择项目目录</option>
            </select>`;
  }
  return `<select id="${projectBranchSelectId(project.id)}" class="form-select" ${disabled}>
    ${opts.map(b => `<option value="${esc(b)}" ${b === project.gitBranch ? 'selected' : ''}>${esc(b)}</option>`).join('')}
  </select>`;
};

const renderProjectCard = (project: SenderProject): HTMLElement => {
  const rt = branchRuntimeMap.get(project.id);
  const mismatch = rt && rt.current && project.gitBranch && rt.current !== project.gitBranch
    ? `当前分支 <strong>${esc(rt.current)}</strong>，目标分支 <strong>${esc(project.gitBranch)}</strong>` : '';
  const branchError = rt?.error ?? '';
  const busy = projectBusyMap.get(project.id) ?? false;
  const steps = projectDeployStepsMap.get(project.id);

  const el = document.createElement('article');
  el.id = `card-${project.id}`;
  el.className = 'card flex flex-col gap-3';
  el.innerHTML = `
    <!-- 卡片头 -->
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <span class="font-semibold text-slate-700">${esc(project.name || project.id)}</span>
      <div class="flex items-center gap-2">
        <button class="btn-ghost btn-sm" data-action="build-one" data-id="${project.id}" ${busy ? 'disabled' : ''}>
          ${busy ? '<span class="spinner"></span>' : ''} 本地打包
        </button>
        <button class="btn-primary btn-sm" data-action="deploy-one" data-id="${project.id}" ${busy ? 'disabled' : ''}>
          ${busy ? '<span class="spinner"></span>' : ''} 发布此项目
        </button>
        <button class="btn-danger btn-sm" data-action="remove" data-id="${project.id}" ${busy ? 'disabled' : ''}>删除</button>
      </div>
    </div>

    ${mismatch ? `
    <div class="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
      <span class="text-xs text-amber-800">⚠ 分支不一致：${mismatch}</span>
      <button class="btn-ghost btn-sm text-amber-700 border-amber-300 hover:bg-amber-100"
              data-action="sync-branch" data-id="${project.id}" ${busy ? 'disabled' : ''}>
        切换并拉取最新代码
      </button>
    </div>` : ''}

    ${branchError ? `
    <div class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
      ⚠ Git 读取失败：${esc(branchError)}
    </div>` : ''}

    <!-- 进度步骤（发布中才显示） -->
    ${steps ? renderDeploySteps(steps) : ''}

    <!-- 日志面板 -->
    <div class="project-log-area ${projectLogMap.has(project.id) ? '' : 'hidden'}">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-medium text-slate-500">构建日志</span>
        <button class="text-xs text-slate-400 hover:text-slate-600 underline"
                data-action="clear-log" data-id="${project.id}">清除</button>
      </div>
      <pre class="log-output text-xs leading-relaxed bg-slate-900 text-slate-100
                  rounded-xl p-3 max-h-56 overflow-y-auto whitespace-pre-wrap
                  break-all font-mono"
           id="log-${project.id}">${esc(projectLogMap.get(project.id) ?? '')}</pre>
    </div>

    <!-- ── 本地构建配置 ── -->
    <div class="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
      <h3 class="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wide">本地构建</h3>
      <div class="grid grid-cols-2 gap-x-5 gap-y-3">
        <div>
          <label class="form-label">项目名称</label>
          <input id="${projectInputId(project.id, 'name')}" class="form-input" value="${esc(project.name)}" />
        </div>
        <div>
          <label class="form-label">项目路径</label>
          <div class="flex gap-2">
            <input id="${projectInputId(project.id, 'projectPath')}" class="form-input" value="${esc(project.projectPath)}" readonly />
            <button class="btn-ghost btn-sm shrink-0" data-action="pick-path" data-id="${project.id}">选择</button>
          </div>
        </div>
        <div>
          <label class="form-label">构建命令</label>
          <input id="${projectInputId(project.id, 'buildCommand')}" class="form-input" value="${esc(project.buildCommand)}" />
        </div>
        <div>
          <label class="form-label">构建输出目录</label>
          <input id="${projectInputId(project.id, 'buildOutputDir')}" class="form-input" value="${esc(project.buildOutputDir)}" />
        </div>
        <div>
          <label class="form-label">Git 分支</label>
          <div class="flex gap-2">
            ${renderBranchSelect(project)}
            <button class="btn-ghost btn-sm shrink-0" data-action="refresh-branches" data-id="${project.id}">刷新</button>
          </div>
        </div>
        <div>
          <label class="form-label">压缩包输出目录（可选）</label>
          <div class="flex gap-2">
            <input id="${projectInputId(project.id, 'artifactOutputDir')}" class="form-input" value="${esc(project.artifactOutputDir)}"
                   placeholder="留空则默认 .web-publisher-artifacts" readonly />
            <button class="btn-ghost btn-sm shrink-0" data-action="pick-artifact-path" data-id="${project.id}">选择</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 远程发布配置 ── -->
    <div class="rounded-xl border border-blue-100 bg-blue-50/40 p-4">
      <h3 class="text-xs font-semibold text-blue-500 mb-3 uppercase tracking-wide">远程发布</h3>
      <div class="grid grid-cols-2 gap-x-5 gap-y-3">
        <div>
          <label class="form-label">接收端地址</label>
          <input id="${projectInputId(project.id, 'receiverBaseUrl')}" class="form-input" value="${esc(project.receiverBaseUrl)}" />
        </div>
        <div>
          <label class="form-label">接收端 Token</label>
          <input id="${projectInputId(project.id, 'receiverToken')}" type="password" class="form-input" value="${esc(project.receiverToken)}" />
        </div>
        <div>
          <label class="form-label">Cloudflare Pages 项目名</label>
          <input id="${projectInputId(project.id, 'pagesProjectName')}" class="form-input" value="${esc(project.pagesProjectName)}"
                 placeholder="在 Cloudflare Pages 控制台可以找到" />
        </div>
        <div>
          <label class="form-label">部署分支（Cloudflare Pages）</label>
          <input id="${projectInputId(project.id, 'deployBranch')}" class="form-input" value="${esc(project.deployBranch)}" />
        </div>
      </div>
    </div>
  `;
  return el;
};

const renderProjectCards = (): void => {
  projectsWrap.innerHTML = '';
  config.senderProjects.forEach(p => projectsWrap.appendChild(renderProjectCard(p)));
};

// ─── 配置收集 ─────────────────────────────────────────────────────────────────

const collectProjects = (): SenderProject[] =>
  config.senderProjects.map(p => ({
    ...p,
    name:             getVal(projectInputId(p.id, 'name'))            || p.name,
    projectPath:      getVal(projectInputId(p.id, 'projectPath'))     || p.projectPath,
    buildCommand:     getVal(projectInputId(p.id, 'buildCommand'))    || p.buildCommand,
    buildOutputDir:   getVal(projectInputId(p.id, 'buildOutputDir'))  || p.buildOutputDir,
    artifactOutputDir:getVal(projectInputId(p.id, 'artifactOutputDir')),
    gitBranch:        getSelectVal(projectBranchSelectId(p.id))       || p.gitBranch,
    receiverBaseUrl:  getVal(projectInputId(p.id, 'receiverBaseUrl')) || p.receiverBaseUrl,
    receiverToken:    getVal(projectInputId(p.id, 'receiverToken'))   || p.receiverToken,
    pagesProjectName: getVal(projectInputId(p.id, 'pagesProjectName')),
    deployBranch:     getVal(projectInputId(p.id, 'deployBranch'))    || p.deployBranch,
  }));

const collectConfig = (): AppConfig => ({
  ...config,
  mode: getModeRadio(),
  senderProjects: collectProjects(),
  receiver: {
    ...config.receiver,
    host:              getVal('receiverHost')   || config.receiver.host,
    port:              Number(getVal('receiverPort')) || config.receiver.port,
    authToken:         getVal('authToken')      || config.receiver.authToken,
    maxUploadMb:       Number(getVal('maxUploadMb')) || config.receiver.maxUploadMb,
    workRootName:      getVal('workRootName')   || config.receiver.workRootName,
    cloudflareApiToken:getVal('cfToken'),
    cloudflareAccountId:getVal('cfAccountId'),
    wranglerBin:       getVal('wranglerBin')    || config.receiver.wranglerBin,
  },
});

const fillForm = (): void => {
  setVal('receiverHost',   config.receiver.host);
  setVal('receiverPort',   config.receiver.port);
  setVal('authToken',      config.receiver.authToken);
  setVal('maxUploadMb',    config.receiver.maxUploadMb);
  setVal('workRootName',   config.receiver.workRootName);
  setVal('cfToken',        config.receiver.cloudflareApiToken);
  setVal('cfAccountId',    config.receiver.cloudflareAccountId);
  setVal('wranglerBin',    config.receiver.wranglerBin);
};

// ─── 部署进度步骤辅助 ─────────────────────────────────────────────────────────

const setStep = (
  projectId: string,
  stepId: string,
  status: StepStatus,
): void => {
  const steps = projectDeployStepsMap.get(projectId);
  if (!steps) return;
  const s = steps.find(x => x.id === stepId);
  if (s) {
    s.status = status;
    // 局部更新进度区域，避免重绘整个卡片（保留表单输入）
    const card = document.getElementById(`card-${projectId}`);
    if (!card) return;
    let stepsEl = card.querySelector<HTMLDivElement>('.deploy-steps-area');
    if (!stepsEl) {
      stepsEl = document.createElement('div');
      stepsEl.className = 'deploy-steps-area';
      const firstGrid = card.querySelector('.grid');
      if (firstGrid) card.insertBefore(stepsEl, firstGrid);
    }
    stepsEl.innerHTML = renderDeploySteps(steps);
  }
};

const startProjectSteps = (projectId: string): void => {
  projectDeployStepsMap.set(projectId, makeSteps());
};

const clearProjectSteps = (projectId: string): void => {
  projectDeployStepsMap.delete(projectId);
  const card = document.getElementById(`card-${projectId}`);
  card?.querySelector('.deploy-steps-area')?.remove();
};

// ─── 日志面板管理 ─────────────────────────────────────────────────────────────

const appendLog = (projectId: string, msg: string): void => {
  const existing = projectLogMap.get(projectId) ?? '';
  let next = existing + msg;
  // 超出上限时保留后半段
  if (next.length > LOG_MAX_BYTES) {
    next = next.slice(next.length - LOG_MAX_BYTES);
  }
  projectLogMap.set(projectId, next);

  // 更新 DOM（如果卡片可见）
  const pre = document.getElementById(`log-${projectId}`);
  if (pre) {
    pre.textContent = next;
    pre.scrollTop = pre.scrollHeight;
  }

  // 显示面板
  const card = document.getElementById(`card-${projectId}`);
  card?.querySelector('.project-log-area')?.classList.remove('hidden');
};

const clearLog = (projectId: string): void => {
  projectLogMap.delete(projectId);
  const pre = document.getElementById(`log-${projectId}`);
  if (pre) pre.textContent = '';
  const card = document.getElementById(`card-${projectId}`);
  card?.querySelector('.project-log-area')?.classList.add('hidden');
};

// 批量操作（__all__）日志分发到全部项目卡片
const appendAllLog = (msg: string): void => {
  config.senderProjects.forEach(p => appendLog(p.id, msg));
};

// ─── 按钮禁用管理 ─────────────────────────────────────────────────────────────

const setBusy = (projectId: string, busy: boolean): void => {
  projectBusyMap.set(projectId, busy);
  const card = document.getElementById(`card-${projectId}`);
  if (!card) return;
  card.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach(btn => {
    btn.disabled = busy;
  });
};

const setGlobalBusy = (busy: boolean): void => {
  [$<HTMLButtonElement>('buildAllBtn'), $<HTMLButtonElement>('deployAllBtn'),
   $<HTMLButtonElement>('saveBtn'), $<HTMLButtonElement>('addProjectBtn')]
    .filter(Boolean)
    .forEach(btn => { btn.disabled = busy; });
};

// ─── 分支加载 ─────────────────────────────────────────────────────────────────

const loadBranchesForProject = async (
  projectId: string,
  projectPath: string,
): Promise<void> => {
  if (!projectPath.trim()) {
    branchRuntimeMap.delete(projectId);
    return;
  }
  const project = config.senderProjects.find(p => p.id === projectId);
  if (!project) return;

  const result = await window.desktopApi.listGitBranches(projectPath.trim());
  const branches = [...result.branches];
  if (result.current && !branches.includes(result.current)) {
    branches.unshift(result.current);
  }
  branchRuntimeMap.set(projectId, { branches, current: result.current });
  if (branches.length > 0 && (!project.gitBranch || !branches.includes(project.gitBranch))) {
    project.gitBranch = result.current || branches[0];
  }
};

const preloadAllBranches = async (): Promise<void> => {
  for (const p of config.senderProjects) {
    try {
      await loadBranchesForProject(p.id, p.projectPath);
    } catch (err) {
      branchRuntimeMap.set(p.id, { branches: [], current: '', error: String(err) });
    }
  }
};

// ─── 分支不一致解析 ───────────────────────────────────────────────────────────

const extractBranchMismatch = (message: string): string | null => {
  const m = message.match(/当前分支为\s*(.+?)，与配置/);
  return m?.[1]?.trim() ?? null;
};

const handleError = (err: unknown, projectId?: string): void => {
  const msg = err instanceof Error ? err.message : String(err);
  showToast(msg, 'error');
  if (projectId) {
    const current = extractBranchMismatch(msg);
    if (current) {
      const rt = branchRuntimeMap.get(projectId) ?? { branches: [], current: '' };
      branchRuntimeMap.set(projectId, { ...rt, current });
      renderProjectCards();
    }
  }
};

// ─── 轮询：发送端部署状态 ─────────────────────────────────────────────────────

const pullDeployments = async (): Promise<Record<string, DeploymentTask | null>> => {
  const result: Record<string, DeploymentTask | null> = {};
  for (const [pid, did] of recentDeploymentMap.entries()) {
    result[pid] = await window.desktopApi.getDeployment(did);
  }
  return result;
};

const syncSenderStatus = async (): Promise<void> => {
  const deployments = await pullDeployments();
  let allDone = true;

  for (const [pid, task] of Object.entries(deployments)) {
    if (!task) continue;
    const steps = projectDeployStepsMap.get(pid);
    if (!steps) continue;

    if (task.status === 'running') {
      allDone = false;
      setStep(pid, 'deploy', 'running');
    } else if (task.status === 'success') {
      setStep(pid, 'deploy', 'done');
      setStep(pid, 'done', 'done');
      setBusy(pid, false);
      showToast(
        task.url ? `✓ 部署成功！${task.url}` : '✓ 部署成功！',
        'success',
      );
      // 成功后 3 秒清除进度条
      setTimeout(() => clearProjectSteps(pid), 3000);
    } else if (task.status === 'failed') {
      setStep(pid, 'deploy', 'failed');
      setBusy(pid, false);
      showToast(`部署失败: ${task.error?.slice(0, 120) ?? '未知错误'}`, 'error');
      setTimeout(() => clearProjectSteps(pid), 5000);
    } else {
      allDone = false;
    }
  }

  if (allDone && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

const startPolling = (): void => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { void syncSenderStatus(); }, 2000);
};

// ─── 轮询：接收端任务列表 ─────────────────────────────────────────────────────

const syncReceiverTasks = async (): Promise<void> => {
  try {
    const tasks = await window.desktopApi.getAllDeployments();
    renderReceiverTasks(tasks);
  } catch {
    // 服务未启动时忽略
  }
};

const startReceiverPolling = (): void => {
  if (receiverPollTimer) clearInterval(receiverPollTimer);
  receiverPollTimer = setInterval(() => { void syncReceiverTasks(); }, 3000);
};

// ─── 事件：项目卡片区域（委托） ───────────────────────────────────────────────

const bindProjectEvents = (): void => {
  projectsWrap.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('button[data-action]');
    if (!btn) return;

    const action    = btn.dataset.action;
    const projectId = btn.dataset.id;
    if (!action || !projectId) return;

    // ── 清除日志 ──
    if (action === 'clear-log') {
      clearLog(projectId);
      return;
    }

    // ── 删除项目 ──
    if (action === 'remove') {
      config.senderProjects = config.senderProjects.filter(p => p.id !== projectId);
      branchRuntimeMap.delete(projectId);
      recentDeploymentMap.delete(projectId);
      localBuildArtifactMap.delete(projectId);
      projectDeployStepsMap.delete(projectId);
      projectLogMap.delete(projectId);
      if (config.senderProjects.length === 0) config.senderProjects.push(newProjectTemplate());
      renderProjectCards();
      showToast('项目已删除', 'info');
      return;
    }

    // ── 选择目录 ──
    if (action === 'pick-path') {
      const project = config.senderProjects.find(p => p.id === projectId);
      if (!project) return;
      try {
        const selectedPath = await window.desktopApi.pickDirectory(project.projectPath);
        if (!selectedPath) return;
        project.projectPath = selectedPath;
        await loadBranchesForProject(projectId, selectedPath);
        renderProjectCards();
        showToast('目录已选择，分支列表已刷新', 'success');
      } catch (err) { handleError(err, projectId); }
      return;
    }

    // ── 选择压缩包输出目录 ──
    if (action === 'pick-artifact-path') {
      const project = config.senderProjects.find(p => p.id === projectId);
      if (!project) return;
      try {
        const selectedPath = await window.desktopApi.pickDirectory(project.artifactOutputDir);
        if (!selectedPath) return;
        project.artifactOutputDir = selectedPath;
        const input = document.getElementById(projectInputId(projectId, 'artifactOutputDir')) as HTMLInputElement | null;
        if (input) input.value = selectedPath;
        showToast('压缩包输出目录已选择', 'success');
      } catch (err) { handleError(err, projectId); }
      return;
    }

    // ── 刷新分支 ──
    if (action === 'refresh-branches') {
      const projectPath = getVal(projectInputId(projectId, 'projectPath'));
      if (!projectPath) { showToast('请先选择项目目录', 'error'); return; }
      const project = config.senderProjects.find(p => p.id === projectId);
      if (!project) return;
      try {
        project.projectPath = projectPath;
        await loadBranchesForProject(projectId, projectPath);
        renderProjectCards();
        showToast('分支列表已刷新', 'success');
      } catch (err) { handleError(err, projectId); }
      return;
    }

    // ── 切换并拉取 ──
    if (action === 'sync-branch') {
      try {
        config = collectConfig();
        config = await window.desktopApi.updateConfig(config);
        setBusy(projectId, true);
        const result = await window.desktopApi.switchBranchAndPull(projectId);
        const rt = branchRuntimeMap.get(projectId) ?? { branches: [], current: '' };
        branchRuntimeMap.set(projectId, { ...rt, current: result.currentBranch, error: undefined });
        renderProjectCards();
        showToast(`已切换到 ${result.currentBranch} 并拉取最新代码`, 'success');
      } catch (err) {
        handleError(err, projectId);
      } finally {
        setBusy(projectId, false);
      }
      return;
    }

    // ── 单项目本地打包 ──
    if (action === 'build-one') {
      try {
        config = collectConfig();
        config = await window.desktopApi.updateConfig(config);
        setBusy(projectId, true);
        startProjectSteps(projectId);
        setStep(projectId, 'build', 'running');

        showToast('开始构建…', 'info');
        const result = await window.desktopApi.buildLocalOne(projectId);
        setStep(projectId, 'build', 'done');
        setStep(projectId, 'zip',   'done');
        localBuildArtifactMap.set(result.projectId, result.artifactPath);
        showToast('本地打包完成 ✓  正在打开产物目录…', 'success');
        setTimeout(() => clearProjectSteps(projectId), 2000);

        const artifactDir = result.artifactPath.replace(/\/[^/]+$/, '');
        window.desktopApi.openFolder(artifactDir);
      } catch (err) {
        setStep(projectId, 'build', 'failed');
        handleError(err, projectId);
        setTimeout(() => clearProjectSteps(projectId), 4000);
      } finally {
        setBusy(projectId, false);
      }
      return;
    }

    // ── 单项目发布 ──
    if (action === 'deploy-one') {
      try {
        config = collectConfig();
        config = await window.desktopApi.updateConfig(config);
        setBusy(projectId, true);
        startProjectSteps(projectId);
        setStep(projectId, 'build', 'running');

        showToast('正在构建并压缩…', 'info');
        const result = await window.desktopApi.buildAndDeployOne(projectId);
        setStep(projectId, 'build',  'done');
        setStep(projectId, 'zip',    'done');
        setStep(projectId, 'upload', 'done');
        setStep(projectId, 'deploy', 'running');

        recentDeploymentMap.set(result.projectId, result.deploymentId);
        showToast('文件已上传，等待远端部署…', 'info');
        startPolling();
      } catch (err) {
        const steps = projectDeployStepsMap.get(projectId);
        const runningStep = steps?.find(s => s.status === 'running');
        if (runningStep) setStep(projectId, runningStep.id, 'failed');
        handleError(err, projectId);
        setBusy(projectId, false);
        setTimeout(() => clearProjectSteps(projectId), 4000);
      }
    }
  });
};

// ─── 全局按钮绑定 ─────────────────────────────────────────────────────────────

const bindGlobalEvents = (): void => {
  // 模式切换
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(r => {
    r.addEventListener('change', () => applyModeVisibility(getModeRadio()));
  });

  // 新增项目
  $('addProjectBtn')?.addEventListener('click', () => {
    config.senderProjects.push(newProjectTemplate());
    renderProjectCards();
    showToast('已新增项目，请填写配置后保存', 'info');
  });

  // 保存配置
  $('saveBtn')?.addEventListener('click', async () => {
    try {
      setGlobalBusy(true);
      config = await window.desktopApi.updateConfig(collectConfig());
      await preloadAllBranches();
      renderProjectCards();
      showToast('配置已保存 ✓', 'success');
    } catch (err) { handleError(err); }
    finally { setGlobalBusy(false); }
  });

  // 启动接收服务
  $('startReceiverBtn')?.addEventListener('click', async () => {
    try {
      config = await window.desktopApi.updateConfig(collectConfig());
      const status = await window.desktopApi.startReceiver();
      updateReceiverStatusUI(status);
      startReceiverPolling();
      showToast('接收服务已启动 ✓', 'success');
    } catch (err) { handleError(err); }
  });

  // 停止接收服务
  $('stopReceiverBtn')?.addEventListener('click', async () => {
    try {
      const status = await window.desktopApi.stopReceiver();
      updateReceiverStatusUI(status);
      if (receiverPollTimer) { clearInterval(receiverPollTimer); receiverPollTimer = null; }
      showToast('接收服务已停止', 'info');
    } catch (err) { handleError(err); }
  });

  // 批量本地打包
  $('buildAllBtn')?.addEventListener('click', async () => {
    try {
      setGlobalBusy(true);
      config = await window.desktopApi.updateConfig(collectConfig());
      showToast('批量构建中…', 'info');
      const result: BatchBuildLocalResult = await window.desktopApi.buildLocalAll();
      result.succeeded.forEach(r => localBuildArtifactMap.set(r.projectId, r.artifactPath));
      if (result.failed.length > 0) {
        result.failed.forEach(f => showToast(`${f.projectName} 构建失败: ${f.error.slice(0, 80)}`, 'error'));
      }
      if (result.succeeded.length > 0) {
        showToast(`${result.succeeded.length} 个项目本地打包完成 ✓`, 'success');
        const opened = new Set<string>();
        result.succeeded.forEach(r => {
          const dir = r.artifactPath.replace(/\/[^/]+$/, '');
          if (!opened.has(dir)) {
            opened.add(dir);
            window.desktopApi.openFolder(dir);
          }
        });
      }
    } catch (err) { handleError(err); }
    finally { setGlobalBusy(false); }
  });

  // 一键发布全部
  $('deployAllBtn')?.addEventListener('click', async () => {
    try {
      setGlobalBusy(true);
      config = await window.desktopApi.updateConfig(collectConfig());
      showToast('批量构建并上传中…', 'info');
      const result: BatchBuildAndDeployResult = await window.desktopApi.buildAndDeployAll();
      result.submitted.forEach(r => recentDeploymentMap.set(r.projectId, r.deploymentId));
      if (result.failed.length > 0) {
        result.failed.forEach(f => showToast(`${f.projectName}: ${f.error.slice(0, 80)}`, 'error'));
      }
      if (result.submitted.length > 0) {
        showToast(`${result.submitted.length} 个项目已上传，等待远端部署…`, 'info');
        startPolling();
      }
    } catch (err) { handleError(err); }
    finally { setGlobalBusy(false); }
  });
};

// ─── 初始化 ───────────────────────────────────────────────────────────────────

const init = async (): Promise<void> => {
  // 注册日志推送监听（只注册一次）
  window.desktopApi.offSenderLog();
  window.desktopApi.onSenderLog(({ projectId, msg }) => {
    if (projectId === '__all__') {
      appendAllLog(msg);
    } else {
      appendLog(projectId, msg);
    }
  });

  config = await window.desktopApi.getConfig();
  setModeRadio(config.mode);
  applyModeVisibility(config.mode);
  fillForm();
  await preloadAllBranches();
  renderProjectCards();
  bindProjectEvents();
  bindGlobalEvents();

  const configPath = await window.desktopApi.getConfigPath();
  const tip = $<HTMLSpanElement>('configPathTip');
  if (tip) { tip.textContent = configPath; tip.title = configPath; }

  // 接收端：获取初始状态
  if (config.mode === 'receiver' || config.mode === 'both') {
    try {
      const status = await window.desktopApi.getReceiverStatus();
      updateReceiverStatusUI(status);
      if (status.running) {
        startReceiverPolling();
        void syncReceiverTasks();
      }
    } catch { /* ignore */ }
  }
};

void init();
