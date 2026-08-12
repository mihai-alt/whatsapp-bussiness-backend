# Deployment Guide

## Recommended layout
- API: Node process behind Nginx / Caddy (port 4000)
- Web: build static assets and serve via Nginx, or host on any static CDN
- MySQL managed instance
- Redis managed instance
- HTTPS required for Meta webhooks and Embedded Signup

## Build frontend
```bash
cd frontend
npm install
npm run build
```
Serve `frontend/dist` as the web root.

Point the SPA to the public API:
```
VITE_API_URL=https://api.yourdomain.com
VITE_SOCKET_URL=https://api.yourdomain.com
```

## Run backend in production
```bash
cd backend
npm install --omit=dev
npm run migrate
npm run seed
NODE_ENV=production node src/server.js
```

Use PM2:
```bash
pm2 start src/server.js --name whatsapp-bsp-api
```

## Nginx sketch
```nginx
server {
  server_name app.yourdomain.com;
  root /var/www/whatsapp-bsp/frontend/dist;
  location / {
    try_files $uri /index.html;
  }
}

server {
  server_name api.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Environment checklist
- Strong `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`
- `APP_URL` = public frontend URL
- `API_URL` = public API URL
- Meta webhook callback URL: `https://api.yourdomain.com/webhooks/whatsapp`
- CORS origin matches frontend URL

## Deploy backend on Render

Frontend (already live): `https://dev1125-business.netlify.app`

### What Render hosts
| Piece | On Render? |
|-------|------------|
| Node API (`backend/`) | Yes — Web Service |
| Redis / Valkey (BullMQ) | Yes — Key Value |
| MySQL 8 | **No** — use Aiven, Railway, PlanetScale, or any remote MySQL |

### 1. Push code to GitHub
Render deploys from a Git repo. From the project root:

```bash
git init
git add .
git commit -m "Prepare backend for Render deploy"
# create a GitHub repo, then:
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Do **not** commit `backend/.env` (it is gitignored).

### 2. Create MySQL (external)
Create a MySQL 8 database and note `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
Allow connections from anywhere (or Render egress) if the provider uses IP allowlists.

### 3. Deploy with Blueprint (recommended)
1. Open [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
2. Connect the GitHub repo
3. Confirm `render.yaml` (creates `whatsapp-bsp-api` + `whatsapp-bsp-redis`)
4. Fill every env var marked **sync: false** (DB_*, SMTP_*, Meta, Razorpay, `API_URL`)
5. Set:
   - `APP_URL=https://dev1125-business.netlify.app`
   - `API_URL=https://<your-service>.onrender.com` (set after the first URL is assigned)
6. Deploy

### 4. Or create the Web Service manually
- **Runtime:** Node
- **Root Directory:** `backend`
- **Build Command:** `npm install --omit=dev`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`
- Add a **Key Value** instance and set `REDIS_URL` from its Internal Connection URL
- Copy env vars from `backend/.env.example`, with production values:
  - `NODE_ENV=production`
  - `HOST=0.0.0.0`
  - `APP_URL=https://dev1125-business.netlify.app`
  - `API_URL=https://<your-service>.onrender.com`

### 5. Migrate and seed
In the Render service → **Shell**:

```bash
npm run migrate
npm run seed
```

Default admin after seed: `admin@example.com` / `Admin@12345`

### 6. Point Netlify frontend at the API
Rebuild/redeploy the frontend with:

```
VITE_API_URL=https://<your-service>.onrender.com
VITE_SOCKET_URL=https://<your-service>.onrender.com
```

### 7. Meta webhooks
Callback URL: `https://<your-service>.onrender.com/webhooks/whatsapp`  
Verify token: same as `META_WEBHOOK_VERIFY_TOKEN`

### Notes
- Free web services sleep after idle; first request can be slow
- Ephemeral disk: uploaded files under `uploads/` are lost on redeploy — use object storage later if needed
- CORS is locked to `APP_URL`; it must match the Netlify origin exactly (no trailing slash)

## Backups
- Daily MySQL dumps
- Persist Redis only if you need durable delayed jobs across restarts (BullMQ jobs are in Redis)
