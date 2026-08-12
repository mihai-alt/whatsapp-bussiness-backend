# Meta WhatsApp Cloud API Setup

Official **Meta Embedded Signup** only — no third-party BSP.

## Values you must configure in Meta Developer (manual)

1. Create a Meta app + add **WhatsApp**
2. Tech Provider / Solution Partner access
3. Facebook Login for Business → Embedded Signup → copy **Config ID**
4. Allow-list your dashboard domain (HTTPS) under Allowed Domains / OAuth redirect URIs
5. Permissions: `whatsapp_business_management`, `whatsapp_business_messaging`
6. Webhook: `https://YOUR_API_HOST/webhooks/whatsapp`  
   Verify token = `META_WEBHOOK_VERIFY_TOKEN`

## Backend `.env`

```
META_APP_ID=
META_APP_SECRET=
META_CONFIG_ID=
META_GRAPH_VERSION=v21.0
META_WEBHOOK_VERIFY_TOKEN=
META_TOKEN_ENCRYPTION_KEY=
META_REDIRECT_URI=
```

## Frontend `.env` (optional fallbacks — no secrets)

```
VITE_META_APP_ID=
VITE_META_CONFIG_ID=
VITE_META_GRAPH_VERSION=v21.0
```

Preferred: frontend loads App ID / Config ID from `GET /api/meta/embedded-signup`.

## Flow

1. Admin clicks **Connect New Number** → **Continue with Meta**
2. Meta Embedded Signup completes
3. Frontend POSTs `code` + session info to `POST /api/numbers/meta/connect`
4. Backend exchanges code, verifies WABA/phone via Graph API, encrypts token, saves connection
