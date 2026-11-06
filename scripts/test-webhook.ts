const state = await Bun.file('.env.chatmail-setup.json').json();
const url = 'https://github-worker-deltachat-bot.omid-zamani-4t.workers.dev/github/webhook';
const raw = JSON.stringify({ action: 'webhook_test', repository: { full_name: 'themadorg/madmail', html_url: 'https://github.com/themadorg/madmail' }, sender: { login: 'Worker integration test (no repository change)' } });
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(state.GITHUB_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const signature = 'sha256=' + Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))), b => b.toString(16).padStart(2, '0')).join('');
const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature, 'X-GitHub-Delivery': crypto.randomUUID(), 'X-GitHub-Event': 'ping' };
const ping = await fetch(url, { method: 'POST', headers, body: raw });
console.log('Signed ping:', ping.status, await ping.json());
if (!ping.ok) throw new Error('Signed ping failed');
const tampered = await fetch(url, { method: 'POST', headers, body: raw + ' ' });
console.log('Tampered payload:', tampered.status);
if (tampered.status !== 401) throw new Error('Tampered payload was not rejected');
headers['X-GitHub-Event'] = 'repository';
for (let n = 0; n < 2; n++) {
  const result = await fetch(url, { method: 'POST', headers, body: raw });
  console.log(n === 0 ? 'Test notification:' : 'Duplicate:', result.status, await result.json());
  if (result.status !== 202) throw new Error('Notification enqueue failed');
}
