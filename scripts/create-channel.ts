import { configureProfile } from './profile';
import * as openpgp from 'openpgp';
import { chmodSync } from 'node:fs';
const path = '.env.chatmail-setup.json';
const state = await Bun.file(path).json();
await configureProfile(state);
function random(bytes: number) { return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url'); }
if (!state.GITHUB_WEBHOOK_SECRET) state.GITHUB_WEBHOOK_SECRET = random(32);
if (!state.CHANNEL_CONFIG) {
  const key = await openpgp.readKey({ armoredKey: state.BOT_PUBLIC_KEY });
  const channel = { id: random(18), name: state.CHANNEL_NAME, secret: random(33).slice(0, 43), auth: random(18), inviteNumber: random(18), fingerprint: key.getFingerprint().toUpperCase(), sinceUid: state.sinceUid ?? 0 };
  state.CHANNEL_CONFIG = channel;
}
if (state.CHANNEL_CONFIG.name !== state.CHANNEL_NAME || !state.CHANNEL_CONFIG.nameUpdatedAt) state.CHANNEL_CONFIG.nameUpdatedAt = Math.floor(Date.now() / 1000);
state.CHANNEL_CONFIG.name = state.CHANNEL_NAME;
const params = new URLSearchParams({ v: '3', x: state.CHANNEL_CONFIG.id, j: state.CHANNEL_CONFIG.inviteNumber, s: state.CHANNEL_CONFIG.auth, a: state.EMAIL_USERNAME, n: state.BOT_NAME, b: state.CHANNEL_NAME });
state.CHANNEL_CONFIG.inviteUrl = `https://i.delta.chat/#${state.CHANNEL_CONFIG.fingerprint}&${params}`;
await Bun.write(path, JSON.stringify(state, null, 2)); chmodSync(path, 0o600);
await Bun.write('.env.github-webhook-secret', state.GITHUB_WEBHOOK_SECRET + '\n'); chmodSync('.env.github-webhook-secret', 0o600);
console.log('Channel configuration and GitHub webhook secret created.');
