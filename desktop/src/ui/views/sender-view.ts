export const senderViewTemplate = `
  <section id="senderSection" class="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          发送端工作区
          <span class="px-2 py-0.5 rounded-lg bg-teal-50 text-teal-600 text-[10px] font-bold tracking-widest border border-teal-100">发送端模式</span>
        </h2>
        <p class="text-sm text-slate-400 mt-1">管理并打包本地项目，一键部署至远程接收端。</p>
      </div>
      <button id="addProjectBtn" class="btn-primary flex items-center gap-2 h-11 px-5 shadow-lg shadow-teal-500/20">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"></path></svg>
        添加项目
      </button>
    </div>

    <div id="projectsWrap" class="grid grid-cols-1 gap-5">
      <!-- Project cards will be rendered here -->
    </div>

    <!-- Batch Actions Bar -->
    <div class="sticky bottom-6 z-10 flex items-center justify-center pointer-events-none">
      <div class="inline-flex items-center p-2 rounded-2xl bg-white/80 backdrop-blur-xl border border-slate-200 shadow-2xl shadow-slate-900/10 pointer-events-auto ring-1 ring-slate-900/5 transition-all duration-300 hover:shadow-teal-500/10 hover:border-teal-500/30">
        <button id="buildAllBtn" class="btn-secondary h-11 px-6 rounded-xl text-sm font-bold flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
          批量打包
        </button>
        <div class="w-px h-6 bg-slate-200 mx-3"></div>
        <button id="deployAllBtn" class="btn-primary h-11 px-8 rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-teal-500/20">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
          部署所有项目
        </button>
      </div>
    </div>
  </section>
`;
