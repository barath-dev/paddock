'use strict';

// A session's team, drawn the way work flows: the session itself leads, at the
// top, and hands work down to its members, Claude Code sub-agents defined in the
// project. Each box lights up while that member is running. Members are edited
// here; what they did is read from the session's transcripts.

const $ = (selector) => document.querySelector(selector);
const POLL_MS = 4000;
const params = new URLSearchParams(location.search);
const ACCOUNT = params.get('account') || '';
let SESSION = params.get('session') || '';
// The team from the sketch this page was made for: one reads, one scores, one checks.
const TEMPLATE = {
  title: 'Report review',
  lead: 'Analyse the report',
  members: [
    { name: 'scorer', model: 'sonnet', short: 'scores it', job: 'Scores the report against the criteria the lead gives, with a short reason for each score.' },
    { name: 'answer-checker', model: 'haiku', short: 'checks the answers', job: 'Checks the answers in the report for mistakes and says which are right, which are wrong, and why.' },
  ],
};

let team = null;
let shown = '';
let editingLead = false;

// ------------------------------------------------------------------ utilities

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

function svg(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private window */ }
  return null;
}

const icon = (name) => window.ccIcon(name);

function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4000);
}

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}
const tokenSum = (t) => (t ? t.input + t.output + t.cacheWrite + t.cacheRead : 0);

// ----------------------------------------------------------------------- API

let token = params.get('t');
if (token) {
  store('cc-token', token);
  params.delete('t');
  history.replaceState(null, '', `${location.pathname}?${params}`);
} else {
  token = store('cc-token') || '';
}

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

const send = (path, body) => api(path, { account: ACCOUNT, sessionId: SESSION, ...body });

// -------------------------------------------------------------------- models

// "opus", "claude-opus-5-5" or "claude-3-5-haiku-20241022" as a colour and a name.
function modelOf(model) {
  const id = String(model || '').toLowerCase();
  const family = ['opus', 'sonnet', 'haiku', 'fable'].find((f) => id.includes(f));
  const tone = family === 'fable' ? 'other' : family || 'other';
  if (!family) return { tone, label: model || 'Unknown' };
  const numbers = id.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '').replace(family, '').split('-').filter((p) => /^\d+$/.test(p));
  const name = family[0].toUpperCase() + family.slice(1);
  return { tone, label: numbers.length ? `${name} ${numbers.join('.')}` : name };
}

// A member's model: its own, or the lead's when it runs on whatever the lead does.
function memberModel(member) {
  if (member.model !== 'inherit') return { ...modelOf(member.model), inherit: false };
  const lead = modelOf(team.lead.model);
  return { tone: lead.tone, label: team.lead.model ? lead.label : 'Lead’s model', inherit: true };
}

function chip(model, extra) {
  return h('span', { class: `chip tone-${model.tone}`, title: extra || null }, model.label);
}

// ------------------------------------------------------------------- drawing

function runsOf(type) {
  return team.runs.filter((run) => run.type === type);
}

function stateOf(runs) {
  if (runs.some((run) => run.state === 'running')) return ['running', 'Running'];
  if (runs.length) return ['done', `Ran ${runs.length === 1 ? 'once' : `${runs.length} times`}`];
  return ['idle', 'Not used yet'];
}

function usedFacts(runs) {
  if (!runs.length) return [];
  const used = runs.reduce((sum, run) => sum + tokenSum(run.tokens), 0);
  const last = Math.max(...runs.map((run) => run.lastAt));
  return [h('span', {}, `${tokens(used)} tokens`), h('span', {}, ago(last))];
}

