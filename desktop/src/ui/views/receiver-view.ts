export type ReceiverPage = 'deploy' | 'source';
export const receiverViewTemplate = (page: ReceiverPage): string => `
  <section id="receiverSection" class="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          接收端服务
          <span class="px-2 py-0.5 rounded-lg bg-blue-50 text-blue-600 text-[10px] font-bold tracking-widest border border-blue-100">接收端模式</span>
        </h2>
        <p class="text-sm text-slate-400 mt-1">部署构建产物，或将收到的源码解压到新的版本目录。</p>
      </div>
      
      <!-- Status Controls -->
      <div class="flex items-center p-1.5 rounded-2xl bg-white border border-slate-200 shadow-sm">
        <div id="receiverStatusDot" class="w-3 h-3 rounded-full bg-slate-300 mx-3"></div>
        <span id="receiverStatusText" class="text-xs font-bold text-slate-500 mr-4 tracking-widest whitespace-nowrap">服务未就绪</span>
        <button id="startReceiverBtn" class="btn-primary h-10 px-6 rounded-xl text-xs font-bold shadow-lg shadow-teal-500/20">启动服务</button>
        <button id="stopReceiverBtn" class="btn-secondary h-10 px-6 rounded-xl text-xs font-bold hidden">停止服务</button>
      </div>
    </div>

    <div role="group" aria-label="接收任务类型" class="flex gap-2 border-b border-slate-200 pb-3">
      <button data-receiver-page="deploy" aria-pressed="${page === 'deploy'}" class="${page === 'deploy' ? 'btn-primary' : 'btn-secondary'} btn-sm h-9">产物部署</button>
      <button data-receiver-page="source" aria-pressed="${page === 'source'}" class="${page === 'source' ? 'btn-primary' : 'btn-secondary'} btn-sm h-9">源码接收</button>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
      <!-- Left: Config -->
      <div class="lg:col-span-1 flex flex-col gap-6">
        <!-- Service Config -->
        <div class="p-6 rounded-3xl bg-white border border-slate-200 shadow-sm space-y-6">
          <div class="flex items-center gap-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            服务设置
          </div>
          
          <div class="space-y-4">
            <div class="space-y-1.5">
              <label class="form-label-new">监听地址</label>
              <input id="receiverHost" class="form-input-new" placeholder="127.0.0.1" />
            </div>
            <div class="space-y-1.5">
              <label class="form-label-new">监听端口</label>
              <input id="receiverPort" type="number" class="form-input-new" placeholder="17777" />
            </div>
            <div class="space-y-1.5">
              <label class="form-label-new">鉴权 Token</label>
              <input id="authToken" type="password" class="form-input-new" placeholder="••••••••" />
            </div>
          </div>
        </div>

        ${page === 'source' ? `<section class="p-5 rounded-3xl bg-white border border-slate-200 shadow-sm space-y-4">
          <h3 class="text-sm font-bold text-slate-800">源码接收目录</h3>
          <div id="sourceTargetRows" class="space-y-3"></div>
          <button id="addSourceTarget" type="button" class="btn-secondary btn-sm">添加目录</button>
        </section>` : `
        <!-- Cloudflare Config -->
        <div class="p-6 rounded-3xl bg-blue-50/50 border border-blue-100 shadow-sm space-y-6">
          <div class="flex items-center gap-3 text-xs font-bold text-blue-500 uppercase tracking-widest">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"></path></svg>
            Cloudflare 凭据
          </div>
          
          <div class="space-y-4">
            <div class="space-y-1.5">
              <label class="form-label-new text-blue-700">API Token</label>
              <input id="cfToken" type="password" class="form-input-new border-blue-200 focus:border-blue-500 bg-white" />
            </div>
            <div class="space-y-1.5">
              <label class="form-label-new text-blue-700">Account ID</label>
              <input id="cfAccountId" class="form-input-new border-blue-200 focus:border-blue-500 bg-white" />
            </div>
          </div>
        </div>`}

        <!-- Advanced -->
        <details class="group/adv">
          <summary class="flex items-center justify-between p-4 rounded-2xl bg-slate-50 border border-slate-200 cursor-pointer list-none hover:bg-slate-100 transition-colors">
            <span class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">高级配置 (通常保持默认即可)</span>
            <svg class="w-4 h-4 text-slate-400 transition-transform group-open/adv:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"></path></svg>
          </summary>
          <div class="p-4 pt-6 space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
            <div class="space-y-1.5">
              <label class="form-label-new">最大上传限制 (MB)</label>
              <input id="maxUploadMb" type="number" class="form-input-new font-mono" />
            </div>
            ${page === 'deploy' ? `<div class="space-y-1.5">
              <label class="form-label-new">Wrangler 命令路径</label>
              <input id="wranglerBin" class="form-input-new font-mono" />
            </div>` : ''}
            <div class="space-y-1.5">
              <label class="form-label-new">工作目录名称 (默认位于用户主目录下)</label>
              <input id="workRootName" class="form-input-new font-mono" />
            </div>
          </div>
        </details>
      </div>

      <!-- Right: Tasks + Guide -->
      <div class="lg:col-span-2 flex flex-col gap-6">
        ${page === 'source' ? `<section class="p-5 rounded-3xl bg-white border border-slate-200 shadow-sm space-y-4">
          <h3 class="text-sm font-bold text-slate-800">源码接收记录</h3>
          <div id="sourceReceiptRows" class="space-y-2 max-h-96 overflow-y-auto"></div>
        </section>` : `
        <!-- Task Records -->
        <div id="receiverTasksSection" class="p-6 rounded-3xl bg-white border border-slate-200 shadow-sm flex flex-col gap-5 min-h-[400px]">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
              构建产物部署记录
            </div>
            <span class="px-2.5 py-1 rounded-lg bg-slate-50 text-slate-400 text-[10px] font-bold tracking-wider border border-slate-100">实时状态</span>
          </div>

          <div id="receiverTasksWrap" class="flex flex-col gap-4">
            <div class="flex flex-col items-center justify-center py-20 text-slate-300">
              <svg class="w-12 h-12 mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
              <p class="text-sm italic">等待构建产物上传…</p>
            </div>
          </div>
        </div>
        <!-- Deploy Guide -->
        <details class="group/guide">
          <summary class="flex items-center justify-between p-5 rounded-3xl bg-amber-50 border border-amber-200 cursor-pointer list-none hover:bg-amber-100/50 transition-colors relative z-10">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center text-amber-700">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
              </div>
              <div>
                <span class="text-sm font-bold text-amber-800">首次使用指引</span>
                <p class="text-[11px] text-amber-700 mt-0.5 opacity-80">点击折叠 / 展开 Cloudflare Tunnel 与 Wrangler 配置流程</p>
              </div>
            </div>
            <svg class="w-5 h-5 text-amber-400 transition-transform group-open/guide:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"></path></svg>
          </summary>
          <div class="p-6 pt-8 bg-amber-50/30 border-x border-b border-amber-200 rounded-b-3xl -mt-6 animate-in fade-in slide-in-from-top-2">
            <ol class="space-y-5">
              <li class="flex gap-4">
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-amber-200 text-[11px] font-bold text-amber-700 flex items-center justify-center shadow-sm">1</span>
                <div class="text-xs text-amber-900 leading-relaxed">
                  <p class="font-bold mb-1.5 text-[13px]">配置 Cloudflare Pages 部署凭据并检查 Wrangler</p>
                  <ol class="list-decimal pl-4 space-y-1 mb-2">
                    <li>登录 Cloudflare 控制台，进入「我的个人资料 → API 令牌」，点击「创建令牌」并填写令牌名称。</li>
                    <li>在「权限策略」中任选一种方式。
                      <ul class="list-disc pl-4 space-y-1 mt-1">
                        <li>接收端只部署 Pages 时，推荐选<strong>「从头开始（Custom）」</strong>，在「权限」中只添加<strong>账户 → Cloudflare Pages → 编辑</strong>。</li>
                        <li><strong>Edit Cloudflare Workers</strong> 模板可直接用于 Pages 部署，也会授予其他 Workers 相关权限。</li>
                      </ul>
                    </li>
                    <li>在「账户资源」中选择「包括 → 特定账户」，仅选中<strong>部署项目所在的账户</strong>。</li>
                    <li>点击「继续查看摘要 → 创建令牌」，复制生成的令牌值，粘贴到接收端「Cloudflare 凭据」的 <strong>API Token</strong> 输入框。</li>
                    <li>在 Cloudflare 控制台切换到刚才选定的账户，进入「Workers &amp; Pages → 账户详情（Account Details）」，复制 <strong>Account ID</strong>，粘贴到接收端「Cloudflare 凭据」的 <strong>Account ID</strong> 输入框。</li>
                  </ol>
                  <p class="mb-1">在接收端终端检查 Wrangler 版本。</p>
                  <code class="block bg-white/80 px-2 py-1 rounded border border-amber-200 font-mono text-[11px] mb-2 text-slate-800">npx wrangler --version</code>
                  <p class="mb-1">如果需要交互式登录（API Token 模式可跳过）：</p>
                  <code class="block bg-white/80 px-2 py-1 rounded border border-amber-200 font-mono text-[11px] text-slate-800">npx wrangler login</code>
                </div>
              </li>
              <li class="flex gap-4">
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-amber-200 text-[11px] font-bold text-amber-700 flex items-center justify-center shadow-sm">2</span>
                <div class="text-xs text-amber-900 leading-relaxed">
                  <p class="font-bold mb-1.5 text-[13px]">安装外网穿透 (Cloudflare Tunnel) <span class="font-normal text-[11px] text-amber-700 ml-1">—— 仅用于公网访问本地机器</span></p>
                  <p class="mb-1">使用 Homebrew 安装 cloudflared：</p>
                  <code class="block bg-white/80 px-2 py-1 rounded border border-amber-200 font-mono text-[11px] mb-2 text-slate-800">brew install cloudflared</code>
                  <p class="mb-1">要获取 Tunnel Token，登录 Cloudflare 控制台，进入 <strong>Networking → Tunnels</strong>。</p>
                  <ul class="list-disc pl-4 space-y-1 mb-2">
                    <li><strong>已有隧道</strong>时，选中接收端要使用的隧道，在 <strong>Overview</strong> 中点击 <strong>Add a replica</strong>，选择 macOS 即可看到安装命令。</li>
                    <li><strong>首次创建</strong>时，点击 <strong>Create Tunnel</strong>，输入名称并确认创建。在 <strong>Setup Environment</strong> 中选择 macOS 和接收端 Mac 的芯片架构，然后找到 <strong>Install and Run</strong> 下的安装命令。</li>
                  </ul>
                  <p>安装命令中，<code class="font-mono">sudo cloudflared service install</code> 后以 <code class="font-mono">eyJ</code> 开头的字符串就是这条隧道的 Token。复制控制台里的整条命令，在接收端 Mac 的终端执行，即可注册并启动隧道服务。</p>
                </div>
              </li>
              <li class="flex gap-4">
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-amber-200 text-[11px] font-bold text-amber-700 flex items-center justify-center shadow-sm">3</span>
                <div class="text-xs text-amber-900 leading-relaxed">
                  <p class="font-bold mb-1.5 text-[13px]">验证 Tunnel 服务状态</p>
                  <p class="mb-1">执行以下命令检查服务是否已注册并在运行：</p>
                  <code class="block bg-white/80 px-2 py-1 rounded border border-amber-200 font-mono text-[11px] text-slate-800">sudo launchctl list | grep -i cloudflared</code>
                </div>
              </li>
              <li class="flex gap-4">
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-amber-200 text-[11px] font-bold text-amber-700 flex items-center justify-center shadow-sm">4</span>
                <div class="text-xs text-amber-900 leading-relaxed">
                  <p class="font-bold mb-1.5 text-[13px]">配置 Cloudflare Tunnel 路由</p>
                  <ol class="list-decimal pl-4 space-y-1">
                    <li>在 Cloudflare 控制台的 <strong>Networking → Tunnels</strong> 选中接收端使用的隧道。打开「路由」，点击「添加路由」，类型选<strong>「已发布的应用程序」</strong>。</li>
                    <li>填写子域名（如 <code>deploy</code>），选择已接入 Cloudflare 的域名。「路径」留空，让健康检查和上传请求都走这条路由。</li>
                    <li>如果 cloudflared 和接收端在同一台 Mac 上，默认服务地址填 <code>http://127.0.0.1:17777</code>。若界面分栏显示，协议选 <strong>HTTP</strong>，地址填 <code>127.0.0.1:17777</code>。端口以接收端「服务设置」中的监听端口为准，填好后保存路由。</li>
                  </ol>
                </div>
              </li>
              <li class="flex gap-4">
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-amber-200 text-[11px] font-bold text-amber-700 flex items-center justify-center shadow-sm">5</span>
                <div class="text-xs text-amber-900 leading-relaxed">
                  <p class="font-bold mb-1.5 text-[13px]">启动接收服务并验证连通性</p>
                  <ol class="list-decimal pl-4 space-y-1">
                    <li>在接收端点击「启动服务」。用这台 Mac 的浏览器打开本机服务地址下的 <code>/healthz</code>，默认是 <code>http://127.0.0.1:17777/healthz</code>。看到 <code>{"ok":true}</code> 表示接收服务已就绪。</li>
                    <li>在发送端浏览器打开 <code>https://你的完整子域名/healthz</code>，域名使用上一步保存的实际值。看到同样的 <code>{"ok":true}</code> 表示公网路由已连通。</li>
                  </ol>
                </div>
              </li>
              <li class="flex gap-4">
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-amber-200 text-[11px] font-bold text-amber-700 flex items-center justify-center shadow-sm">6</span>
                <div class="text-xs text-amber-900 leading-relaxed">
                  <p class="font-bold mb-1.5 text-[13px]">配置发送端地址</p>
                  <p>在发送端项目配置中，将 <strong>接收端地址</strong> 改为 Tunnel 域名（如 <code class="font-mono bg-white/80 px-1.5 py-0.5 rounded border border-amber-200 text-[11px]">https://deploy.example.com</code>），Token 填写接收端「服务设置」中的<strong>鉴权 Token</strong>。</p>
                </div>
              </li>
              <li class="flex gap-4">
                <span class="flex-shrink-0 w-6 h-6 rounded-full bg-white border border-amber-200 text-[11px] font-bold text-amber-700 flex items-center justify-center shadow-sm">7</span>
                <div class="text-xs text-amber-900 leading-relaxed">
                  <p class="font-bold mb-1.5 text-[13px]">卸载与移除服务（不再使用时）</p>
                  <p class="mb-1">先停止并卸载服务：</p>
                  <code class="block bg-white/80 px-2 py-1 rounded border border-amber-200 font-mono text-[11px] mb-2 text-slate-800">sudo cloudflared service uninstall</code>
                  <p class="mb-1">若需彻底移除程序：</p>
                  <code class="block bg-white/80 px-2 py-1 rounded border border-amber-200 font-mono text-[11px] text-slate-800">brew uninstall cloudflared</code>
                </div>
              </li>
            </ol>
          </div>
        </details>`}
      </div>
    </div>
  </section>
`;
