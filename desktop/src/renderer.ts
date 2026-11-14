import './index.css';
import {
  AppConfig,
  AppMode,
  DeploymentTask,
  ReceiverRuntimeStatus,
  SenderProject, DeployProject, SourceProject,
} from './shared/types';
import { createProject, isDeployProject, isSourceProject } from './shared/projects';
import type { DesktopApi } from './preload';

// UI Imports
import { $, getVal, setVal, esc } from './ui/utils/dom';
import { showToast } from './ui/components/toast';
import { 
  createProjectCard, 
  renderProjectLog,
  renderDeploySteps, 
  DeployStep, 
  BranchRuntime 
} from './ui/components/project-card';
import { appLayoutTemplate } from './ui/layout/app-layout';
import { senderViewTemplate } from './ui/views/sender-view';
import { receiverViewTemplate, ReceiverPage } from './ui/views/receiver-view';
import { newSourcePanel, sourceTargetMarkup, sourceResultMarkup, sourceReceiptRows, sourceTargetRows, SourcePanelState } from './ui/components/source-transfer';

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
const projectDeployStepsMap = new Map<string, DeployStep[]>(); // projectId → steps
const projectBusyMap = new Map<string, boolean>();           // projectId → busy
const sourcePanels = new Map<string, SourcePanelState>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let receiverPollTimer: ReturnType<typeof setInterval> | null = null;
type Workspace = 'sender' | 'source' | 'receiver';
let currentActiveTab: Workspace = 'sender';
let receiverPage: ReceiverPage = 'deploy';
const openProjectConfigs = new Set<string>();

// projectId → log text (max 50KB)
const projectLogMap = new Map<string, string>();
const LOG_MAX_BYTES = 50 * 1024;
const receiverLogExpandedSet = new Set<string>();
const receiverLogScrollMap = new Map<string, number>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const projectInputId = (pid: string, field: keyof DeployProject | keyof SourceProject): string =>
  `p__${pid}__${field}`;
const projectBranchSelectId = (pid: string): string => `p__${pid}__branchSel`;

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
const navSourceBtn = $<HTMLButtonElement>('navSourceBtn');
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

