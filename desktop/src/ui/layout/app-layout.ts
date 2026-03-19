import logoUrl from '../../assets/logo.svg';

export const appLayoutTemplate = `
<div class="flex min-h-screen bg-slate-50 font-sans text-slate-900 selection:bg-teal-100 selection:text-teal-900">
  <!-- Sidebar -->
  <aside class="w-72 flex-shrink-0 flex flex-col bg-white border-r border-slate-200 z-30 shadow-[4px_0_24px_rgba(0,0,0,0.02)]">
    <!-- Brand -->
    <div class="h-20 flex items-center px-8 border-b border-slate-100">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl bg-teal-600 flex items-center justify-center shadow-lg shadow-teal-500/20">
          <img src="${logoUrl}" alt="Logo" class="w-6 h-6 invert" />
        </div>
        <div>
          <h1 class="font-black text-slate-800 text-lg tracking-tight leading-none">Web Publisher</h1>
          <span class="text-[10px] font-bold text-teal-600 uppercase tracking-[0.2em] mt-1 block">网页便捷发布</span>
        </div>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 px-4 py-8 space-y-2">
      <div class="px-4 mb-4">
        <span class="text-[10px] font-bold text-slate-400 tracking-widest">运行模式</span>
      </div>
      
      <button id="navSenderBtn" class="w-full flex items-center gap-3 px-4 h-12 rounded-2xl text-sm font-bold transition-all duration-200 group nav-btn-active">
        <div class="w-8 h-8 rounded-xl bg-teal-50 flex items-center justify-center text-teal-600 group-hover:scale-110 transition-transform">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
        </div>
        发送端工作区
      </button>

      <button id="navReceiverBtn" class="w-full flex items-center gap-3 px-4 h-12 rounded-2xl text-sm font-bold transition-all duration-200 group text-slate-500 hover:bg-slate-50">
        <div class="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center text-slate-500 group-hover:scale-110 transition-transform">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
        </div>
        接收端服务
      </button>

      <div class="px-4 pt-8 mb-4 border-t border-slate-50">
        <span class="text-[10px] font-bold text-slate-400 tracking-widest">应用设置</span>
      </div>

      <!-- Mode Switcher (Radios) -->
      <div class="px-2 space-y-1">
        <label class="flex items-center gap-3 px-3 h-10 rounded-xl cursor-pointer hover:bg-slate-50 transition-colors group">
          <input type="radio" name="mode" value="sender" class="w-4 h-4 accent-teal-600" />
          <span class="text-xs font-bold text-slate-500 group-hover:text-slate-700">仅发送端</span>
        </label>
        <label class="flex items-center gap-3 px-3 h-10 rounded-xl cursor-pointer hover:bg-slate-50 transition-colors group">
          <input type="radio" name="mode" value="receiver" class="w-4 h-4 accent-teal-600" />
          <span class="text-xs font-bold text-slate-500 group-hover:text-slate-700">仅接收端</span>
        </label>
        <label class="flex items-center gap-3 px-3 h-10 rounded-xl cursor-pointer hover:bg-slate-50 transition-colors group">
          <input type="radio" name="mode" value="both" class="w-4 h-4 accent-teal-600" />
          <span class="text-xs font-bold text-slate-500 group-hover:text-slate-700">双端调试模式</span>
        </label>
      </div>
    </nav>

    <!-- Footer -->
    <div class="p-6 space-y-4">
      <div class="p-4 rounded-2xl bg-slate-900 text-white shadow-xl shadow-slate-900/20">
        <p class="text-[10px] font-bold text-slate-500 tracking-widest mb-3">配置保存</p>
        <p class="text-[11px] leading-relaxed text-slate-400 mb-4 opacity-80">修改后点击保存全部配置以生效。</p>
        <button id="saveBtn" class="w-full h-11 bg-teal-500 hover:bg-teal-400 text-white font-bold text-sm rounded-xl transition-all active:scale-95 shadow-lg shadow-teal-500/20">
          保存全部配置
        </button>
      </div>
      <div id="configPathTip" class="text-[10px] text-slate-400 truncate opacity-60 hover:opacity-100 transition-opacity cursor-help px-2" title=""></div>
    </div>
  </aside>

  <!-- Main Content -->
  <main class="flex-1 flex flex-col h-screen overflow-hidden relative">
    <!-- Header/Overview -->
    <header class="h-20 bg-white/60 backdrop-blur-md border-b border-slate-200 px-10 flex items-center justify-between z-20 sticky top-0">
      <div class="flex items-center gap-8">
        <div>
          <p class="text-[10px] font-bold text-slate-400 tracking-widest">当前运行模式</p>
          <p id="overviewMode" class="text-sm font-black text-slate-800 mt-0.5">-</p>
        </div>
        <div class="w-px h-8 bg-slate-200"></div>
        <div>
          <p class="text-[10px] font-bold text-slate-400 tracking-widest">项目总数</p>
          <p id="overviewProjectCount" class="text-sm font-black text-slate-800 mt-0.5">0</p>
        </div>
        <div class="w-px h-8 bg-slate-200"></div>
        <div>
          <p class="text-[10px] font-bold text-slate-400 tracking-widest">接收端状态</p>
          <p id="overviewReceiverStatus" class="text-sm font-black text-slate-800 mt-0.5">未知</p>
        </div>
      </div>

      <div class="flex items-center gap-4">
        <div class="flex -space-x-2">
           <div class="w-8 h-8 rounded-full bg-teal-100 border-2 border-white flex items-center justify-center text-teal-700 text-[10px] font-bold">发</div>
           <div class="w-8 h-8 rounded-full bg-blue-100 border-2 border-white flex items-center justify-center text-blue-700 text-[10px] font-bold">接</div>
        </div>
      </div>
    </header>

    <!-- Scrollable Content Area -->
    <div class="flex-1 overflow-y-auto p-10 custom-scrollbar scroll-smooth">
      <div id="viewContainer" class="max-w-6xl mx-auto">
        <!-- Views will be injected here -->
      </div>
    </div>
  </main>
</div>
`;
