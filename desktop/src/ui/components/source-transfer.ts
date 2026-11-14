import type { SourceProject, SourceReceipt, SourceTarget } from '../../shared/types';
import { esc } from '../utils/dom';

export interface SourcePanelState {
  request: number;
  loading: boolean;
  sending: boolean;
  pending?: boolean;
  hasRootIgnore?: boolean;
  targets: SourceTarget[];
  notice: string;
  error: string;
  log: string;
  finalPath: string;
}

export const newSourcePanel = (): SourcePanelState => ({
  request: 0,
  loading: false,
  sending: false,
  targets: [],
  notice: '',
  error: '',
  log: '',
  finalPath: '',
});

export const sourceSenderView = (projects: SourceProject[], selectedId: string): string => `
  <section class="space-y-6">
    <header class="flex items-center justify-between gap-4">
      <div><h2 class="text-xl font-bold text-slate-800">源码项目</h2>
        <p class="text-sm text-slate-500 mt-1">将项目源码发送到接收端指定目录，每次发送创建一个版本。</p></div>
      <button id="addProjectBtn" type="button" class="btn-primary h-11 px-5">创建项目</button>
    </header>
    ${projects.length ? projects.map(project => `
      <article id="card-${esc(project.id)}" class="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0"><h3 class="text-lg font-bold text-slate-800">${esc(project.name)}</h3>
            <p class="text-xs text-slate-500 break-all">${esc(project.projectPath || '尚未选择本地源码目录')}</p></div>
          <button type="button" class="btn-secondary btn-sm shrink-0" data-action="source-open" data-id="${esc(project.id)}" aria-expanded="${selectedId === project.id}">${selectedId === project.id ? '收起' : '打开项目'}</button>
        </div>
        ${selectedId === project.id ? '<div id="sourceProjectForm"></div>' : ''}
      </article>`).join('') : '<p class="rounded-3xl border border-dashed border-slate-300 p-8 text-sm text-slate-500">暂无源码项目</p>'}
  </section>`;

export const sourceProjectForm = (project: SourceProject): string => {
  const id = esc(project.id);
  return `<div class="space-y-5">
    <div class="flex items-end gap-3">
      <label class="flex-1"><span class="form-label-new">本地源码目录</span>
        <input id="p__${id}__projectPath" class="form-input-new" value="${esc(project.projectPath)}" placeholder="选择当前工作目录" readonly />
      </label><button class="btn-secondary h-10" data-action="pick-path" data-id="${id}">选择目录</button>
    </div>
    <details class="rounded-xl border border-slate-200 px-4 py-3" ${!project.projectPath || !project.receiverBaseUrl ? 'open' : ''}>
      <summary class="cursor-pointer text-sm font-semibold text-slate-700">项目与连接设置</summary>
      <div class="grid sm:grid-cols-2 gap-4 mt-4">
        <label class="sm:col-span-2"><span class="form-label-new">项目名称</span><input id="p__${id}__name" class="form-input-new" value="${esc(project.name)}" /></label>
        <label><span class="form-label-new">接收端地址</span><input id="p__${id}__receiverBaseUrl" data-source-connection="${id}" class="form-input-new" value="${esc(project.receiverBaseUrl)}" /></label>
        <label><span class="form-label-new">接收端鉴权 Token</span><input id="p__${id}__receiverToken" data-source-connection="${id}" class="form-input-new" type="password" value="${esc(project.receiverToken)}" /></label>
      </div>
      <button type="button" data-action="remove" data-id="${id}" class="btn-secondary btn-sm mt-4">移除源码项目</button>
    </details>
    <div data-source-panel></div>
  </div>`;
};

