# Antigrid HLS relay

Standalone, dependency-free Node.js 22+ HTTP/HLS relay. It fetches manifests and media only when a client requests them. It does not decode, transcode, or use a GPU. The `chzzk/` directory is reserved for a later integration; this phase has no CHZZK-specific code or browser extension.

## Run

```sh
cd /home/eruin/project/antigrid
npm start
```

The default listener is `127.0.0.1:8080`. To bind to a LAN or Tailscale interface, set `RELAY_HOST`, `RELAY_PUBLIC_BASE_URL`, and `RELAY_API_TOKEN`. The service refuses non-local binding without both a public base URL and API token. Set `RELAY_CORS_ORIGIN` to the exact browser extension or page origin if browser CORS access is needed later. Use TLS or a trusted private network for remote access; an HTTP bearer token is not encrypted in transit.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_HOST` | `127.0.0.1` | Listen address |
| `RELAY_PORT` | `8080` | Listen port |
| `RELAY_PUBLIC_BASE_URL` | Listener URL | Playback URL prefix in API responses |
| `RELAY_API_TOKEN` | unset | Bearer token for session and status APIs |
| `RELAY_CORS_ORIGIN` | unset | Exact allowed browser origin |
| `RELAY_IDLE_MS` | `30000` | Expire session after this much idle time |
| `RELAY_CLEANUP_MS` | `1000` | Expiry scan interval |
| `RELAY_ALLOW_PRIVATE_UPSTREAM` | `0` | Allow private/loopback upstream targets for local development only |

Create a session (replace the URL with a real public HLS manifest):

```sh
curl -sS -X POST http://127.0.0.1:8080/api/session \
  -H 'Content-Type: application/json' \
  -d '{"upstream_url":"https://example.com/live/master.m3u8"}'
```

The JSON response has `session_id` and `playback_url`. Use the playback URL with `curl`, `ffprobe`, or `ffmpeg`; delete the session with `DELETE /api/session/{session_id}`. `GET /debug/status` reports active sessions, active requests, and cumulative bytes. If `RELAY_API_TOKEN` is set, send `Authorization: Bearer <token>` to create/delete/status requests. Playback URLs are unguessable capabilities, so keep them private. The session API accepts optional `headers` limited to `Referer`, `User-Agent`, `Origin`, and `Authorization`; cookies are rejected. Authorization is removed on cross-origin redirects.

## API contract for a future Chrome client

Create a session with `POST /api/session`, `Content-Type: application/json`, and a JSON object containing `upstream_url` (required absolute HTTP(S) HLS URL) and `headers` (optional allowlisted upstream headers). Example:

```http
POST /api/session HTTP/1.1
Authorization: Bearer <relay-api-token>
Content-Type: application/json

{"upstream_url":"https://cdn.example/live/master.m3u8?temporary_token=...","headers":{"Referer":"https://chzzk.naver.com/"}}
```

Success is HTTP `201` with `{"session_id":"<opaque-id>","playback_url":"https://relay.example.ts.net/session/<opaque-id>/master.m3u8"}`. Use that URL as-is; the client does not rewrite playlist or segment URLs. Each media request refreshes the idle timer. There is no heartbeat endpoint. When the upstream authorization expires, obtain a fresh URL and create a new session, then delete the old one. Session creation validates the URL but makes no upstream media request.

Stop with `DELETE /api/session/<opaque-id>` and the bearer token; success is HTTP `204` with an empty body. This aborts active requests. `GET /debug/status` with the bearer token returns `active_sessions`, `active_downstream_requests`, `active_upstream_requests`, cumulative `bytes_received`/`bytes_sent`, and per-session age/idle counters. Counters reset when the process restarts. Errors are JSON objects of the form `{"error":"message"}`: `400` invalid input or blocked target, `401` missing/wrong API token, `404` unknown session/resource, `413` oversized request, and `502` upstream/rewrite failure. Playback URLs are bearer capabilities independent of the API token; do not log or share them.

For Chrome, keep the API bearer token in the extension context and send control requests from its background service worker with narrow host permission. A content script's cross-origin fetch obeys the page origin's CORS rules. If page-side HLS playback fetches relay URLs, set `RELAY_CORS_ORIGIN=https://chzzk.naver.com`; the relay then permits `GET`, `POST`, `DELETE`, `OPTIONS` plus `Authorization`, `Content-Type`, and `Range` from that exact origin. CORS is a browser rule, not authentication. The playback URL itself grants access to its session. Avoid placing the API token in the page or a content script message that page code can influence. The extension integration must confirm the browser's CSP, CORS, and mixed-content behavior on the real page.

