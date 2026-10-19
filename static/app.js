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
    projectOptions: [], // optional project folders (default cwd of each source, etc.)
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
    zcode: { bin: 'zcode',
      fields: [
        { key: 'cwd', label: '工作目录', type: 'text', wide: true },
        { key: 'prompt', label: '启动提示词', type: 'textarea', wide: true },
      ] },
  };

  const CATALOG_KINDS = {
    claude: [['mcpServers', 'MCP', 'MCP Servers'], ['agents', 'Agents', '子智能体'], ['commands', 'Commands', '斜杠命令'], ['skills', 'Skills', 'Skills']],
    codex: [['mcpServers', 'MCP', 'MCP Servers'], ['tools', 'Tools', '工具命名空间'], ['commands', 'Commands', '启动命令']],
    opencode: [['models', 'Models', '模型'], ['tools', 'Tools', '会话工具'], ['commands', 'Commands', '启动命令']],
    zcode: [['models', 'Models', '模型'], ['tools', 'Tools', '会话工具'], ['commands', 'Commands', '启动命令']],
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

  // ---------- Modal 系统 (替换原生 alert/confirm) ----------
  function showModal(options) {
    return new Promise((resolve) => {
      const overlay = el('div', 'modal-overlay');
      const card = el('div', 'modal-card');

      if (options.title) {
        const title = el('h2', options.type === 'confirm' ? 'modal-confirm-title' : 'modal-title');
        title.textContent = options.title;
        card.appendChild(title);
      }

      if (options.message) {
        const msg = el('div', options.type === 'confirm' ? 'modal-confirm-message' : 'modal-desc');
        msg.textContent = options.message;
        card.appendChild(msg);
      }

      let input = null;
      if (options.type === 'prompt') {
        input = el('input', 'modal-input');
        input.type = 'text';
        input.value = options.defaultValue || '';
        if (options.placeholder) input.placeholder = options.placeholder;
        card.appendChild(input);
      }

      const actions = el('div', 'modal-actions');

      if (options.type === 'confirm' || options.type === 'prompt') {
        const cancelBtn = el('button', 'btn-secondary');
        cancelBtn.textContent = options.cancelText || '取消';
        cancelBtn.onclick = () => {
          overlay.remove();
          resolve(options.type === 'prompt' ? null : false);
        };
        actions.appendChild(cancelBtn);
      }

      const okBtn = el('button', options.danger ? 'btn-primary' : 'btn-primary');
      if (options.danger) okBtn.style.background = 'var(--error)';
      okBtn.textContent = options.okText || (options.type === 'alert' ? '确定' : '确认');
      okBtn.onclick = () => {
        overlay.remove();
        if (options.type === 'prompt') {
          resolve(input ? input.value.trim() : '');
        } else {
          resolve(true);
        }
      };
      actions.appendChild(okBtn);

      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') okBtn.click();
          if (e.key === 'Escape') overlay.remove();
        });
      } else {
        okBtn.focus();
      }

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(options.type === 'prompt' ? null : false);
        }
      });
    });
  }

  function showAlert(message, title = '提示') {
    return showModal({ type: 'alert', title, message });
  }

  function showConfirm(message, title = '确认操作', options = {}) {
    return showModal({
      type: 'confirm',
      title,
      message,
      danger: options.danger || false,
      okText: options.okText,
      cancelText: options.cancelText
    });
  }

  function showPrompt(message, defaultValue = '', title = '输入', placeholder = '') {
    return showModal({ type: 'prompt', title, message, defaultValue, placeholder });
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

  // ---------- 顶部智能体显示选择(多选:勾上的显示,其余隐藏) ----------
  const ALL_SOURCES = ['claude', 'codex', 'opencode', 'zcode'];
  const SOURCE_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode' };
  const SRC_VIS_LS = 'openagent_visible_sources';

  function visibleSources() {
    const saved = lsGet(SRC_VIS_LS, null);
    // 无记录=全显;空数组防呆回退全显
    if (!Array.isArray(saved) || !saved.length) return ALL_SOURCES.slice();
    return ALL_SOURCES.filter(s => saved.includes(s));
  }
  function applySourceVisibility() {
    const vis = visibleSources();
    document.querySelectorAll('.source-tab').forEach(b => {
      b.style.display = vis.includes(b.dataset.source) ? '' : 'none';
    });
    // 当前源被取消显示时退回首个可见源
    if (!vis.includes(state.source)) {
      state.source = vis[0] || 'claude';
      onSourceChange();
    }
  }
  function renderSourcePicker() {
    const pop = $('source-picker-popover');
    const vis = visibleSources();
    pop.innerHTML = '';
    ALL_SOURCES.forEach(s => {
      const lbl = el('label', 'source-pick-item');
      const chk = el('input'); chk.type = 'checkbox'; chk.checked = vis.includes(s);
      chk.addEventListener('change', () => {
        let cur = visibleSources().filter(x => x !== s);
        if (chk.checked) cur = ALL_SOURCES.filter(x => cur.includes(x) || x === s);
        if (!cur.length) { chk.checked = true; toast('至少保留一个智能体'); return; }
        lsSet(SRC_VIS_LS, cur);
        applySourceVisibility();
      });
      const span = el('span'); span.textContent = SOURCE_LABELS[s];
      lbl.appendChild(chk); lbl.appendChild(span);
      pop.appendChild(lbl);
    });
  }
  function toggleSourcePicker() {
    const pop = $('source-picker-popover');
    const open = pop.style.display !== 'none';
    if (open) { pop.style.display = 'none'; return; }
    renderSourcePicker();
    pop.style.display = 'block';
    setTimeout(() => {
      document.addEventListener('pointerdown', function onAway(ev) {
        if (!pop.contains(ev.target) && ev.target.id !== 'source-tab-picker') {
          pop.style.display = 'none';
          document.removeEventListener('pointerdown', onAway);
        }
      });
    }, 0);
  }
  $('source-tab-picker').onclick = (ev) => { ev.stopPropagation(); toggleSourcePicker(); };

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
    // 切源重置搜索状态(输入保留,重跑;全文命中缓存失效)
    lastFullQuery = null;
    if ($('search-results-note')) $('search-results-note').style.display = 'none';
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
    const map = { claude: ['Claude', 'Local Claude Code sessions, reads from ~/.claude/projects.'],
                   codex: ['Codex', 'Codex CLI sessions, reads from ~/.codex/sessions.'],
                   opencode: ['OpenCode', 'OpenCode sessions, reads from the local opencode.db.'],
                   zcode: ['ZCode', 'ZCode desktop sessions, read-only from ~/.zcode/cli.'] };
    $('hero-title').textContent = map[state.source][0];
    $('hero-desc').textContent = map[state.source][1];
  }

  // ---------- 恢复命令(顶部常驻) ----------
  const RESUME_BYPASS_FLAG = { claude: '--dangerously-skip-permissions',
                               codex: '--dangerously-bypass-approvals-and-sandbox',
                               opencode: '--auto' };
  if ($('resume-bypass-chk')) {
    $('resume-bypass-chk').checked = lsGet('openagent_resume_bypass', false);
    $('resume-bypass-chk').onchange = () => {
      lsSet('openagent_resume_bypass', $('resume-bypass-chk').checked);
      buildResumeCmd();
    };
  }
  function buildResumeCmd() {
    const bar = $('resume-bar');
    if (state.currentSessionId && state.source !== 'zcode') {
      // zcode 为桌面客户端,无终端 resume 命令,不显示恢复条
      bar.classList.add('show');
      let cmd;
      if (state.source === 'claude') cmd = `claude -r ${state.currentSessionId}`;
      else if (state.source === 'codex') cmd = `codex resume ${state.currentSessionId}`;
      else cmd = `opencode --session ${state.currentSessionId}`;
      // 第二参数:跳过权限确认(各 CLI 参数已核对 --help)
      if ($('resume-bypass-chk') && $('resume-bypass-chk').checked) cmd += ' ' + RESUME_BYPASS_FLAG[state.source];
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
    } else if (state.source === 'zcode') {
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
      state.lastSessions = res.sessions || [];
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

  function sessionItem(s, hits) {
    const item = el('div', 'session-item' + (s.id === state.currentSessionId ? ' active' : ''));
    item.dataset.id = s.id;
    item.dataset.source = state.source;
    item.dataset.title = s.title || s.id;
    item.dataset.project = s.project || '';
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
    // 全文搜索命中片段(可选)
    if (hits && hits.length) {
      const hitBox = el('div', 'si-hits');
      hitBox.textContent = `命中 ${hits.length} 处`;
      hits.slice(0, 3).forEach(hm => {
        const sn = el('span', 'hit-snippet');
        // 片段内命中段用 <mark> 高亮
        sn.textContent = '';
        const pre = document.createTextNode(hm.snippet.slice(0, hm.hitStart));
        const midEl = el('mark'); midEl.textContent = hm.snippet.slice(hm.hitStart, hm.hitEnd);
        const post = document.createTextNode(hm.snippet.slice(hm.hitEnd));
        sn.appendChild(pre); sn.appendChild(midEl); sn.appendChild(post);
        hitBox.appendChild(sn);
      });
      item.appendChild(hitBox);
    }
    // 右键菜单
    item.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openCtxMenu(ev, s); });
    return item;
  }

  // ---------- 右键菜单 ----------
  let ctxTarget = null;
  const ctxMenu = $('ctx-menu');

  function openCtxMenu(ev, session) {
    ctxTarget = session;
    // 只读源不提供删除入口(数据文件不允许被本工具改动)
    const readonly = state.source === 'zcode';
    $('ctx-soft-del').style.display = readonly ? 'none' : '';
    $('ctx-local-del').style.display = readonly ? 'none' : '';
    ctxMenu.style.display = 'block';

    // 先让浏览器计算菜单实际尺寸
    const menuW = ctxMenu.offsetWidth || 224;
    const menuH = ctxMenu.offsetHeight || 160;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 8;

    // 优先在鼠标右下方展示；若超出视口边界则翻转
    let x = ev.clientX;
    let y = ev.clientY;
    if (x + menuW + MARGIN > vw) x = vw - menuW - MARGIN;
    if (y + menuH + MARGIN > vh) y = vh - menuH - MARGIN;
    x = Math.max(MARGIN, x);
    y = Math.max(MARGIN, y);

    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';

    // 挂载关闭监听
    setTimeout(() => {
      document.addEventListener('click', hideCtxMenu, { once: true });
      document.addEventListener('contextmenu', onCtxDocRight);
      document.addEventListener('keydown', onCtxEsc);
      ctxMenu.addEventListener('mouseleave', hideCtxMenu, { once: true });
      // 任意滚动关闭（在捕获阶段监听，命中后 once 自动移除）
      window.addEventListener('wheel', hideCtxMenu, { capture: true, once: true, passive: true });
      document.querySelector('.session-list')?.addEventListener('scroll', hideCtxMenu, { once: true });
    }, 0);
  }

  function onCtxDocRight(e) {
    if (!e.target.closest('.session-item')) hideCtxMenu();
  }
  function onCtxEsc(e) {
    if (e.key === 'Escape') hideCtxMenu();
  }

  function hideCtxMenu() {
    ctxMenu.style.display = 'none';
    // 清理所有残留监听（多次调用 remove 无害）
    document.removeEventListener('contextmenu', onCtxDocRight);
    document.removeEventListener('keydown', onCtxEsc);
    ctxMenu.removeEventListener('mouseleave', hideCtxMenu);
    window.removeEventListener('wheel', hideCtxMenu, { capture: true });
    document.querySelector('.session-list')?.removeEventListener('scroll', hideCtxMenu);
  }
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
    const overlay = el('div', 'modal-overlay');
    const card = el('div', 'modal-card');

    const title = el('h2', 'modal-title'); title.textContent = '编辑会话标题别名'; card.appendChild(title);
    const desc = el('p', 'modal-desc');
    desc.textContent = '仅修改本地展示别名，不改原始会话文件。留空则恢复原标题。';
    card.appendChild(desc);

    const inp = el('input', 'modal-input');
    inp.type = 'text'; inp.value = s.title || ''; card.appendChild(inp);

    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'btn-secondary'); cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => overlay.remove();
    const saveBtn = el('button', 'btn-primary'); saveBtn.textContent = '保存';
    saveBtn.onclick = async () => {
      try {
        await postJSON('/api/sessions/meta', { source: state.source, sessionId: s.id, titleAlias: inp.value.trim() });
        toast('标题已更新');
        overlay.remove();
        // 只更新列表中该条目的标题，不整体刷新
        const item = $('session-list').querySelector(`.session-item[data-id="${s.id}"]`);
        if (item) {
          const newTitle = inp.value.trim() || s.id;
          item.querySelector('.si-title').textContent = newTitle;
          item.dataset.title = newTitle;
        }
      } catch (e) { toast(`保存失败：${e.message}`); }
    };
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    inp.focus(); inp.select();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
      if (e.key === 'Escape') overlay.remove();
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  async function deleteSession(s, method) {
    const tip = method === 'soft'
      ? '标记隐藏，会话文件仍保留在磁盘。'
      : '文件将进入系统回收站，可从回收站恢复。';
    const confirmed = await showConfirm(
      `「${s.title || s.id}」\n\n${tip}`,
      method === 'soft' ? '从界面删除' : '移至回收站',
      { danger: method !== 'soft', okText: method === 'soft' ? '确认删除' : '移至回收站' }
    );
    if (!confirmed) return;
    const url = method === 'soft' ? '/api/sessions/delete' : '/api/sessions/delete-local';
    try {
      const r = await postJSON(url, { source: state.source, sessionId: s.id });
      if (r && r.error) { toast(`删除失败：${r.error}`); return; }
      toast(method === 'soft' ? '已从界面删除' : '已移至回收站');
      // 直接从 DOM 移除该条目，不刷新整个列表
      const item = $('session-list').querySelector(`.session-item[data-id="${s.id}"]`);
      if (item) item.remove();
      // 更新计数
      const countEl = $('session-count');
      const cur = parseInt(countEl.textContent || '0', 10);
      if (cur > 0) countEl.textContent = cur - 1;
      // 若正在查看该会话，退回首页
      if (state.currentSessionId === s.id) $('back-home-btn').click();
    } catch (e) { toast(`删除失败：${e.message}`); }
  }

  // ---------- 会话搜索 ----------
  // 两种模式:
  //  - 默认(元数据):对已加载列表做客户端过滤(标题/ID/目录/文件路径),瞬时且不受服务端缓存影响。
  //  - 全文(勾选):调 /api/search 扫会话正文,渲染命中片段卡片。
  let searchTimer;
  let lastFullQuery = null;
  $('search-input').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  };
  if ($('search-full-chk')) {
    $('search-full-chk').onchange = () => {
      // 模式提示词随开关切换
      $('search-input').placeholder = $('search-full-chk').checked
        ? '搜索会话正文内容(较慢)'
        : '搜索会话标题/ID/目录';
      lastFullQuery = null; // 模式切换强制重跑
      runSearch();
    };
  }
  async function runSearch() {
    const q = $('search-input').value.trim();
    const full = $('search-full-chk') && $('search-full-chk').checked;
    const note = $('search-results-note');
    if (!q) {
      note.style.display = 'none';
      // 恢复原始列表(重新加载缓存态列表,不强制重扫)
      await loadSessions(false);
      return;
    }
    if (full) {
      if (q === lastFullQuery) return;
      lastFullQuery = q;
      note.style.display = 'block';
      note.textContent = `全文搜索「${q}」中…`;
      const list = $('session-list'); list.innerHTML = '<div class="empty-state"><p>扫描会话正文…</p></div>';
      try {
        const res = await fetchJSON(`/api/search?source=${state.source}&q=${encodeURIComponent(q)}`);
        const hits = res.results || [];
        list.innerHTML = '';
        hits.forEach(h => {
          const s = state.lastSessions && state.lastSessions.find(x => x.id === h.sessionId);
          list.appendChild(sessionItem(s || { id: h.sessionId, title: h.sessionId.slice(0, 8) + '…', project: '', time_created: 0 }, h.matches));
        });
        note.textContent = hits.length
          ? `全文命中 ${hits.length} 个会话`
          : `全文未命中(仅扫描最近 600 个会话文件)`;
      } catch (e) {
        list.innerHTML = `<div class="empty-state"><p>全文搜索失败: ${escapeHtml(e.message)}</p></div>`;
        note.textContent = '';
      }
    } else {
      note.style.display = 'none';
      filterSessionsClient(q);
    }
  }
  // 客户端元数据过滤:遍历已有 DOM 项,按 data 属性匹配
  function filterSessionsClient(q) {
    const q2 = q.toLowerCase();
    const items = $('session-list').querySelectorAll('.session-item');
    let shown = 0;
    items.forEach(it => {
      const hay = [it.dataset.title, it.dataset.id, it.dataset.filePath, it.dataset.project]
        .filter(Boolean).join(' ').toLowerCase();
      const vis = hay.includes(q2);
      it.style.display = vis ? '' : 'none';
      if (vis) shown++;
    });
    const note = $('search-results-note');
    note.style.display = 'block';
    note.textContent = shown === items.length ? '' : `元数据过滤: ${shown}/${items.length} 条`;
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

  // 思考内容默认隐藏,勾选"思考"开关后显示
  let showReasoning = false;
  if ($('show-reasoning-chk')) {
    showReasoning = lsGet('openagent_show_reasoning', false);
    $('show-reasoning-chk').checked = showReasoning;
    $('show-reasoning-chk').onchange = () => {
      showReasoning = $('show-reasoning-chk').checked;
      lsSet('openagent_show_reasoning', showReasoning);
      if (state.currentSessionId && state.source) renderCurrentAgain();
    };
  }
  // 开关变化后重渲染当前会话(不重新拉数据也可以,简单起见重新 fetch)
  async function renderCurrentAgain() {
    try {
      const data = await fetchJSON(`/api/session?source=${state.source}&id=${state.currentSessionId}`);
      renderMessages(data.messages || []);
    } catch (e) { /* 忽略重渲染失败 */ }
  }

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
          // 默认舍弃思考内容,勾选"思考"开关后显示
          flushBuf();
          if (showReasoning) blocks.push({kind:'reasoning', text:p.text || ''});
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
    $('catalog-title').textContent = { claude: 'Claude 本地索引', codex: 'Codex 本地索引', opencode: 'OpenCode 本地索引', zcode: 'ZCode 本地索引' }[state.source];
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
    zcode: { base: 'OPENAI_BASE_URL', key: 'OPENAI_API_KEY', bin: 'zcode',
             modelFlag: '-m', needsPrompt: true, modelIsPositional: false, params: [] },
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
  applySourceVisibility();  // 先按已保存选择隐藏不需要的智能体 tab,可能触发 onSourceChange 换源
  setActiveSourceTab();
  updateHero();
  renderCmdBuilder(true);
  buildApiFields();
  loadSessions(true);   // 首次加载强制重扫:F5/直开页面即拿到最新会话,而非旧缓存
  loadCatalog(true);     // F5/直开页面也强制重建本地索引，与“刷新索引”行为一致
})();
