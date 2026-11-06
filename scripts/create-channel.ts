import * as openpgp from 'openpgp';
import { chmodSync } from 'node:fs';
const path = '.env.chatmail-setup.json';
const state = await Bun.file(path).json();
function random(bytes: number) { return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url'); }
if (!state.GITHUB_WEBHOOK_SECRET) state.GITHUB_WEBHOOK_SECRET = random(32);
if (!state.CHANNEL_CONFIG) {
  const key = await openpgp.readKey({ armoredKey: state.BOT_PUBLIC_KEY });
  const channel = { id: random(18), name: 'Madmail GitHub', secret: random(33).slice(0, 43), auth: random(18), inviteNumber: random(18), fingerprint: key.getFingerprint().toUpperCase(), sinceUid: state.sinceUid ?? 0 };
  const params = new URLSearchParams({ v: '3', x: channel.id, j: channel.inviteNumber, s: channel.auth, a: state.EMAIL_USERNAME, n: 'Madmail Bot', b: channel.name });
  state.CHANNEL_CONFIG = { ...channel, inviteUrl: `https://i.delta.chat/#${channel.fingerprint}&${params}` };
}
await Bun.write(path, JSON.stringify(state, null, 2)); chmodSync(path, 0o600);
await Bun.write('.env.github-webhook-secret', state.GITHUB_WEBHOOK_SECRET + '\n'); chmodSync('.env.github-webhook-secret', 0o600);
console.log('Channel configuration and GitHub webhook secret created.');
