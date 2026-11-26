# Omegly

Random text and video chat with strangers. No dependencies, only Node.js 18+.

## Run

```
ADMIN_PASSWORD=choose-a-strong-password node server.js
```

- Site: http://localhost:3000
- Admin panel: http://localhost:3000/admin

If you don't set ADMIN_PASSWORD, a random one is printed when the server starts.

## What the admin panel does

- Button to open or lock the Boys/Girls filter for everyone (locked by default)
- Support inbox: read and reply to user messages
- Reports: see the last messages of the reported chat, ban the reported IP
- Live counters (online, waiting, chats now) and the ban list

## Going live

- Camera and microphone only work on HTTPS, so put the site behind HTTPS (Render, Railway, Fly.io, or a VPS with Caddy/Nginx).
- Behind Nginx, disable proxy buffering for /api/events (the app already sends X-Accel-Buffering: no).
- Video uses a free Google STUN server. Some mobile networks and strict firewalls need a TURN server too; add one to the iceServers list in public/index.html.
- Run one instance only: chat state lives in memory.
- Keep the site text and general video only, and moderate reports regularly.
