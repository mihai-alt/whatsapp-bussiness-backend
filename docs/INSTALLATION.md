# Installation Guide

## Prerequisites
- Node.js 20+
- MySQL 8+
- Redis 6+
- A Meta Developer App with WhatsApp product enabled

## 1. Clone / extract the project
```bash
cd whatsapp
```

## 2. Configure backend
```bash
cd backend
copy .env.example .env   # Windows
# or: cp .env.example .env
```

Edit `backend/.env`:
- `DB_*` — MySQL credentials
- `REDIS_*` — Redis host/port
- `JWT_*` — long random secrets
- `META_*` — Meta app credentials (see META_SETUP.md)
- `SMTP_*` — optional, for password reset emails (logs to console if empty)

## 3. Configure frontend
```bash
cd ../frontend
copy .env.example .env
```

Set:
```
VITE_API_URL=http://localhost:4000
VITE_SOCKET_URL=http://localhost:4000
```

## 4. Install packages
From project root:
```bash
npm run install:all
```

## 5. Create database schema
```bash
npm run migrate
npm run seed
```

Seed creates:
- Admin user: `admin@example.com` / `Admin@12345`
- Wallet balance: `1000 INR`
- Default message pricing

## 6. Start services
Terminal 1:
```bash
npm run dev:api
```

Terminal 2:
```bash
npm run dev:web
```

Open http://localhost:5173

## 7. Verify
- Login with seeded admin
- Health check: http://localhost:4000/health
