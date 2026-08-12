# Wallet Recharge (Razorpay)

Member wallet recharge uses **Razorpay Checkout** with backend signature verification and optional webhooks. The wallet is never credited from the frontend alone.

## Environment

In `backend/.env`:

```env
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx

WALLET_MIN_RECHARGE=100
WALLET_MAX_RECHARGE=100000
WALLET_CURRENCY=INR
LOW_WALLET_THRESHOLD=100
```

Use **Test Mode** keys from [Razorpay Dashboard](https://dashboard.razorpay.com/) → Settings → API Keys.

## Webhook

1. Dashboard → Account & Settings → Webhooks
2. URL: `https://YOUR_PUBLIC_API/api/webhooks/razorpay`
3. Secret → `RAZORPAY_WEBHOOK_SECRET`
4. Events: `payment.captured`, `payment.failed`, `order.paid`

For local testing, use a tunnel (ngrok / Cloudflare Tunnel) pointing to the API port.

## APIs

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/wallet/recharge/create-order` | JWT | Create DB recharge + Razorpay order |
| POST | `/api/wallet/recharge/verify` | JWT | Verify checkout signature + credit |
| POST | `/api/wallet/recharge/cancel` | JWT | Mark dismissed checkout cancelled |
| POST | `/api/webhooks/razorpay` | Signature | Idempotent capture / fail |
| POST | `/api/wallet/credit` | Admin JWT | Manual credit (no Razorpay) |
| GET | `/api/wallet` | JWT | Balance + limits |
| GET | `/api/wallet/transactions` | JWT | Ledger |
| GET | `/api/wallet/recharges` | JWT | Recharge history |

## Safety

- `RAZORPAY_KEY_SECRET` and webhook secret never leave the backend
- Credit runs in a MySQL transaction with row lock
- `recharges.credited`, unique `razorpay_payment_id`, and unique `(reference_type, reference_id)` on wallet transactions prevent double credit
- Campaign message debits use `reference_type=campaign_message` + message id (idempotent retries)
