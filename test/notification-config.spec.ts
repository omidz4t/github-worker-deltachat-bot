import { describe, expect, it, vi } from 'vitest';
import { parseConfig, matchesConfig, recommendedConfig } from '../docs/config/model.js';
import { githubWebhook, type ChatmailEnv } from '../src/index';
import catalog from '../docs/config/events.json';

describe('JSON notification rules', () => {
  it('supports explicit on/off rules and a default for unknown events', () => {
    const config = parseConfig({ version: 1, default: 'off', events: { push: true, issues: false } });
    expect(matchesConfig(config, 'push', {})).toBe(true);
    expect(matchesConfig(config, 'issues', {})).toBe(false);
    expect(matchesConfig(config, 'future_event', {})).toBe(false);
    config.default = 'on';
    expect(matchesConfig(config, 'future_event', {})).toBe(true);
    expect(matchesConfig(config, 'issues', {})).toBe(false);
    expect(matchesConfig(config, 'constructor', {})).toBe(true);
  });
  it('combines actions, conclusions, and states and treats empty lists as no matches', () => {
    const config = parseConfig({ version: 1, default: 'off', events: {
      workflow_run: { actions: ['completed'], conclusions: ['failure', 'timed_out'] },
      status: { states: ['failure', 'error'] }, deployment_status: { states: ['failure'] },
      issue_comment: { actions: [] }, repository_dispatch: { actions: ['custom.event'] },
    } });
    expect(matchesConfig(config, 'workflow_run', { action: 'completed', workflow_run: { conclusion: 'failure' } })).toBe(true);
    expect(matchesConfig(config, 'workflow_run', { action: 'in_progress', workflow_run: { conclusion: 'failure' } })).toBe(false);
    expect(matchesConfig(config, 'workflow_run', { action: 'completed', workflow_run: { conclusion: 'success' } })).toBe(false);
    expect(matchesConfig(config, 'status', { state: 'error' })).toBe(true);
    expect(matchesConfig(config, 'status', { state: 'success' })).toBe(false);
    expect(matchesConfig(config, 'deployment_status', { deployment_status: { state: 'failure' } })).toBe(true);
    expect(matchesConfig(config, 'issue_comment', { action: 'created' })).toBe(false);
    expect(matchesConfig(config, 'repository_dispatch', { action: 'custom.event' })).toBe(true);
  });
  it('rejects bad schemas, typos, and configs that cannot fit in the secret', () => {
    for (const input of ['{', 'null', '[]', '{"version":2,"default":"off","events":{}}', '{"version":1,"default":"no","events":{}}']) expect(() => parseConfig(input)).toThrow();
    expect(() => parseConfig({ version: 1, default: 'off', events: { push: { action: ['created'] } } })).toThrow();
    expect(() => parseConfig({ version: 1, default: 'off', events: { issues: { actions: 'opened' } } })).toThrow();
    expect(() => parseConfig({ version: 1, default: 'off', events: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`event_${i}`, true])) })).toThrow('secret limit');
  });
  it('includes the complete documented catalog and exports recommended and all-event presets under 5 KiB', () => {
    expect(catalog.events).toHaveLength(76);
    expect(catalog.events.map(event => event.name)).toEqual(expect.arrayContaining(['issues', 'issue_relates_to', 'pull_request', 'workflow_job', 'secret_scanning_scan', 'projects_v2', 'custom_property', 'repository_ruleset']));
    expect(catalog.events.find(event => event.name === 'issues')?.actions).toContain('opened');
    expect(() => parseConfig(recommendedConfig())).not.toThrow();
    expect(() => parseConfig({ version: 1, default: 'off', events: Object.fromEntries(catalog.events.map(event => [event.name, true])) })).not.toThrow();
    expect(matchesConfig(recommendedConfig(), 'workflow_job', { action: 'completed', workflow_job: { conclusion: 'failure' } })).toBe(false);
  });
});

describe('Webhook configuration integration', () => {
  it('overrides legacy pipeline settings, blocks disabled events, and fails closed on invalid JSON', async () => {
    const secret = 'test-secret';
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'queued' }, { status: 202 }));
    const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_REPOSITORY: 'themadorg/madmail', PIPELINE_NOTIFICATIONS: 'off', NOTIFICATION_CONFIG: JSON.stringify({ version: 1, default: 'off', events: { workflow_run: true } }), NOTIFICATIONS: { idFromName: () => 'id', get: () => ({ fetch }) } } as unknown as ChatmailEnv;
    async function send(event: string) {
      const raw = JSON.stringify({ repository: { full_name: 'themadorg/madmail' }, action: 'in_progress' });
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = 'sha256=' + Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))), byte => byte.toString(16).padStart(2, '0')).join('');
      return githubWebhook(new Request('https://worker/github/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': signature, 'x-github-event': event, 'x-github-delivery': crypto.randomUUID() } }), env);
    }
    expect((await send('workflow_run')).status).toBe(202);
    expect((await send('push')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    env.NOTIFICATION_CONFIG = '{broken';
    expect((await send('workflow_run')).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
