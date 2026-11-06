import { it, expect } from 'vitest';
import { avatarHeader, profileName } from '../src/profile';
it('rejects unsafe names, oversized logos, and non-image data', () => {
  expect(profileName('  A bot  ', 'Default')).toBe('A bot');
  expect(() => profileName('Bot\r\nInjected: yes', 'Default')).toThrow();
  expect(() => profileName('x'.repeat(101), 'Default')).toThrow();
  expect(avatarHeader('iVBORw0KGgo=')).toBe('base64:iVBORw0KGgo=');
  expect(() => avatarHeader(btoa('not an image'))).toThrow();
  expect(() => avatarHeader('A'.repeat(28001))).toThrow();
});