const switchView = (target: Workspace): void => {
  currentActiveTab = target;
  const links = { sender: navSenderBtn, source: navSourceBtn, receiver: navReceiverBtn };
  for (const [key, button] of Object.entries(links)) {
    button.classList.toggle('nav-btn-active', key === target);
    if (key === target) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (target !== 'receiver') {
    if (receiverPollTimer) { clearInterval(receiverPollTimer); receiverPollTimer = null; }
    viewContainer.innerHTML = senderViewTemplate(target === 'source');
    renderProjectCards();
  } else {
    viewContainer.innerHTML = receiverViewTemplate(receiverPage);
    fillReceiverForm();
    void syncReceiverTasks();
    startReceiverPolling();
    // Get latest receiver status
    void window.desktopApi.getReceiverStatus().then(updateReceiverStatusUI);
  }
  
  updateOverview();
};

const applyModeVisibility = (mode: AppMode): void => {
  // If mode changed to something that doesn't support current tab, switch tab
  if (mode === 'sender' && currentActiveTab === 'receiver') {
    switchView('sender');
  } else if (mode === 'receiver' && currentActiveTab !== 'receiver') {
    switchView('receiver');
  }
  
  // Update nav buttons visibility based on mode
  navSenderBtn.style.display = (mode === 'sender' || mode === 'both') ? 'flex' : 'none';
  navSourceBtn.style.display = navSenderBtn.style.display;
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
        <p class="text-sm italic">等待构建产物上传…</p>
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
  const source = currentActiveTab === 'source';
  const projects = config.senderProjects.filter(source ? isSourceProject : isDeployProject);
  wrap.innerHTML = projects.length ? '' : `<p class="rounded-3xl border border-dashed border-slate-300 p-8 text-sm text-slate-500">暂无${source ? '源码' : '部署'}项目</p>`;
  projects.forEach(p => {
    const card = createProjectCard(
      p, 
      branchRuntimeMap.get(p.id), 
      projectBusyMap.get(p.id), 
      projectDeployStepsMap.get(p.id),
      projectLogMap.get(p.id)
    );
    wrap.appendChild(card);
    const details = card.querySelector<HTMLDetailsElement>('[data-project-config]');
    details.open = openProjectConfigs.has(p.id);
    details.ontoggle = () => {
      if (!card.isConnected) return;
      if (details.open) openProjectConfigs.add(p.id);
      else openProjectConfigs.delete(p.id);
    };
    if (p.kind === 'source') {
      let panel = sourcePanels.get(p.id);
      if (!panel) { panel = newSourcePanel(); sourcePanels.set(p.id, panel); }
      if (!panel.initialized) void refreshSourcePanel(p, panel, Boolean(p.sourceTargetId));
      else updateSourcePanel(p);
    }
  });
  updateOverview();
};

// ─── Form Collection ─────────────────────────────────────────────────────────

const collectProjects = (): SenderProject[] =>
  config.senderProjects.map(p => {
    const connection = {
      name: readInput(projectInputId(p.id, 'name'), p.name),
      gitBranch: readSelect(projectBranchSelectId(p.id), p.gitBranch),
      artifactOutputDir: readInput(projectInputId(p.id, 'artifactOutputDir'), p.artifactOutputDir, true),
      projectPath: readInput(projectInputId(p.id, 'projectPath'), p.projectPath),
      receiverBaseUrl: readInput(projectInputId(p.id, 'receiverBaseUrl'), p.receiverBaseUrl, true),
      receiverToken: readInput(projectInputId(p.id, 'receiverToken'), p.receiverToken, true),
    };
    if (p.kind === 'source') return { ...p, ...connection };
    return { ...p, ...connection,
      buildCommand: readInput(projectInputId(p.id, 'buildCommand'), p.buildCommand),
      buildOutputDir: readInput(projectInputId(p.id, 'buildOutputDir'), p.buildOutputDir),
      pagesProjectName: readInput(projectInputId(p.id, 'pagesProjectName'), p.pagesProjectName, true),
      deployBranch: readInput(projectInputId(p.id, 'deployBranch'), p.deployBranch),
    };
  });

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
  const targets = $('sourceTargetRows');
  if (targets) targets.innerHTML = sourceTargetRows(config.receiver.sourceTargets);
};

const updateSourcePanel = (project: SourceProject): void => {
  const card = document.getElementById(`card-${project.id}`);
  const panel = sourcePanels.get(project.id);
  if (!card || !panel) return;
  const busy = !!projectBusyMap.get(project.id);
  card.querySelector('[data-source-target]').innerHTML = sourceTargetMarkup(project, panel, busy);
  card.querySelector('[data-source-result]').innerHTML = sourceResultMarkup(project, panel);
  const send = card.querySelector<HTMLButtonElement>('[data-action="source-send"]');
  send.textContent = panel.sending ? '正在发送…' : panel.pending ? '重新打包并发送' : '打包并发送';
  send.disabled = busy || panel.loading || !project.projectPath || panel.pending === undefined ||
    !panel.targets.some(t => t.id === project.sourceTargetId);
  const retry = card.querySelector<HTMLButtonElement>('[data-action="source-retry"]');
  retry.hidden = !panel.pending;
  retry.disabled = busy;
};

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

