import { avatarHeader, profileName } from '../src/profile';
export function buildSecrets(state: Record<string, unknown>): Record<string, string> {
  const names = ['WEBIMAP_HOSTNAME', 'EMAIL_USERNAME', 'EMAIL_PASSWORD', 'BOT_PRIVATE_KEY', 'BOT_PUBLIC_KEY', 'API_TOKEN', 'CONTACT', 'GITHUB_WEBHOOK_SECRET', 'CHANNEL_CONFIG', 'BOT_NAME', 'CHANNEL_NAME', 'BOT_LOGO', 'CHANNEL_LOGO'];
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = state[name];
    if (name === 'CONTACT' || name === 'CHANNEL_CONFIG') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing ${name}`);
      if (name === 'CHANNEL_CONFIG' && (!('id' in value) || !('secret' in value) || !('inviteUrl' in value))) throw new Error('Invalid channel configuration');
      result[name] = JSON.stringify(value);
    } else {
      if (typeof value !== 'string' || !value) throw new Error(`Missing ${name}`);
      if (name === 'BOT_LOGO' || name === 'CHANNEL_LOGO') avatarHeader(value);
      if (name === 'BOT_NAME' || name === 'CHANNEL_NAME') profileName(value, value);
      result[name] = value;
    }
  }
  return result;
}
