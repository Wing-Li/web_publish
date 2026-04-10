import { SenderProject, StepStatus } from '../../shared/types';
import { esc } from '../utils/dom';

export interface BranchRuntime {
  branches: string[];
  current: string;
  error?: string;
}

export interface DeployStep {
  id: string;
  label: string;
  status: StepStatus;
}

type LogPhase = 'build' | 'zip' | 'upload' | 'deploy' | 'other';

interface LogSection {
  phase: LogPhase;
  title: string;
  lines: string[];
}

const LOG_PHASE_META: Record<LogPhase, { title: string; badgeClass: string; sectionClass: string; dotClass: string; }> = {
  build: {
    title: '构建阶段',
    badgeClass: 'bg-cyan-100 text-cyan-800 border border-cyan-200',
    sectionClass: 'border-cyan-500/15 bg-cyan-500/[0.08]',
    dotClass: 'bg-cyan-400',
  },
  zip: {
    title: '压缩阶段',
    badgeClass: 'bg-violet-100 text-violet-800 border border-violet-200',
    sectionClass: 'border-violet-500/15 bg-violet-500/[0.08]',
    dotClass: 'bg-violet-400',
  },
  upload: {
    title: '上传阶段',
    badgeClass: 'bg-amber-100 text-amber-800 border border-amber-200',
    sectionClass: 'border-amber-500/15 bg-amber-500/[0.08]',
    dotClass: 'bg-amber-400',
  },
  deploy: {
    title: '部署阶段',
    badgeClass: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
    sectionClass: 'border-emerald-500/15 bg-emerald-500/[0.08]',
    dotClass: 'bg-emerald-400',
  },
  other: {
    title: '其他日志',
    badgeClass: 'bg-slate-100 text-slate-700 border border-slate-200',
    sectionClass: 'border-slate-500/15 bg-slate-500/[0.08]',
    dotClass: 'bg-slate-400',
  },
};

const normalizeLogText = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/([^\n])((?:▶|✓|✗|↺)\s)/g, '$1\n$2')
    .replace(/([^\n])(\n?┏━ )/g, '$1\n$2')
    .trim();

const phaseFromHeader = (line: string): LogPhase | null => {
  if (line.includes('构建阶段')) return 'build';
  if (line.includes('压缩阶段')) return 'zip';
  if (line.includes('上传阶段')) return 'upload';
  if (line.includes('部署阶段')) return 'deploy';
  return null;
};

const phaseFromLine = (line: string, currentPhase: LogPhase): LogPhase => {
  if (/执行构建命令|构建完成|npm |pnpm |yarn |vite |building/i.test(line)) return 'build';
  if (/压缩|zipPath|zip\b|adding:/i.test(line)) return 'zip';
  if (/上传|uploadId|分片|chunk|receiverBaseUrl|接收端/i.test(line)) return 'upload';
  if (/部署|deploymentId|wrangler|Cloudflare|合并分片/i.test(line)) return 'deploy';
  return currentPhase;
};

const parseLogSections = (logContent: string): LogSection[] => {
  const text = normalizeLogText(logContent);
  if (!text) return [];

  const sections: LogSection[] = [];
  let currentPhase: LogPhase = 'other';
  let currentSection: LogSection | null = null;

  const ensureSection = (phase: LogPhase): LogSection => {
    if (currentSection && currentSection.phase === phase) return currentSection;
    currentPhase = phase;
    currentSection = { phase, title: LOG_PHASE_META[phase].title, lines: [] };
    sections.push(currentSection);
    return currentSection;
  };

  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trimEnd();
    if (!line.trim()) return;

    if (line.startsWith('┏━')) {
      const phase = phaseFromHeader(line) ?? 'other';
      ensureSection(phase);
      return;
    }

    if (line.startsWith('━━')) {
      currentSection = { phase: 'other', title: line.replace(/^━━\s*/, '').replace(/\s*━━$/, '') || '其他日志', lines: [] };
      sections.push(currentSection);
      currentPhase = 'other';
      return;
    }

    const phase = phaseFromLine(line, currentPhase);
    ensureSection(phase).lines.push(line);
  });

  return sections.filter((section) => section.lines.length > 0);
};

