const state = await Bun.file('.env.chatmail-setup.json').json();
const action = process.argv[2] ?? 'info';
if (!['info', 'bootstrap', 'poll'].includes(action)) throw new Error('Use info, bootstrap, or poll');
const response = await fetch(`https://github-worker-deltachat-bot.omid-zamani-4t.workers.dev/channel${action === 'poll' ? '/poll' : ''}`, {
  method: action === 'info' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${state.API_TOKEN}` },
});
console.log(`HTTP ${response.status}`, await response.json());
if (!response.ok) process.exitCode = 1;
