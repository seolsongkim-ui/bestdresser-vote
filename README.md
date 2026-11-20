# LELP Best Dresser Pair Vote

- `/` — voter page (what the QR code opens)
- `/host.html` — host screen for the projector (set range → Start voting → QR → End voting → 10 s reveal)
- `/api/vote` — serverless API

## Environment variables (Vercel)
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — added automatically when an Upstash Redis store is connected
- `BESTDRESSER_ADMIN_KEY` — host password