const renderLogLine = (line: string): string => {
  let toneClass = 'text-slate-300';
  let markerClass = 'text-slate-500';

  if (line.startsWith('✓')) {
    toneClass = 'text-emerald-300';
    markerClass = 'text-emerald-400';
  } else if (line.startsWith('▶')) {
    toneClass = 'text-sky-200';
    markerClass = 'text-sky-400';
  } else if (line.startsWith('↺')) {
    toneClass = 'text-amber-200';
    markerClass = 'text-amber-400';
  } else if (line.startsWith('✗')) {
    toneClass = 'text-rose-300';
    markerClass = 'text-rose-400';
  } else if (/^adding:/i.test(line)) {
    toneClass = 'text-slate-400';
    markerClass = 'text-violet-300';
  }

  const marker = /^[✓▶↺✗]/.test(line)
    ? `<span class="mt-0.5 text-[13px] leading-none ${markerClass}">${esc(line[0])}</span><span class="${toneClass}">${esc(line.slice(1).trimStart())}</span>`
    : /^adding:/i.test(line)
      ? `<span class="mt-1 h-1.5 w-1.5 rounded-full ${markerClass}"></span><span class="${toneClass}">${esc(line)}</span>`
      : `<span class="mt-1 h-1.5 w-1.5 rounded-full bg-slate-600"></span><span class="${toneClass}">${esc(line)}</span>`;

  return `
    <div class="grid grid-cols-[12px,1fr] gap-3 items-start text-[12px] leading-6 break-all">
      ${marker}
    </div>
  `;
};

export const renderProjectLog = (logContent?: string): string => {
  const sections = parseLogSections(logContent ?? '');
  if (sections.length === 0) return '';

  return sections.map((section) => {
    const meta = LOG_PHASE_META[section.phase];
    return `
      <section class="rounded-2xl border px-4 py-3 ${meta.sectionClass}">
        <div class="flex items-center gap-2 mb-3">
          <span class="h-2.5 w-2.5 rounded-full ${meta.dotClass}"></span>
          <span class="px-2.5 py-1 rounded-full text-[10px] font-black tracking-[0.16em] uppercase ${meta.badgeClass}">
            ${esc(section.title)}
          </span>
          <span class="text-[10px] font-bold tracking-[0.12em] uppercase text-slate-500">
            ${section.lines.length} 行
          </span>
        </div>
        <div class="space-y-1">
          ${section.lines.map(renderLogLine).join('')}
        </div>
      </section>
    `;
  }).join('');
};

const stepIcon = (status: StepStatus): string => {
  if (status === 'done')    return '<svg class="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>';
  if (status === 'failed')  return '<svg class="w-3.5 h-3.5 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"></path></svg>';
  if (status === 'running') return '<span class="spinner w-3 h-3 text-teal-600 border-2"></span>';
  return '<span class="w-1.5 h-1.5 rounded-full bg-slate-200"></span>';
};

