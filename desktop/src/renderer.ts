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

// UI Imports
import { $, getVal, setVal, esc } from './ui/utils/dom';
import { showToast } from './ui/components/toast';
import { 
  createProjectCard, 
  renderDeploySteps, 
  DeployStep, 
  BranchRuntime 
} from './ui/components/project-card';
import { appLayoutTemplate } from './ui/layout/app-layout';
import { senderViewTemplate } from './ui/views/sender-view';
import { receiverViewTemplate } from './ui/views/receiver-view';

declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'done' | 'failed';

// ─── Global State ────────────────────────────────────────────────────────────

let config: AppConfig;
const branchRuntimeMap = new Map<string, BranchRuntime>();
const recentDeploymentMap = new Map<string, string>();       // projectId → deploymentId
const localBuildArtifactMap = new Map<string, string>();     // projectId → zipPath
const projectDeployStepsMap = new Map<string, DeployStep[]>(); // projectId → steps
const projectBusyMap = new Map<string, boolean>();           // projectId → busy

let pollTimer: ReturnType<typeof setInterval> | null = null;
let receiverPollTimer: ReturnType<typeof setInterval> | null = null;
let currentActiveTab: 'sender' | 'receiver' = 'sender';

// projectId → log text (max 50KB)
const projectLogMap = new Map<string, string>();
const LOG_MAX_BYTES = 50 * 1024;
const receiverLogExpandedSet = new Set<string>();
const receiverLogScrollMap = new Map<string, number>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  { id: 'deploy', label: '部署', status: 'pending' },
  { id: 'done',   label: '完成',     status: 'pending' },
];

// ─── Initial Render ──────────────────────────────────────────────────────────

document.body.innerHTML = appLayoutTemplate;

// ─── DOM References ──────────────────────────────────────────────────────────

const viewContainer = $('viewContainer');
const navSenderBtn = $<HTMLButtonElement>('navSenderBtn');
const navReceiverBtn = $<HTMLButtonElement>('navReceiverBtn');

// ─── Mode & Visibility Control ───────────────────────────────────────────────

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

const switchView = (target: 'sender' | 'receiver'): void => {
  currentActiveTab = target;
  
  // Update Nav UI
  if (target === 'sender') {
    navSenderBtn.classList.add('nav-btn-active');
    navReceiverBtn.classList.remove('nav-btn-active');
    navReceiverBtn.classList.add('text-slate-500', 'hover:bg-slate-50');
    viewContainer.innerHTML = senderViewTemplate;
    renderProjectCards();
  } else {
    navReceiverBtn.classList.add('nav-btn-active');
    navSenderBtn.classList.remove('nav-btn-active');
    navSenderBtn.classList.add('text-slate-500', 'hover:bg-slate-50');
    viewContainer.innerHTML = receiverViewTemplate;
    fillReceiverForm();
    void syncReceiverTasks();
    // Get latest receiver status
    void window.desktopApi.getReceiverStatus().then(updateReceiverStatusUI);
  }
  
  updateOverview();
};

const applyModeVisibility = (mode: AppMode): void => {
  // If mode changed to something that doesn't support current tab, switch tab
  if (mode === 'sender' && currentActiveTab === 'receiver') {
    switchView('sender');
  } else if (mode === 'receiver' && currentActiveTab === 'sender') {
    switchView('receiver');
  }
  
  // Update nav buttons visibility based on mode
  navSenderBtn.style.display = (mode === 'sender' || mode === 'both') ? 'flex' : 'none';
  navReceiverBtn.style.display = (mode === 'receiver' || mode === 'both') ? 'flex' : 'none';
  
  updateOverview();
};

// ─── UI Updates ──────────────────────────────────────────────────────────────

