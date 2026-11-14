export const senderViewTemplate = `
  <section id="senderSection" class="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          部署项目
        </h2>
        <p class="text-sm text-slate-500 mt-1">构建项目，生成本地 ZIP，或将构建产物部署到 Cloudflare Pages。</p>
      </div>
      <button id="addProjectBtn" class="btn-primary flex items-center gap-2 h-11 px-5 shadow-lg shadow-teal-500/20">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"></path></svg>
        创建项目
      </button>
    </div>

    <div id="projectsWrap" class="grid grid-cols-1 gap-5">
      <!-- Project cards will be rendered here -->
    </div>
  </section>
`;