export const renderDeploySteps = (steps: DeployStep[]): string => {
  const items = steps.map((s, i) => {
    const isActive = s.status === 'running';
    const isDone   = s.status === 'done';
    const isFailed = s.status === 'failed';
    
    const circleClass = isDone   ? 'border-emerald-500 bg-emerald-50'
                      : isFailed ? 'border-rose-500 bg-rose-50'
                      : isActive ? 'border-teal-500 bg-teal-50 animate-pulse'
                      : 'border-slate-200 bg-white';
                      
    const labelClass = isActive ? 'text-teal-700 font-bold'
                     : isDone   ? 'text-emerald-700 font-medium'
                     : isFailed ? 'text-rose-700 font-medium'
                     : 'text-slate-400';

    const connector = i < steps.length - 1
      ? `<div class="flex-1 h-0.5 mx-2 ${isDone ? 'bg-emerald-400' : 'bg-slate-100'}"></div>`
      : '';

    return `
      <div class="flex items-center flex-1 last:flex-initial group">
        <div class="flex flex-col items-center gap-1.5">
          <div class="w-8 h-8 rounded-xl border-2 flex items-center justify-center transition-all duration-300 ${circleClass}">
            ${stepIcon(s.status)}
          </div>
          <span class="text-[11px] font-bold tracking-widest ${labelClass}">${s.label}</span>
        </div>
        ${connector}
      </div>
    `;
  }).join('');
  
  return `
    <div class="flex items-center justify-between w-full py-4 px-2 bg-slate-50/50 rounded-2xl border border-slate-100">
      ${items}
    </div>
  `;
};

const projectInputId = (pid: string, field: keyof SenderProject): string =>
  `p__${pid}__${field}`;
const projectBranchSelectId = (pid: string): string => `p__${pid}__branchSel`;

const renderBranchSelect = (project: SenderProject, rt?: BranchRuntime): string => {
  const opts = rt?.branches ?? (project.gitBranch ? [project.gitBranch] : []);
  const disabled = project.projectPath.trim() ? '' : 'disabled';
  
  if (opts.length === 0) {
    return `<select id="${projectBranchSelectId(project.id)}" class="form-select text-slate-400" ${disabled}>
              <option value="">请先选择项目目录</option>
            </select>`;
  }
  
  return `
    <select id="${projectBranchSelectId(project.id)}" class="form-select" ${disabled}>
      ${opts.map(b => `<option value="${esc(b)}" ${b === project.gitBranch ? 'selected' : ''}>${esc(b)}</option>`).join('')}
    </select>
  `;
};