For private remote access, keep the Node listener on loopback and use an existing private HTTPS reverse proxy, such as Tailscale Serve, with `RELAY_PUBLIC_BASE_URL` set to its HTTPS URL and `RELAY_API_TOKEN` set to a strong secret. A direct tailnet bind is also possible with `RELAY_HOST`, but HTTPS is preferable for browser playback on an HTTPS page. Do not use Tailscale Funnel or expose the relay publicly. Restrict access with tailnet policy as appropriate. No network service configuration is changed by this project.

The relay rewrites playlist URI lines and `URI="..."` attributes, resolves relative URLs, and handles HLS `EXT-X-DEFINE` variables used in resource URLs. Resource URLs carry an opaque session-scoped token and a filename suffix for FFmpeg compatibility. There is no arbitrary `?url=` proxy. Each outbound request validates and pins DNS resolution, blocks non-public targets by default, and validates redirects. Manifests are capped at 2 MiB and media resources at 256 MiB; media is streamed in chunks. A session can register at most 10,000 resource URLs. All active upstream requests are aborted on downstream disconnect, session deletion, or idle expiry.

## Verify

```sh
npm test
```

The tests start local HTTP fixtures, so they need permission to open loopback sockets. They cover master and nested playlists, relative URLs, URI attributes, extensionless playlists through redirects, range requests, SSRF restrictions, log redaction, cancellation, deletion, process termination, idle expiry, and actual `ffprobe`/`ffmpeg` consumption of a generated HLS stream. FFmpeg is a test client only. During manual playback, inspect `GET /debug/status`; after stopping or deleting the client, `active_upstream_requests` and `active_downstream_requests` should become zero. After the idle timeout, `active_sessions` should also become zero. `ss -tpn` can confirm no remaining media connections.

This relay has **not** been tested against a CHZZK playback URL. On 2026-09-23 the server reached `chzzk.naver.com`, but requests to `api.chzzk.naver.com` timed out, so no public live URL was obtained. The documented `live-detail` response can contain a stringified `livePlaybackJson` with HLS media paths, but that endpoint and any authorization requirements still need testing from this server. Current Streamlink CHZZK code also adds a `__bgda__` query value to some `.m4v` segment URLs; whether this relay needs a CHZZK-specific adapter for that behavior remains unverified. LL-HLS blocking reload query parameters (`_HLS_msn`, `_HLS_part`, `_HLS_skip`) are not forwarded from relay playlist requests and need testing if normal HLS is unavailable. Keep CHZZK URL acquisition and any necessary URL transformation in `chzzk/`, separate from the generic relay. See [Chrome integration notes](chzzk/README.md).

Local fixture measurement on 2026-09-23 (separate Node relay process; 1.31 MiB/s generated stream): baseline CPU ~1%, RSS 58 MiB; active CPU ~3%, RSS 64 MiB; after DELETE CPU ~0–1%, RSS 71 MiB, with zero sessions, clients, and upstream requests. `ss -tnp` showed one relay-to-upstream connection during playback and zero afterward. Counters reached zero within 1–5 ms after DELETE in these runs. Node retained some allocated memory after playback, but media traffic stopped. These figures are local loopback measurements, not real CHZZK throughput; CPU and RSS vary by host and Node runtime. A persistent small control process is simpler than per-session process startup and adds little idle CPU. The relay does no decoding, transcoding, or GPU work.
