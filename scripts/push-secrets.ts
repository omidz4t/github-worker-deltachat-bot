import { buildSecrets } from './secrets';
import { chmodSync } from 'node:fs';
const state = await Bun.file('.env.chatmail-setup.json').json();
const secrets = buildSecrets(state);
const path = '.env.cloudflare-secrets.json';
try {
  await Bun.write(path, JSON.stringify(secrets)); chmodSync(path, 0o600);
  const result = Bun.spawn(['bunx', 'wrangler', 'secret', 'bulk', path], { stdout: 'inherit', stderr: 'inherit' });
  if (await result.exited) throw new Error('Secret upload failed');
} finally { await Bun.file(path).delete(); }