function leadCard() {
  const model = team.lead.model ? modelOf(team.lead.model) : { tone: 'other', label: 'No replies yet' };
  const job = editingLead
    ? h('input', { class: 'lead-job', value: team.lead.job || '', placeholder: 'What the lead does, like “Analyse the report”', 'aria-label': 'What the lead does',
      onkeydown: (event) => {
        if (event.key === 'Enter') saveLead(event.target.value);
        if (event.key === 'Escape') { editingLead = false; draw(true); }
      },
      onblur: (event) => saveLead(event.target.value) })
    : h('button', { type: 'button', class: `link job${team.lead.job ? '' : ' empty'}`, title: 'Change what the lead does',
      onclick: () => { editingLead = true; draw(true); } }, team.lead.job || 'Say what the lead does…');
  return h('div', { class: `card lead tone-${model.tone}`, id: 'lead' },
    h('div', { class: 'card-top' }, h('span', { class: 'role' }, 'Lead · this session'), chip(model)),
    h('div', { class: 'name' }, 'Main session'),
    job,
    h('div', { class: 'facts' },
      h('span', { class: 'state', 'data-state': LEAD_STATES[leadStatus()][0] }, LEAD_STATES[leadStatus()][1]),
      tokenSum(team.lead.tokens) > 0 && h('span', {}, `${tokens(tokenSum(team.lead.tokens))} tokens of its own`)),
    leadStatus() === 'blocked' && team.key && h('div', { class: 'card-actions' },
      h('button', { type: 'button', class: 'btn', onclick: openLead }, icon('square-terminal'), 'Open in a terminal')));
}

// How the session is doing, as Paddock lists it: [the dot's state, what it says].
const LEAD_STATES = {
  working: ['running', 'Working'],
  blocked: ['stopped', 'Waiting for you'],
  idle: ['idle', 'Open, idle'],
  done: ['done', 'Done'],
  closed: ['idle', 'Closed'],
};
const leadStatus = () => (LEAD_STATES[team.status] ? team.status : team.open ? 'idle' : 'closed');

function memberCard(member) {
  const model = memberModel(member);
  const runs = runsOf(member.name);
  const [state, label] = stateOf(runs);
  return h('button', { type: 'button', class: `card member tone-${model.tone}${state === 'running' ? ' running' : ''}`, 'data-member': member.name, 'data-tone': model.tone,
    'aria-label': `${member.name}, ${model.label}. ${member.job}. ${label}. Edit`, onclick: () => editMember(member) },
  h('div', { class: 'card-top' }, h('span', { class: 'role' }, 'Member'), chip(model, model.inherit ? 'Runs on the lead’s model' : null)),
  h('div', { class: 'name' }, member.name),
  h('div', { class: `job${member.job ? '' : ' empty'}` }, member.job || 'No description: the lead will not know when to use it.'),
  h('div', { class: 'facts' }, h('span', { class: 'state', 'data-state': state }, label), usedFacts(runs)));
}

// Sub-agents the session ran that are not members: Claude Code's own, or another folder's.
function otherCard(type) {
  const runs = runsOf(type);
  const model = modelOf(runs.map((run) => run.model).find(Boolean));
  const [state, label] = stateOf(runs);
  return h('div', { class: `card other tone-${model.tone}${state === 'running' ? ' running' : ''}`, 'data-member': type, 'data-tone': model.tone },
    h('div', { class: 'card-top' }, h('span', { class: 'role' }, 'Sub-agent'), chip(model)),
    h('div', { class: 'name' }, type),
    h('div', { class: 'job' }, runs[runs.length - 1].task || ''),
    h('div', { class: 'facts' }, h('span', { class: 'state', 'data-state': state }, label), usedFacts(runs)));
}