const updateReceiverStatusUI = (status: ReceiverRuntimeStatus): void => {
  const dot  = $<HTMLSpanElement>('receiverStatusDot');
  const text = $<HTMLSpanElement>('receiverStatusText');
  const startBtn = $<HTMLButtonElement>('startReceiverBtn');
  const stopBtn = $<HTMLButtonElement>('stopReceiverBtn');

  if (!dot || !text) return; // Might not be on receiver view

  if (status.running) {
    dot.className  = 'w-3 h-3 rounded-full bg-emerald-500 mx-3 animate-pulse';
    text.textContent = `运行中 — ${status.host}:${status.port}`;
    text.className = 'text-xs font-bold text-emerald-600 mr-4 tracking-widest whitespace-nowrap';
    if (startBtn) startBtn.classList.add('hidden');
    if (stopBtn) stopBtn.classList.remove('hidden');
  } else {
    dot.className  = 'w-3 h-3 rounded-full bg-slate-300 mx-3';
    text.textContent = '服务已停止';
    text.className = 'text-xs font-bold text-slate-500 mr-4 tracking-widest whitespace-nowrap';
    if (startBtn) startBtn.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.add('hidden');
  }
  updateOverview(status.running ? `运行中 (${status.host}:${status.port})` : '未启动');
};

const modeText = (mode: AppMode): string => {
  if (mode === 'sender') return '发送端模式';
  if (mode === 'receiver') return '接收端模式';
  return '全功能双模式';
};

const updateOverview = (receiverTextOverride?: string): void => {
  const modeEl = $<HTMLParagraphElement>('overviewMode');
  const countEl = $<HTMLParagraphElement>('overviewProjectCount');
  const receiverEl = $<HTMLParagraphElement>('overviewReceiverStatus');
  
  if (modeEl) modeEl.textContent = modeText(getModeRadio());
  if (countEl) countEl.textContent = String(config?.senderProjects?.length ?? 0);
  if (receiverEl) {
    if (receiverTextOverride) {
      receiverEl.textContent = receiverTextOverride;
    } else {
      const statusText = $('receiverStatusText')?.textContent?.trim();
      receiverEl.textContent = statusText || (config?.mode === 'sender' ? 'N/A' : '未知');
    }
  }
};

// ─── Receiver Task List ──────────────────────────────────────────────────────

const statusBadge = (status: string): string => {
  const map: Record<string, string> = {
    queued:  '等待中',
    running: '部署中',
    success: '成功',
    failed:  '失败',
  };
  const cls = `badge-${status}`;
  return `<span class="${cls}">${map[status] ?? status}</span>`;
};

