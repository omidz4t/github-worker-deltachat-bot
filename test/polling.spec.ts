import { it, expect } from 'vitest';
import { subscriberPollMs } from '../src/polling';
it('defaults to ten minutes and validates polling bounds', () => {
  expect(subscriberPollMs()).toBe(600000);
  expect(subscriberPollMs('1')).toBe(60000);
  expect(subscriberPollMs('60')).toBe(3600000);
  for (const invalid of ['0', '-1', '1.5', '1441', 'invalid']) expect(() => subscriberPollMs(invalid)).toThrow();
});