const refreshSourcePanel = async (project: SourceProject, panel: SourcePanelState, loadTargets = true): Promise<void> => {
  const request = ++panel.request;
  const currentPanelProject = (): SourceProject | undefined => {
    if (sourcePanels.get(project.id) !== panel || panel.request !== request) return;
    return config.senderProjects.filter(isSourceProject).find(p => p.id === project.id);
  };
  panel.initialized = true;
  panel.loading = loadTargets;
  panel.targets = [];
  panel.notice = loadTargets ? '' : '发送前请刷新并选择接收目录。';
  panel.hasRootIgnore = undefined;
  updateSourcePanel(project);
  const info = window.desktopApi.getSourceInfo(project.id, project.projectPath).then(result => {
    const current = currentPanelProject();
    if (!current) return;
    panel.hasRootIgnore = result.hasRootIgnore;
    panel.pending = result.pending;
    updateSourcePanel(current);
  });
  const targets = loadTargets && window.desktopApi.getSourceTargets(project).then(rows => {
    const current = currentPanelProject();
    if (!current) return;
    panel.targets = rows;
    if (current.sourceTargetId && !rows.some(t => t.id === current.sourceTargetId)) {
      current.sourceTargetId = '';
      panel.notice = '上次选择的目录已不可用，请重新选择。';
    }
    if (!rows.length) panel.notice = '请在接收端添加并保存一个源码接收目录。';
  });
  const results = await Promise.allSettled([info, targets]);
  const current = currentPanelProject();
  if (!current) return;
  for (const result of results) {
    if (result.status === 'rejected') panel.notice = errorText(result.reason);
  }
  panel.loading = false;
  updateSourcePanel(current);
};

const runSourceSend = async (project: SourceProject, panel: SourcePanelState, retry: boolean): Promise<void> => {
  if (panel.sending || projectBusyMap.get(project.id)) return;
  if (!retry && !panel.targets.some(t => t.id === project.sourceTargetId)) return;
  if (!retry && panel.pending && !window.confirm('重新发送将替换本机的待重试任务，并使用当前工作目录创建新版本。继续吗？')) return;
  ++panel.request;
  panel.loading = false;
  panel.sending = true;
  panel.error = '';
  panel.finalPath = '';
  appendLog(project.id, retry ? '正在继续原任务…\n' : '正在准备发送…\n');
  setBusy(project.id, true);
  updateSourcePanel(project);
  try {
    await window.desktopApi.updateConfig(config);
    const { finalPath } = await window.desktopApi.sendSource(project.id, retry);
    panel.finalPath = finalPath;
    panel.pending = false;
    showToast('源码已解压到远端版本目录', 'success');
  } catch (err) {
    panel.error = errorText(err);
    const info = await window.desktopApi.getSourceInfo(project.id, project.projectPath).catch((): undefined => undefined);
    panel.pending = info?.pending;
    handleError(err, project.id);
  } finally {
    panel.sending = false;
    setBusy(project.id, false);
  }
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

const normalizeLogChunk = (msg: string): string =>
  msg
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/([^\n])((?:▶|✓|✗|↺)\s)/g, '$1\n$2')
    .replace(/([^\n])(\n?┏━ )/g, '$1\n$2');

const looksLikeStageStart = (msg: string): boolean =>
  /^(?:\s*(?:┏━|━━|▶|✓|✗|↺))/.test(msg);

const mergeLogText = (existing: string, incoming: string): string => {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.endsWith('\n') || incoming.startsWith('\n')) return `${existing}${incoming}`;
  if (looksLikeStageStart(incoming)) return `${existing}\n${incoming}`;
  return `${existing}${incoming}`;
};

const appendLog = (projectId: string, msg: string): void => {
  const existing = projectLogMap.get(projectId) ?? '';
  const incoming = normalizeLogChunk(msg);
  let next = mergeLogText(existing, incoming);
  if (next.length > LOG_MAX_BYTES) next = next.slice(next.length - LOG_MAX_BYTES);
  projectLogMap.set(projectId, next);

  const pre = document.getElementById(`log-${projectId}`);
  if (pre) {
    pre.innerHTML = renderProjectLog(next);
    pre.scrollTop = pre.scrollHeight;
  }

  const card = document.getElementById(`card-${projectId}`);
  card?.querySelector('.project-log-area')?.classList.remove('hidden');
};