// A session with no team yet: what it has, and how to start one. The template is only offered, never drawn as a team.
function emptyCard() {
  const folder = team.cwd.split('/').filter(Boolean).pop() || team.cwd;
  const used = [...new Set(team.runs.map((run) => run.type))];
  return h('div', { class: 'card empty-team' },
    h('div', { class: 'card-top' }, h('span', { class: 'role' }, 'No team yet')),
    h('div', { class: 'name' }, folder),
    h('div', { class: 'job' },
      `Members belong to this folder, so every session in ${folder} shares them. `,
      used.length ? `This session has started ${used.join(', ')} on its own, without a team.` : 'This session has not started any sub-agents.'),
    h('div', { class: 'card-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => editMember(null) }, icon('user-plus'), 'Add the first member')),
    h('p', { class: 'template-line' }, 'Or use a template: ',
      h('button', { type: 'button', class: 'link', onclick: useTemplate,
        title: TEMPLATE.members.map((m) => `${m.name} on ${modelOf(m.model).label}: ${m.job}`).join('\n') },
      `${TEMPLATE.title} (adds ${TEMPLATE.members.map((m) => m.name).join(' and ')})`)));
}

function addCard() {
  return h('button', { type: 'button', class: 'card add', onclick: () => editMember(null) }, icon('user-plus'), 'Add a member');
}

function draw(force = false) {
  const signature = JSON.stringify(team);
  if (!force && signature === shown) return;
  // Typing in the lead's box: leave it be until it is saved.
  if (!force && document.activeElement && document.activeElement.classList.contains('lead-job')) return;
  shown = signature;

  document.title = `Team · ${team.title}`;
  $('#title').textContent = team.title;
  $('#where').textContent = `${team.cwd} · ${team.account}`;
  $('#top-actions').replaceChildren(
    h('button', { type: 'button', class: 'btn', onclick: () => editMember(null) }, icon('user-plus'), 'Add a member'));
  drawRunBox();

  const names = new Set(team.members.map((m) => m.name));
  const others = [...new Set(team.runs.map((run) => run.type))].filter((type) => !names.has(type));
  const diagram = $('#diagram');
  diagram.replaceChildren(...[
    svg('svg', { class: 'wires', id: 'wires', 'aria-hidden': 'true' }),
    h('div', { class: 'tier' }, leadCard()),
    h('div', { class: 'tier' }, team.members.map(memberCard), team.members.length ? addCard() : emptyCard()),
    others.length > 0 && h('div', { class: 'tier' }, h('div', { class: 'tier-label' }, 'Also started by this session, not on the team'), others.map(otherCard)),
  ].filter(Boolean));
  if (editingLead) diagram.querySelector('.lead-job').focus();

  const lead = modelOf(team.lead.model);
  const wantsOpus = team.members.length > 0 && Boolean(team.lead.model) && lead.tone !== 'opus';
  $('#note').replaceChildren(h('span', {},
    'Members are Claude Code agent files in ', h('code', {}, team.agentsDir), ', so any session in this folder can use them. ',
    'Running the team from here starts Claude Code afresh, so it always sees the members as they are now.',
    wantsOpus && [h('br'), `The lead runs on ${lead.label}. To lead on Opus, type `, h('code', {}, '/model opus'), ' in the session.']));
  wires();
  drawRuns();
}

// Lines from the lead down to each member: down, across, down, as on paper.
function wires() {
  const diagram = $('#diagram');
  const layer = $('#wires');
  const lead = $('#lead');
  if (!layer || !lead) return;
  const box = diagram.getBoundingClientRect();
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
  };
  const from = rect(lead);
  const fx = from.x + from.w / 2;
  const fy = from.y + from.h;
  const paths = [];
  const arrows = [];
  for (const card of diagram.querySelectorAll('[data-member]')) {
    const to = rect(card);
    const tx = to.x + to.w / 2;
    const ty = to.y;
    const mid = card.classList.contains('other') ? ty - 22 : fy + (ty - fy) / 2;
    const r = Math.min(8, Math.abs(tx - fx) / 2);
    const turn = tx === fx ? '' : `Q ${fx} ${mid} ${fx + Math.sign(tx - fx) * r} ${mid} L ${tx - Math.sign(tx - fx) * r} ${mid} Q ${tx} ${mid} ${tx} ${mid + r}`;
    const live = card.classList.contains('running') ? ` live tone-${card.dataset.tone}` : '';
    paths.push(svg('path', { class: `wire${live}${card.classList.contains('other') ? ' dashed' : ''}`,
      d: `M ${fx} ${fy} L ${fx} ${mid - (tx === fx ? 0 : r)} ${turn} L ${tx} ${ty - 7}` }));
    arrows.push(svg('path', { class: `arrow${live}`, d: `M ${tx - 5} ${ty - 8} L ${tx + 5} ${ty - 8} L ${tx} ${ty - 1} Z` }));
  }
  layer.replaceChildren(...paths, ...arrows);
}

function drawRuns() {
  const runs = [...team.runs].reverse();
  if (!runs.length) {
    $('#runs').replaceChildren(h('p', { class: 'empty-runs' }, 'No sub-agents yet. When the session hands work to one, it shows here and its box lights up.'));
    return;
  }
  const members = new Map(team.members.map((m) => [m.name, m]));
  $('#runs').replaceChildren(h('div', { class: 'run-list' }, runs.map((run) => {
    const model = modelOf(run.model);
    const states = { running: 'Running', done: 'Done', stopped: 'Stopped' };
    return h('div', { class: `run tone-${model.tone}${run.depth > 1 ? ' nested' : ''}` },
      h('span', { class: 'when', title: new Date(run.startedAt).toLocaleString() }, ago(run.startedAt)),
      h('span', { class: 'who' }, h('b', { title: members.has(run.type) ? 'On the team' : 'Not on the team' }, run.type), run.model && chip(model)),
      h('span', { class: 'task', title: run.task }, run.depth > 1 ? `${run.task} (started by a sub-agent)` : run.task),
      h('span', { class: 'used' }, `${tokens(tokenSum(run.tokens))} tokens`),
      h('span', { class: 'state', 'data-state': run.state }, states[run.state] || run.state));
  })));
}

// ------------------------------------------------------------------- actions

async function load() {
  try {
    team = await api(`/api/team?account=${encodeURIComponent(ACCOUNT)}&session=${encodeURIComponent(SESSION)}`);
    draw();
  } catch (error) {
    if (!team) {
      $('#title').textContent = 'No team to show';
      $('#where').textContent = error.message;
    } else {
      toast(error.message, 'error');
    }
  }
}

async function saveLead(job) {
  if (!editingLead) return;
  editingLead = false;
  if (job.trim() === (team.lead.job || '')) return draw(true);
  try {
    await send('/api/team/lead', { job });
  } catch (error) {
    toast(error.message, 'error');
  }
  await load();
  draw(true);
}

// The box that sets the team to work. Drawn once, so polling never touches what is being typed.
function drawRunBox() {
  const box = $('#run');
  if (!box.firstChild) {
    box.append(
      h('h2', { class: 'section-title', id: 'run-title' }, 'Run the team'),
      h('form', { class: 'run-box', onsubmit: (event) => { event.preventDefault(); runTeam(); } },
        h('textarea', { id: 'run-task', rows: 4, 'aria-labelledby': 'run-title',
          placeholder: 'What should the team work on? Paste the report, or say which file it is in.' }),
        h('div', { class: 'run-row' },
          h('fieldset', { class: 'models' }, h('legend', { class: 'sr-only' }, 'The lead runs on'), h('span', { class: 'hint' }, 'Lead on'),
            [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']].map(([id, label]) => h('label', { class: `tone-${id}` },
              h('input', { type: 'radio', name: 'lead-model', value: id, checked: id === 'opus' }), label))),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'link', onclick: copyPrompt }, 'Copy the prompt instead'),
          h('button', { type: 'submit', class: 'btn btn-primary', id: 'run-go' }, icon('play'), 'Run the team')),
        h('p', { class: 'hint', id: 'run-hint' })));
  }
  $('#run-go').disabled = !team.members.length || running;
  $('#run-hint').textContent = !team.members.length ? 'Add a member first: the team runs with the members of this folder.'
    : team.open ? 'This session is open, so the team starts as a new background session in the same folder, and this page follows it.'
      : 'Claude Code continues this session in the background with the team. Watch the boxes light up as each member works.';
}