export const sourcePanelMarkup = (project: SourceProject, panel: SourcePanelState, busy: boolean): string => {
  const id = esc(project.id);
  const selected = panel.targets.find(t => t.id === project.sourceTargetId);
  const canSend = !busy && !panel.sending && !panel.loading && !!selected && !!project.projectPath && panel.pending !== undefined;
  return `
    <section class="rounded-2xl border border-teal-200 bg-teal-50/30 p-4 sm:p-5 space-y-4">
      ${project.projectPath && panel.hasRootIgnore === false ? '<p class="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800" role="status">根目录缺少 .gitignore。除 .git 外，本地配置、依赖等文件也可能被打包。</p>' : ''}
      <div>
        <label class="form-label-new" for="source-target-${id}">接收目录</label>
        <div class="flex gap-2">
          <select id="source-target-${id}" data-source-select="${id}" class="form-select flex-1 min-w-0" ${busy || panel.sending || panel.loading || !panel.targets.length ? 'disabled' : ''}>
            <option value="">${panel.loading ? '正在读取接收目录…' : '选择接收端提供的目录'}</option>
            ${panel.targets.map(t => `<option value="${esc(t.id)}" ${t.id === project.sourceTargetId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
          <button type="button" class="btn-secondary btn-sm" data-action="source-refresh" data-id="${id}" ${panel.loading || busy || panel.sending ? 'disabled' : ''}>刷新目录</button>
        </div>
        ${selected ? `<p class="font-mono text-xs text-slate-600 mt-2 break-all">${esc(selected.path)}</p>` : ''}
        ${panel.notice ? `<p role="status" class="mt-2 text-xs text-slate-600 break-all">${esc(panel.notice)}</p>` : ''}
      </div>
      ${panel.pending ? '<p class="text-xs text-amber-800">有一项发送尚未完成。继续原任务会使用上次的源码包和接收目录。</p>' : ''}
      <div class="flex flex-wrap items-center gap-2 justify-end">
        <button type="button" class="${panel.pending ? 'btn-secondary' : 'btn-primary'} btn-sm h-9 px-4" data-action="source-send" data-id="${id}" ${canSend ? '' : 'disabled'}>
          ${panel.sending ? '正在发送…' : panel.pending ? '重新打包并发送' : '打包并发送'}
        </button>
        ${panel.pending ? `<button type="button" class="btn-primary btn-sm h-9 px-4" data-action="source-retry" data-id="${id}" ${busy || panel.sending ? 'disabled' : ''}>继续原任务</button>` : ''}
      </div>
      <pre data-source-log class="${panel.log ? '' : 'hidden'} rounded-xl bg-slate-900 text-slate-100 p-3 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">${esc(panel.log)}</pre>
      ${panel.error ? `<p role="alert" class="text-xs text-rose-700 break-all">${esc(panel.error)}</p>` : ''}
      ${panel.finalPath ? `
        <div role="status" class="rounded-xl border border-teal-200 bg-white p-3 space-y-1">
          <p class="font-bold text-xs text-teal-700">已解压到远端版本目录</p>
          <div class="flex flex-wrap items-center gap-2"><code class="flex-1 text-xs break-all">${esc(panel.finalPath)}</code>
            <button type="button" data-action="source-copy" data-id="${id}" class="btn-secondary btn-sm">复制路径</button>
          </div>
        </div>` : ''}
    </section>`;
};

export const sourceTargetRows = (targets: SourceTarget[]): string => targets.length
  ? targets.map(t => `
      <div class="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
        <label class="block">
          <span class="form-label-new">目录名称</span>
          <input type="text" class="form-input-new" data-source-target-name="${esc(t.id)}" value="${esc(t.name)}" />
        </label>
        <p class="font-mono text-xs text-slate-600 break-all">${esc(t.path)}</p>
        <div class="flex gap-2">
          <button type="button" class="btn-secondary btn-sm" data-target-change="${esc(t.id)}">选择目录</button>
          <button type="button" class="btn-secondary btn-sm" data-target-remove="${esc(t.id)}" title="从接收配置中移除目录">移除</button>
        </div>
      </div>`).join('')
  : '<p class="text-xs text-slate-500">添加本机文件夹后，发送端即可选择它来接收源码。</p>';

export const sourceReceiptRows = (receipts: SourceReceipt[]): string => receipts.length
  ? receipts.map(r => `
      <article class="p-3 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <strong class="text-sm text-slate-800 break-all">${esc(r.projectName)}</strong>
          <span class="badge-success">已解压</span>
          <time class="ml-auto text-xs text-slate-500">${esc(new Date(r.completedAt).toLocaleString())}</time>
        </div>
        <p class="text-xs text-slate-600">${esc(r.targetName)}</p>
        <div class="flex items-center gap-2">
          <code class="flex-1 min-w-0 break-all text-xs">${esc(r.finalPath)}</code>
          <button type="button" class="btn-secondary btn-sm shrink-0" data-open-receipt="${esc(r.id)}">打开目录</button>
        </div>
      </article>`).join('')
  : '<p class="text-xs text-slate-500">完成解压后，源码版本会显示在这里。</p>';
