import { describe, it, expect, vi } from 'vitest';
import { validSignature, githubMessage, shouldNotify } from '../src/github';
import { githubWebhook, type ChatmailEnv } from '../src/index';
const secret = 'test-webhook-secret';
async function sign(raw: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return 'sha256=' + Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))), b => b.toString(16).padStart(2, '0')).join('');
}
describe('GitHub signature validation and routing', () => {
  it('verifies exact bytes and rejects tampering and malformed signatures', async () => {
    const raw = '{"message":"hello 👋"}'; const signature = await sign(raw);
    expect(await validSignature(new TextEncoder().encode(raw), signature, secret)).toBe(true);
    expect(await validSignature(new TextEncoder().encode(raw + ' '), signature, secret)).toBe(false);
    expect(await validSignature(new TextEncoder().encode(raw), 'sha256=xyz', secret)).toBe(false);
    expect(await validSignature(new TextEncoder().encode(raw), signature, 'wrong')).toBe(false);
  });
  it('returns ping immediately and queues allowed events with delivery ID', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'queued' }, { status: 202 }));
    const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_REPOSITORY: 'themadorg/madmail', NOTIFICATIONS: { idFromName: () => 'id', get: () => ({ fetch }) } } as unknown as ChatmailEnv;
    const raw = JSON.stringify({ repository: { full_name: 'themadorg/madmail' }, sender: { login: 'contributor' }, commits: [{ id: 'abcdef1234', message: 'Fix WebIMAP' }], ref: 'refs/heads/main', compare: 'https://github.com/themadorg/madmail/compare/abc...def' });
    const headers = { 'x-hub-signature-256': await sign(raw), 'x-github-event': 'ping', 'x-github-delivery': crypto.randomUUID() };
    expect((await githubWebhook(new Request('https://worker/github/webhook', { method: 'POST', body: raw, headers }), env)).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    headers['x-github-event'] = 'push';
    expect((await githubWebhook(new Request('https://worker/github/webhook', { method: 'POST', body: raw, headers }), env)).status).toBe(202);
    expect(JSON.parse(fetch.mock.calls[0][1].body).text).toContain('Fix WebIMAP');
    const other = JSON.stringify({ repository: { full_name: 'attacker/repo' } });
    expect((await githubWebhook(new Request('https://worker/github/webhook', { method: 'POST', body: other, headers: { ...headers, 'x-hub-signature-256': await sign(other) } }), env)).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized and unsigned payloads before enqueueing', async () => {
    const env = { GITHUB_WEBHOOK_SECRET: secret } as ChatmailEnv;
    expect((await githubWebhook(new Request('https://worker/github/webhook', { method: 'POST', body: '{}' }), env)).status).toBe(401);
    expect((await githubWebhook(new Request('https://worker/github/webhook', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }), env)).status).toBe(413);
  });
  it('formats a release notification', () => {
    expect(githubMessage('release', { action: 'published', repository: { full_name: 'themadorg/madmail' }, release: { tag_name: 'v1.0', html_url: 'https://github.com/themadorg/madmail/releases/tag/v1.0' } })).toContain('release v1.0');
  });
});

describe('pipeline notification filter', () => {
  it.each(['workflow_run', 'workflow_job', 'check_run', 'check_suite'])('filters %s to completed failures by default', event => {
    for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required']) expect(shouldNotify(event, { action: 'completed', [event]: { conclusion } })).toBe(true);
    for (const conclusion of ['success', 'neutral', 'cancelled', 'skipped', null]) expect(shouldNotify(event, { action: 'completed', [event]: { conclusion } })).toBe(false);
    expect(shouldNotify(event, { action: 'in_progress', [event]: { conclusion: 'failure' } })).toBe(false);
    expect(shouldNotify(event, { action: 'requested' }, 'all')).toBe(true);
    expect(shouldNotify(event, { action: 'completed', [event]: { conclusion: 'failure' } }, 'off')).toBe(false);
  });
  it('filters commit statuses and leaves other events alone', () => {
    expect(shouldNotify('status', { state: 'failure' })).toBe(true);
    expect(shouldNotify('status', { state: 'error' })).toBe(true);
    expect(shouldNotify('status', { state: 'success' })).toBe(false);
    expect(shouldNotify('status', { state: 'pending' })).toBe(false);
    expect(shouldNotify('push', {}, 'off')).toBe(true);
  });
  it('acknowledges signed nonfailure events without adding them to the queue', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'queued' }, { status: 202 }));
    const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_REPOSITORY: 'themadorg/madmail', PIPELINE_NOTIFICATIONS: 'failures', NOTIFICATIONS: { idFromName: () => 'id', get: () => ({ fetch }) } } as unknown as ChatmailEnv;
    async function send(conclusion: string) {
      const raw = JSON.stringify({ repository: { full_name: 'themadorg/madmail' }, action: 'completed', workflow_job: { name: 'Tests', conclusion, html_url: 'https://github.com/themadorg/madmail/actions/runs/1' } });
      return githubWebhook(new Request('https://worker/github/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': await sign(raw), 'x-github-event': 'workflow_job', 'x-github-delivery': crypto.randomUUID() } }), env);
    }
    expect((await send('success')).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect((await send('failure')).status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).text).toContain('Tests: failure');
  });
});
