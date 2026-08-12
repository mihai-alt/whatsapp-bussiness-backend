# Business Wallet (Admin + Member)

There is **one** shared business wallet (`wallets.user_id IS NULL`).

- Admin Wallet UI = management dashboard over that wallet  
- Member Wallet UI = recharge / history for the **same** balance  
- Recharges credit the business wallet; `created_by` records who paid  
- Campaign deductions debit the business wallet  

## Admin APIs (`requireRole('admin')`)

| Method | Path |
|--------|------|
| GET | `/api/admin/wallet` |
| GET | `/api/admin/wallet/summary` |
| GET | `/api/admin/wallet/balance-history` |
| GET | `/api/admin/wallet/transactions` |
| GET | `/api/admin/wallet/recharges` |
| GET | `/api/admin/wallet/usage` |

Recharge uses existing:

- `POST /api/wallet/recharge/create-order`
- `POST /api/wallet/recharge/verify`
- `POST /api/webhooks/razorpay`
