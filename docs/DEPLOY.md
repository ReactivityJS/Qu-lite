# Deploying a relay

One process, one port (default 8787) serves everything:

| Path | What |
|---|---|
| `/` | client start page (`web/index.html`): connection check from the browser, store test, how an app connects |
| `/demo.html` | the demo app |
| `/dist/qu-lite.js` | the library as one browser ES module, for apps: `import { createPeer } from 'https://relay.example/dist/qu-lite.js'` |
| `/ws` | WebSocket (any path upgrades) - the API |
| `/sse/<session>` | HTTPS + SSE fallback for networks that block WebSocket - the same API |
| `/healthz` | `200 ok` for the proxy or the container (GET and HEAD) |
| `/info` | `{name, version, transports, uptime}` - nothing about spaces |
| `/stats`, `/metrics` | operating figures as JSON / Prometheus text - only with `--stats-token` (`QU_STATS_TOKEN`), for requests carrying the token |

The web files are served only with `--static ./web` (`QU_STATIC`). The Docker image always sets it. The relay
speaks plain HTTP. **TLS is the reverse proxy's job**: clients then use `https://` and `wss://` on the same origin.

## Run

```sh
docker compose up -d --build                 # image: web files built in, data in the volume qu-lite-data
# or without Docker
npm ci && node web/build.mjs
node --no-warnings bin/mirror.mjs --port 8787 --host 127.0.0.1 --db ./mirror.sqlite --static ./web
```

Behind a proxy, publish the port on localhost only (`ports: ["127.0.0.1:8787:8787"]` in `docker-compose.yml`),
so nobody reaches it around the proxy. Options and environment variables: [API.md](API.md#mirror-cli-and-docker).

## What the proxy must do

- **Upgrade WebSockets** on `/ws` (`Upgrade`/`Connection` headers).
- **Stream SSE without buffering** on `/sse/`. The relay sends `X-Accel-Buffering: no`, which nginx honours.
  Uploads are POSTs of up to 1 MiB.
- **Allow long-lived connections**. The relay pings WebSocket clients every 25 s and SSE streams carry a keep-alive
  every 15 s, so any read timeout above ~30 s is enough. nginx's default of 60 s works; 1 hour is more relaxed.
- **Path prefix (optional)**: the relay can live under a prefix the proxy strips, for example
  `https://example.org/qu/` → `http://127.0.0.1:8787/`. The start page, the demo and `relayTransport({ url:
  'https://example.org/qu' })` keep the prefix (`/qu/ws`, `/qu/sse`). Use a trailing slash in the public URL.

The relay does not use client IP addresses (rate limits are per connection), so `X-Forwarded-For` is optional.

## Caddy

```caddyfile
relay.example.org {
	encode gzip
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1          # stream SSE immediately
	}
}

# under a path prefix
example.org {
	handle_path /qu/* {
		reverse_proxy 127.0.0.1:8787 {
			flush_interval -1
		}
	}
	redir /qu /qu/
}
```

Caddy handles certificates and WebSocket upgrades by itself.

## nginx

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name relay.example.org;
    ssl_certificate     /etc/letsencrypt/live/relay.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.org/privkey.pem;

    client_max_body_size 2m;                 # SSE uploads (max 1 MiB per POST)

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;               # long-lived WebSocket / SSE
        proxy_send_timeout 1h;
        proxy_buffering off;                 # SSE (the relay also sends X-Accel-Buffering: no)
    }
}

# under a path prefix: the trailing slashes make nginx strip /qu/
#   location /qu/ { proxy_pass http://127.0.0.1:8787/; ...same settings as above... }
```

## Hardening a public relay

Anyone can reach a public relay and create spaces on it: a space's grant is self-certifying, and no account is
needed. The relay can't read anything, but it can be filled up or flooded. Set these limits:

| Setting | Recommendation | Why |
|---|---|---|
| `QU_MAX_SPACES` / `--max-spaces` | e.g. `10000` | caps how many spaces strangers can create; known spaces keep working |
| `QU_QUOTA_BYTES` / `QU_QUOTA_RECORDS` | e.g. `1073741824` / `200000` | caps each space, including every inbox |
| `QU_MAX_ENVELOPE` | `262144` (default) | largest single record |
| `QU_RATE` | `200` (default) | frames/s per connection |
| connections per IP | at the proxy (below) | rate limits are per connection; the relay doesn't see client IPs |

The relay also closes WebSocket messages above 8 MiB (`maxFrameBytes`) and SSE uploads above 1 MiB.

Connection limits per client IP belong in the proxy, for example in nginx:

```nginx
limit_conn_zone $binary_remote_addr zone=qu_conn:10m;
# inside the server/location block:
limit_conn qu_conn 20;
```

## Operating figures

Start the relay with a token (`QU_STATS_TOKEN` in `docker-compose.yml`, or `--stats-token`). `/stats` and
`/metrics` then answer requests that send `Authorization: Bearer <token>` (or `?token=<token>`; avoid it,
because query strings end up in proxy access logs). Without a
token they don't exist (404). Behind the proxy every request arrives from localhost, so the token is the only
protection. Use a long random one: `openssl rand -hex 24`.

```sh
curl -fsS -H "Authorization: Bearer $QU_STATS_TOKEN" https://relay.example.org/stats | jq
```

The report covers:
- traffic in/out (total, per open connection, throughput over 10 s) and connections (open, total, peak);
- envelopes processed by outcome, reconciles, rate-limit drops and quota refusals;
- storage: spaces, envelopes, bytes and the SQLite file size.

Peers appear by random network id only. There are no identities and no space ids.

Prometheus:

```yaml
scrape_configs:
  - job_name: qu-lite
    scheme: https
    metrics_path: /metrics
    authorization: { credentials: <QU_STATS_TOKEN> }
    static_configs: [{ targets: ['relay.example.org'] }]
```

You can also keep `/stats` and `/metrics` off the public address entirely, for example in nginx:
`location ~ ^/(stats|metrics)$ { allow 10.0.0.0/8; deny all; proxy_pass http://127.0.0.1:8787; }`.

## Check

- `curl -fsS https://relay.example.org/healthz` prints `ok`.
- Open `https://relay.example.org/`: the status should read **verbunden über ws**. Then press **Speichertest**.
  It writes one record into a new, empty space and waits for the relay to confirm it.
- If the status reads **über sse**, WebSocket upgrades don't get through the proxy. The app still works (SSE
  fallback), but check the `Upgrade`/`Connection` settings.
- The data lives in the SQLite database (`QU_DB`, in Docker the volume `/data`), including the relay's identity, so
  clients resume their syncs after a restart. Back it up like any SQLite file (`sqlite3 mirror.sqlite ".backup …"`).
