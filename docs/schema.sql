-- WhatsApp BSP schema reference dump
-- Prefer running: npm run migrate

CREATE DATABASE IF NOT EXISTS whatsapp_bsp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE whatsapp_bsp;

-- Tables are created by backend/src/db/migrate.js
-- After migrate + seed you will have:
--   users, refresh_tokens, password_resets
--   whatsapp_accounts, templates
--   contacts, contact_groups, contact_group_members
--   campaigns, campaign_messages
--   wallets, wallet_transactions, recharges, message_pricing
--   notifications, audit_logs