const renderReceiverTasks = (tasks: DeploymentTask[]): void => {
  const wrap = $<HTMLDivElement>('receiverTasksWrap');
  if (!wrap) return;

  // Remember expand/scroll state
  wrap.querySelectorAll<HTMLDetailsElement>('details[data-log-details="1"][data-id]').forEach((el) => {
    const id = el.dataset.id;
    if (!id) return;
    if (el.open) receiverLogExpandedSet.add(id);
    else receiverLogExpandedSet.delete(id);
  });
  wrap.querySelectorAll<HTMLPreElement>('pre[data-log-pre="1"][data-id]').forEach((el) => {
    const id = el.dataset.id;
    if (!id) return;
    receiverLogScrollMap.set(id, el.scrollTop);
  });

  if (tasks.length === 0) {
    wrap.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-slate-300">
        <svg class="w-12 h-12 mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
        <p class="text-sm italic">等待任务接入...</p>
      </div>
    `;
    return;
  }

  wrap.innerHTML = tasks.map(t => `
    <div class="flex flex-col gap-3 p-4 rounded-2xl border border-slate-100 bg-slate-50/50 hover:border-slate-200 transition-colors">
      <div class="flex items-center gap-3 flex-wrap">
        ${statusBadge(t.status)}
        <span class="font-bold text-slate-700 text-sm">${esc(t.projectName)}</span>
        <span class="text-[10px] text-slate-400 font-bold">分支: ${esc(t.branch)}</span>
        <span class="text-[10px] text-slate-300 ml-auto font-mono">${t.createdAt.slice(0, 19).replace('T', ' ')}</span>
      </div>
      ${t.url ? `
        <a href="${esc(t.url)}" class="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-teal-50 text-teal-600 text-xs font-bold hover:bg-teal-100 transition-colors"
           onclick="navigator.clipboard.writeText('${esc(t.url)}');event.preventDefault();showToast('链接已复制', 'success');">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.826a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"></path></svg>
          ${esc(t.url)}
        </a>` : ''}
      ${t.error ? `
        <div class="p-3 rounded-xl bg-rose-50 border border-rose-100 text-[11px] text-rose-600 leading-relaxed font-medium">
          错误: ${esc(t.error.slice(0, 300))}
        </div>` : ''}
      ${t.logs ? `
        <details class="group/tasklog" data-log-details="1" data-id="${esc(t.id)}" ${receiverLogExpandedSet.has(t.id) ? 'open' : ''}>
          <summary class="cursor-pointer text-[10px] font-bold text-slate-400 tracking-widest hover:text-slate-600 transition-colors flex items-center gap-1"
                   data-log-summary="1" data-id="${esc(t.id)}">
            <svg class="w-3 h-3 transition-transform group-open/tasklog:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"></path></svg>
            部署日志
          </summary>
          <pre class="mt-3 max-h-52 overflow-y-auto rounded-xl bg-slate-900 p-4
                      text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-all font-mono border border-slate-800 shadow-inner"
               data-log-pre="1" data-id="${esc(t.id)}">${esc(t.logs)}</pre>
        </details>
      ` : ''}
    </div>
  `).join('');

  // Restore scroll
  tasks.forEach((task) => {
    const pre = wrap.querySelector<HTMLPreElement>(`pre[data-log-pre="1"][data-id="${task.id}"]`);
    if (!pre) return;
    const top = receiverLogScrollMap.get(task.id);
    if (typeof top === 'number') pre.scrollTop = top;
  });
};

// ─── Render Project Cards ────────────────────────────────────────────────────

const renderProjectCards = (): void => {
  const wrap = $('projectsWrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  config.senderProjects.forEach(p => {
    const card = createProjectCard(
      p, 
      branchRuntimeMap.get(p.id), 
      projectBusyMap.get(p.id), 
      projectDeployStepsMap.get(p.id),
      projectLogMap.get(p.id)
    );
    wrap.appendChild(card);
  });
  updateOverview();
};

// ─── Form Collection ─────────────────────────────────────────────────────────

const collectProjects = (): SenderProject[] =>
  config.senderProjects.map(p => ({
    ...p,
    name:             readInput(projectInputId(p.id, 'name'), p.name),
    projectPath:      readInput(projectInputId(p.id, 'projectPath'), p.projectPath),
    buildCommand:     readInput(projectInputId(p.id, 'buildCommand'), p.buildCommand),
    buildOutputDir:   readInput(projectInputId(p.id, 'buildOutputDir'), p.buildOutputDir),
    artifactOutputDir:readInput(projectInputId(p.id, 'artifactOutputDir'), p.artifactOutputDir, true),
    gitBranch:        readSelect(projectBranchSelectId(p.id), p.gitBranch),
    receiverBaseUrl:  readInput(projectInputId(p.id, 'receiverBaseUrl'), p.receiverBaseUrl),
    receiverToken:    readInput(projectInputId(p.id, 'receiverToken'), p.receiverToken),
    pagesProjectName: readInput(projectInputId(p.id, 'pagesProjectName'), p.pagesProjectName, true),
    deployBranch:     readInput(projectInputId(p.id, 'deployBranch'), p.deployBranch),
  }));

const getInputIfMounted = (id: string): string | undefined => {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return undefined;
  return el.value.trim();
};

const getSelectIfMounted = (id: string): string | undefined => {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  if (!el) return undefined;
  return el.value.trim();
};

const readInput = (id: string, fallback: string, allowEmpty = false): string => {
  const value = getInputIfMounted(id);
  if (value === undefined) return fallback;
  if (allowEmpty) return value;
  return value || fallback;
};

const readSelect = (id: string, fallback: string): string => {
  const value = getSelectIfMounted(id);
  if (value === undefined) return fallback;
  return value || fallback;
};

const readNumber = (id: string, fallback: number): number => {
  const value = getInputIfMounted(id);
  if (value === undefined) return fallback;
  return Number(value) || fallback;
};

const collectConfig = (): AppConfig => ({
  ...config,
  mode: getModeRadio(),
  senderProjects: collectProjects(),
  receiver: {
    ...config.receiver,
    host:               readInput('receiverHost', config.receiver.host),
    port:               readNumber('receiverPort', config.receiver.port),
    authToken:          readInput('authToken', config.receiver.authToken),
    maxUploadMb:        readNumber('maxUploadMb', config.receiver.maxUploadMb),
    workRootName:       readInput('workRootName', config.receiver.workRootName),
    cloudflareApiToken: readInput('cfToken', config.receiver.cloudflareApiToken, true),
    cloudflareAccountId:readInput('cfAccountId', config.receiver.cloudflareAccountId, true),
    wranglerBin:        readInput('wranglerBin', config.receiver.wranglerBin),
  },
});

const fillReceiverForm = (): void => {
  setVal('receiverHost',   config.receiver.host);
  setVal('receiverPort',   config.receiver.port);
  setVal('authToken',      config.receiver.authToken);
  setVal('maxUploadMb',    config.receiver.maxUploadMb);
  setVal('workRootName',   config.receiver.workRootName);
  setVal('cfToken',        config.receiver.cloudflareApiToken);
  setVal('cfAccountId',    config.receiver.cloudflareAccountId);
  setVal('wranglerBin',    config.receiver.wranglerBin);
};

// ─── Progress Management ─────────────────────────────────────────────────────

const setStep = (projectId: string, stepId: string, status: StepStatus): void => {
  const steps = projectDeployStepsMap.get(projectId);
  if (!steps) return;
  const s = steps.find(x => x.id === stepId);
  if (s) {
    s.status = status;
    const card = document.getElementById(`card-${projectId}`);
    if (!card) return;
    const stepsArea = card.querySelector('.deploy-steps-area');
    if (stepsArea) {
      stepsArea.classList.remove('hidden');
      stepsArea.classList.add('opacity-100');
      stepsArea.innerHTML = renderDeploySteps(steps);
    }
  }
};

const startProjectSteps = (projectId: string): void => {
  projectDeployStepsMap.set(projectId, makeSteps());
};

const clearProjectSteps = (projectId: string): void => {
  projectDeployStepsMap.delete(projectId);
  const card = document.getElementById(`card-${projectId}`);
  const stepsArea = card?.querySelector('.deploy-steps-area');
  if (stepsArea) {
    stepsArea.classList.add('opacity-0');
    setTimeout(() => stepsArea.classList.add('hidden'), 500);
  }
};

// ─── Log Management ──────────────────────────────────────────────────────────

const appendLog = (projectId: string, msg: string): void => {
  const existing = projectLogMap.get(projectId) ?? '';
  let next = existing + msg;
  if (next.length > LOG_MAX_BYTES) next = next.slice(next.length - LOG_MAX_BYTES);
  projectLogMap.set(projectId, next);

  const pre = document.getElementById(`log-${projectId}`);
  if (pre) {
    pre.textContent = next;
    pre.scrollTop = pre.scrollHeight;
  }

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

const appendAllLog = (msg: string): void => {
  config.senderProjects.forEach(p => appendLog(p.id, msg));
};

// ─── Busy Management ─────────────────────────────────────────────────────────

const setBusy = (projectId: string, busy: boolean): void => {
  projectBusyMap.set(projectId, busy);
  const card = document.getElementById(`card-${projectId}`);
  if (!card) return;
  card.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach(btn => {
    btn.disabled = busy;
  });
  // Update the button icon/spinner by re-rendering part of the header or just the button
  // For simplicity, we just trigger a full card update if needed, but here we just toggle disabled
};

const setGlobalBusy = (busy: boolean): void => {
  [$<HTMLButtonElement>('buildAllBtn'), $<HTMLButtonElement>('deployAllBtn'),
   $<HTMLButtonElement>('saveBtn'), $<HTMLButtonElement>('addProjectBtn')]
    .filter(Boolean)
    .forEach(btn => { btn.disabled = busy; });
};

// ─── Git Branch Handling ─────────────────────────────────────────────────────

const loadBranchesForProject = async (projectId: string, projectPath: string): Promise<void> => {
  if (!projectPath.trim()) {
    branchRuntimeMap.delete(projectId);
    return;
  }
  const project = config.senderProjects.find(p => p.id === projectId);
  if (!project) return;

  const result = await window.desktopApi.listGitBranches(projectPath.trim());
  const branches = [...result.branches];
  if (result.current && !branches.includes(result.current)) branches.unshift(result.current);
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

// ─── Polling: Sender ─────────────────────────────────────────────────────────

const syncSenderStatus = async (): Promise<void> => {
  for (const [pid, did] of recentDeploymentMap.entries()) {
    const task = await window.desktopApi.getDeployment(did);
    if (!task) continue;
    const steps = projectDeployStepsMap.get(pid);
    if (!steps) continue;

    if (task.status === 'running') {
      setStep(pid, 'deploy', 'running');
    } else if (task.status === 'success') {
      setStep(pid, 'deploy', 'done');
      setStep(pid, 'done', 'done');
      setBusy(pid, false);
      showToast(`✓ 项目 ${task.projectName} 部署成功！`, 'success');
      recentDeploymentMap.delete(pid);
      setTimeout(() => clearProjectSteps(pid), 3000);
    } else if (task.status === 'failed') {
      setStep(pid, 'deploy', 'failed');
      setBusy(pid, false);
      showToast(`部署失败: ${task.error?.slice(0, 120) ?? '未知错误'}`, 'error');
      recentDeploymentMap.delete(pid);
      setTimeout(() => clearProjectSteps(pid), 5000);
    }
  }

  if (recentDeploymentMap.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

const startPolling = (): void => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { void syncSenderStatus(); }, 2000);
};

// ─── Polling: Receiver ───────────────────────────────────────────────────────

const syncReceiverTasks = async (): Promise<void> => {
  if (currentActiveTab !== 'receiver') return;
  try {
    const tasks = await window.desktopApi.getAllDeployments();
    renderReceiverTasks(tasks);
  } catch { /* ignore */ }
};

const startReceiverPolling = (): void => {
  if (receiverPollTimer) clearInterval(receiverPollTimer);
  receiverPollTimer = setInterval(() => { void syncReceiverTasks(); }, 3000);
};

// ─── Event Delegation ────────────────────────────────────────────────────────

const bindEvents = (): void => {
  // Nav tabs
  navSenderBtn.onclick = () => switchView('sender');
  navReceiverBtn.onclick = () => switchView('receiver');

  // Mode Radios
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(r => {
    r.onchange = () => {
      applyModeVisibility(getModeRadio());
    };
  });

  // Global Actions
  $('saveBtn').onclick = async () => {
    try {
      setGlobalBusy(true);
      config = await window.desktopApi.updateConfig(collectConfig());
      await preloadAllBranches();
      if (currentActiveTab === 'sender') renderProjectCards();
      showToast('所有配置已成功保存', 'success');
    } catch (err) { handleError(err); }
    finally { setGlobalBusy(false); }
  };

  // View Container Delegation
  viewContainer.onclick = async (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('button[data-action]');
    
    // Receiver Service Controls
    if (target.id === 'startReceiverBtn') {
      try {
        config = await window.desktopApi.updateConfig(collectConfig());
        const status = await window.desktopApi.startReceiver();
        updateReceiverStatusUI(status);
        startReceiverPolling();
        showToast('接收端服务已成功启动', 'success');
      } catch (err) { handleError(err); }
      return;
    }
    if (target.id === 'stopReceiverBtn') {
      try {
        const status = await window.desktopApi.stopReceiver();
        updateReceiverStatusUI(status);
        if (receiverPollTimer) { clearInterval(receiverPollTimer); receiverPollTimer = null; }
        showToast('接收端服务已停止', 'info');
      } catch (err) { handleError(err); }
      return;
    }

    // Sender Global Actions
    if (target.id === 'addProjectBtn') {
      config.senderProjects.push(newProjectTemplate());
      renderProjectCards();
      showToast('已添加新项目，请配置后保存', 'info');
      return;
    }
    if (target.id === 'buildAllBtn') {
      try {
        setGlobalBusy(true);
        config = await window.desktopApi.updateConfig(collectConfig());
        showToast('开始批量构建项目...', 'info');
        const result: BatchBuildLocalResult = await window.desktopApi.buildLocalAll();
        result.succeeded.forEach(r => localBuildArtifactMap.set(r.projectId, r.artifactPath));
        if (result.failed.length > 0) {
          result.failed.forEach(f => showToast(`${f.projectName} 构建失败`, 'error'));
        }
        if (result.succeeded.length > 0) {
          showToast(`${result.succeeded.length} 个项目构建成功`, 'success');
          const opened = new Set<string>();
          result.succeeded.forEach(r => {
            const dir = r.artifactPath.replace(/\/[^/]+$/, '');
            if (!opened.has(dir)) { opened.add(dir); window.desktopApi.openFolder(dir); }
          });
        }
      } catch (err) { handleError(err); }
      finally { setGlobalBusy(false); }
      return;
    }
    if (target.id === 'deployAllBtn') {
      try {
        setGlobalBusy(true);
        config = await window.desktopApi.updateConfig(collectConfig());
        showToast('正在批量发布项目...', 'info');
        const result: BatchBuildAndDeployResult = await window.desktopApi.buildAndDeployAll();
        result.submitted.forEach(r => recentDeploymentMap.set(r.projectId, r.deploymentId));
        if (result.failed.length > 0) {
          result.failed.forEach(f => showToast(`${f.projectName} 发布失败`, 'error'));
        }
        if (result.submitted.length > 0) {
          showToast(`${result.submitted.length} 个项目已提交发布`, 'info');
          startPolling();
        }
      } catch (err) { handleError(err); }
      finally { setGlobalBusy(false); }
      return;
    }

    // Project Card Actions
    if (!btn) return;
    const { action, id: projectId } = btn.dataset;
    if (!action || !projectId) return;

    if (action === 'clear-log') { clearLog(projectId); return; }
    if (action === 'remove') {
      config.senderProjects = config.senderProjects.filter(p => p.id !== projectId);
      if (config.senderProjects.length === 0) config.senderProjects.push(newProjectTemplate());
      renderProjectCards();
      showToast('项目已从列表移除', 'info');
      return;
    }
    if (action === 'pick-path') {
      const p = config.senderProjects.find(x => x.id === projectId);
      if (!p) return;
      const path = await window.desktopApi.pickDirectory(p.projectPath);
      if (path) {
        p.projectPath = path;
        await loadBranchesForProject(projectId, path);
        renderProjectCards();
        showToast('路径已更新', 'success');
      }
      return;
    }
    if (action === 'pick-artifact-path') {
      const p = config.senderProjects.find(x => x.id === projectId);
      if (!p) return;
      const path = await window.desktopApi.pickDirectory(p.artifactOutputDir);
      if (path) {
        p.artifactOutputDir = path;
        const input = $<HTMLInputElement>(projectInputId(projectId, 'artifactOutputDir'));
        if (input) input.value = path;
        showToast('产物目录已更新', 'success');
      }
      return;
    }
    if (action === 'refresh-branches') {
      const path = getVal(projectInputId(projectId, 'projectPath'));
      if (!path) { showToast('请先选择项目目录', 'error'); return; }
      try {
        await loadBranchesForProject(projectId, path);
        renderProjectCards();
        showToast('分支列表已刷新', 'success');
      } catch (err) { handleError(err, projectId); }
      return;
    }
    if (action === 'sync-branch') {
      try {
        config = await window.desktopApi.updateConfig(collectConfig());
        setBusy(projectId, true);
        const res = await window.desktopApi.switchBranchAndPull(projectId);
        const rt = branchRuntimeMap.get(projectId) ?? { branches: [], current: '' };
        branchRuntimeMap.set(projectId, { ...rt, current: res.currentBranch, error: undefined });
        renderProjectCards();
        showToast(`已成功切换到 ${res.currentBranch}`, 'success');
      } catch (err) { handleError(err, projectId); }
      finally { setBusy(projectId, false); }
      return;
    }
    if (action === 'build-one') {
      try {
        config = await window.desktopApi.updateConfig(collectConfig());
        setBusy(projectId, true);
        startProjectSteps(projectId);
        setStep(projectId, 'build', 'running');
        showToast('正在构建项目...', 'info');
        const res = await window.desktopApi.buildLocalOne(projectId);
        setStep(projectId, 'build', 'done');
        setStep(projectId, 'zip',   'done');
        localBuildArtifactMap.set(res.projectId, res.artifactPath);
        showToast('本地打包成功 ✓', 'success');
        setTimeout(() => clearProjectSteps(projectId), 2000);
        window.desktopApi.openFolder(res.artifactPath.replace(/\/[^/]+$/, ''));
      } catch (err) {
        setStep(projectId, 'build', 'failed');
        handleError(err, projectId);
        setTimeout(() => clearProjectSteps(projectId), 4000);
      } finally { setBusy(projectId, false); }
      return;
    }
    if (action === 'deploy-one') {
      try {
        config = await window.desktopApi.updateConfig(collectConfig());
        setBusy(projectId, true);
        startProjectSteps(projectId);
        setStep(projectId, 'build', 'running');
        showToast('正在准备发布...', 'info');
        const res = await window.desktopApi.buildAndDeployOne(projectId);
        setStep(projectId, 'build',  'done');
        setStep(projectId, 'zip',    'done');
        setStep(projectId, 'upload', 'done');
        setStep(projectId, 'deploy', 'running');
        recentDeploymentMap.set(res.projectId, res.deploymentId);
        showToast('上传成功，等待云端部署', 'info');
        startPolling();
      } catch (err) {
        const steps = projectDeployStepsMap.get(projectId);
        const running = steps?.find(s => s.status === 'running');
        if (running) setStep(projectId, running.id, 'failed');
        handleError(err, projectId);
        setBusy(projectId, false);
        setTimeout(() => clearProjectSteps(projectId), 4000);
      }
      return;
    }

    // Receiver Task Logs Delegation
    const summary = target.closest<HTMLElement>('summary[data-log-summary="1"]');
    if (summary) {
      const taskId = summary.dataset.id;
      if (taskId) {
        setTimeout(() => {
          const details = viewContainer.querySelector<HTMLDetailsElement>(`details[data-id="${taskId}"]`);
          if (details?.open) receiverLogExpandedSet.add(taskId);
          else receiverLogExpandedSet.delete(taskId);
        }, 0);
      }
    }
  };
};

// ─── Initialization ──────────────────────────────────────────────────────────

const init = async (): Promise<void> => {
  // Logs
  window.desktopApi.offSenderLog();
  window.desktopApi.onSenderLog(({ projectId, msg }) => {
    if (projectId === '__all__') appendAllLog(msg);
    else appendLog(projectId, msg);
  });

  // Config
  config = await window.desktopApi.getConfig();
  setModeRadio(config.mode);
  
  // Set initial tab based on mode
  if (config.mode === 'receiver') currentActiveTab = 'receiver';
  else currentActiveTab = 'sender';
  
  switchView(currentActiveTab);
  applyModeVisibility(config.mode);
  
  await preloadAllBranches();
  if (currentActiveTab === 'sender') renderProjectCards();
  
  bindEvents();

  // Config Path Tip
  const configPath = await window.desktopApi.getConfigPath();
  const tip = $('configPathTip');
  if (tip) { tip.textContent = configPath; tip.title = configPath; }
};

void init();