let running = false;

async function runTeam() {
  const task = $('#run-task').value.trim();
  if (!task) {
    toast('Say what the team should work on.', 'error');
    return $('#run-task').focus();
  }
  const model = (document.querySelector('input[name="lead-model"]:checked') || {}).value || 'opus';
  running = true;
  drawRunBox();
  try {
    const started = await send('/api/team/run', { prompt: teamPrompt(task), model });
    $('#run-task').value = '';
    if (started.sessionId && started.sessionId !== SESSION) {
      SESSION = started.sessionId;
      params.set('session', SESSION);
      history.replaceState(null, '', `${location.pathname}?${params}`);
      toast(`The team is running as a new background session (${started.id}). Following it here.`);
    } else {
      toast(`The team is running in the background (${started.id}).`);
    }
  } catch (error) {
    toast(error.message, 'error');
  }
  running = false;
  await load();
  drawRunBox();
}

async function openLead() {
  try {
    await api('/api/sessions/resume', { key: team.key });
    toast('Opened in a terminal.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function teamPrompt(task) {
  const lead = team.lead.job ? `${team.lead.job.replace(/[.\s]+$/, '')}.` : 'Lead this piece of work.';
  return [
    lead,
    '',
    'You lead a team. Hand work to its members with the Agent tool, by name:',
    ...team.members.map((m) => `- ${m.name} (${memberModel(m).label}): ${m.job}`),
    '',
    'If a member is not among your agent types yet, start a general-purpose agent on that member’s model instead, and give it the member’s job.',
    'Start members whose work does not depend on each other at the same time. Then bring their results together and give me one answer.',
    ...(task ? ['', 'The work:', task] : []),
  ].join('\n');
}

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(teamPrompt($('#run-task').value.trim()));
    toast('Copied. Paste it into the session to start the team.');
  } catch {
    toast('The browser would not copy. Select the text in the next window instead.', 'error');
  }
}

