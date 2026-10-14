// 规则之书·简版 —— SillyTavern 第三方扩展
// 功能：世界/区域/个人规则 + 区域/建筑/角色 的增删改、启用开关、提示词注入、GitHub 私有仓库同步
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, setExtensionPrompt, extension_prompt_types, eventSource, event_types } from '../../../../script.js';

const EXT_KEY = 'rule-book-lite';
const PROMPT_KEY = 'rule_book_lite';

const TABS = [
  { id: 'all', label: '全部规则' },
  { id: 'region', label: '区域规则' },
  { id: 'personal', label: '个人规则' },
  { id: 'regions', label: '区域' },
  { id: 'buildings', label: '建筑' },
  { id: 'characters', label: '角色' },
  { id: 'enabled', label: '已启用' },
  { id: 'settings', label: '设置' },
];

const TYPE_LABEL = { world: '世界规则', region: '区域规则', personal: '个人规则' };

let ui = { tab: 'all', open: false };

/* ---------------- 设置与数据 ---------------- */

function defaultData() {
  return {
    rules: [],      // {id,name,type,target,desc,tag,enabled,updatedAt}
    regions: [],    // {id,name,desc,enabled,updatedAt}
    buildings: [],  // {id,name,regionId,desc,enabled,updatedAt}
    characters: [], // {id,name,desc,enabled,updatedAt}
    github: { owner: '', repo: '', path: 'rules.json', token: '', autoSync: true },
    deleted: {},    // {id: 删除时间戳}，同步时阻止远端复活本地已删条目
    lastSync: '',
  };
}

function data() {
  if (!extension_settings[EXT_KEY]) extension_settings[EXT_KEY] = defaultData();
  const d = extension_settings[EXT_KEY];
  for (const k of Object.keys(defaultData())) if (d[k] === undefined) d[k] = defaultData()[k];
  return d;
}

function save() {
  saveSettingsDebounced();
  rebuildInjection();
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function collectionOf(tab) {
  return { regions: 'regions', buildings: 'buildings', characters: 'characters' }[tab] || 'rules';
}

/* ---------------- 提示词注入 ---------------- */

function rebuildInjection() {
  const d = data();
  const on = d.rules.filter(r => r.enabled);
  if (on.length === 0) {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 1);
    return;
  }
  const lines = [];
  lines.push('[规则之书 · 已生效规则]');
  lines.push('以下规则是本世界的既定事实。所有角色将其视为本来如此：不质疑、不解释来源、不产生违和感。规则被修改后以新规则为准重新自洽；规则被删除后相关记忆与记录自动合理化，不留“曾被改写”的痕迹。');
  const groups = [
    ['world', '◆ 世界规则（全局生效）', r => `- ${r.name}：${r.desc}`],
    ['region', '◆ 区域规则（仅在指定区域/建筑内生效）', r => `- 【${r.target || '未指定区域'}】${r.name}：${r.desc}`],
    ['personal', '◆ 个人规则（仅作用于指定对象）', r => `- 【${r.target || '未指定对象'}】${r.name}：${r.desc}`],
  ];
  for (const [type, title, fmt] of groups) {
    const list = on.filter(r => r.type === type);
    if (list.length) {
      lines.push('', title);
      for (const r of list) lines.push(fmt(r));
    }
  }
  setExtensionPrompt(PROMPT_KEY, lines.join('\n'), extension_prompt_types.IN_CHAT, 1);
}

