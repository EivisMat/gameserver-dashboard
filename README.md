# gameserver-dashboard

A web dashboard for managing game servers running on [Pterodactyl Panel](https://pterodactyl.io/).

I host a Minecraft server for friends and wanted to let them manage it themselves without giving everyone access to the actual panel. This dashboard gives each user their own login and only the permissions they need (start/stop, console, files, backups, etc.), plus some extras the panel doesn't have: a modpack installer, live resource graphs, a player counter and WireGuard VPN peer management.

I run it in production on my own VPS. It's built for private use behind a VPN, not for exposing to the open internet.

## Tech stack

- Node.js + Express backend, `ws` for WebSockets
- SQLite (better-sqlite3) for users, permissions and activity logs
- JWT cookie sessions, bcrypt password hashing
- Plain HTML/CSS/JS frontend, no framework and no build step

## How it works

The dashboard sits between the browser and Pterodactyl. All server operations (create, power, files, backups, schedules) go through Pterodactyl's REST APIs using API keys that stay on the backend, so users never touch the panel directly. Users, permissions and the per-server activity log live in a local SQLite database.

A few parts worth mentioning:

- **Console**: the backend opens a WebSocket to the Wings daemon and relays it to the browser. Everyone watching the same server shares one console view and can see each other's commands.
- **Permissions**: each user has `(permission, scope)` rows, where scope is either `*` or a specific server. Users also automatically own the servers they created themselves.
- **Modpack installer**: downloads a pack from Modrinth or CurseForge, resolves the mod files, uploads everything to the server in chunks and accepts the EULA so the server can boot.
- **Player count**: a small Minecraft Server List Ping client written with raw TCP sockets.
- **WireGuard**: peers are created/revoked through a small root-owned shell script called via sudo.

## Setup

You need Node.js 18+, a working Pterodactyl Panel with at least one Wings node, and two panel API keys (an Application key and a Client key).

```bash
git clone https://github.com/EivisMat/gameserver-dashboard.git
cd gameserver-dashboard
npm install
cp .env.example .env      # fill in panel URL, API keys and node IP
node setup.js admin <password>
node server.js
```

The app listens on `127.0.0.1:3001`, so put a reverse proxy with TLS in front of it and make sure it forwards WebSocket upgrades. Every setting is documented in `.env.example`.

For the WireGuard tab (optional), copy `wireguard/wg-helper.sh` to a root-owned path and allow the app's user to run it with sudo:

```
dashboard-user ALL=(root) NOPASSWD: /opt/dashboard/wg-helper.sh
```

Run the tests with `npm test`.

## License

[MIT](./LICENSE)