async function useTemplate() {
  try {
    for (const member of TEMPLATE.members) {
      if (team.members.some((m) => m.name === member.name)) continue;
      await send('/api/team/member', { member });
    }
    if (!team.lead.job) await send('/api/team/lead', { job: TEMPLATE.lead });
    toast(`${TEMPLATE.title} is set up. Say what to review below and run the team.`);
  } catch (error) {
    toast(error.message, 'error');
  }
  await load();
}

const MODEL_CHOICES = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['inherit', 'Same as the lead']];

function editMember(member) {
  const sheet = $('#sheet');
  const model = member ? member.model : 'sonnet';
  const choices = MODEL_CHOICES.some(([id]) => id === model) ? MODEL_CHOICES : [...MODEL_CHOICES, [model, modelOf(model).label]];
  let armed = false;
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('p', { class: 'hint' }, hint));
  const form = h('form', { method: 'dialog',
    onsubmit: async (event) => {
      event.preventDefault();
      const data = new FormData(event.target);
      try {
        await send('/api/team/member', { member: {
          file: member ? member.file : '',
          name: String(data.get('name')).trim(),
          model: String(data.get('model')),
          job: String(data.get('job')),
          instructions: String(data.get('instructions')),
        } });
        sheet.close();
        toast(member ? 'Saved.' : 'Added to the team.');
        await load();
      } catch (error) {
        toast(error.message, 'error');
      }
    } },
  h('h2', { id: 'sheet-title' }, member ? `Edit ${member.name}` : 'Add a member'),
  field('Name', h('input', { name: 'name', required: true, value: member ? member.name : '', placeholder: 'scorer', pattern: '[a-z][a-z0-9\\-]*', maxLength: 48, autocomplete: 'off', spellcheck: false }),
    'Lowercase letters, digits and dashes. The lead calls it by this name.'),
  h('fieldset', { class: 'models' }, h('legend', {}, 'Model'),
    choices.map(([id, label]) => h('label', { class: `tone-${id === 'inherit' ? modelOf(team.lead.model).tone : modelOf(id).tone}` },
      h('input', { type: 'radio', name: 'model', value: id, checked: id === model }), label))),
  field('What it does', h('input', { name: 'job', required: true, value: member ? member.job : '', maxLength: 400, placeholder: 'Checks the answers in the report' }),
    'One sentence. The lead reads it to decide when to hand work over.'),
  field('Instructions', h('textarea', { name: 'instructions', value: member ? member.instructions : '', placeholder: 'Left empty, Paddock writes a short brief from what it does.' }),
    member && member.tools ? `It can use: ${member.tools}. That is kept as it is.` : 'What it is told before it starts. It can use the same tools as the lead.'),
  h('div', { class: 'sheet-actions' },
    member && h('button', { type: 'button', class: 'btn btn-danger',
      onclick: async (event) => {
        if (!armed) {
          armed = true;
          event.currentTarget.textContent = 'Click again to remove';
          return;
        }
        try {
          await send('/api/team/remove', { file: member.file });
          sheet.close();
          toast(`${member.name} is off the team. Its file is kept in Paddock’s folder.`);
          await load();
        } catch (error) {
          toast(error.message, 'error');
        }
      } }, 'Remove'),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'btn', onclick: () => sheet.close() }, 'Cancel'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, member ? 'Save' : 'Add')));
  sheet.replaceChildren(form);
  sheet.showModal();
}

// ---------------------------------------------------------------------- start

$('#back').replaceChildren(icon('chevron-left'), 'Sessions');
if (!ACCOUNT || !SESSION) {
  $('#title').textContent = 'No session chosen';
  $('#where').textContent = 'Open a session in Paddock and choose Team.';
} else {
  load();
  setInterval(() => {
    if (!document.hidden && !$('#sheet').open) load();
  }, POLL_MS);
}
new ResizeObserver(() => wires()).observe($('#diagram'));
