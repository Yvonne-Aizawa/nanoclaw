# Service Container

A **service container** is a persistent, group-scoped Node.js process that runs alongside NanoClaw. Unlike agent containers (which are ephemeral and spawned per message), a service container stays alive and can maintain a long-running connection — such as a WebSocket — to an external service.

When an event arrives from the external service, the service container writes an IPC file to trigger the group agent. The agent then handles the event (reads context, calls APIs, replies).

## How it works

1. You write a Node.js program to `/workspace/group/service/index.js`
2. NanoClaw starts the container automatically (if `service.enabled: true` in config)
3. The program connects to the external service and listens for events
4. On each event, it writes a JSON file to `/workspace/ipc/input/` to trigger the agent
5. You can edit the code and restart the container via IPC

## Writing the service program

The container runs `node /workspace/group/service/index.js` with:
- `/workspace/group/` — your group folder (read/write, same as in agent containers)
- `/workspace/ipc/input/` — write JSON files here to trigger the agent
- `NANOCLAW_GROUP_FOLDER` env var — your group folder name
- `ANTHROPIC_BASE_URL` env var — credential proxy (optional, for LLM calls)

### Triggering the agent

Write a JSON file to `/workspace/ipc/input/{timestamp}.json`:

```js
import fs from 'fs';

function triggerAgent(chatJid, text) {
  const payload = JSON.stringify({ type: 'message', chatJid, text, sender: 'service' });
  const file = `/workspace/ipc/input/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, file); // atomic write
}
```

The `chatJid` must be the JID of your group (e.g. `tg:-5149439771`).

### Restarting after edits

After editing `service/index.js`, write a restart IPC file:

```js
function restartSelf() {
  const payload = JSON.stringify({ type: 'restart_service' });
  const file = `/workspace/ipc/input/${Date.now()}-restart.json`;
  fs.writeFileSync(`${file}.tmp`, payload);
  fs.renameSync(`${file}.tmp`, file);
}
```

Or trigger from the agent container itself the same way.

## Autonomous loop pattern

For tasks that run on their own schedule (polling an API, executing a strategy, background processing) — no external events needed:

```js
'use strict';
const fs = require('fs');

const LOG_FILE = '/workspace/group/service.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

function writeStatus(state) {
  fs.writeFileSync('/workspace/group/status.json',
    JSON.stringify({ updatedAt: new Date().toISOString(), ...state }, null, 2));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  log('Service started');
  while (true) {
    try {
      // Do work here — API calls, decisions, etc.
      writeStatus({ lastRun: new Date().toISOString() });
    } catch (err) {
      log(`Error: ${err.message}`);
    }
    await sleep(10_000); // wait between iterations
  }
}

main().catch(err => { log(`Fatal: ${err.message}`); process.exit(1); });
```

Reading logs and status from an agent container:

```bash
tail -50 /workspace/group/service.log
cat /workspace/group/status.json
```

## Example: OpenBotCity WebSocket client

```js
// /workspace/group/service/index.js
import fs from 'fs';
import WebSocket from 'ws';

const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER;
const envPath = `/workspace/group/openbotcity.env`;

function readJwt() {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const [k, ...v] = line.split('=');
    if (k.trim() === 'OPENBOTCITY_JWT') return v.join('=').trim();
  }
  throw new Error('OPENBOTCITY_JWT not found in env file');
}

function triggerAgent(text) {
  // Read the group's chat JID from a file the agent writes
  const jidPath = `/workspace/group/chat_jid`;
  if (!fs.existsSync(jidPath)) return;
  const chatJid = fs.readFileSync(jidPath, 'utf-8').trim();
  const payload = JSON.stringify({ type: 'message', chatJid, text, sender: 'service' });
  const file = `/workspace/ipc/input/${Date.now()}.json`;
  fs.writeFileSync(`${file}.tmp`, payload);
  fs.renameSync(`${file}.tmp`, file);
}

function connect() {
  const jwt = readJwt();
  const ws = new WebSocket('wss://api.openbotcity.com/ws', {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  ws.on('open', () => console.log('Connected to OpenBotCity'));

  ws.on('message', (data) => {
    const event = JSON.parse(data.toString());
    triggerAgent(`[OBC Event]\n${JSON.stringify(event, null, 2)}`);
  });

  ws.on('close', () => {
    console.log('Disconnected, reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

connect();
```

## Config

Enable the service container in `config.json`:

```json
"group": {
  "open_bot_city": {
    "service": {
      "enabled": true
    }
  }
}
```

Optional fields:
- `"image"` — Docker image (default: `node:20-alpine`)
- `"memory"` — memory limit (default: `"256m"`)
- `"cpus"` — CPU limit (default: `0.5`)

After adding config, restart NanoClaw: `systemctl --user restart nanoclaw`

## Installing npm packages

The service container runs `node:20-alpine` which has no npm packages pre-installed. To use packages like `ws`:

```js
// At the top of service/index.js, bootstrap deps if missing:
import { execSync } from 'child_process';
import { existsSync } from 'fs';
if (!existsSync('/workspace/group/service/node_modules/ws')) {
  execSync('npm install ws', { cwd: '/workspace/group/service', stdio: 'inherit' });
}
```

Or write a `package.json` to `/workspace/group/service/package.json` and run `npm install` from an agent container before enabling the service.
