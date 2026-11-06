// Shared by the browser configurator and Worker; no credentials are stored here.
export const MAX_CONFIG_BYTES = 5120;
export const MAX_EXPANDED_BYTES = 65536;
const token = /^[a-zA-Z0-9_.-]+$/;
export function parseConfig(input, maxBytes = MAX_CONFIG_BYTES) {
  const config = typeof input === 'string' ? JSON.parse(input) : input;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a JSON object.');
  if (Object.keys(config).some(key => !['version', 'default', 'events'].includes(key))) throw new Error('Unknown configuration field.');
  if (config.version !== 1) throw new Error('version must be 1.');
  if (!['on', 'off'].includes(config.default)) throw new Error('default must be "on" or "off".');
  if (!config.events || typeof config.events !== 'object' || Array.isArray(config.events)) throw new Error('events must be an object.');
  for (const [event, rule] of Object.entries(config.events)) {
    if (!/^[a-z][a-z0-9_]*$/.test(event)) throw new Error(`Invalid event name: ${event}`);
    if (typeof rule === 'boolean') continue;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`Invalid rule for ${event}.`);
    for (const [field, values] of Object.entries(rule)) {
      if (!['actions', 'conclusions', 'states'].includes(field)) throw new Error(`Unknown ${event} filter: ${field}`);
      if (!Array.isArray(values) || !values.every(value => typeof value === 'string' && token.test(value))) throw new Error(`${event}.${field} must be an array of names.`);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(config)).length > maxBytes) throw new Error('Configuration exceeds the allowed size / secret limit. Use compressed export or fewer action filters.');
  return config;
}
export function matchesConfig(config, event, payload) {
  const rule = Object.hasOwn(config.events, event) ? config.events[event] : config.default === 'on';
  if (typeof rule === 'boolean') return rule;
  if (rule.actions && !rule.actions.includes(payload.action)) return false;
  const result = payload[event] ?? (event === 'deployment_status' ? payload.deployment_status : null);
  if (rule.conclusions && !rule.conclusions.includes(result?.conclusion)) return false;
  if (rule.states && !rule.states.includes(result?.state ?? payload.state ?? payload.build?.status)) return false;
  return true;
}
export function recommendedConfig() {
  return { version: 1, default: 'off', events: {
    push: true, issues: { actions: ['opened', 'closed', 'reopened'] },
    pull_request: { actions: ['opened', 'closed', 'reopened', 'ready_for_review'] },
    release: { actions: ['published'] }, discussion: { actions: ['created', 'answered'] },
    workflow_run: { actions: ['completed'], conclusions: ['failure', 'timed_out', 'startup_failure', 'action_required'] },
  } };
}

async function readLimited(stream, limit) {
  const reader = stream.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('Expanded configuration exceeds 64 KiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function encodeConfig(config) {
  const json = JSON.stringify(parseConfig(config, MAX_EXPANDED_BYTES));
  const bytes = await readLimited(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip')), MAX_EXPANDED_BYTES);
  const encoded = 'gz:' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (encoded.length > MAX_CONFIG_BYTES) throw new Error('Compressed configuration exceeds the 5 KiB secret limit. Select fewer action filters.');
  return encoded;
}
export async function decodeConfig(input) {
  if (typeof input !== 'string') return parseConfig(input, MAX_EXPANDED_BYTES);
  const value = input.trim();
  if (!value.startsWith('gz:')) return parseConfig(value);
  if (value.length > MAX_CONFIG_BYTES || !/^gz:[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid compressed configuration.');
  const base64 = value.slice(3).replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
  const expanded = await readLimited(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_EXPANDED_BYTES);
  return parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(expanded), MAX_EXPANDED_BYTES);
}