/* ---------------- UI 构建 ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildFab() {
  if (document.getElementById('rbl-fab')) return;
  const fab = el('div', '', '📖');
  fab.id = 'rbl-fab';
  fab.title = '规则之书';
  fab.onclick = openPanel;
  document.body.appendChild(fab);
}

function openPanel() {
  if (document.getElementById('rbl-overlay')) return;
  ui.open = true;
  const overlay = el('div');
  overlay.id = 'rbl-overlay';
  overlay.onclick = e => { if (e.target === overlay) closePanel(); };

  const panel = el('div');
  panel.id = 'rbl-panel';

  // header
  const header = el('div', 'rbl-header');
  header.appendChild(el('span', 'rbl-title', '规则之书'));
  const syncState = el('span', 'rbl-sync-state');
  syncState.id = 'rbl-sync-state';
  header.appendChild(syncState);
  const syncBtn = el('button', 'rbl-btn primary', '⟳ 同步');
  syncBtn.onclick = () => syncNow();
  header.appendChild(syncBtn);
  const closeBtn = el('button', 'rbl-btn', '✕');
  closeBtn.onclick = closePanel;
  header.appendChild(closeBtn);
  panel.appendChild(header);

  // tabs
  const tabs = el('div', 'rbl-tabs');
  tabs.id = 'rbl-tabs';
  for (const t of TABS) {
    const b = el('div', 'rbl-tab' + (t.id === ui.tab ? ' active' : ''), t.label);
    b.dataset.tab = t.id;
    b.onclick = () => { ui.tab = t.id; renderPanel(); };
    tabs.appendChild(b);
  }
  panel.appendChild(tabs);

  const body = el('div', 'rbl-body');
  body.id = 'rbl-body';
  panel.appendChild(body);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  renderPanel();
  updateSyncState();

  // 打开时自动拉取一次（多端同步）
  if (data().github.autoSync && ghConfigured()) syncNow(true);
}

function closePanel() {
  ui.open = false;
  document.getElementById('rbl-overlay')?.remove();
}

function updateSyncState(text) {
  const s = document.getElementById('rbl-sync-state');
  if (!s) return;
  if (text) { s.textContent = text; return; }
  const d = data();
  s.textContent = d.lastSync ? `上次同步：${new Date(d.lastSync).toLocaleString()}` : '尚未同步';
}

function renderPanel() {
  document.querySelectorAll('#rbl-tabs .rbl-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === ui.tab);
  });
  const body = document.getElementById('rbl-body');
  if (!body) return;
  body.innerHTML = '';
  if (ui.tab === 'settings') return renderSettings(body);

  const items = itemsForTab(ui.tab);
  const toolbar = el('div', 'rbl-toolbar');
  toolbar.appendChild(el('span', 'rbl-count', `共 ${items.length} 条`));
  if (ui.tab !== 'enabled') {
    const addBtn = el('button', 'rbl-btn primary', '＋ 新增');
    addBtn.onclick = () => openEditor(ui.tab, null);
    toolbar.appendChild(addBtn);
  }
  body.appendChild(toolbar);

  if (items.length === 0) {
    body.appendChild(el('div', 'rbl-empty', ui.tab === 'enabled' ? '还没有启用任何条目' : '空空如也，点右上角「＋ 新增」'));
    return;
  }
  const grid = el('div', 'rbl-cards');
  for (const item of items) grid.appendChild(renderCard(ui.tab, item));
  body.appendChild(grid);
}

function itemsForTab(tab) {
  const d = data();
  const byTime = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  switch (tab) {
    case 'all': return [...d.rules].sort(byTime);
    case 'region': return d.rules.filter(r => r.type === 'region').sort(byTime);
    case 'personal': return d.rules.filter(r => r.type === 'personal').sort(byTime);
    case 'regions': return [...d.regions].sort(byTime);
    case 'buildings': return [...d.buildings].sort(byTime);
    case 'characters': return [...d.characters].sort(byTime);
    case 'enabled': {
      const all = [
        ...d.rules.filter(r => r.enabled).map(r => ({ ...r, _tab: 'all' })),
        ...d.regions.filter(r => r.enabled).map(r => ({ ...r, _tab: 'regions' })),
        ...d.buildings.filter(r => r.enabled).map(r => ({ ...r, _tab: 'buildings' })),
        ...d.characters.filter(r => r.enabled).map(r => ({ ...r, _tab: 'characters' })),
      ];
      return all.sort(byTime);
    }
  }
  return [];
}

function renderCard(tab, item) {
  const d = data();
  const isRule = !item.regionId && item.type !== undefined;
  const realTab = item._tab || tab;
  const card = el('div', 'rbl-card' + (item.enabled ? ' enabled' : ''));

  const titleRow = el('div', 'rc-title-row');
  titleRow.appendChild(el('span', 'rc-name', item.name || '（未命名）'));
  if (isRule) titleRow.appendChild(el('span', `rbl-badge type-${item.type}`, TYPE_LABEL[item.type] || item.type));
  titleRow.appendChild(el('span', 'rbl-badge ' + (item.enabled ? 'on' : 'off'), item.enabled ? '已启用' : '已停用'));
  card.appendChild(titleRow);

  if (isRule && item.target) card.appendChild(el('div', 'rc-meta', `适用对象：${item.target}`));
  if (realTab === 'buildings') {
    const rg = d.regions.find(r => r.id === item.regionId);
    if (rg) card.appendChild(el('div', 'rc-meta', `所属区域：${rg.name}`));
  }
  if (item.desc) card.appendChild(el('div', 'rc-desc', item.desc));
  const metaBits = [];
  if (item.tag) metaBits.push(`标记：${item.tag}`);
  if (item.updatedAt) metaBits.push(new Date(item.updatedAt).toLocaleString());
  if (metaBits.length) card.appendChild(el('div', 'rc-meta', metaBits.join(' · ')));

  const actions = el('div', 'rc-actions');
  const toggleBtn = el('button', 'rbl-btn', item.enabled ? '停用' : '启用');
  toggleBtn.onclick = () => {
    const coll = data()[collectionOf(realTab)];
    const target = coll.find(x => x.id === item.id);
    if (target) { target.enabled = !target.enabled; target.updatedAt = Date.now(); save(); renderPanel(); }
  };
  actions.appendChild(toggleBtn);

  if (ui.tab !== 'enabled') {
    const editBtn = el('button', 'rbl-btn', '编辑');
    editBtn.onclick = () => openEditor(realTab, item.id);
    actions.appendChild(editBtn);
    const delBtn = el('button', 'rbl-btn danger', '删除');
    delBtn.onclick = () => {
      if (!confirm(`确定删除「${item.name}」？`)) return;
      const collKey = collectionOf(realTab);
      data()[collKey] = data()[collKey].filter(x => x.id !== item.id);
      if (!data().deleted) data().deleted = {};
      data().deleted[item.id] = Date.now(); // 记录删除，防止同步时从远端复活
      save(); renderPanel();
    };
    actions.appendChild(delBtn);
  }
  card.appendChild(actions);
  return card;
}

/* ---------------- 编辑弹窗 ---------------- */

