// OpenAgent Session Viewer — 前端
(function () {
  'use strict';

  // ---------- state ----------
  let state = {
    source: 'claude',
    currentSessionId: '',
    catalog: null,
    activeKind: null,
    projectRoot: '',   // 本地索引扫描的具体项目文件夹
    projectOptions: [], // 可选项目目录(默认 C:\Users\Light 等)
    apiDraft: {},       // 临时会话命令各字段草稿,key=字段名,切 source 时 dump/restore,信息保留复用
  };

  const $ = (id) => document.getElementById(id);
  const el = (t, cls) => { const e = document.createElement(t); if (cls) e.className = cls; return e; };

  // 各 source 启动命令字段
  const CMD_FIELDS = {
    claude: { bin: 'claude',
      fields: [
        { key: 'model', label: '模型', type: 'select', options: [['', '默认模型'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable'], ['custom', '手动输入']] },
        { key: 'customModel', label: '自定义模型 ID', type: 'text', showIfModel: 'custom' },
        { key: 'effort', label: '推理强度', type: 'select', options: [['', '默认'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']] },
        { key: 'permission', label: '权限', type: 'select', options: [['default', '默认确认'], ['acceptEdits', '自动接受编辑'], ['plan', '计划模式'], ['bypassPermissions', '跳过确认']] },
        { key: 'cwd', label: '工作目录', type: 'text', wide: true },
        { key: 'prompt', label: '启动提示词', type: 'textarea', wide: true },
      ] },
    codex: { bin: 'codex',
      fields: [
        { key: 'model', label: '模型', type: 'select', options: [['', '默认模型'], ['gpt-5', 'gpt-5'], ['gpt-5-codex', 'gpt-5-codex'], ['o3', 'o3'], ['custom', '手动输入']] },
        { key: 'customModel', label: '自定义模型 ID', type: 'text', showIfModel: 'custom' },
        { key: 'sandbox', label: '沙箱', type: 'select', options: [['', '默认'], ['workspace-write', 'workspace-write'], ['read-only', 'read-only'], ['danger-full-access', 'danger-full-access']] },
        { key: 'approval', label: '审批策略', type: 'select', options: [['', '默认'], ['on-request', 'on-request'], ['on-failure', 'on-failure'], ['never', 'never']] },
        { key: 'cwd', label: '工作目录', type: 'text', wide: true },
        { key: 'prompt', label: '启动提示词', type: 'textarea', wide: true },
      ] },
    opencode: { bin: 'opencode',
      fields: [
        { key: 'subcmd', label: '子命令', type: 'select', options: [['tui', 'TUI (默认/可恢复)'], ['run', 'run (单轮执行)'], ['serve', 'serve'], ['auth', 'auth login'], ['models', 'models']] },
        { key: 'sessionId', label: '会话 ID(恢复用 --session)', type: 'text', wide: true, showIfSub: 'tui' },
        { key: 'cwd', label: '工作目录', type: 'text', wide: true },
        { key: 'prompt', label: '启动提示词', type: 'textarea', wide: true },
      ] },
  };

  const CATALOG_KINDS = {
    claude: [['mcpServers', 'MCP', 'MCP Servers'], ['agents', 'Agents', '子智能体'], ['commands', 'Commands', '斜杠命令'], ['skills', 'Skills', 'Skills']],
    codex: [['mcpServers', 'MCP', 'MCP Servers'], ['tools', 'Tools', '工具命名空间'], ['commands', 'Commands', '启动命令']],
    opencode: [['models', 'Models', '模型'], ['tools', 'Tools', '会话工具'], ['commands', 'Commands', '启动命令']],
  };

  const DEFAULT_PROJECT = 'C:\\Users\\Light';

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 1800);
  }
  function quotePS(v) { v = String(v || '').trim(); return v ? `"${v.replace(/`/g, '``').replace(/"/g, '`"')}"` : ''; }
  function quoteArg(v) { v = String(v || '').trim(); return v ? `"${v.replace(/"/g, '\\"')}"` : ''; }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&', '<': '<', '>': '>' }[c])); }

  // ---------- URL 持久化 ----------
  function setStateFromURL() {
    const m = location.pathname.match(/^\/session\/([\w-]+)\/([^/]+)/);
    if (m) { state.source = m[1]; state.currentSessionId = m[2]; }
    const sp = new URLSearchParams(location.search);
    if (sp.get('src')) state.source = sp.get('src');
    if (sp.get('project')) state.projectRoot = sp.get('project');
  }
  function pushURL() {
    let p = '/';
    if (state.currentSessionId) p = `/session/${state.source}/${state.currentSessionId}`;
    const q = new URLSearchParams();
    if (state.projectRoot) q.set('project', state.projectRoot);
    const qs = q.toString() ? '?' + q.toString() : '';
    history.replaceState(null, '', p + qs);
  }

  // ---------- source 切换 ----------
  function setActiveSourceTab() {
    document.querySelectorAll('.source-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.source === state.source));
  }
  document.querySelectorAll('.source-tab').forEach(btn => {
    btn.onclick = () => {
      if (state.source === btn.dataset.source) return;
      state.source = btn.dataset.source;
      onSourceChange();
    };
  });

  function onSourceChange() {
    dumpApiDraft();
    setActiveSourceTab();
    updateHero();
    buildResumeCmd();
    renderCmdBuilder(true);
    buildApiFields();
    restoreFromDraft();
    showHome();              // 切 source 一律回首页,不再停留旧会话视图
    loadSessions();
    loadCatalog();
  }
  // 切换 source 前把当前临时会话表单的值存进 draft(共通字段跨源保留+各 source param 分键),
  // 重建表单后再回填——切智能体时已填信息不丢失。空值不清空已有 draft(避免换源时被空表单覆盖)。
  function dumpApiDraft() {
    document.querySelectorAll('#api-builder-grid [data-apikey]').forEach(e => {
      const k = e.dataset.apikey;
      const v = apiVal(k);
      if (v) state.apiDraft[k] = v;
    });
  }
  function restoreFromDraft() {
    Object.entries(state.apiDraft || {}).forEach(([k, v]) => {
      const e = document.querySelector(`#api-builder-grid [data-apikey="${k}"]`);
      if (!e || !v) return;
      // combo/普通 input 都直接赋 value;param select 赋无对应 option 的值会保持空,无碍。
      e.value = v;
      e.dispatchEvent(new Event('input'));
    });
  }
  function showHome() {
    state.currentSessionId = '';
    buildResumeCmd();
    highlightActive();
    pushURL();
    $('conversation-view').style.display = 'none';
    $('welcome-state').style.display = 'block';
  }
  function updateHero() {
    const map = { claude: ['Claude', 'Claude Code 本机会话,默认读取 ~/.claude/projects。'],
                   codex: ['Codex', 'Codex CLI 会话,默认读取 ~/.codex/sessions。'],
                   opencode: ['OpenCode', 'OpenCode 会话,默认读取本地 opencode.db。'] };
    $('hero-title').textContent = map[state.source][0];
    $('hero-desc').textContent = map[state.source][1];
  }

  // ---------- 恢复命令(顶部常驻) ----------
  function buildResumeCmd() {
    const bar = $('resume-bar');
    if (state.currentSessionId) {
      bar.classList.add('show');
      let cmd;
      if (state.source === 'claude') cmd = `claude -r ${state.currentSessionId}`;
      else if (state.source === 'codex') cmd = `codex resume ${state.currentSessionId}`;
      else cmd = `opencode --session ${state.currentSessionId}`;
      $('resume-cmd').textContent = cmd;
    } else {
      bar.classList.remove('show');
    }
  }
  $('copy-resume-btn').onclick = async () => {
    if (!state.currentSessionId) return;
    await navigator.clipboard.writeText($('resume-cmd').textContent).catch(() => {});
    toast('已复制恢复命令');
  };

  // ---------- 启动命令生成器 ----------
  function buildCommand() {
    const def = CMD_FIELDS[state.source];
    const parts = [def.bin];
    const fv = {};
    document.querySelectorAll('#builder-grid .b-field').forEach(f => fv[f.dataset.key] = (f.value || '').trim());
    if (state.source === 'claude') {
      if (fv.model === 'custom') { if (fv.customModel) parts.push('--model', fv.customModel); }
      else if (fv.model) parts.push('--model', fv.model);
      if (fv.effort) parts.push('--effort', fv.effort);
      if (fv.permission && fv.permission !== 'default') parts.push('--permission-mode', fv.permission);
      if (fv.prompt) parts.push(quoteArg(fv.prompt));
    } else if (state.source === 'codex') {
      if (fv.model === 'custom') { if (fv.customModel) parts.push('--model', fv.customModel); }
      else if (fv.model) parts.push('--model', fv.model);
      if (fv.sandbox) parts.push('--sandbox', fv.sandbox);
      if (fv.approval) parts.push('--ask-for-approval', fv.approval);
      if (fv.prompt) parts.push(quoteArg(fv.prompt));
    } else {
      const sub = fv.subcmd || 'tui';
      if (sub === 'tui') { if (fv.sessionId) parts.push('--session', fv.sessionId); if (fv.prompt) parts.push(quoteArg(fv.prompt)); }
      else if (sub === 'run') { parts.push('run'); if (fv.sessionId) parts.push('-s', fv.sessionId); if (fv.prompt) parts.push(quoteArg(fv.prompt)); }
      else if (sub === 'serve') parts.push('serve');
      else if (sub === 'auth') parts.push('auth', 'login');
      else if (sub === 'models') parts.push('models');
    }
    let cmd = parts.join(' ');
    if (fv.cwd) cmd = `Set-Location -LiteralPath ${quotePS(fv.cwd)}; ${cmd}`;
    $('generated-command').textContent = cmd;
  }
  function fieldVal(key) {
    const e = document.querySelector(`#builder-grid .b-field[data-key="${key}"]`);
    return e ? e.value : '';
  }
  function renderCmdBuilder(forceRebuild) {
    // 切换 source 时强制重建;同 source 内字段联动只切显隐,避免清空已填值。
    const def = CMD_FIELDS[state.source];
    $('cmd-source-label').textContent = state.source + ' · launch command';
    const grid = $('builder-grid');
    if (forceRebuild) grid.innerHTML = '';
    def.fields.forEach(f => {
      let lbl = grid.querySelector(`label[data-key="${f.key}"]`);
      if (!lbl) {
        lbl = el('label', f.wide ? 'wide' : '');
        lbl.dataset.key = f.key;
        const span = el('span'); span.textContent = f.label; lbl.appendChild(span);
        let input;
        if (f.type === 'select') {
          input = el('select'); input.className = 'b-field';
          f.options.forEach(([v, t]) => { const o = el('option'); o.value = v; o.textContent = t; input.appendChild(o); });
        } else if (f.type === 'textarea') {
          input = el('textarea'); input.className = 'b-field'; input.rows = 2;
        } else {
          input = el('input'); input.type = 'text'; input.className = 'b-field';
        }
        input.dataset.key = f.key;
        input.addEventListener('input', buildCommand);
        if (f.type === 'select') input.addEventListener('change', onBuilderFieldChange);
        lbl.appendChild(input);
        grid.appendChild(lbl);
      }
      // 联动显隐:不重建 DOM,只 toggle 当前 label 的 display
      if (f.showIfModel || f.showIfSub) {
        const need = f.showIfModel || f.showIfSub;
        const triggerKey = f.showIfModel ? 'model' : 'subcmd';
        lbl.style.display = (fieldVal(triggerKey) === need) ? '' : 'none';
      }
    });
    buildCommand();
  }
  // model/subcmd 变化时仅切换联动字段显隐 + 重算命令,不重建 grid
  function onBuilderFieldChange() {
    const def = CMD_FIELDS[state.source];
    const grid = $('builder-grid');
    def.fields.forEach(f => {
      if (!f.showIfModel && !f.showIfSub) return;
      const lbl = grid.querySelector(`label[data-key="${f.key}"]`);
      if (!lbl) return;
      const need = f.showIfModel || f.showIfSub;
      const triggerKey = f.showIfModel ? 'model' : 'subcmd';
      const triggerPairs = f.showIfModel ? 'model' : 'subcmd'; // alias for clarity
      const visible = fieldVal(triggerKey) === need;
      const wasVisible = lbl.style.display !== 'none';
      lbl.style.display = visible ? '' : 'none';
      // 隐藏时清空它的值,避免残留进命令
      if (!visible && wasVisible) {
        const inp = lbl.querySelector('.b-field');
        if (inp) inp.value = '';
      }
    });
    buildCommand();
  }
  $('copy-command-btn').onclick = async () => { await navigator.clipboard.writeText($('generated-command').textContent).catch(() => {}); toast('已复制启动命令'); };
  $('open-terminal-btn').onclick = async () => { await navigator.clipboard.writeText($('generated-command').textContent).catch(() => {}); toast('命令已复制,粘贴到终端执行'); };

  // ---------- 会话列表 ----------
  async function loadSessions(refresh = false) {
    const list = $('session-list');
    list.innerHTML = '<div class="empty-state"><p>加载中…</p></div>';
    try {
      const r = refresh ? '&refresh=1' : '';
      const _t = Date.now();
      const res = await fetchJSON(`/api/sessions?source=${state.source}&limit=300${r}&_t=${_t}`);
      $('session-count').textContent = res.total || 0;
      fillProjectRootSelect(res.projects || []);
      list.innerHTML = '';
      (res.sessions || []).forEach(s => list.appendChild(sessionItem(s)));
      if (state.currentSessionId) openSessionFromURL(state.currentSessionId, false);
    } catch (e) {
      list.innerHTML = `<div class="empty-state"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
    }
  }
  $('session-refresh-btn').onclick = () => { toast('正在重新扫描…'); loadSessions(true); };
  function fillProjectRootSelect(projects) {
    const sel = $('project-root-select');
    const cur = state.projectRoot || DEFAULT_PROJECT;
    const seen = new Set([cur]);
    let opts = [cur];
    (projects || []).forEach(p => { if (p && !seen.has(p)) { seen.add(p); opts.push(p); } });
    state.projectOptions = opts;
    sel.innerHTML = '';
    opts.forEach(o => { const op = el('option'); op.value = o; op.textContent = o; if (o === cur) op.selected = true; sel.appendChild(op); });
  }
  $('project-root-select').onchange = () => {
    state.projectRoot = $('project-root-select').value;
    pushURL();
    loadCatalog(true);
  };
  $('refresh-catalog-btn').onclick = () => { toast('正在刷新…'); loadSessions(true); loadCatalog(true); };

  function sessionItem(s) {
    const item = el('div', 'session-item' + (s.id === state.currentSessionId ? ' active' : ''));
    item.dataset.id = s.id;
    item.dataset.source = state.source;
    item.dataset.title = s.title || s.id;
    if (s.filePath) item.dataset.filePath = s.filePath;
    const title = el('div', 'si-title'); title.textContent = s.title || s.id; item.appendChild(title);
    const meta = el('div', 'si-meta');
    const d = s.time_created ? new Date(s.time_created).toLocaleString() : '';
    meta.textContent = `${(s.project || '').replace(/\\/g, '/')} · ${d}`;
    item.appendChild(meta);
    // 文件路径 + 一键复制(右键菜单也提供"复制路径")
    if (s.filePath) {
      const pathRow = el('div', 'si-path-row');
      const ptext = el('span', 'si-path');
      const shown = s.filePath.length > 52 ? '…' + s.filePath.slice(-51) : s.filePath;
      ptext.textContent = shown;
      ptext.title = s.filePath;
      pathRow.appendChild(ptext);
      const copyBtn = el('button', 'si-copy-path');
      copyBtn.type = 'button'; copyBtn.textContent = '⧉'; copyBtn.title = '复制文件路径';
      copyBtn.onclick = async (ev) => {
        ev.stopPropagation();
        await navigator.clipboard.writeText(s.filePath).catch(() => {});
        toast('已复制路径');
      };
      pathRow.appendChild(copyBtn);
      item.appendChild(pathRow);
    }
    item.onclick = () => openSession(s.id, s.title || s.id);
    // 右键菜单
    item.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openCtxMenu(ev, s); });
    return item;
  }

  // ---------- 右键菜单 ----------
  let ctxTarget = null;
  const ctxMenu = $('ctx-menu');
  function openCtxMenu(ev, session) {
    ctxTarget = session;
    ctxMenu.style.display = 'block';
    const x = Math.min(ev.clientX, window.innerWidth - 240);
    const y = Math.min(ev.clientY, window.innerHeight - 140);
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
  }
  function hideCtxMenu() { ctxMenu.style.display = 'none'; }
  document.addEventListener('click', hideCtxMenu);
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.session-item')) hideCtxMenu();
  });
  $('ctx-edit').onclick = () => { hideCtxMenu(); if (ctxTarget) showEditDialog(ctxTarget); };
  $('ctx-copy-path').onclick = async () => {
    hideCtxMenu();
    if (ctxTarget && ctxTarget.filePath) {
      await navigator.clipboard.writeText(ctxTarget.filePath).catch(() => {});
      toast('已复制路径');
    } else { toast('该会话无文件路径'); }
  };
  $('ctx-soft-del').onclick = () => { hideCtxMenu(); if (ctxTarget) deleteSession(ctxTarget, 'soft'); };
  $('ctx-local-del').onclick = () => { hideCtxMenu(); if (ctxTarget) deleteSession(ctxTarget, 'local'); };

  function postJSON(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(body) }).then(r => r.json());
  }

  function showEditDialog(s) {
    const bd = el('div', 'modal-layer'); bd.style.cssText = 'position:fixed;inset:0;background:rgba(20,20,19,0.4);z-index:300;display:flex;align-items:center;justify-content:center';
    bd.innerHTML = `
      <div style="width:min(420px,92vw);background:var(--canvas);border:1px solid var(--hairline);border-radius:var(--r-lg);padding:20px">
        <h3 class="serif" style="font-size:20px;margin:0 0 12px">编辑会话标题别名</h3>
        <p style="font-size:12.5px;color:var(--muted);margin:0 0 14px">仅修改本地展示别名,不改原始会话文件。留空则恢复原标题。</p>
        <input id="edit-name" type="text" value="${escapeHtml(s.title || '').replace(/"/g,'"')}"
          style="width:100%;min-height:40px;border:1px solid var(--hairline);border-radius:var(--r-sm);background:var(--canvas);color:var(--ink);padding:9px 12px;font-size:14px" />
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
          <button class="btn-secondary" data-cancel>取消</button>
          <button class="btn-primary" data-save>保存</button>
        </div>
      </div>`;
    document.body.appendChild(bd);
    const inp = bd.querySelector('#edit-name'); inp.focus(); inp.select();
    bd.querySelector('[data-cancel]').onclick = () => bd.remove();
    bd.querySelector('[data-save]').onclick = async () => {
      try {
        await postJSON('/api/sessions/meta', { source: state.source, sessionId: s.id, titleAlias: inp.value.trim() });
        toast('标题已更新'); bd.remove(); loadSessions();
      } catch (e) { toast(`保存失败:${e.message}`); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') bd.querySelector('[data-save]').click(); if (e.key === 'Escape') bd.remove(); });
  }

  async function deleteSession(s, method) {
    const tip = method === 'soft'
      ? '从界面删除?(标记隐藏,会话文件仍保留在磁盘)'
      : '移至回收站?(文件进系统回收站,可从回收站恢复)';
    if (!confirm(`「${s.title || s.id}」\n${tip}`)) return;
    const url = method === 'soft' ? '/api/sessions/delete' : '/api/sessions/delete-local';
    try {
      const r = await postJSON(url, { source: state.source, sessionId: s.id });
      if (r && r.error) { toast(`删除失败:${r.error}`); return; }
      toast(method === 'soft' ? '已从界面删除' : '已移至回收站');
      if (state.currentSessionId === s.id) $('back-home-btn').click();
      loadSessions();
    } catch (e) { toast(`删除失败:${e.message}`); }
  }

  let searchTimer;
  $('search-input').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(filterSessions, 200);
  };
  async function filterSessions() {
    const q = $('search-input').value.trim();
    const res = await fetchJSON(`/api/sessions?source=${state.source}&limit=300&q=${encodeURIComponent(q)}`);
    const list = $('session-list'); list.innerHTML = '';
    (res.sessions || []).forEach(s => list.appendChild(sessionItem(s)));
  }

  // ---------- 会话详情 ----------
  async function openSession(id, title) {
    state.currentSessionId = id;
    highlightActive();
    buildResumeCmd();
    pushURL();
    $('welcome-state').style.display = 'none';
    const v = $('conversation-view'); v.style.display = 'block';
    $('conversation-title').textContent = title;
    const cont = $('messages-container'); cont.innerHTML = '<div class="empty-state"><p>加载中…</p></div>';
    try {
      const data = await fetchJSON(`/api/session?source=${state.source}&id=${id}`);
      renderMessages(data.messages || []);
      const sm = data.session || {};
      $('meta-model').textContent = sm.model || '';
      $('meta-proj').textContent = (sm.project || '').replace(/\\/g, '/');
      $('meta-time').textContent = sm.time_created ? new Date(sm.time_created).toLocaleString() : '';
      // 具体文件路径(Claude=.jsonl / Codex=.jsonl / Opencode=db),点击复制
      const mf = $('meta-file');
      const fp = sm.filePath || '';
      if (fp) {
        const shown = fp.length > 48 ? '…' + fp.slice(-47) : fp;
        mf.textContent = '📄 ' + shown;
        mf.title = fp;
        mf.style.cursor = 'pointer';
        mf.onclick = async () => { await navigator.clipboard.writeText(fp).catch(() => {}); toast('已复制文件路径'); };
      } else {
        mf.textContent = ''; mf.title = ''; mf.onclick = null; mf.style.cursor = '';
      }
    } catch (e) {
      cont.innerHTML = `<div class="empty-state"><p>加载失败: ${escapeHtml(e.message)}</p></div>`;
    }
  }
  async function openSessionFromURL(id, restore) {
    const items = await waitFor(() => $('session-list').querySelector(`.session-item[data-id="${id}"]`));
    if (items) { const t = items.querySelector('.si-title').textContent; openSession(id, t); }
    else { state.currentSessionId = id; buildResumeCmd(); pushURL(); }
  }
  function waitFor(fn, timeout = 3000) {
    return new Promise(res => {
      const t0 = Date.now();
      const tick = () => { const v = fn(); if (v) res(v); else if (Date.now() - t0 > timeout) res(null); else setTimeout(tick, 50); };
      tick();
    });
  }
  function highlightActive() {
    document.querySelectorAll('.session-item').forEach(it =>
      it.classList.toggle('active', it.dataset.id === state.currentSessionId));
  }
  $('back-home-btn').onclick = () => showHome();

  function renderMessages(messages) {
    const cont = $('messages-container'); cont.innerHTML = '';
    // task3: only show dialog text + reasoning, skip tool_use/tool_result parts.
    // task1 guard: merge consecutive single-char text parts (legacy backend split each char
    // into its own part, each rendering as one-char-per-line vertically).
    messages.forEach(m => {
      const blocks = [];
      let buf = '';
      const flushBuf = () => { if (buf) { blocks.push({kind:'text', text:buf}); buf = ''; } };
      (m.parts || []).forEach(p => {
        if (p.type === 'text') {
          const t = p.text || '';
          if (t.length === 1) { buf += t; }
          else { flushBuf(); blocks.push({kind:'text', text:t}); }
        } else if (p.type === 'reasoning') {
          flushBuf(); blocks.push({kind:'reasoning', text:p.text || ''});
        }
      });
      flushBuf();
      if (!blocks.length && m.text) blocks.push({kind:'text', text:m.text});
      if (!blocks.length) return;
      const div = el('div', `message ${m.role}`);
      const role = el('div', 'm-role'); role.textContent = m.role; div.appendChild(role);
      blocks.forEach(b => {
        const x = el('div', b.kind === 'reasoning' ? 'part-reasoning' : 'part-text');
        x.textContent = b.text;
        div.appendChild(x);
      });
      cont.appendChild(div);
    });
  }
function safeJson(v) { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2); } catch { return String(v); } }
  function safeStr(v) { return typeof v === 'string' ? v : safeJson(v); }

  // ---------- 本地索引 ----------
  async function loadCatalog(refresh = false) {
    $('catalog-title').textContent = { claude: 'Claude 本地索引', codex: 'Codex 本地索引', opencode: 'OpenCode 本地索引' }[state.source];
    if (!state.projectRoot) state.projectRoot = $('project-root-select').value || DEFAULT_PROJECT;
    const disp = $('catalog-display');
    disp.innerHTML = '<div class="empty-state"><p>加载本地索引…</p></div>';
    try {
      const r = refresh ? '&refresh=1' : '';
      const _t = Date.now();
      const url = `/api/catalog?source=${state.source}${r}&projectRoot=${encodeURIComponent(state.projectRoot)}&_t=${_t}`;
      state.catalog = await fetchJSON(url);
      $('catalog-updated').textContent = `项目: ${state.projectRoot} · ${state.catalog.generatedAt || ''}`;
      renderCatalogTabs();
    } catch (e) {
      disp.innerHTML = `<div class="empty-state"><p>索引加载失败: ${escapeHtml(e.message)}</p></div>`;
    }
  }
  function renderCatalogTabs() {
    const k = CATALOG_KINDS[state.source] || [];
    const counts = state.catalog?.counts || {};
    const box = $('catalog-kind-tabs'); box.innerHTML = '';
    if (!state.activeKind || !k.find(x => x[0] === state.activeKind)) state.activeKind = k[0]?.[0] || null;
    k.forEach(([key, label, desc]) => {
      const card = el('button', 'catalog-kind-card' + (state.activeKind === key ? ' active' : ''));
      card.dataset.kind = key;
      card.innerHTML = `<strong>${counts[key] ?? 0}</strong><span>${label}</span><small>${desc}</small>`;
      card.onclick = () => { state.activeKind = key; renderCatalogTabs(); renderCatalogItems(); };
      box.appendChild(card);
    });
    renderCatalogItems();
  }
  function renderCatalogItems() {
    const disp = $('catalog-display'); disp.innerHTML = '';
    const items = (state.catalog && state.catalog[state.activeKind]) || [];
    if (!items.length) { disp.innerHTML = '<div class="empty-state"><p>该分类暂无数据。</p></div>'; return; }
    items.forEach(item => {
      const row = el('div', 'catalog-item');
      const name = el('div', 'ci-name'); name.textContent = item.name || item.id || '(unnamed)'; row.appendChild(name);
      const meta = el('div', 'ci-meta');
      meta.textContent = [item.scope, item.transport, item.command, item.model, item.url].filter(Boolean).join(' · ') || item.path || '';
      row.appendChild(meta);
      if (item.tools && item.tools.length) {
        const tw = el('div', 'ci-tools'); tw.textContent = 'tools: ' + item.tools.slice(0, 40).join(', '); row.appendChild(tw);
      }
      if (item.description) { const d = el('div', 'ci-meta'); d.textContent = item.description; row.appendChild(d); }
      disp.appendChild(row);
    });
  }

  // ---------- 临时会话命令生成器(API+Key+模型,单次会话生效) ----------
  // 各 source 的 env 名 + CLI 参数规范(已核对官方 --help):
  //  claude:  --model X  --effort <low|medium|high|xhigh|max>  --permission-mode <default|acceptEdits|plan|bypassPermissions>
  //  codex:   -m X  -c model_reasoning_effort=<minimal|low|medium|high>  -s <sandbox>  -a <approval>
  //  opencode: -m <provider/model>  --agent <name>  --auto (无 reasoning effort;权限=auto 或手动确认)
  // 模型 = 填 base+key 后点"拉取模型"调 /api/models(OpenAI 兼容 /v1/models)填下拉。
  // API 地址历史 + 拉取到的模型列表按 source 各存一份于 localStorage。
  const API_ENV = {
    claude: { base: 'ANTHROPIC_BASE_URL', key: 'ANTHROPIC_AUTH_TOKEN', bin: 'claude',
              modelFlag: '--model',
              params: [
                { key: 'effort', label: '推理强度 --effort', type: 'select',
                  options: [['', '默认'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']] },
                { key: 'permission', label: '权限 --permission-mode', type: 'select',
                  options: [['', '默认确认'], ['acceptEdits', 'acceptEdits'], ['plan', 'plan'], ['bypassPermissions', 'bypassPermissions']] },
              ] },
    codex: { base: 'OPENAI_BASE_URL', key: 'OPENAI_API_KEY', bin: 'codex',
             modelFlag: '-m', needsPrompt: true, modelIsPositional: false,
             params: [
               { key: 'effort', label: '推理强度 -c model_reasoning_effort', type: 'select',
                 options: [['', '默认'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']] },
               { key: 'sandbox', label: '沙箱 -s', type: 'select',
                 options: [['', '默认'], ['workspace-write', 'workspace-write'], ['read-only', 'read-only'], ['danger-full-access', 'danger-full-access']] },
               { key: 'approval', label: '审批 -a', type: 'select',
                 options: [['', '默认'], ['untrusted', 'untrusted'], ['on-request', 'on-request'], ['never', 'never']] },
             ] },
    opencode: { base: 'OPENAI_BASE_URL', key: 'OPENAI_API_KEY', bin: 'opencode', cmd: 'run',
                modelFlag: '-m', needsPrompt: true, modelIsPositional: false,
                params: [
                  { key: 'agent', label: '子智能体 --agent', type: 'text', ph: '如 build / custom' },
                  { key: 'auto', label: '权限 --auto(自动批准)', type: 'select',
                    options: [['', '手动确认'], ['auto', 'auto 全自动(危险)']] },
                ] },
  };
  const API_LS = { bases: 'openagent_api_bases', models: s => `openagent_api_models_${s}` };
  function lsGet(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

  function buildApiFields() {
    const a = API_ENV[state.source];
    const grid = $('api-builder-grid'); grid.innerHTML = '';
    // apiBase / model:可输入，也可直接从输入框下方的列表选择。
    const fields = [
      { key: 'apiBase', label: `API 地址(设 ${a.base})`, kind: 'combo', storageKey: () => API_LS.bases, ph: 'https://your-gateway.com' },
      { key: 'apiKey', label: `API Key(设 ${a.key})`, type: 'text', isKey: true, ph: 'sk-...' },
      { key: 'model', label: '模型(model)', kind: 'combo', storageKey: () => API_LS.models(state.source), ph: '先填地址+Key 再拉取,或手输', isModel: true },
    ];
    (a.params || []).forEach(p => fields.push(Object.assign({}, p, { kind: 'param' })));
    fields.push({ key: 'cwd', label: '工作目录(可选)', type: 'text', ph: 'C:\\Users\\Light', wide: true });
    fields.push({ key: 'prompt', label: '会话首条提示(可选)', type: 'textarea', wide: true });
    fields.forEach(f => {
      const lbl = el('label', f.wide ? 'wide' : ''); lbl.dataset.key = 'api-' + f.key;
      const span = el('span'); span.textContent = f.label; lbl.appendChild(span);
      let input;
      if (f.kind === 'combo') {
        buildComboField(lbl, f);
        grid.appendChild(lbl); return;
      }
      if (f.type === 'select') { input = el('select'); input.className = 'b-field'; (f.opts || f.options || []).forEach(([v, t]) => { const o = el('option'); o.value = v; o.textContent = t; input.appendChild(o); }); }
      else if (f.type === 'textarea') { input = el('textarea'); input.rows = 2; input.className = 'b-field'; }
      else { input = el('input'); input.type = (f.isKey && apiHideKey()) ? 'password' : 'text'; if (f.ph) input.placeholder = f.ph; input.className = 'b-field'; }
      input.dataset.apikey = f.key;
      if (f.kind === 'param') input.dataset.param = '1';
      input.addEventListener('input', buildApiCommand);
      lbl.appendChild(input); grid.appendChild(lbl);
      if (f.isKey) { const btn = el('button', 'inline-mini'); btn.type = 'button'; btn.textContent = '拉取模型'; btn.onclick = fetchModels; lbl.appendChild(btn); }
    });
    buildApiCommand();
    // 首屏/换源后:若列表已有数据而 draft 无值,自动选首个地址与首个模型,免每次重选。
    if (!apiVal('apiBase')) {
      const inp = document.querySelector(`#api-builder-grid [data-apikey="apiBase"]`);
      const list = lsGet(API_LS.bases, []);
      if (inp && !inp.value && list.length) inp.value = Array.isArray(list[0]) ? list[0][0] : list[0];
    }
    if (!apiVal('model')) {
      const inp = document.querySelector(`#api-builder-grid [data-apikey="model"]`);
      const list = lsGet(API_LS.models(state.source), []);
      if (inp && !inp.value && list.length) inp.value = list[0];
    }
    buildApiCommand();
  }
  // 单一可输可选字段：只有输入框和紧贴输入框的候选列表，不再提供“已保存”管理下拉。
  function buildComboField(lbl, f) {
    const storageKey = f.storageKey();
    const key = f.key;
    const input = el('input'); input.type = 'text'; input.className = 'b-field combo-input';
    input.dataset.apikey = key;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    if (f.ph) input.placeholder = f.ph;

    const pop = el('div', 'combo-popover combo-input-list');
    pop.style.display = 'none';
    let visibleValues = [];
    let activeIndex = -1;

    const values = () => [...new Set(lsGet(storageKey, []).map(item =>
      String(Array.isArray(item) ? item[0] : item).trim()).filter(Boolean))];
    const closePop = () => {
      pop.style.display = 'none';
      input.setAttribute('aria-expanded', 'false');
      activeIndex = -1;
      document.removeEventListener('scroll', onDocumentScroll, true);
      window.removeEventListener('wheel', onAwayClose, true);
      window.removeEventListener('resize', onAwayClose);
    };
    const choose = (value) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      closePop();
    };
    const setActive = (index) => {
      const rows = pop.querySelectorAll('.combo-pick');
      if (!rows.length) return;
      activeIndex = Math.max(0, Math.min(index, rows.length - 1));
      rows.forEach((row, i) => row.classList.toggle('active', i === activeIndex));
      rows[activeIndex].scrollIntoView({ block: 'nearest' });
    };
    const renderPop = (showAll = false) => {
      const query = showAll ? '' : input.value.trim().toLowerCase();
      visibleValues = values().filter(v => !query || v.toLowerCase().includes(query));
      pop.innerHTML = '';
      activeIndex = -1;
      if (!visibleValues.length) {
        closePop();
        return;
      }
      visibleValues.forEach(v => {
        const pick = el('button', 'combo-pick');
        pick.type = 'button'; pick.textContent = v; pick.title = v;
        pick.addEventListener('mousedown', ev => ev.preventDefault());
        pick.onclick = ev => { ev.stopPropagation(); choose(v); };
        pop.appendChild(pick);
      });
    };
    const openPop = (showAll = false) => {
      renderPop(showAll);
      if (!visibleValues.length) return;
      pop.style.display = 'block';
      input.setAttribute('aria-expanded', 'true');
      document.addEventListener('scroll', onDocumentScroll, true);
      window.addEventListener('wheel', onAwayClose, { capture: true, passive: true });
      window.addEventListener('resize', onAwayClose);
    };
    const onAwayClose = ev => {
      // 候选列表自身需要能滚动；只有列表外的滚轮/缩放才关闭。
      if (ev && pop.contains(ev.target)) return;
      closePop();
    };
    // 捕获中栏、列表或页面的任何滚动；输入框离开原位置时列表立即关闭。
    const onDocumentScroll = ev => { if (!pop.contains(ev.target)) closePop(); };

    input.addEventListener('focus', () => openPop(true));
    input.addEventListener('click', () => openPop(true));
    input.addEventListener('input', () => {
      buildApiCommand();
      if (document.activeElement === input) openPop(false);
    });
    input.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (pop.style.display === 'none') openPop(true);
        setActive(activeIndex + 1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (pop.style.display === 'none') openPop(true);
        setActive(activeIndex < 0 ? visibleValues.length - 1 : activeIndex - 1);
      } else if (ev.key === 'Enter' && activeIndex >= 0) {
        ev.preventDefault(); choose(visibleValues[activeIndex]);
      } else if (ev.key === 'Escape' || ev.key === 'Tab') {
        closePop();
      }
    });
    input.addEventListener('blur', () => setTimeout(closePop, 0));
    document.addEventListener('pointerdown', ev => {
      if (pop.style.display !== 'none' && !lbl.contains(ev.target)) closePop();
    });

    // 拉取模型或复制后刷新输入框候选列表；打开时始终显示本次拉取到的完整结果。
    input._refreshList = () => {
      renderPop(true);
      if (document.activeElement === input && visibleValues.length) openPop(true);
    };
    lbl.appendChild(input);
    lbl.appendChild(pop);
  }
  // 刷新某个输入框的候选列表(给复制/拉取回调用)。
  function refreshComboInput(key) {
    const inp = document.querySelector(`#api-builder-grid [data-apikey="${key}"]`);
    if (inp && typeof inp._refreshList === 'function') inp._refreshList();
  }
  function apiHideKey() { return $('api-hide-key') && $('api-hide-key').checked; }
  function apiVal(key) {
    const e = document.querySelector(`#api-builder-grid [data-apikey="${key}"]`);
    if (!e) return '';
    // combo 字段即 input,直接读 value;param 的 select 也走 value。
    return (e.value || '').trim();
  }

  function buildApiCommand() {
    const a = API_ENV[state.source];
    const apiBase = apiVal('apiBase'), apiKey = apiVal('apiKey'),
          model = apiVal('model'), cwd = apiVal('cwd'), prompt = apiVal('prompt');
    const envParts = [];
    if (apiBase) envParts.push(`${a.base}=${quotePS(apiBase)}`);
    if (apiKey) envParts.push(`${a.key}=${quotePS(apiKey)}`);
    const envPrefix = envParts.length ? envParts.map(p => '$env:' + p).join('; ') + '; ' : '';
    const cmdParts = [a.bin];
    if (a.cmd && !(a.needsPrompt && !prompt)) cmdParts.push(a.cmd);
    if (model && a.modelFlag && !a.modelIsPositional) cmdParts.push(a.modelFlag, model);
    // source 专属参数
    (a.params || []).forEach(p => {
      const v = apiParam(p.key);
      if (!v) return;
      if (state.source === 'codex' && p.key === 'effort') { cmdParts.push('-c', `model_reasoning_effort=${v}`); return; }
      if (state.source === 'opencode' && p.key === 'auto') { cmdParts.push('--auto'); return; }
      const flag = flagForParam(state.source, p.key);
      if (flag) cmdParts.push(flag, v);
    });
    if (model && a.modelIsPositional) cmdParts.push(quoteArg(model));
    if (prompt) cmdParts.push(quoteArg(prompt));
    let cmd = envPrefix + cmdParts.join(' ');
    if (cwd) cmd = `Set-Location -LiteralPath ${quotePS(cwd)}; ${cmd}`;
    $('api-generated-command').textContent = cmd;
  }
  function flagForParam(src, key) {
    const m = { claude: { effort: '--effort', permission: '--permission-mode' },
                codex:  { sandbox: '-s', approval: '-a' },
                opencode: { agent: '--agent' } };
    return (m[src] || {})[key];
  }
  function apiParam(key) { const e = document.querySelector(`#api-builder-grid [data-param][data-apikey="${key}"]`); return e ? e.value.trim() : ''; }

  // 把一个值去重写入存储列表(localStorage),最多保留 N 条。复制/拉取时静默使用,实现"复制即保存"。
  function pushStored(storageKey, v, max=20, isModel=false) {
    v = (v || '').trim(); if (!v) return false;
    const list = lsGet(storageKey, []);
    const norm = s => (s || '').replace(/\/+$/, '');
    if (list.find(it => (Array.isArray(it) ? norm(it[0]) : norm(it)) === norm(v))) return false;
    list.push(isModel ? v : [v, v]);
    while (list.length > max) list.shift();
    lsSet(storageKey, list); return true;
  }
  async function fetchModels() {
    const base = apiVal('apiBase'), key = apiVal('apiKey');
    if (!base) { toast('请先填 API 地址'); return; }
    const btn = document.querySelector(`#api-builder-grid [data-apikey="apiKey"]`).parentElement.querySelector('.inline-mini');
    const old = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
    try {
      const r = await postJSON('/api/models', { base, key });
      if (r.error) { toast(`拉取失败: ${r.error}`); return; }
      const models = [...new Set((r.models || []).map(m => String(m || '').trim()).filter(Boolean))];
      // 全量替换当前 source 的模型列表(以本次拉取为准),刷新完整的模型管理浮层。
      lsSet(API_LS.models(state.source), models);
      const modelInp = document.querySelector(`#api-builder-grid [data-apikey="model"]`);
      refreshComboInput('model');
      if (modelInp && models.length) { modelInp.value = models[0]; modelInp.dispatchEvent(new Event('input')); }
      // 顺带把 API 地址也存入地址列表,免得下次还要手填
      pushStored(API_LS.bases, base);
      refreshComboInput('apiBase');
      toast(`已拉取 ${models.length} 个模型`);
      buildApiCommand();
    } catch (e) { toast(`拉取失败: ${e.message}`); }
    finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
  }
  // 切换 key 隐藏 / 复制
  $('api-hide-key').onchange = () => {
    const inp = document.querySelector(`#api-builder-grid [data-apikey="apiKey"]`);
    if (inp) inp.type = apiHideKey() ? 'password' : 'text';
  };
  $('api-copy-btn').onclick = async () => {
    // 复制时记住当前 API 地址和模型，供输入框候选列表下次复用。
    const base = apiVal('apiBase'), model = apiVal('model');
    const key = apiVal('apiKey');
    let saved = '';
    if (base && pushStored(API_LS.bases, base)) { refreshComboInput('apiBase'); saved += '地址 '; }
    if (model && pushStored(API_LS.models(state.source), model, 20, true)) { refreshComboInput('model'); saved += '模型 '; }
    // key 也存一份(同地址绑定),便于切回时配对——存 localStorage,仅本机自用
    if (key && base) lsSet('openagent_api_key_' + state.source, key);
    await navigator.clipboard.writeText($('api-generated-command').textContent).catch(() => {});
    toast(saved ? `已复制命令，并记住 ${saved}` : '已复制临时会话命令');
  };

  // ---------- init ----------
  setStateFromURL();
  setActiveSourceTab();
  updateHero();
  renderCmdBuilder(true);
  buildApiFields();
  loadSessions(true);   // 首次加载强制重扫:F5/直开页面即拿到最新会话,而非旧缓存
  loadCatalog(true);     // F5/直开页面也强制重建本地索引，与“刷新索引”行为一致
})();
