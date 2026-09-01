# cscodetunnel

Ngrok-style tunnel CLI + local dashboard, built on [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/) (`cloudflared`). Expose local services to the internet in one command:

```
$ cscodetunnel http 3000
✔ Dashboard: http://127.0.0.1:4040
✔ Inspection proxy listening on 127.0.0.1:41234 → http://127.0.0.1:3000
────────────────────────────────────────────────────────────
  https tunnel ready: https://random-words-here.trycloudflare.com
────────────────────────────────────────────────────────────
```

Open `http://127.0.0.1:4040` to inspect every request (headers, bodies, status, duration), manage tunnels, and watch the cloudflared log — like ngrok's `localhost:4040`.

## Install

Requires **Node.js ≥ 20**. `cloudflared` is downloaded automatically on first run (from GitHub releases into `~/.cscodetunnel/bin`), or set `CSCDFLARED_BIN` to use your own.

```sh
git clone <this repo> && cd cscodetunnel
npm install
npm run build
npm link          # puts `cscodetunnel` on your PATH
```

Dev mode without building: `npm run dev -- http 3000` (tsx).

## Usage

### HTTP quick tunnel (no Cloudflare account)

```sh
cscodetunnel http 3000                 # expose localhost:3000
cscodetunnel http 3000 --auth u:pass   # basic auth in front of the tunnel
cscodetunnel http 3000 --host-header localhost:3000   # for Vite/Next.js dev servers that reject foreign Host headers
cscodetunnel http 3000 --region us     # pass --region through to cloudflared
cscodetunnel http 3000 --target http://localhost:3000   # override target if your app only listens on IPv6 (::1)
```

URL is random (`*.trycloudflare.com`) and changes on every restart/reconnect. WebSockets pass through; request inspection works over the proxy.

### TCP quick tunnel

```sh
cscodetunnel tcp 5432
```

The printed `tcp://` address is for cloudflared itself — remote clients connect with:

```sh
cloudflared access tcp --hostname <hostname> --url 127.0.0.1:5432
```

### Named tunnels (Cloudflare account + custom domain)

```sh
cscodetunnel named login                        # one-time browser authorization
cscodetunnel named create myapp                 # create the tunnel (prints UUID)
cscodetunnel named route myapp myapp.example.com  # DNS CNAME route
cscodetunnel named run myapp 3000               # run it with the inspection proxy
cscodetunnel named list
```

`named run <name> <port>` generates a managed config at `~/.cscodetunnel/named/<name>.yml` — **your own `~/.cloudflared/config.yml` is never touched or loaded** (this also prevents its ingress rules from hijacking quick tunnels). Pass `--raw` to run your own cloudflared config as-is, without the inspection proxy.

### Default tunnel

A default tunnel is baked in (`cscode-tunnel`), so after install you can just run:

```sh
cscodetunnel start                 # run the default named tunnel (random *.cscode.xyz subdomain)
cscodetunnel start 3001            # override the port
cscodetunnel default --clear       # remove the baked-in default
cscodetunnel default myapp --hostname myapp.example.com --port 3000   # set your own
```

Saved in `~/.cscodetunnel/config.json` under `defaultTunnel`.

Set `--hostname "*.example.com"` for a **random subdomain** on every start (trycloudflare-style):
the `*` is replaced with a fresh `<adjective>-<noun>-<hex>` label. Requires a wildcard DNS route:

```sh
cscodetunnel named route cscode-tunnel "*.example.com"
```

> **Note:** `start` still needs the tunnel credentials (`~/.cloudflared/<uuid>.json`) and account
> authorization (`~/.cloudflared/cert.pem`, or `cscodetunnel named login`) on the machine. These are
> secrets and are **never** shipped in the npm package.

### Dashboard

| flag | default | meaning |
|---|---|---|
| `--dashboard-port <n>` | `4040` | dashboard port (auto-bumps to 4041–4045 if busy) |
| `--no-dashboard` | off | skip the dashboard entirely |
| `--no-open` | off | don't auto-open the browser |

Type `quit` (or Ctrl+C) in the terminal to shut everything down gracefully.

### Doctor

```sh
cscodetunnel doctor   # environment + cloudflared checks
```

### Telemetry

By default `cscodetunnel` sends an **anonymous** usage ping to Google Analytics
(event name + command + version + OS/arch only — no personal data). Set
`CSCDFLARED_TELEMETRY=0` to opt out:

```sh
# Windows (PowerShell)
$env:CSCDFLARED_TELEMETRY = "0"; cscodetunnel http 3000

# macOS / Linux
CSCDFLARED_TELEMETRY=0 cscodetunnel http 3000
```

## How it works

```
Internet → Cloudflare edge → cloudflared → inspection proxy → your app
```

The proxy (bound to `127.0.0.1`, random port) sits between cloudflared and your app: it logs every request into an in-memory ring buffer (last 1000), enforces basic auth, and applies the Host-header policy. cloudflared is spawned per tunnel, its log lines are parsed for the public URL, and unexpected exits trigger a restart with exponential backoff (1s → 30s cap, resets after 2 min stable). Terminal errors (tunnel already registered, auth failures) stop the loop and surface in the dashboard.

## Known limitations (v1)

- **Quick tunnels**: hard cap of 200 in-flight requests (429 beyond), no Server-Sent Events support (WebSockets work), random URL per run, no uptime guarantee — Cloudflare positions them for testing/demos. For production use named tunnels.
- **WebSocket inspection**: upgrades pass through with connect/disconnect logging only — no frame inspection, and `--host-header` does not apply to upgrades.
- **Compressed bodies** (gzip/br) are captured raw and shown with a "compressed" badge (no decompression).
- **Bodies are capped** at 256 KB (streaming continues untouched); slow-drip streams finalize as `truncated` after 30 s.
- **TCP tunnels have no request inspection** (proxy is HTTP-only).
- On Windows, closing the console window (vs Ctrl+C/`quit`) hard-kills the CLI and may orphan a cloudflared process — next run warns about a live managed binary.

## Development

```sh
npm test            # vitest unit + integration (no real cloudflared needed)
npm run e2e         # real end-to-end: real quick tunnel + public URL fetch (needs internet)
npm run build       # tsc + copy web assets
```