function openEditor(tab, id) {
  const collKey = collectionOf(tab);
  const coll = data()[collKey];
  const existing = id ? coll.find(x => x.id === id) : null;
  const isRule = collKey === 'rules';

  const overlay = el('div');
  overlay.id = 'rbl-modal-overlay';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  const modal = el('div');
  modal.id = 'rbl-modal';
  modal.onclick = e => e.stopPropagation();

  const titles = { all: '规则', region: '区域规则', personal: '个人规则', regions: '区域', buildings: '建筑', characters: '角色' };
  modal.appendChild(el('h3', null, (existing ? '编辑' : '新增') + (titles[tab] || '')));

  const fields = {};
  function addField(key, label, kind, value, options) {
    const wrap = el('div', 'rbl-field');
    wrap.appendChild(el('label', null, label));
    let input;
    if (kind === 'textarea') input = el('textarea');
    else if (kind === 'select') {
      input = el('select');
      for (const [v, t] of options) input.appendChild(new Option(t, v));
    } else input = el('input');
    if (kind !== 'checkbox') input.value = value ?? '';
    else input.checked = value !== false;
    wrap.appendChild(input);
    modal.appendChild(wrap);
    fields[key] = input;
  }

  if (isRule) {
    addField('name', '规则名称', 'input', existing?.name);
    const typeOpts = tab === 'region' ? [['region', '区域规则']] : tab === 'personal' ? [['personal', '个人规则']]
      : [['world', '世界规则'], ['region', '区域规则'], ['personal', '个人规则']];
    addField('type', '规则类型', 'select', existing?.type || typeOpts[0][0], typeOpts);
    addField('target', '适用对象（区域规则填区域/建筑名，个人规则填角色名）', 'input', existing?.target);
    addField('desc', '效果描述', 'textarea', existing?.desc);
    addField('tag', '标记（可选）', 'input', existing?.tag);
  } else if (collKey === 'regions') {
    addField('name', '区域名称', 'input', existing?.name);
    addField('desc', '描述', 'textarea', existing?.desc);
  } else if (collKey === 'buildings') {
    addField('name', '建筑名称', 'input', existing?.name);
    addField('regionId', '所属区域', 'select', existing?.regionId || data().regions[0]?.id || '',
      data().regions.map(r => [r.id, r.name]));
    addField('desc', '描述', 'textarea', existing?.desc);
  } else if (collKey === 'characters') {
    addField('name', '角色名称', 'input', existing?.name);
    addField('desc', '简介 / 备注', 'textarea', existing?.desc);
  }

  const actions = el('div', 'rbl-modal-actions');
  const cancel = el('button', 'rbl-btn', '取消');
  cancel.onclick = () => overlay.remove();
  const okBtn = el('button', 'rbl-btn primary', '保存');
  okBtn.onclick = () => {
    const name = fields.name.value.trim();
    if (!name) { toastr.warning('名称不能为空'); return; }
    if (existing) {
      Object.assign(existing, readFields(), { name, updatedAt: Date.now() });
    } else {
      const prefix = { rules: 'R', regions: 'REG', buildings: 'BLD', characters: 'CHR' }[collKey];
      coll.push({ id: uid(prefix), name, enabled: true, updatedAt: Date.now(), ...readFields() });
    }
    save(); overlay.remove(); renderPanel();
  };
  actions.appendChild(cancel);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function readFields() {
    const out = {};
    if (fields.type) out.type = fields.type.value;
    if (fields.target) out.target = fields.target.value.trim();
    if (fields.tag) out.tag = fields.tag.value.trim();
    if (fields.regionId) out.regionId = fields.regionId.value;
    if (fields.desc) out.desc = fields.desc.value.trim();
    return out;
  }
}

