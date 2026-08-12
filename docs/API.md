# API Reference

Base URL: `http://localhost:4000`

Auth header for protected routes:
```
Authorization: Bearer <accessToken>
```

## Auth
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/auth/register` | First user becomes admin |
| POST | `/api/auth/login` | Returns access + refresh tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/forgot-password` | Emails reset link (SMTP or stub log) |
| POST | `/api/auth/reset-password` | `{ token, password }` |
| POST | `/api/auth/change-password` | Auth required |
| GET | `/api/auth/me` | Current user |
| PATCH | `/api/auth/me` | Update profile (name) |
| POST | `/api/auth/me/avatar` | Upload avatar (`multipart/form-data`, field `avatar`, max 2MB) |
| DELETE | `/api/auth/me/avatar` | Remove avatar |
| GET | `/api/auth/users` | Admin team list |

## WhatsApp
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/whatsapp/config` | Public Meta app config for UI |
| GET | `/api/whatsapp` | List connected accounts |
| POST | `/api/whatsapp/connect` | Admin legacy/manual connect |
| POST | `/api/whatsapp/:id/sync` | Refresh Meta metadata |
| POST | `/api/whatsapp/:id/disconnect` | Local disconnect |
| GET | `/api/numbers/config` | Embedded Signup config (no secrets) |
| GET | `/api/numbers` | List connected numbers (no tokens) |
| POST | `/api/numbers/meta/connect` | Admin Embedded Signup connect |
| GET | `/api/numbers/:id` | Number details (no tokens) |
| POST | `/api/numbers/:id/reconnect` | Admin Embedded Signup reconnect |
| DELETE | `/api/numbers/:id` | Admin disconnect |
| POST | `/api/numbers/:id/disconnect` | Admin disconnect alias |
| GET/POST | `/webhooks/whatsapp` | Meta webhook (existing) |
| GET/POST | `/api/webhooks/meta` | Meta webhook alias |

## Business profile
| Method | Path |
|--------|------|
| GET | `/api/profile/business/:accountId` |
| PATCH | `/api/profile/business/:accountId` |
| POST | `/api/profile/business/:accountId/picture` |

## Templates
| Method | Path |
|--------|------|
| GET | `/api/templates` | list; supports `status`, `search`, `accountId`, `page`, `limit`, `paged=true`, `includeStats=true` |
| GET | `/api/templates/meta` | languages, categories, guidelines URL |
| GET | `/api/templates/stats` | totals + status percentages |
| GET | `/api/templates/:id` |
| POST | `/api/templates` | create draft (`bodyText` or `components`) |
| PUT | `/api/templates/:id` | edit draft/rejected |
| POST | `/api/templates/:id/submit` | submit to Meta |
| POST | `/api/templates/sync` | Admin sync from Meta |
| DELETE | `/api/templates/:id` |

## Contacts
| Method | Path |
|--------|------|
| GET | `/api/contacts` |
| POST | `/api/contacts` |
| PUT | `/api/contacts/:id` |
| DELETE | `/api/contacts/:id` |
| POST | `/api/contacts/import` |
| GET | `/api/contacts/export/csv` |
| GET | `/api/contacts/groups/list` |
| POST | `/api/contacts/groups` |
| POST | `/api/contacts/groups/:id/members` |
| DELETE | `/api/contacts/groups/:id` |

## Campaigns
| Method | Path |
|--------|------|
| GET | `/api/campaigns` |
| GET | `/api/campaigns/meta` | types, priorities, suggested tags |
| GET | `/api/campaigns/:id` |
| POST | `/api/campaigns/estimate` | audience cost vs wallet |
| POST | `/api/campaigns/preview-csv` |
| POST | `/api/campaigns` | multipart: details, template, group/CSV, mapping; `saveAsDraft` |
| POST | `/api/campaigns/:id/send` | launch draft/scheduled now |
| POST | `/api/campaigns/:id/pause` |
| POST | `/api/campaigns/:id/resume` |
| POST | `/api/campaigns/:id/cancel` |
| POST | `/api/campaigns/:id/retry-failed` |

## Wallet
| Method | Path |
|--------|------|
| GET | `/api/wallet` |
| GET | `/api/wallet/transactions` |
| GET | `/api/wallet/recharges` |
| GET | `/api/wallet/usage` |
| GET | `/api/wallet/pricing` |
| PUT | `/api/wallet/pricing` | Admin |
| POST | `/api/wallet/credit` | Admin manual credit |
| POST | `/api/wallet/recharge` | Stub payment gateway intent |

## Dashboard / reports / notifications
| Method | Path |
|--------|------|
| GET | `/api/dashboard` |
| GET | `/api/reports/messages` |
| GET | `/api/reports/campaigns` |
| GET | `/api/notifications` |
| POST | `/api/notifications/:id/read` |
| POST | `/api/notifications/read-all` |

## Webhooks
| Method | Path |
|--------|------|
| GET | `/webhooks/whatsapp` | Meta verify challenge |
| POST | `/webhooks/whatsapp` | Status + template events |

## Socket.IO events
- Client → `subscribe:campaign` with campaign id
- Server → `campaign:progress`
- Server → `message:status`
- Server → `notification`
