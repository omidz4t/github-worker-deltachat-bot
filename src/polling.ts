export function subscriberPollMs(value?: string): number {
  if (value === undefined || value === '') return 10 * 60 * 1000;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('SUBSCRIBER_POLL_MINUTES must be an integer from 1 to 1440');
  return minutes * 60 * 1000;
}