/* ---------------- 设置页 ---------------- */

function renderSettings(body) {
  const d = data();
  const form = el('div', 'rbl-form');

  const hint = el('div', 'rbl-hint');
  hint.innerHTML = '同步使用 GitHub 私有仓库：新建一个私有仓库（如 <code>tavern-rules</code>），' +
    '在 GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens 生成只对该仓库有 <b>Contents 读写</b> 权限的 token。' +
    '令牌只保存在本机酒馆扩展设置里。';
  form.appendChild(hint);

  const defs = [
    ['owner', 'GitHub 用户名'],
    ['repo', '仓库名'],
    ['path', '数据文件名（默认 rules.json）'],
    ['token', 'Personal Access Token'],
  ];
  const inputs = {};
  for (const [k, label] of defs) {
    const wrap = el('div', 'rbl-field');
    wrap.appendChild(el('label', null, label));
    const input = el('input');
    if (k === 'token') input.type = 'password';
    input.value = d.github[k] || '';
    wrap.appendChild(input);
    form.appendChild(wrap);
    inputs[k] = input;
  }

  const autoWrap = el('div', 'rbl-field');
  const autoLabel = el('label');
  const auto = el('input');
  auto.type = 'checkbox';
  auto.checked = !!d.github.autoSync;
  autoLabel.appendChild(auto);
  autoLabel.appendChild(document.createTextNode(' 打开面板时自动同步'));
  autoWrap.appendChild(autoLabel);
  form.appendChild(autoWrap);

  const saveBtn = el('button', 'rbl-btn primary', '保存设置');
  saveBtn.onclick = () => {
    for (const k of Object.keys(inputs)) d.github[k] = inputs[k].value.trim();
    d.github.autoSync = auto.checked;
    save(); toastr.success('设置已保存');
  };
  form.appendChild(saveBtn);

  const row = el('div');
  row.style.display = 'flex'; row.style.gap = '8px'; row.style.flexWrap = 'wrap';
  const syncBtn = el('button', 'rbl-btn', '⟳ 立即同步');
  syncBtn.onclick = () => syncNow();
  const histBtn = el('button', 'rbl-btn', '🕘 同步历史');
  histBtn.onclick = () => showHistory(body);
  const expBtn = el('button', 'rbl-btn', '⬇ 导出 JSON');
  expBtn.onclick = exportJson;
  const impBtn = el('button', 'rbl-btn', '⬆ 导入 JSON');
  impBtn.onclick = importJson;
  row.appendChild(syncBtn); row.appendChild(histBtn); row.appendChild(expBtn); row.appendChild(impBtn);
  form.appendChild(row);

  const histBox = el('div');
  histBox.id = 'rbl-history';
  form.appendChild(histBox);

  body.appendChild(form);
}

async function showHistory() {
  const box = document.getElementById('rbl-history');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(el('div', 'rbl-hint', '读取中…'));
  try {
    const g = data().github;
    const res = await ghFetch(`/commits?path=${encodeURIComponent(g.path)}&per_page=20`);
    const commits = await res.json();
    box.innerHTML = '';
    if (!commits.length) { box.appendChild(el('div', 'rbl-hint', '暂无提交记录')); return; }
    for (const c of commits) {
      const item = el('div', 'rbl-history-item');
      item.appendChild(el('span', 'time', new Date(c.commit.committer.date).toLocaleString()));
      item.appendChild(el('span', 'msg', c.commit.message.split('\n')[0]));
      box.appendChild(item);
    }
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('div', 'rbl-hint', `读取失败：${e.message}`));
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify(packData(data()), null, 2)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rule-book-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJson() {
  const input = el('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      mergeInto(data(), parsed);
      save(); renderPanel(); toastr.success('导入完成');
    } catch (e) { toastr.error(`导入失败：${e.message}`); }
  };
  input.click();
}

