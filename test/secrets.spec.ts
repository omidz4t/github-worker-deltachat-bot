import { it, expect } from 'vitest';
import { buildSecrets } from '../scripts/secrets';
it('uploads the channel and contact as distinct secrets and rejects missing configuration', () => {
  const state = { WEBIMAP_HOSTNAME: 'https://mail.example', EMAIL_USERNAME: 'bot@example', EMAIL_PASSWORD: 'password', BOT_PRIVATE_KEY: 'private', BOT_PUBLIC_KEY: 'public', API_TOKEN: 'api', GITHUB_WEBHOOK_SECRET: 'github', CONTACT: { name: 'Contact' }, CHANNEL_CONFIG: { id: 'channel-id', secret: 'broadcast-secret', inviteUrl: 'https://example.org/invite' } };
  const secrets = buildSecrets(state);
  expect(JSON.parse(secrets.CONTACT)).toEqual(state.CONTACT);
  expect(JSON.parse(secrets.CHANNEL_CONFIG)).toEqual(state.CHANNEL_CONFIG);
  expect(() => buildSecrets({ ...state, CHANNEL_CONFIG: state.CONTACT })).toThrow('Invalid channel configuration');
});
