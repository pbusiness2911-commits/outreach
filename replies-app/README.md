# Replies phone app

Cloudflare Worker behind the "Replies" home-screen app.

- Deploy: `cd replies-app && npx wrangler@4 deploy`
- Preview with real data: set `REPLIES_APP_URL` to the private app link (ends in `/a/<secret>`), run `node replies-app/preview.mjs`, open http://localhost:8799