export const createProjectCard = (
  project: SenderProject, 
  rt?: BranchRuntime, 
  busy = false, 
  steps?: DeployStep[],
  logContent?: string
): HTMLElement => {
  const mismatch = rt && rt.current && project.gitBranch && rt.current !== project.gitBranch
    ? `当前: <span class="font-bold">${esc(rt.current)}</span> ⇄ 目标: <span class="font-bold">${esc(project.gitBranch)}</span>` : '';
  const branchError = rt?.error ?? '';

  const el = document.createElement('article');
  el.id = `card-${project.id}`;
  el.className = 'group relative flex flex-col gap-4 p-5 rounded-3xl bg-white border border-slate-200 shadow-sm hover:shadow-xl hover:border-teal-500/30 transition-all duration-300';
  
  el.innerHTML = `
    <!-- Header: Info + Actions -->
    <div class="flex items-start justify-between gap-4 border-b border-slate-50 pb-4">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <div class="w-2 h-2 rounded-full ${busy ? 'bg-teal-500 animate-ping' : 'bg-slate-300'}"></div>
          <h3 class="font-bold text-slate-800 truncate text-lg tracking-tight">${esc(project.name || '未命名项目')}</h3>
          <span class="px-2 py-0.5 rounded-full bg-slate-100 text-[10px] font-bold text-slate-500 uppercase tracking-widest">${project.id.split('_').pop()}</span>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          <div class="flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
            <span class="truncate max-w-[200px]" title="${esc(project.projectPath)}">${esc(project.projectPath || '未设置路径')}</span>
          </div>
          <div class="flex items-center gap-1">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"></path></svg>
            <span>分支: ${esc(project.gitBranch || '未设置')}</span>
          </div>
        </div>
      </div>
      
      <div class="flex items-center gap-2 shrink-0">
        <button class="btn-secondary btn-sm h-9 px-4" data-action="build-one" data-id="${project.id}" ${busy ? 'disabled' : ''}>
          ${busy ? '<span class="spinner w-3 h-3 border-2 mr-2"></span>' : ''} 本地打包
        </button>
        <button class="btn-primary btn-sm h-9 px-4" data-action="deploy-one" data-id="${project.id}" ${busy ? 'disabled' : ''}>
          ${busy ? '<span class="spinner w-3 h-3 border-2 mr-2"></span>' : ''} 部署
        </button>
        <div class="h-6 w-px bg-slate-200 mx-1"></div>
        <button class="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors" 
                data-action="remove" data-id="${project.id}" ${busy ? 'disabled' : ''} title="删除项目">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
      </div>
    </div>

    <!-- Alerts/Messages -->
    <div class="space-y-2">
      ${mismatch ? `
        <div class="flex items-center justify-between gap-3 p-3 rounded-2xl border border-amber-200 bg-amber-50/50">
          <div class="flex items-center gap-2 text-[11px] text-amber-800">
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            <p>分支冲突：${mismatch}</p>
          </div>
          <button class="text-[11px] font-bold text-amber-700 hover:text-amber-900 underline decoration-2 underline-offset-4 whitespace-nowrap"
                  data-action="sync-branch" data-id="${project.id}" ${busy ? 'disabled' : ''}>
            切换并同步
          </button>
        </div>` : ''}

      ${branchError ? `
        <div class="flex items-center gap-2 p-3 rounded-2xl border border-rose-200 bg-rose-50/50 text-[11px] text-rose-700">
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          <p>Git 错误：${esc(branchError)}</p>
        </div>` : ''}
    </div>

    <!-- Steps Progress -->
    <div class="deploy-steps-area transition-all duration-500 ${steps ? 'opacity-100' : 'hidden opacity-0'}">
      ${steps ? renderDeploySteps(steps) : ''}
    </div>

    <!-- Config Accordion -->
    <details class="group/config">
      <summary class="flex items-center justify-center gap-2 py-2 rounded-xl bg-slate-50 hover:bg-slate-100 cursor-pointer list-none transition-colors border border-dashed border-slate-200">
        <span class="text-[11px] font-bold text-slate-400 tracking-widest group-open/config:hidden">显示详细配置</span>
        <span class="text-[11px] font-bold text-slate-400 tracking-widest hidden group-open/config:inline">隐藏配置信息</span>
        <svg class="w-4 h-4 text-slate-400 transition-transform group-open/config:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"></path></svg>
      </summary>
      
      <div class="mt-6 space-y-8 animate-in fade-in slide-in-from-top-2 duration-300">
        <!-- Section: Build -->
        <div>
          <h4 class="flex items-center gap-2 text-xs font-bold text-slate-800 uppercase tracking-widest mb-4">
            <span class="w-1 h-3 rounded-full bg-teal-500"></span>
            本地构建配置
          </h4>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 bg-slate-50/50 p-5 rounded-2xl border border-slate-100">
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-slate-400 uppercase tracking-wider pl-1">
                项目名称
                <span class="ml-1 font-medium normal-case tracking-normal text-[10px] text-slate-400">
                  （将作为打包结果前缀，例如：my_site_0320_153045.zip）
                </span>
              </label>
              <input id="${projectInputId(project.id, 'name')}" class="form-input-new font-bold text-slate-700" value="${esc(project.name)}" placeholder="例如：我的博客项目" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-slate-400 uppercase tracking-wider pl-1">项目所在路径</label>
              <div class="flex gap-2">
                <input id="${projectInputId(project.id, 'projectPath')}" class="flex-1 form-input-new bg-white/50 text-slate-500 font-mono text-[11px]" value="${esc(project.projectPath)}" readonly title="${esc(project.projectPath)}" />
                <button class="btn-secondary h-10 px-4 shrink-0 text-[11px] font-bold" data-action="pick-path" data-id="${project.id}">选择路径</button>
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-slate-400 uppercase tracking-wider pl-1">执行构建命令</label>
              <input id="${projectInputId(project.id, 'buildCommand')}" class="form-input-new font-mono text-slate-600" value="${esc(project.buildCommand)}" placeholder="例如：npm run build" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-slate-400 uppercase tracking-wider pl-1">构建产物目录</label>
              <input id="${projectInputId(project.id, 'buildOutputDir')}" class="form-input-new font-mono text-slate-600" value="${esc(project.buildOutputDir)}" placeholder="例如：dist 或 out" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-slate-400 uppercase tracking-wider pl-1">Git 分支设定</label>
              <div class="flex gap-2">
                ${renderBranchSelect(project, rt)}
                <button class="btn-secondary h-10 px-4 shrink-0 text-[11px] font-bold" data-action="refresh-branches" data-id="${project.id}">刷新分支</button>
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-slate-400 uppercase tracking-wider pl-1">打包产物输出目录 (可选)</label>
              <div class="flex gap-2">
                <input id="${projectInputId(project.id, 'artifactOutputDir')}" class="flex-1 form-input-new bg-white/50 text-slate-500 font-mono text-[11px]" value="${esc(project.artifactOutputDir)}"
                       placeholder="留空则使用默认目录" readonly title="${esc(project.artifactOutputDir)}" />
                <button class="btn-secondary h-10 px-4 shrink-0 text-[11px] font-bold" data-action="pick-artifact-path" data-id="${project.id}">选择目录</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Section: Remote -->
        <div>
          <h4 class="flex items-center gap-2 text-xs font-bold text-slate-800 uppercase tracking-widest mb-4">
            <span class="w-1 h-3 rounded-full bg-blue-500"></span>
            远程部署配置
          </h4>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 bg-blue-50/30 p-5 rounded-2xl border border-blue-100/50">
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-blue-400 uppercase tracking-wider pl-1">接收端服务地址</label>
              <input id="${projectInputId(project.id, 'receiverBaseUrl')}" class="form-input-new font-mono text-blue-700" value="${esc(project.receiverBaseUrl)}" placeholder="http://ip:port" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-blue-400 uppercase tracking-wider pl-1">接收端鉴权 Token</label>
              <input id="${projectInputId(project.id, 'receiverToken')}" type="password" class="form-input-new font-mono text-blue-700" value="${esc(project.receiverToken)}" placeholder="输入访问令牌" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-blue-400 uppercase tracking-wider pl-1">Cloudflare Pages 项目名</label>
              <input id="${projectInputId(project.id, 'pagesProjectName')}" class="form-input-new text-blue-700" value="${esc(project.pagesProjectName)}"
                     placeholder="需要与控制台项目名一致" />
            </div>
            <div class="flex flex-col gap-1.5">
              <label class="text-[11px] font-black text-blue-400 uppercase tracking-wider pl-1">目标部署分支 (默认 main)</label>
              <input id="${projectInputId(project.id, 'deployBranch')}" class="form-input-new text-blue-700"
                     value="${esc(project.deployBranch)}" placeholder="main" />
            </div>
          </div>
        </div>
      </div>
    </details>

    <!-- Logs Panel -->
    <div class="project-log-area ${logContent ? '' : 'hidden'} mt-2 transition-all duration-300">
      <div class="flex flex-col rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div class="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
          <div class="flex items-center gap-2 text-[11px] font-black text-slate-500 uppercase tracking-widest">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7"></path></svg>
            项目构建日志
          </div>
          <button class="text-[10px] font-bold text-slate-400 hover:text-rose-500 uppercase tracking-widest transition-colors flex items-center gap-1"
                  data-action="clear-log" data-id="${project.id}">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            清除日志
          </button>
        </div>
        <div class="log-output bg-slate-950 text-slate-300 p-4 max-h-72 overflow-y-auto
                    font-mono m-0 border-0 space-y-3"
             id="log-${project.id}">${renderProjectLog(logContent)}</div>
      </div>
    </div>
  `;
  
  return el;
};
