# WhatsApp BSP Dashboard

Single-business WhatsApp Business Platform console built on the **official Meta WhatsApp Cloud API**.

## Stack
- Frontend: React + Vite + Tailwind CSS
- Backend: Node.js + Express
- Database: MySQL 8
- Queue: Redis + BullMQ
- Auth: JWT
- Realtime: Socket.IO

## Quick start
1. Install MySQL and Redis
2. Copy env files:
   - `backend/.env.example` → `backend/.env`
   - `frontend/.env.example` → `frontend/.env`
3. Install dependencies:
   ```bash
   npm run install:all
   ```
4. Migrate and seed:
   ```bash
   npm run migrate
   npm run seed
   ```
5. Run API and web:
   ```bash
   npm run dev:api
   npm run dev:web
   ```

Default admin after seed: `admin@example.com` / `Admin@12345`

## Docs
- [Installation](docs/INSTALLATION.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Meta setup](docs/META_SETUP.md)
- [API reference](docs/API.md)

## Features
- Team login / register / forgot & change password
- Connect approved WhatsApp Cloud API numbers (token or Embedded Signup code)
- Business profile updates
- Template create / submit / sync
- Contacts, groups, CSV/XLSX import-export
- Bulk campaigns with pause/resume/cancel/retry and live progress
- Wallet with deduction + manual admin credit (payment gateway stubbed)
- Reports and in-app notifications
