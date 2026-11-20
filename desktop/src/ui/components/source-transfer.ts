import type { SourceProject, SourceReceipt, SourceTarget } from '../../shared/types';
import { esc } from '../utils/dom';

export interface SourcePanelState {
  request: number;
  loading: boolean;
  sending: boolean;
  initialized: boolean;
  pending?: boolean;
  hasRootIgnore?: boolean;
  targets: SourceTarget[];
  notice: string;
  noticeIsError: boolean;
  error: string;
  finalPath: string;
}

export const newSourcePanel = (): SourcePanelState => ({
  request: 0,
  loading: false,
  sending: false,
  initialized: false,
  targets: [],
  notice: '',
  noticeIsError: false,
  error: '',
  finalPath: '',
});

export const sourceTargetMarkup = (project: SourceProject, panel: SourcePanelState, busy: boolean): string => {
  const id = esc(project.id);
  const selected = panel.targets.find(t => t.id === project.sourceTargetId);
  return `
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
        ${panel.notice ? `<p role="${panel.noticeIsError ? 'alert' : 'status'}" class="mt-2 text-xs leading-relaxed whitespace-pre-line break-words ${panel.noticeIsError ? 'rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900' : 'text-slate-600'}">${esc(panel.notice)}</p>` : ''}
      </div>
`;
};

export const sourceResultMarkup = (project: SourceProject, panel: SourcePanelState): string => {
  const id = esc(project.id);
  return `
    ${project.projectPath && panel.hasRootIgnore === false ? '<p class="text-xs text-amber-800">根目录缺少 .gitignore，本地配置和依赖文件也可能被打包。</p>' : ''}
    ${panel.pending ? '<p class="text-xs text-amber-800">有未完成的发送。「继续原任务」使用上次的源码包和接收目录。</p>' : ''}
      ${panel.error ? `<p role="alert" class="text-xs text-rose-700 whitespace-pre-line break-words">${esc(panel.error)}</p>` : ''}
      ${panel.finalPath ? `
        <div role="status" class="rounded-xl border border-teal-200 bg-white p-3 space-y-1">
          <p class="font-bold text-xs text-teal-700">已解压到远端版本目录</p>
          <div class="flex flex-wrap items-center gap-2"><code class="flex-1 text-xs break-all">${esc(panel.finalPath)}</code>
            <button type="button" data-action="source-copy" data-id="${id}" class="btn-secondary btn-sm">复制路径</button>
          </div>
        </div>` : ''}
  `;
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