const clearLog = (projectId: string): void => {
  projectLogMap.delete(projectId);
  const pre = document.getElementById(`log-${projectId}`);
  if (pre) pre.innerHTML = '';
  const card = document.getElementById(`card-${projectId}`);
  card?.querySelector('.project-log-area')?.classList.add('hidden');
};

// ─── Busy Management ─────────────────────────────────────────────────────────

const setBusy = (projectId: string, busy: boolean): void => {
  projectBusyMap.set(projectId, busy);
  const card = document.getElementById(`card-${projectId}`);
  if (!card) return;
  card.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach(btn => {
    btn.disabled = busy;
  });
  // 某些错误分支会在 busy=true 时触发整卡重绘，导致按钮保留 loading 样式。
  // busy 结束后统一重绘，确保 spinner 与 disabled 状态完全回收。
  if (!busy) {
    config = collectConfig();
    renderProjectCards();
  }
};

const setGlobalBusy = (busy: boolean): void => {
  [$<HTMLButtonElement>('saveBtn'), $<HTMLButtonElement>('addProjectBtn'),
   $<HTMLButtonElement>('exportConfigBtn'), $<HTMLButtonElement>('importConfigBtn')]
    .filter(Boolean)
    .forEach(btn => { btn.disabled = busy; });
};

// ─── Git Branch Handling ─────────────────────────────────────────────────────

