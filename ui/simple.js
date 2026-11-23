'use strict';

// The Simple layout: a card for each project folder, its sessions in it, one button
// each. It reads and acts through the same server calls as the other pages. All of it
// is inside one function, so none of its names takes the place of a browser one (a
// script's own open() replaces window.open).
(() => {
  const $ = (selector) => document.querySelector(selector);
  const DAY = 24 * 60 * 60 * 1000;
  const OLD = 30 * DAY;          // projects not used for this long are folded away
  const SHOWN = 3;               // sessions on a card before "more"
  const MOST = 20;               // sessions on an opened card
  const COLORS = ['#0f9488', '#7c56d8', '#d0661c', '#c2417c', '#2f6fd0', '#4a8f2f', '#b08412', '#64768a'];
  const STATUS = { working: 'Working', blocked: 'Needs you', idle: 'Open, idle', done: 'Done', closed: 'Closed' };

  // What this tab was showing, so a reload comes back to it: the search, the cards
  // opened, older projects shown, and how far down the page it was.
  const KEPT = 'cc-simple-view';
  const kept = (() => {
    try { return JSON.parse(sessionStorage.getItem(KEPT)) || {}; } catch { return {}; }
  })();

  const S = {
    data: null,        // /api/state
    history: null,     // /api/history items
    teams: null,       // /api/teams
    usage: null,       // /api/usage
    account: store('cc-simple-account') || '',
    q: typeof kept.q === 'string' ? kept.q : '',
    opened: new Set(Array.isArray(kept.opened) ? kept.opened : []), // cards showing all their sessions
    older: kept.older === true,  // projects not used lately are shown
    renaming: null,    // the key of the session whose name is being typed
    stopped: false,
  };
  let shown = '';

  // ---------------------------------------------------------------- utilities

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value);
    }
    el.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
    return el;
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch { /* private window */ }
    return null;
  }

  // Put children in an element, as h() does: lists flattened, false and null left out.
  const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((child) => child != null && child !== false));
  const icon = (name) => window.ccIcon(name);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function toast(message, kind = 'ok') {
    const report = kind === 'error' && window.ccReport;
    if (report) report.noteError(message);
    const el = h('div', { class: `toast toast-${kind}` }, message);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4500);
  }

  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function tokens(n) {
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(n);
  }

  // A page in a new tab, through a link.
  function newTab(url) {
    const link = h('a', { href: url, target: '_blank', rel: 'noopener' });
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied.');
    } catch {
      toast('The browser would not copy it.', 'error');
    }
  }

  // ---------------------------------------------------------------------- API

  let token = new URLSearchParams(location.search).get('t');
  if (token) {
    store('cc-token', token);
    history.replaceState(null, '', location.pathname);
  } else {
    token = store('cc-token') || '';
  }
  window.ccToken = token;   // for Settings, which talks to the server too

  async function api(path, body) {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-CC-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Open Paddock from the terminal once, so this page has its key.');
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  // Run an action, say how it went, and read the sessions again.
  async function act(run, done) {
    try {
      const result = await run();
      if (done) toast(typeof done === 'function' ? done(result) : done);
      return result;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    } finally {
      refresh();
    }
  }

  // ------------------------------------------------------------------ the data

  const folderId = (cwd) => {
    const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean);
    return parts.length ? `/${parts.join('/')}` : '?';
  };
  const folderPath = (id) => (!id || id === '?' ? '' : /^\/(~|[A-Za-z]:)/.test(id) ? id.slice(1) : id);
  const accountOf = (name) => (S.data ? S.data.accounts.find((a) => a.name === name) : null) || {};
  function accountColor(name) {
    const accounts = S.data ? S.data.accounts : [];
    const index = accounts.findIndex((a) => a.name === name);
    return (index >= 0 && accounts[index].color) || COLORS[(index < 0 ? 0 : index) % COLORS.length];
  }

  // Running sessions and saved conversations, one entry each, as the other pages make them.
  function entries() {
    const saved = new Map((S.history || []).map((item) => [`${item.account}|${item.sessionId}`, item]));
    const list = S.data.sessions.map((s) => {
      const id = `${s.account}|${s.sessionId}`;
      const item = s.sessionId ? saved.get(id) : undefined;
      saved.delete(id);
      return entry(s, item);
    });
    for (const item of saved.values()) list.push(entry(null, item));
    // Opened and never used: nothing to go back to.
    return list.filter((e) => e.session || e.item.prompts > 0);
  }

  function entry(s, item) {
    const { account, sessionId } = s || item;
    const cwd = (s && s.cwd) || (item && item.cwd) || '';
    return {
      key: sessionId ? `${account}|${sessionId}` : `s:${s.key}`,
      session: s,
      item,
      account,
      sessionId,
      name: s ? s.name : item.title,
      renamed: (s || item).renamed,
      pinned: Boolean((s && s.pinned) || (item && item.pinned)),
      cwd,
      status: s ? s.status : 'closed',
      open: Boolean(s && s.open),
      at: Math.max((s && (s.closedAt || s.updatedAt)) || 0, (item && item.lastActivity) || 0),
      command: (s && s.resumeCommand) || (item && item.resumeCommand) || '',
      search: `${s ? s.name : item.title} ${cwd} ${account} ${(item && item.promptText) || ''}`.toLowerCase(),
    };
  }

  const needsYou = (e) => e.open && (e.status === 'blocked' || (e.status === 'done' && Date.now() - e.at < DAY));
  const working = (e) => e.open && e.status === 'working';
  // Within a card: what needs you, then what is working, open, pinned, then the latest.
  const rank = (e) => (needsYou(e) ? 0 : working(e) ? 1 : e.open ? 2 : e.pinned ? 3 : 4);

  // The projects to show: sessions grouped by folder, for the chosen account and search.
  function projects() {
    const needle = S.q.trim().toLowerCase();
    const pinned = new Set((S.data.pinnedFolders || []).map(folderId));
    const byFolder = new Map();
    for (const e of entries()) {
      if (S.account && e.account !== S.account) continue;
      const id = folderId(e.cwd);
      if (!byFolder.has(id)) byFolder.set(id, []);
      byFolder.get(id).push(e);
    }
    const list = [];
    for (const [id, all] of byFolder) {
      const path = folderPath(id);
      const name = id === '?' ? 'No folder' : id === '/~' ? 'Home' : id.split('/').pop();
      const matches = needle && !`${name} ${path}`.toLowerCase().includes(needle) ? all.filter((e) => e.search.includes(needle)) : all;
      if (!matches.length) continue;
      matches.sort((a, b) => rank(a) - rank(b) || b.at - a.at);
      list.push({
        id,
        path,
        name,
        parent: path.slice(0, Math.max(0, path.length - name.length - 1)),
        sessions: matches,
        accounts: [...new Set(all.map((e) => e.account))],
        needs: all.filter(needsYou).length,
        working: all.filter(working).length,
        open: all.filter((e) => e.open).length,
        pinned: pinned.has(id),
        at: Math.max(...all.map((e) => e.at)),
      });
    }
    const order = (p) => (p.needs ? 0 : p.working ? 1 : p.pinned ? 2 : p.open ? 3 : 4);
    return list.sort((a, b) => order(a) - order(b) || b.at - a.at);
  }

  // ------------------------------------------------------------------ drawing

  function render(force = false) {
    if (!S.data || S.stopped) return;
    // Leave the page be while something on it is being used.
    if (!force && (!$('#menu').hidden || S.renaming || document.querySelector('dialog[open]'))) return;
    const list = projects();
    const signature = JSON.stringify([list.map((p) => [p.id, p.needs, p.working, p.pinned, p.sessions.map((e) => [e.key, e.name, e.status, e.pinned, Math.round(e.at / 60000)])]),
      S.account, S.opened.size, S.older, S.teams, S.usage && S.usage.at, S.data.accounts.map((a) => [a.name, a.color])]);
    if (!force && signature === shown) return;
    shown = signature;
    const waiting = list.reduce((n, p) => n + p.needs, 0);
    document.title = `${waiting ? `(${waiting}) ` : ''}Paddock`;
    drawFilters();
    drawToday();
    drawTeams();
    drawCards(list);
    keep();
    // Back to where the page was, once the cards it was showing are there.
    if (S.history && kept.scroll && !keep.restored) {
      keep.restored = true;
      window.scrollTo(0, kept.scroll);
    }
  }

  function keep() {
    try {
      // Until the page is back where it was, the place it was is still the one to keep.
      const scroll = keep.restored || !kept.scroll ? Math.round(window.scrollY) : kept.scroll;
      sessionStorage.setItem(KEPT, JSON.stringify({ q: S.q, opened: [...S.opened], older: S.older, scroll }));
    } catch { /* nothing kept: a reload starts at the top */ }
  }

  function drawFilters() {
    const all = entries();
    const accounts = S.data.accounts.filter((a) => !a.removed && all.some((e) => e.account === a.name));
    if (S.account && !accounts.some((a) => a.name === S.account)) S.account = '';
    const chip = (name, label, count, color) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.account === name),
      onclick: () => { S.account = name; store('cc-simple-account', name); render(true); } },
    color && h('span', { class: 'dot', style: { '--acct': color } }), label, h('span', { class: 'count' }, String(count)));
    fill($('#filters'),
      chip('', 'All', all.length),
      accounts.length > 1 && accounts.map((a) => chip(a.name, a.name, all.filter((e) => e.account === a.name).length, accountColor(a.name))));
  }

  // Today's tokens, on this browser's own day, for the chosen account or all of them.
  function drawToday() {
    const el = $('#today');
    if (!S.usage) { el.hidden = true; return; }
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const from = start.getTime();
    const per = [];
    for (const [name, data] of Object.entries(S.usage.accounts)) {
      if (S.account && name !== S.account) continue;
      const sum = data.hours.filter((row) => row[0] * 3600000 >= from).reduce((n, row) => n + row[1] + row[2] + row[3] + row[4], 0);
      if (sum) per.push([name, sum]);
    }
    const total = per.reduce((n, [, sum]) => n + sum, 0);
    el.hidden = !total;
    if (!total) return;
    fill(el, 'Today: ', h('b', {}, `${tokens(total)} tokens`),
      per.length > 1 && per.sort((a, b) => b[1] - a[1]).map(([name, sum]) => [' · ', h('span', { class: 'dot', style: { '--acct': accountColor(name) } }), ` ${name} ${tokens(sum)}`]));
  }

  function modelTone(model) {
    const id = String(model || '').toLowerCase();
    const family = ['opus', 'sonnet', 'haiku'].find((f) => id.includes(f));
    return { tone: family || 'other', label: family ? family[0].toUpperCase() + family.slice(1) : (model || '').replace(/^claude-/, '') };
  }

  // Teams working now, each opening its team page.
  function drawTeams() {
    const el = $('#teams');
    const live = (S.teams || []).filter((t) => (!S.account || t.account === S.account) && t.runs.some((run) => run.state === 'running'));
    el.hidden = !live.length;
    if (!live.length) return;
    fill(el, h('span', { class: 'teams-label' }, icon('users'), ' Teams working'),
      live.map((t) => {
        const running = [...new Map(t.runs.filter((run) => run.state === 'running').map((run) => [run.type, run])).values()];
        return h('a', { class: 'team', href: `/team?account=${encodeURIComponent(t.account)}&session=${encodeURIComponent(t.sessionId)}`, target: '_blank', rel: 'noopener', title: 'Open the team' },
          h('b', {}, t.title),
          running.map((run) => {
            const member = t.members.find((m) => m.name === run.type);
            const model = modelTone(member && member.model !== 'inherit' ? member.model : run.model);
            return h('span', { class: `member tone-${model.tone}` }, `${run.type} · ${model.label}`);
          }));
      }));
  }

  function drawCards(list) {
    const cutoff = Date.now() - OLD;
    const recent = list.filter((p) => S.older || S.q.trim() || p.open || p.pinned || p.at >= cutoff);
    const folded = list.length - recent.length;
    const cards = $('#cards');
    if (!S.history && !list.length) return cards.replaceChildren(h('p', { class: 'empty' }, 'Reading your sessions…'));
    if (!list.length) {
      return cards.replaceChildren(h('p', { class: 'empty' }, S.q.trim() ? `Nothing matches “${S.q.trim()}”.` : 'No sessions yet. Start Claude Code or Codex in a project and it shows up here.'));
    }
    fill(cards, recent.map(card),
      folded > 0 && h('button', { type: 'button', class: 'link older', onclick: () => { S.older = true; render(true); } }, `Show ${plural(folded, 'older project')}`),
      S.older && !S.q.trim() && h('button', { type: 'button', class: 'link older', onclick: () => { S.older = false; render(true); } }, 'Hide older projects'));
  }

  function card(p) {
    const opened = S.opened.has(p.id);
    const rows = p.sessions.slice(0, opened ? MOST : SHOWN);
    const hidden = p.sessions.length - rows.length;
    const state = p.needs ? h('div', { class: 'state', 'data-state': 'needs' }, h('span', { class: 'status', 'data-status': 'blocked' }), h('b', {}, `${p.needs} need${p.needs === 1 ? 's' : ''} you`))
      : p.working ? h('div', { class: 'state', 'data-state': 'working' }, h('span', { class: 'status', 'data-status': 'working' }), h('b', {}, `${p.working} working`))
        : h('div', { class: 'state' }, h('span', { class: 'status', 'data-status': p.open ? 'idle' : 'closed' }), p.open ? `${p.open} open` : `Last used ${ago(p.at)}`);
    return h('article', { class: `card${p.needs ? ' needs' : p.working ? ' busy' : ''}`, 'aria-label': p.name },
      h('header', { class: 'card-head' },
        h('div', { class: 'card-title' },
          h('h2', { title: p.path }, p.pinned && h('span', { class: 'pin-mark', title: 'Pinned' }, '● '), p.name),
          h('p', { title: p.path }, p.parent || ' ')),
        h('span', { class: 'dots' }, p.accounts.map((name) => h('span', { class: 'dot', title: name, style: { '--acct': accountColor(name) } }))),
        h('button', { type: 'button', class: 'icon-btn more-btn', 'aria-label': `More for ${p.name}`, 'aria-haspopup': 'menu',
          onclick: (event) => showMenu(event.currentTarget, projectMenu(p)) }, icon('ellipsis'))),
      state,
      h('ul', { class: 'rows' }, rows.map(row)),
      (hidden > 0 || opened) && h('div', { class: 'card-foot' },
        h('button', { type: 'button', class: 'link', onclick: () => { if (opened) S.opened.delete(p.id); else S.opened.add(p.id); render(true); } },
          opened ? 'Show fewer' : `+ ${hidden} more`)));
  }

  function row(e) {
    const meta = needsYou(e) ? (e.status === 'blocked' ? 'Needs you' : `Finished ${ago(e.at)}`)
      : e.open ? `${STATUS[e.status] || e.status} · ${ago(e.at)}` : ago(e.at);
    const first = e.item && e.item.firstPrompt;
    const primary = e.open ? h('button', { type: 'button', class: `btn${needsYou(e) ? ' btn-primary' : ''}`, onclick: () => resume(e) }, 'Open')
      : e.command ? h('button', { type: 'button', class: 'btn', onclick: () => resume(e) }, 'Resume') : null;
    return h('li', { class: 'row', 'data-status': e.status },
      h('span', { class: 'status', 'data-status': e.open ? e.status : 'closed', title: STATUS[e.status] || e.status }),
      h('span', { class: 'who' },
        S.renaming === e.key ? renameBox(e) : h('span', { class: 'name', title: first || e.name }, e.name),
        h('span', { class: 'meta' }, accountsShown() && [h('span', { class: 'dot', style: { '--acct': accountColor(e.account) } }), ' '], meta)),
      primary || h('span'),
      h('button', { type: 'button', class: 'icon-btn more-btn', 'aria-label': `More for ${e.name}`, 'aria-haspopup': 'menu',
        onclick: (event) => showMenu(event.currentTarget, sessionMenu(e)) }, icon('ellipsis')));
  }

  // Each session's account is marked only where more than one shows.
  const accountsShown = () => !S.account && S.data.accounts.filter((a) => !a.removed).length > 1;

  // -------------------------------------------------------------------- menus

  function sessionMenu(e) {
    const editor = window.ccEditor && window.ccEditor.current();
    const claude = (accountOf(e.account).tool || 'claude') === 'claude';
    return [
      e.sessionId && ['Rename', 'pencil', () => { S.renaming = e.key; render(true); const box = $('.rename'); if (box) { box.focus(); box.select(); } }],
      e.sessionId && [e.pinned ? 'Unpin' : 'Pin to the top', e.pinned ? 'pin-off' : 'pin', () => pin(e)],
      e.command && ['Copy command', 'copy', () => copy(e.command)],
      e.sessionId && claude && ['Team', 'users', () => newTab(`/team?account=${encodeURIComponent(e.account)}&session=${encodeURIComponent(e.sessionId)}`)],
      editor && e.cwd && [`Open in ${editor.name}`, 'square-code', () => act(() => window.ccEditor.open(e.session ? { key: e.session.key } : { account: e.account, sessionId: e.sessionId }), (name) => `Opened ${e.name} in ${name}.`)],
      e.open && 'hr',
      e.open && ['Close session…', 'circle-stop', () => closeSession(e), true],
    ];
  }

  function projectMenu(p) {
    const editor = window.ccEditor && window.ccEditor.current();
    return [
      p.id !== '?' && [p.pinned ? 'Unpin project' : 'Pin project to the top', p.pinned ? 'pin-off' : 'pin',
        () => act(() => api('/api/pins', { folder: p.path, pinned: !p.pinned }), p.pinned ? `Unpinned ${p.name}.` : `Pinned ${p.name} to the top.`)],
      editor && p.id !== '?' && [`Open in ${editor.name}`, 'square-code', () => act(() => window.ccEditor.open({ folder: p.path }), (name) => `Opened ${p.name} in ${name}.`)],
      p.path && ['Copy folder path', 'copy', () => copy(p.path)],
    ];
  }

  function showMenu(anchor, items) {
    const menu = $('#menu');
    menu.replaceChildren(...items.filter(Boolean).map((item) => item === 'hr' ? h('hr')
      : h('button', { type: 'button', role: 'menuitem', class: item[3] ? 'danger' : null, onclick: () => { hideMenu(); item[2](); } }, icon(item[1]), item[0])));
    if (!menu.firstChild) return;
    menu.hidden = false;
    const at = anchor.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    menu.style.setProperty('left', `${Math.max(8, Math.min(at.right - box.width, innerWidth - box.width - 8))}px`);
    menu.style.setProperty('top', `${at.bottom + box.height + 8 > innerHeight ? Math.max(8, at.top - box.height - 4) : at.bottom + 4}px`);
    menu.querySelector('button').focus();
    menu.anchor = anchor;
  }

  function hideMenu() {
    const menu = $('#menu');
    if (menu.hidden) return;
    menu.hidden = true;
    if (menu.anchor && menu.anchor.isConnected) menu.anchor.focus();
    render();
  }

  // ------------------------------------------------------------------ actions

  function resume(e) {
    return e.session
      ? act(() => api('/api/sessions/resume', { key: e.session.key }), (r) => `Opened ${e.name} in ${r.terminal}.`)
      : act(() => api('/api/history/resume', { account: e.account, sessionId: e.sessionId }), (r) => `Opened ${e.name} in ${r.terminal}.`);
  }

  async function pin(e) {
    await act(() => api('/api/pins', { account: e.account, sessionId: e.sessionId, pinned: !e.pinned }), e.pinned ? 'Unpinned.' : 'Pinned to the top.');
    loadHistory();
  }

  function renameBox(e) {
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = box.value.trim();
      S.renaming = null;
      render(true);
      if (!save || value === e.name || (!value && !e.renamed)) return;
      await act(() => api('/api/sessions/rename', { account: e.account, sessionId: e.sessionId, title: value }),
        value ? `Renamed to ${value}.` : 'Back to its own title.');
      loadHistory();
    };
    const box = h('input', { type: 'text', class: 'rename', value: e.name, 'aria-label': 'Session name', spellcheck: false,
      onkeydown: (event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
      },
      onblur: () => finish(box.isConnected) });
    return box;
  }

  function closeSession(e) {
    const sheet = $('#sheet');
    const confirm = h('button', { type: 'submit', class: 'btn btn-danger' }, 'Close session');
    sheet.replaceChildren(h('form', { method: 'dialog', onsubmit: async (event) => {
      event.preventDefault();
      sheet.close();
      const result = await act(() => api('/api/sessions/close', { keys: [e.session.key] }));
      const outcome = result && result.results[0];
      if (outcome && outcome.ok) toast('Closed. The conversation is kept.');
      else if (outcome) toast(`Could not close it: ${outcome.message}`, 'error');
    } },
    h('h2', { id: 'sheet-title' }, `Close “${e.name}”?`),
    h('p', {}, 'It stops, and its conversation is kept, so you can resume it later.'),
    h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => sheet.close() }, 'Cancel'), confirm)));
    sheet.showModal();
    confirm.focus();
  }

  // -------------------------------------------------------------------- data

  async function refresh() {
    if (S.stopped) return;
    try {
      S.data = await api('/api/state');
    } catch (err) {
      if (!S.data) $('#cards').replaceChildren(h('p', { class: 'empty' }, err.message));
      return;
    }
    // A new version (the server updated itself) reloads the page; after one, says what's new.
    if (window.ccUpdates) window.ccUpdates.seen(S.data);
    render();
  }

  async function loadHistory() {
    if (S.stopped) return;
    try {
      S.history = (await api('/api/history')).items;
    } catch (err) {
      toast(`Could not read saved conversations: ${err.message}`, 'error');
    }
    render();
  }

  async function loadTeams() {
    if (S.stopped) return;
    try {
      S.teams = (await api('/api/teams')).teams;
      render();
    } catch { /* the strip waits for the next try */ }
  }

  async function loadUsage() {
    if (S.stopped) return;
    try {
      S.usage = { ...(await api('/api/usage')), at: Date.now() };
      render();
    } catch { /* the line waits for the next try */ }
  }

  // ------------------------------------------------------------------- start

  $('#settings').append(icon('settings'));
  $('#settings').addEventListener('click', () => window.ccSettings.open());
  $('#search').value = S.q;
  $('#search').addEventListener('input', (event) => { S.q = event.target.value; render(true); });
  let scrolling = 0;
  window.addEventListener('scroll', () => {
    clearTimeout(scrolling);
    scrolling = setTimeout(keep, 200);
  }, { passive: true });
  document.addEventListener('click', (event) => {
    if (!$('#menu').hidden && !event.target.closest('#menu') && !event.target.closest('.more-btn')) hideMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]') || S.renaming) return;
    const menu = $('#menu');
    if (!menu.hidden) {
      const buttons = [...menu.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') hideMenu();
      else if (event.key === 'ArrowDown') buttons[(at + 1) % buttons.length].focus();
      else if (event.key === 'ArrowUp') buttons[(at + buttons.length - 1) % buttons.length].focus();
      else return;
      event.preventDefault();
      return;
    }
    const typing = event.target instanceof Element && event.target.closest('input, textarea');
    if (event.key === '/' && !typing) {
      event.preventDefault();
      $('#search').focus();
    } else if (event.key === 'Escape' && event.target === $('#search')) {
      $('#search').value = '';
      S.q = '';
      render(true);
    }
  });
  window.addEventListener('cc-settings-changed', () => { shown = ''; refresh(); });
  window.addEventListener('cc-stopped', () => {
    S.stopped = true;
    $('#cards').replaceChildren(h('p', { class: 'empty' }, 'Paddock has stopped. Run it again from a terminal to come back here.'));
  });

  refresh().then(() => { loadHistory(); loadTeams(); loadUsage(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  setInterval(() => { if (!document.hidden) loadTeams(); }, 5000);
  setInterval(() => { if (!document.hidden) loadHistory(); }, 20000);
  setInterval(() => { if (!document.hidden) loadUsage(); }, 60000);
})();
