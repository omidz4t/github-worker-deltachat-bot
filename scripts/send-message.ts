// The ignored setup state contains the API token. Never print it.
const state = await Bun.file('.env.chatmail-setup.json').json();
const response = await fetch('https://github-worker-deltachat-bot.omid-zamani-4t.workers.dev/send', {
  method: 'POST',
  headers: { Authorization: `Bearer ${state.API_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: process.argv[2] || 'Hello from the Cloudflare Worker!' }),
});
console.log(`HTTP ${response.status}`, await response.json());
if (!response.ok) process.exitCode = 1;
