# Installing a relay with Docker

This guide takes a fresh Linux server (Debian/Ubuntu shown) to a running Qu Lite relay behind HTTPS, with Docker
Compose. For a **Docker Swarm** with caddy-docker-proxy, see [Docker Swarm](#docker-swarm-with-caddy-docker-proxy). The relay
serves its API (`/ws`, `/sse`), the client start page (`/`), the demo (`/demo.html`) and the browser bundle
(`/dist/qu-lite.js`) on **one port**. A reverse proxy in front does TLS. Background and proxy details are in
[DEPLOY.md](DEPLOY.md).

Time: about 15 minutes. You need a server with a public IP, a domain or subdomain whose DNS points to it (here
`relay.example.org`), and SSH access with `sudo`.

## 1. Install Docker

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # then log out and in again, so `docker` works without sudo
docker compose version               # must print v2 or later
```

## 2. Get Qu Lite

```sh
sudo mkdir -p /opt/qu-lite && sudo chown "$USER" /opt/qu-lite
git clone https://github.com/ReactivityJS/Qu-lite.git /opt/qu-lite
cd /opt/qu-lite
```

## 3. Configure

```sh
cp .env.example .env
nano .env
```

Defaults that fit a public relay are already filled in:

| Setting | Default in `.env.example` | Meaning |
|---|---|---|
| `QU_BIND` | `127.0.0.1` | only the reverse proxy on this machine can reach the relay; use `0.0.0.0` only for a quick test without a proxy |
| `QU_PUBLISH_PORT` | `8787` | host port |
| `QU_MAX_SPACES` | `10000` | most spaces strangers can create |
| `QU_QUOTA_RECORDS` / `QU_QUOTA_BYTES` | `200000` / 1 GiB | limits per space (group, inbox) |
| `QU_MAX_ENVELOPE` | `262144` | largest single record |
| `QU_RATE` | `200` | frames/s per connection |
| `QU_STATS_TOKEN` | empty (off) | enables `/stats` and `/metrics`; create one with `openssl rand -hex 24` |

`.env` stays on the server: it is in `.gitignore` and is not copied into the image.

## 4. Start

```sh
docker compose up -d --build
docker compose ps                     # STATUS: "healthy" after a few seconds
curl -fsS http://127.0.0.1:8787/healthz   # prints: ok
docker compose logs -f                # "qu-lite mirror … on http+ws://0.0.0.0:8787 …" (Ctrl+C to leave)
```

The data (envelopes, the relay's identity) lives in the Docker volume `qu-lite-data`, so it survives restarts and
rebuilds. `restart: unless-stopped` brings the relay back after a reboot.

## 5. HTTPS with Caddy (simplest)

Caddy gets and renews the certificate by itself.

```sh
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
relay.example.org {
	encode gzip
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
EOF
sudo systemctl reload caddy
```

Open ports 80 and 443 in the firewall (`sudo ufw allow 80,443/tcp`), but not 8787. Using nginx instead, or a path
prefix like `https://example.org/qu/`: see [DEPLOY.md](DEPLOY.md).

## 6. Check

1. `curl -fsS https://relay.example.org/healthz` prints `ok`.
2. Open `https://relay.example.org/` in a browser: the status should read **verbunden über ws**. Press
   **Speichertest**: it should say "gespeichert und bestätigt in … ms".
   - **über sse** instead of ws: WebSocket upgrades don't get through the proxy. Check the proxy config. The app
     still works over the slower SSE fallback.
3. Open `https://relay.example.org/demo.html?name=alice` and, in a second browser or a private window,
   `…/demo.html?name=bob`. Create a group, share the invite link and chat. [TESTING.md](TESTING.md#manual-browser-test)
   has a complete checklist.
4. With a stats token: `curl -fsS -H "Authorization: Bearer $TOKEN" https://relay.example.org/stats`.

Apps connect with `transports: [['relay', { url: 'https://relay.example.org' }]]`. The start page shows the
complete snippet.

## Operations

**Update**

```sh
cd /opt/qu-lite
git pull
docker compose up -d --build          # rebuilds and restarts; data stays in the volume
docker image prune -f                 # optional: remove old images
```

Clients reconnect by themselves within seconds, and their unsent writes wait in their outbox meanwhile.

**Backup** (online, while the relay runs)

```sh
mkdir -p backups
docker compose exec qu-lite node --no-warnings bin/backup.mjs /data/mirror.sqlite /data/backup.sqlite
docker compose cp qu-lite:/data/backup.sqlite "backups/qu-lite-$(date +%F).sqlite"
docker compose exec qu-lite rm /data/backup.sqlite
```

Daily at 03:15 via `crontab -e`, as one line (`-T`: cron has no terminal; `%` must be escaped in crontab):

```cron
15 3 * * * cd /opt/qu-lite && docker compose exec -T qu-lite node --no-warnings bin/backup.mjs /data/mirror.sqlite /data/backup.sqlite && docker compose cp qu-lite:/data/backup.sqlite "backups/qu-lite-$(date +\%F).sqlite" && docker compose exec -T qu-lite rm /data/backup.sqlite
```

The backup contains only sealed envelopes and the relay's own identity, no
readable content. Still, keep it as private as the server.

**Restore**

```sh
docker compose stop
docker compose run --rm --no-deps -v "$PWD/backups":/b:ro qu-lite \
  sh -c 'cp /b/qu-lite-2026-10-28.sqlite /data/mirror.sqlite && rm -f /data/mirror.sqlite-wal /data/mirror.sqlite-shm'
docker compose start
```

`docker compose run` uses the relay's own image and user, so the restored file belongs to the relay. After a restore the relay has its old
identity again, and clients push whatever it lacks the next time they reconcile.

**Logs, status, resources**

```sh
docker compose logs --since 1h        # connections, grants, quota and rate-limit events
docker compose ps                     # health
docker stats qu-lite-qu-lite-1        # CPU / memory
```

**Stop or remove**

```sh
docker compose down                   # stop, keep the data
docker compose down -v                # stop AND delete all data (the volume)
```

## Docker Swarm (with caddy-docker-proxy)

If your swarm already runs [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy), the relay is
one more service. `docker-stack.yml` carries the Caddy labels, publishes **no port** (Caddy reaches it over the
shared overlay network) and pins it to one node.

**One replica, always.** The relay keeps its data in a local SQLite file and its connections in the process. Two
replicas would be two separate relays whose clients don't see each other's live messages. Updates therefore
stop the old task before starting the new one (`order: stop-first`). That means a few seconds without the relay;
clients reconnect by themselves, and their unsent writes wait in their outbox.

**Image**: the CI publishes `ghcr.io/reactivityjs/qu-lite` for amd64 and arm64 once the tests passed:
- `:main` after every push to `main`;
- `:1.2.3`, `:1.2` and `:latest` for a release tag.

Pin a version in production (`QU_IMAGE=ghcr.io/reactivityjs/qu-lite:0.2.0`). A new GitHub package starts out
private: either make it public (package settings → visibility), or log the nodes in
(`docker login ghcr.io` with a token that has `read:packages`) and deploy with `--with-registry-auth`.

**Deploy**

```sh
# once: pin the relay to the node that keeps its data (the volume is local to that node)
docker node update --label-add qu-lite=true <node>

# optional: stats token as a secret, then uncomment QU_STATS_TOKEN_FILE and the secrets blocks in docker-stack.yml
printf %s "$(openssl rand -hex 24)" | docker secret create qu_stats_token -

# settings (QU_DOMAIN, limits, QU_IMAGE) from .env - docker stack deploy does not read it by itself
cp .env.example .env && echo "QU_DOMAIN=relay.example.org" >> .env && nano .env
set -a; . ./.env; set +a
docker stack deploy -c docker-stack.yml qu-lite            # add --with-registry-auth for a private image
```

The stack expects the overlay network that caddy-docker-proxy watches to be called `caddy` and to exist already
(`external: true`). If yours has a different name, change it in `docker-stack.yml`. Under a path prefix
(`https://example.org/qu/`), use the `handle_path` labels commented in the file instead of `caddy:` with its own
domain. `QU_BIND`/`QU_PUBLISH_PORT` don't apply here, since nothing is published.

**Check**: `docker service ps qu-lite_relay` shows one task `Running` (healthy after a few seconds). Then continue
with [6. Check](#6-check) using your domain.

**Update**

```sh
docker service update --image ghcr.io/reactivityjs/qu-lite:0.2.1 qu-lite_relay   # or: set QU_IMAGE, deploy again
docker service update --force qu-lite_relay                                       # same tag, newly pulled (:main)
docker service rollback qu-lite_relay                                             # back to the previous version
```

**Backup / restore**: the volume `qu-lite_data` lives on the labelled node. Run the same commands as above
there, with the container instead of `docker compose exec`:

```sh
C=$(docker ps -q -f name=qu-lite_relay)
docker exec "$C" node --no-warnings bin/backup.mjs /data/mirror.sqlite /data/backup.sqlite
docker cp "$C":/data/backup.sqlite "backups/qu-lite-$(date +%F).sqlite" && docker exec "$C" rm /data/backup.sqlite
```

To restore, on the same node (the image runs as the relay's own user, so the file gets the right owner):

```sh
docker service scale qu-lite_relay=0
docker run --rm -v qu-lite_data:/data -v "$PWD/backups":/b:ro ghcr.io/reactivityjs/qu-lite:main \
  sh -c 'cp /b/qu-lite-2026-10-28.sqlite /data/mirror.sqlite && rm -f /data/mirror.sqlite-wal /data/mirror.sqlite-shm'
docker service scale qu-lite_relay=1
```

**Logs**: `docker service logs -f qu-lite_relay`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `docker compose ps` stays `unhealthy` | `docker compose logs`; usually the port is taken - change `QU_PUBLISH_PORT` |
| `curl http://127.0.0.1:8787/healthz` works, the domain does not | proxy or DNS: `sudo systemctl status caddy`, `journalctl -u caddy`, DNS A/AAAA record |
| start page says **über sse** | WebSocket upgrade blocked at the proxy (nginx: the `Upgrade`/`Connection` headers) |
| connections drop every few seconds or minutes | proxy read timeout shorter than ~30 s - see DEPLOY.md (the relay pings every 25 s) |
| clients see `qu.record.refused` with `quota` | a space hit `QU_QUOTA_RECORDS`/`QU_QUOTA_BYTES` - raise them in `.env`, then `docker compose up -d` |
| logs show `refused new space` | `QU_MAX_SPACES` reached |
| `/stats` returns 404 | `QU_STATS_TOKEN` is empty |
| Swarm: task stays `Pending` | no node has the label `qu-lite=true`, or the image can't be pulled (private package: `--with-registry-auth`) |
| Swarm: domain answers 502 | relay and Caddy are not on the same overlay network (`caddy`), or the task is not healthy yet |