/* ---------------- GitHub 同步 ---------------- */

function ghConfigured() {
  const g = data().github;
  return g.owner && g.repo && g.token;
}

function ghFetch(path, opts = {}) {
  const g = data().github;
  return fetch(`https://api.github.com/repos/${g.owner}/${g.repo}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${g.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  }).then(res => {
    if (!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status}`);
    return res;
  });
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function packData(d) {
  return { version: 1, rules: d.rules, regions: d.regions, buildings: d.buildings, characters: d.characters };
}

// 按 id + updatedAt 做 last-write-wins 合并；本地已删除的 id 不从远端复活
function mergeInto(local, remote) {
  let added = 0, updated = 0;
  const deleted = local.deleted || {};
  for (const key of ['rules', 'regions', 'buildings', 'characters']) {
    if (!Array.isArray(remote[key])) continue;
    const map = new Map(local[key].map(x => [x.id, x]));
    for (const item of remote[key]) {
      if (deleted[item.id] && deleted[item.id] >= (item.updatedAt || 0)) continue; // 本地已删除
      const cur = map.get(item.id);
      if (!cur) { local[key].push(item); added++; }
      else if ((item.updatedAt || 0) > (cur.updatedAt || 0)) { Object.assign(cur, item); updated++; }
    }
  }
  return { added, updated };
}

// 统计本地相对远端需要推送的变更数（新增/修改/删除）
function diffCount(localPacked, localDeleted, remote) {
  let changed = 0;
  for (const key of ['rules', 'regions', 'buildings', 'characters']) {
    const rmap = new Map((remote[key] || []).map(x => [x.id, JSON.stringify(x)]));
    for (const item of localPacked[key]) {
      if (rmap.get(item.id) !== JSON.stringify(item)) changed++;
    }
    for (const item of remote[key] || []) {
      if (localDeleted[item.id]) changed++; // 本地删除，需推送以覆盖远端
    }
  }
  return changed;
}

async function syncNow(silent = false) {
  const d = data();
  if (!ghConfigured()) {
    if (!silent) { toastr.warning('请先在「设置」页填写 GitHub 仓库信息'); ui.tab = 'settings'; renderPanel(); }
    return;
  }
  updateSyncState('同步中…');
  try {
    const g = d.github;
    const path = `/contents/${encodeURIComponent(g.path)}`;
    const getRes = await ghFetch(path);

    let remoteData = null, sha = null;
    if (getRes.ok) {
      const file = await getRes.json();
      sha = file.sha;
      try { remoteData = JSON.parse(b64decode(file.content)); } catch { remoteData = null; }
    }

    // 1. 远端合入本地（本地已删除的 id 不复活）
    let mergedInfo = { added: 0, updated: 0 };
    if (remoteData) mergedInfo = mergeInto(d, remoteData);

    // 2. 判断本地相对远端是否有需要推送的改动
    const changed = remoteData ? diffCount(packData(d), d.deleted || {}, remoteData) : -1;

    // 3. 有改动则推送（推送成功后清理已覆盖的删除标记）
    if (!remoteData || changed > 0) {
      const now = new Date();
      const msg = !remoteData
        ? '初始化规则之书数据'
        : `同步 ${now.toLocaleString()} · 合并新增 ${mergedInfo.added} / 更新 ${mergedInfo.updated} · 本地变更 ${changed}`;
      const putRes = await ghFetch(path, {
        method: 'PUT',
        body: JSON.stringify({ message: msg, content: b64encode(JSON.stringify(packData(d), null, 2)), ...(sha ? { sha } : {}) }),
      });
      if (!putRes.ok) throw new Error(`推送失败 GitHub ${putRes.status}`);
      d.deleted = {}; // 远端已与本地一致，删除记录可清空
    }

    d.lastSync = Date.now();
    save();
    renderPanel();
    updateSyncState();
    if (!silent) toastr.success('同步完成');
  } catch (e) {
    updateSyncState(`同步失败：${e.message}`);
    if (!silent) toastr.error(`同步失败：${e.message}`);
  }
}

/* ---------------- 入口 ---------------- */

jQuery(async () => {
  data();
  rebuildInjection();
  buildFab();

  // 注入的提示词是按聊天存档保存的；切换角色卡/聊天后必须重新注入，
  // 否则新聊天里规则不会进入上下文（面板数据是全局的，所以会"显示启用但没生效"）
  eventSource.on(event_types.CHAT_CHANGED, () => rebuildInjection());
});
