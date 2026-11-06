import { parseConfig, recommendedConfig, MAX_CONFIG_BYTES, MAX_EXPANDED_BYTES, encodeConfig, decodeConfig } from './model.js?v=2';

const $ = id => document.getElementById(id);
const storageKey = 'github-deltachat-notifications-v1';
let config = recommendedConfig();
let catalog = [];
let outputRevision = 0;
const conclusionEvents = new Set(['workflow_run', 'workflow_job', 'check_run', 'check_suite']);
const conclusions = ['failure', 'timed_out', 'startup_failure', 'action_required', 'success', 'neutral', 'cancelled', 'skipped', 'stale'];
const stateEvents = { status: ['error', 'failure', 'pending', 'success'], deployment_status: ['error', 'failure', 'inactive', 'in_progress', 'queued', 'pending', 'success'], page_build: ['built', 'errored', 'building'] };
function message(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function element(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
function ruleFor(name) { return Object.hasOwn(config.events, name) ? config.events[name] : config.default === 'on'; }
function compact() { return JSON.stringify(parseConfig(config)); }
function save() { try { localStorage.setItem(storageKey, JSON.stringify(config)); } catch { /* Browser storage may be disabled. */ } }
function updateOutput() {
  $('json').value = JSON.stringify(config, null, 2);
  const bytes = new TextEncoder().encode(JSON.stringify(config)).length;
  $('size').textContent = `${bytes.toLocaleString()} / ${MAX_CONFIG_BYTES.toLocaleString()} bytes (compact JSON)`;
  $('count').textContent = `(${catalog.filter(event => event.name !== 'ping' && ruleFor(event.name) !== false).length} selected / ${catalog.filter(event => event.name !== 'ping').length})`;
  try { compact(); $('copy').disabled = false; $('download').disabled = false; message(''); }
  catch (error) { $('copy').disabled = true; $('download').disabled = true; message(error.message, true); }
  save();
  updateCompressed();
}
async function updateCompressed() {
  const revision = ++outputRevision;
  $('copy-compressed').disabled = true; $('download-compressed').disabled = true;
  $('encoded').value = ''; $('encoded-size').textContent = 'Compressing…';
  try {
    const encoded = await encodeConfig(config);
    if (revision !== outputRevision) return;
    $('encoded').value = encoded;
    const raw = new TextEncoder().encode(JSON.stringify(config)).length;
    $('encoded-size').textContent = `${encoded.length.toLocaleString()} / ${MAX_CONFIG_BYTES.toLocaleString()} bytes · JSON: ${raw.toLocaleString()} bytes${encoded.length < raw ? ` · ${Math.round((1 - encoded.length / raw) * 100)}% smaller` : ''}`;
    $('copy-compressed').disabled = false; $('download-compressed').disabled = false;
  } catch (error) {
    if (revision !== outputRevision) return;
    $('encoded-size').textContent = error.message;
  }
}
function putRule(name, value) {
  if (typeof value === 'boolean' && value === (config.default === 'on')) delete config.events[name];
  else config.events[name] = value;
  updateOutput();
}
function filterField(event, field, choices, title) {
  const box = element('fieldset'); box.append(element('legend', title));
  const rule = ruleFor(event.name);
  const current = typeof rule === 'object' ? rule[field] : undefined;
  const allLabel = element('label'); const all = document.createElement('input'); all.type = 'checkbox'; all.checked = current === undefined;
  allLabel.append(all, ` Any ${field}`); box.append(allLabel);
  const group = element('div', '', 'choices');
  const values = [...new Set([...choices, ...(current ?? [])])];
  const checks = [];
  for (const value of values) {
    const label = element('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = value;
    input.checked = current ? current.includes(value) : true; input.disabled = all.checked;
    label.append(input, ` ${value}`); group.append(label); checks.push(input);
    input.addEventListener('change', apply);
  }
  box.append(group);
  function apply() {
    const previous = ruleFor(event.name);
    const next = typeof previous === 'object' ? { ...previous } : {};
    if (all.checked) delete next[field]; else next[field] = checks.filter(input => input.checked).map(input => input.value);
    putRule(event.name, Object.keys(next).length ? next : true);
  }
  all.addEventListener('change', () => { for (const input of checks) input.disabled = all.checked; apply(); });
  if (field === 'actions') {
    const label = element('label', 'Custom action names (comma separated)', 'muted');
    const custom = document.createElement('input'); custom.type = 'text'; custom.placeholder = 'e.g. custom_action'; custom.style.width = '100%'; label.append(custom); box.append(label);
    const add = element('button', 'Use custom actions'); add.type = 'button'; box.append(add);
    add.addEventListener('click', () => {
      const names = custom.value.split(',').map(value => value.trim()).filter(Boolean);
      if (!names.length || names.some(name => !/^[a-zA-Z0-9_.-]+$/.test(name))) { message('Enter valid custom action names.', true); return; }
      const previous = ruleFor(event.name);
      putRule(event.name, { ...(typeof previous === 'object' ? previous : {}), actions: names }); renderEvents();
    });
  }
  return box;
}
function eventRow(event) {
  const row = element('div', '', 'event');
  const title = element('div', '', 'event-title'); const label = element('label'); const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = ruleFor(event.name) !== false;
  if (event.name === 'ping') { enabled.checked = false; enabled.disabled = true; }
  label.append(enabled, ` ${event.name}`); title.append(label);
  const link = element('a', 'docs'); link.href = `https://docs.github.com/en/webhooks/webhook-events-and-payloads#${event.name}`; link.className = 'muted'; title.append(link); row.append(title);
  if (event.name === 'ping') { row.append(element('p', 'Always acknowledged; never sent to the channel.', 'muted')); return row; }
  const details = element('details', '', 'filters'); details.hidden = !enabled.checked;
  details.open = typeof ruleFor(event.name) === 'object'; details.append(element('summary', 'Filter actions / results'));
  details.append(filterField(event, 'actions', event.actions, 'Actions (when the payload has an action)'));
  if (conclusionEvents.has(event.name)) details.append(filterField(event, 'conclusions', conclusions, 'Pipeline conclusion'));
  if (stateEvents[event.name]) details.append(filterField(event, 'states', stateEvents[event.name], 'Status / state'));
  row.append(details);
  enabled.addEventListener('change', () => {
    putRule(event.name, enabled.checked);
    row.replaceWith(eventRow(event));
  });
  return row;
}
function renderEvents() {
  $('events').replaceChildren();
  const query = $('search').value.toLowerCase().trim();
  for (const event of catalog) if (!query || `${event.name} ${event.actions.join(' ')}`.includes(query)) $('events').append(eventRow(event));
  if (!$('events').children.length) $('events').append(element('p', 'No matching events.', 'muted'));
}
function refresh() { $('default').value = config.default; renderEvents(); updateOutput(); }
async function importJson(text) {
  try {
    config = typeof text === 'string' && text.trim().startsWith('gz:') ? await decodeConfig(text) : parseConfig(text, MAX_EXPANDED_BYTES);
    for (const name of Object.keys(config.events)) if (!catalog.some(event => event.name === name)) catalog.push({ name, actions: [] });
    catalog.sort((a, b) => a.name.localeCompare(b.name)); refresh(); message('Configuration imported.');
  } catch (error) { message(error.message, true); }
}
$('search').addEventListener('input', renderEvents);
$('recommended').addEventListener('click', () => { config = recommendedConfig(); refresh(); });
$('all').addEventListener('click', () => { config = { version: 1, default: 'off', events: Object.fromEntries(catalog.filter(event => event.name !== 'ping').map(event => [event.name, true])) }; refresh(); });
$('none').addEventListener('click', () => { config = { version: 1, default: 'off', events: {} }; refresh(); });
$('default').addEventListener('change', () => {
  const rules = Object.fromEntries(catalog.filter(event => event.name !== 'ping').map(event => [event.name, ruleFor(event.name)]));
  config.default = $('default').value;
  for (const [name, rule] of Object.entries(rules)) {
    if (typeof rule === 'boolean' && rule === (config.default === 'on')) delete config.events[name]; else config.events[name] = rule;
  }
  refresh();
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(compact()); message('Copied JSON.'); }
  catch { message('Copy unavailable. Use Download JSON or select and copy the JSON manually.', true); }
});
$('download').addEventListener('click', () => {
  try {
    const url = URL.createObjectURL(new Blob([compact() + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'notification-config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); message('JSON downloaded.');
  } catch (error) { message(error.message, true); }
});
$('apply').addEventListener('click', () => importJson($('json').value));
$('json').addEventListener('input', () => { ++outputRevision; $('copy-compressed').disabled = true; $('download-compressed').disabled = true; $('encoded').value = '';  $('copy').disabled = true; $('download').disabled = true; message('Click Import edited JSON to validate and apply your edits.'); });
$('file').addEventListener('change', async () => {
  const file = $('file').files?.[0]; if (!file) return;
  if (file.size > 65536) { message('Import file exceeds 64 KiB.', true); return; }
  importJson(await file.text()); $('file').value = '';
});
$('custom').addEventListener('submit', event => {
  event.preventDefault(); const name = $('custom-name').value.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(name)) { message('Use a lowercase event name with underscores.', true); return; }
  if (!catalog.some(event => event.name === name)) catalog.push({ name, actions: [] });
  catalog.sort((a, b) => a.name.localeCompare(b.name)); config.events[name] = true; $('search').value = name; $('custom-name').value = ''; refresh();
});
try {
  const response = await fetch('./events.json'); if (!response.ok) throw new Error('Could not load the event catalog.');
  const data = await response.json(); catalog = data.events;
  $('catalog-date').textContent = `Updated ${data.updated}.`;
  try { const saved = localStorage.getItem(storageKey); if (saved) config = parseConfig(saved, MAX_EXPANDED_BYTES); } catch { /* Start with recommended settings if stored preferences are invalid. */ }
  for (const name of Object.keys(config.events)) if (!catalog.some(event => event.name === name)) catalog.push({ name, actions: [] });
  refresh();
} catch (error) { $('events').replaceChildren(element('p', error.message, 'error')); message(error.message, true); }

$('copy-compressed').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('encoded').value); message('Compressed secret copied. Paste it into NOTIFICATION_CONFIG.'); }
  catch { message('Clipboard unavailable. Use Download secret.', true); }
});
$('download-compressed').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([$('encoded').value + '\n'], { type: 'text/plain' }));
  const link = document.createElement('a'); link.href = url; link.download = 'notification-config.txt'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); message('Secret downloaded.');
});
