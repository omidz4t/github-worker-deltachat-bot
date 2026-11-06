// Shared by the browser configurator and Worker; no credentials are stored here.
export const MAX_CONFIG_BYTES = 5120;
const token = /^[a-zA-Z0-9_.-]+$/;
export function parseConfig(input) {
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
  if (new TextEncoder().encode(JSON.stringify(config)).length > MAX_CONFIG_BYTES) throw new Error('Configuration exceeds the 5 KiB Cloudflare secret limit. Use all-actions filters or select fewer action types.');
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