const loadBranchesForProject = async (projectId: string, projectPath: string): Promise<void> => {
  if (!projectPath.trim()) {
    branchRuntimeMap.delete(projectId);
    return;
  }
  const initial = config.senderProjects.find(p => p.id === projectId);
  if (!initial) return;
  const result = await window.desktopApi.listGitBranches(projectPath.trim(), initial.kind === 'source' && !initial.gitBranch);
  const project = config.senderProjects.find(p => p.id === projectId);
  if (!project || project.projectPath !== projectPath) return;
  const branches = [...result.branches];
  if (result.current && !branches.includes(result.current)) branches.unshift(result.current);
  branchRuntimeMap.set(projectId, { branches, current: result.current });
  if (branches.length > 0 && (!project.gitBranch || (project.kind === 'deploy' && !branches.includes(project.gitBranch)))) {
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

const extractPermissionPath = (message: string): string => {
  const m = message.match(/无法访问项目目录:\s*(.+)/);
  return m?.[1]?.trim() ?? '';
};

const handleError = (err: unknown, projectId?: string): void => {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const msg = rawMsg.replace('[MAC_PERMISSION_REQUIRED]', '').trim();
  showToast(msg, 'error');
  if (rawMsg.includes('[MAC_PERMISSION_REQUIRED]')) {
    const path = extractPermissionPath(rawMsg);
    void window.desktopApi.requestMacOsFolderPermissionHelp(path);
  }
  if (projectId) {
    const current = extractBranchMismatch(rawMsg);
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
    const project = config.senderProjects.find((item) => item.id === pid);
    if (!project) continue;

    const task = await window.desktopApi.getRemoteDeployment(
      project.receiverBaseUrl,
      project.receiverToken,
      did,
    );
    if (!task) continue;
    const steps = projectDeployStepsMap.get(pid);
    if (!steps) continue;

    if (task.status === 'running') {
      setStep(pid, 'deploy', 'running');
    } else if (task.status === 'success') {
      appendLog(
        pid,
        [
          '\n┏━ 部署完成 ━━━━━━━━━━━',
          `✓ 远程部署成功，deploymentId: ${task.id}`,
          task.url ? `▶ 访问地址: ${task.url}` : '',
        ].filter(Boolean).join('\n') + '\n',
      );
      setStep(pid, 'deploy', 'done');
      setStep(pid, 'done', 'done');
      setBusy(pid, false);
      showToast(`✓ 项目 ${task.projectName} 部署成功！`, 'success');
      recentDeploymentMap.delete(pid);
      setTimeout(() => clearProjectSteps(pid), 3000);
    } else if (task.status === 'failed') {
      appendLog(
        pid,
        [
          '\n┏━ 部署完成 ━━━━━━━━━━━',
          `✗ 远程部署失败，deploymentId: ${task.id}`,
          task.error ? `✗ 失败原因: ${task.error}` : '',
        ].filter(Boolean).join('\n') + '\n',
      );
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
  const source = receiverPage === 'source';
  const wrap = $(source ? 'sourceReceiptRows' : 'receiverTasksWrap');
  try {
    if (source) {
      const receipts = await window.desktopApi.getSourceReceipts();
      if (wrap.isConnected) wrap.innerHTML = sourceReceiptRows(receipts);
    } else {
      const tasks = await window.desktopApi.getAllDeployments();
      if (wrap.isConnected) renderReceiverTasks(tasks);
    }
  } catch (error) {
    if (wrap.isConnected) wrap.textContent = errorText(error);
  }
};

const startReceiverPolling = (): void => {
  if (receiverPollTimer) clearInterval(receiverPollTimer);
  receiverPollTimer = setInterval(() => { void syncReceiverTasks(); }, 3000);
};

// ─── Event Delegation ────────────────────────────────────────────────────────

const bindEvents = (): void => {
  // Nav tabs
  navSenderBtn.onclick = () => { config = collectConfig(); switchView('sender'); };
  navSourceBtn.onclick = () => { config = collectConfig(); switchView('source'); };
  navReceiverBtn.onclick = () => { config = collectConfig(); switchView('receiver'); };

  // Mode Radios
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(r => {
    r.onchange = () => {
      config = collectConfig();
      applyModeVisibility(getModeRadio());
    };
  });

  const createDialog = $<HTMLDialogElement>('createProjectDialog');
  $('cancelCreateProject').onclick = () => createDialog.close();
  createDialog.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const kind = createDialog.querySelector<HTMLInputElement>('input[name="projectKind"]:checked').value;
    const nameInput = $<HTMLInputElement>('newProjectName');
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const project = createProject(kind === 'source' ? 'source' : 'deploy', crypto.randomUUID());
    project.name = name;
    config = collectConfig();
    config.senderProjects.push(project);
    openProjectConfigs.add(project.id);
    createDialog.close();
    switchView(project.kind === 'source' ? 'source' : 'sender');
    showToast('项目已创建，配置完成后可保存', 'success');
  };

  // Global Actions
  $('saveBtn').onclick = async () => {
    try {
      setGlobalBusy(true);
      config = await window.desktopApi.updateConfig(collectConfig());
      await preloadAllBranches();
      renderProjectCards();
      showToast('所有配置已成功保存', 'success');
    } catch (err) { handleError(err); }
    finally { setGlobalBusy(false); }
  };

  $('exportConfigBtn').onclick = async () => {
    try {
      setGlobalBusy(true);
      const result = await window.desktopApi.exportConfig(collectConfig());
      if (!result.canceled) {
        showToast('配置已导出，可直接发给同事导入', 'success');
      }
    } catch (err) { handleError(err); }
    finally { setGlobalBusy(false); }
  };

  $('importConfigBtn').onclick = async () => {
    if (!window.confirm('导入配置会覆盖当前全部设置，是否继续？')) return;

    try {
      setGlobalBusy(true);
      const result = await window.desktopApi.importConfig();
      if (result.canceled || !result.config) return;

      config = result.config;
      sourcePanels.clear();
      openProjectConfigs.clear();
      branchRuntimeMap.clear();
      setModeRadio(config.mode);
      currentActiveTab = config.mode === 'receiver' ? 'receiver' : 'sender';
      switchView(currentActiveTab);
      applyModeVisibility(config.mode);
      await preloadAllBranches();
      renderProjectCards();
      showToast('配置已导入并保存', 'success');
    } catch (err) { handleError(err); }
    finally { setGlobalBusy(false); }
  };

  // View Container Delegation
  viewContainer.oninput = (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.sourceTargetName) {
      const target = config.receiver.sourceTargets.find(t => t.id === input.dataset.sourceTargetName);
      if (target) target.name = input.value;
    }
    const project = config.senderProjects.find(p => p.id === input.dataset.sourceConnection);
    if (project?.kind !== 'source') return;
    project.sourceTargetId = '';
    const panel = sourcePanels.get(project.id);
    if (panel) {
      ++panel.request;
      panel.loading = false;
      panel.targets = [];
      panel.notice = '接收端连接已更改，请刷新目录。';
      updateSourcePanel(project);
    }
  };
  viewContainer.onchange = e => {
    const select = e.target as HTMLSelectElement;
    if (select.dataset.projectBranch) {
      config = collectConfig();
      renderProjectCards();
      return;
    }
    if (!select.dataset.sourceSelect) return;
    const project = config.senderProjects.find(p => p.id === select.dataset.sourceSelect);
    if (project?.kind !== 'source') return;
    project.sourceTargetId = select.value;
    updateSourcePanel(project);
  };
  viewContainer.onclick = async (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('button[data-action]');
    const receiverButton = target.closest<HTMLButtonElement>('button');
    const page = receiverButton?.dataset.receiverPage;
    if (page === 'source' || page === 'deploy') {
      config = collectConfig();
      receiverPage = page;
      switchView('receiver');
      return;
    }
    if (receiverButton?.id === 'addSourceTarget' || receiverButton?.dataset.targetChange) {
      const existing = config.receiver.sourceTargets.find(t => t.id === receiverButton.dataset.targetChange);
      try {
        const path = await window.desktopApi.pickDirectory(existing?.path);
        if (!path || path === existing?.path) return;
        if (config.receiver.sourceTargets.some(t => t.path === path)) {
          showToast('该目录已添加', 'info');
          return;
        }
        const id = crypto.randomUUID();
        if (existing) { existing.path = path; existing.id = id; }
        else config.receiver.sourceTargets.push({ id, path, name: path.split(/[/\\]/).filter(Boolean).pop() || path });
        const rows = $('sourceTargetRows');
        if (rows) rows.innerHTML = sourceTargetRows(config.receiver.sourceTargets);
        showToast('目录已更新，保存全部配置后生效', 'info');
      } catch (err) { handleError(err); }
      return;
    }
    if (receiverButton?.dataset.targetRemove) {
      config.receiver.sourceTargets = config.receiver.sourceTargets.filter(t => t.id !== receiverButton.dataset.targetRemove);
      $('sourceTargetRows').innerHTML = sourceTargetRows(config.receiver.sourceTargets);
      showToast('已从配置移除目录，保存后生效', 'info');
      return;
    }
    if (receiverButton?.dataset.openReceipt) {
      try { await window.desktopApi.openSourceReceipt(receiverButton.dataset.openReceipt); }
      catch (err) { handleError(err); }
      return;
    }
    
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
    if (receiverButton?.id === 'addProjectBtn') {
      const kind = currentActiveTab === 'source' ? 'source' : 'deploy';
      createDialog.querySelector<HTMLInputElement>(`input[value="${kind}"]`).checked = true;
      setVal('newProjectName', '');
      createDialog.showModal();
      $('newProjectName').focus();
      return;
    }
    // Project Card Actions
    if (!btn) return;
    const { action, id: projectId } = btn.dataset;
    if (!action || !projectId) return;
    // 任何会触发局部重绘的项目卡操作，先把当前输入草稿同步到内存，避免未保存输入被覆盖
    config = collectConfig();

    if (action.startsWith('source-')) {
      const project = config.senderProjects.find(p => p.id === projectId);
      if (project?.kind !== 'source') return;
      const panel = sourcePanels.get(projectId);
      if (panel && action === 'source-refresh') {
        await refreshSourcePanel(project, panel);
      } else if (panel && (action === 'source-send' || action === 'source-retry')) {
        await runSourceSend(project, panel, action === 'source-retry');
      } else if (panel?.finalPath && action === 'source-copy') {
        try { await navigator.clipboard.writeText(panel.finalPath); showToast('远端路径已复制', 'success'); }
        catch (err) { handleError(err); }
      }
      return;
    }
    if (action === 'clear-log') { clearLog(projectId); return; }
    if (action === 'remove') {
      sourcePanels.delete(projectId);
      openProjectConfigs.delete(projectId);
      branchRuntimeMap.delete(projectId);
      config.senderProjects = config.senderProjects.filter(p => p.id !== projectId);
      renderProjectCards();
      showToast('项目已从列表移除', 'info');
      return;
    }
    if (action === 'pick-path') {
      const p = config.senderProjects.find(x => x.id === projectId);
      if (!p) return;
      const previousPath = p.projectPath;
      const path = await window.desktopApi.pickDirectory(previousPath);
      if (path) {
        p.projectPath = path;
        const panel = sourcePanels.get(projectId);
        if (panel) { ++panel.request; panel.initialized = false; }
        if (p.kind === 'source' && path !== previousPath) p.gitBranch = '';
        try { await loadBranchesForProject(projectId, path); }
        catch (err) { branchRuntimeMap.set(projectId, { branches: [], current: '', error: errorText(err) }); }
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
        appendLog(projectId, '\n━━ 分支同步 ━━\n');
        appendLog(projectId, '▶ 开始执行：切换并同步分支...\n');
        const res = await window.desktopApi.switchBranchAndPull(projectId);
        const rt = branchRuntimeMap.get(projectId) ?? { branches: [], current: '' };
        branchRuntimeMap.set(projectId, { ...rt, current: res.currentBranch, error: undefined });
        appendLog(projectId, `✓ 已切换到分支 ${res.currentBranch}，并完成同步\n`);
        renderProjectCards();
        showToast(`已成功切换到 ${res.currentBranch}`, 'success');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(projectId, `✗ 切换并同步失败: ${msg}\n`);
        handleError(err, projectId);
      }
      finally { setBusy(projectId, false); }
      return;
    }
    if (action === 'build-one') {
      const deploy = config.senderProjects.find(p => p.id === projectId)?.kind === 'deploy';
      try {
        config = await window.desktopApi.updateConfig(collectConfig());
        setBusy(projectId, true);
        if (deploy) {
          startProjectSteps(projectId);
          setStep(projectId, 'build', 'running');
        }
        showToast('正在打包项目…', 'info');
        const res = await window.desktopApi.buildLocalOne(projectId);
        setStep(projectId, 'build', 'done');
        setStep(projectId, 'zip',   'done');
        showToast('本地打包成功 ✓', 'success');
        setTimeout(() => clearProjectSteps(projectId), 2000);
        window.desktopApi.openFolder(res.artifactPath.replace(/[/\\][^/\\]+$/, ''));
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
  window.desktopApi.onSenderLog(({ projectId, msg }) => appendLog(projectId, msg));
  window.desktopApi.offSourceLog();
  window.desktopApi.onSourceLog(({ projectId, msg }) => appendLog(projectId, msg));

  // Config
  config = await window.desktopApi.getConfig();
  setModeRadio(config.mode);
  
  // Set initial tab based on mode
  if (config.mode === 'receiver') currentActiveTab = 'receiver';
  else currentActiveTab = 'sender';
  
  switchView(currentActiveTab);
  applyModeVisibility(config.mode);
  
  await preloadAllBranches();
  renderProjectCards();
  
  bindEvents();

  // Config Path Tip
  const configPath = await window.desktopApi.getConfigPath();
  const tip = $('configPathTip');
  if (tip) { tip.textContent = configPath; tip.title = configPath; }
};

void init();
