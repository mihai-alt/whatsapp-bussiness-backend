import path from 'path';
import { pathToFileURL } from 'url';
import mysql from 'mysql2/promise';
import { config } from '../config.js';

const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role ENUM('admin','member') NOT NULL DEFAULT 'member',
    avatar_url VARCHAR(512) NULL,
    phone VARCHAR(32) NULL,
    language VARCHAR(32) NOT NULL DEFAULT 'en',
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    date_format VARCHAR(32) NOT NULL DEFAULT 'DD/MM/YYYY',
    bio TEXT NULL,
    email_verified TINYINT(1) NOT NULL DEFAULT 0,
    email_verified_at DATETIME NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_refresh_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS password_resets (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_reset_token (token_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS email_verifications (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    used_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_email_verify_user (user_id),
    INDEX idx_email_verify_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS email_verification_codes (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    used_at DATETIME NULL,
    last_sent_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_evc_user (user_id),
    INDEX idx_evc_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS pending_signups (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    last_sent_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_pending_signup_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone_number VARCHAR(32) NULL,
    phone_number_id VARCHAR(64) NOT NULL UNIQUE,
    waba_id VARCHAR(64) NOT NULL,
    business_name VARCHAR(255) NULL,
    quality_rating VARCHAR(64) NULL,
    messaging_limit VARCHAR(64) NULL,
    access_token TEXT NOT NULL,
    token_expires_at DATETIME NULL,
    status ENUM('connected','disconnected','error') NOT NULL DEFAULT 'connected',
    profile_picture_url VARCHAR(1024) NULL,
    about_text TEXT NULL,
    meta_payload JSON NULL,
    connected_by INT UNSIGNED NULL,
    connected_at TIMESTAMP NULL,
    disconnected_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (connected_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS templates (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    whatsapp_account_id INT UNSIGNED NOT NULL,
    name VARCHAR(512) NOT NULL,
    language VARCHAR(16) NOT NULL DEFAULT 'en_US',
    category ENUM('MARKETING','UTILITY','AUTHENTICATION') NOT NULL DEFAULT 'MARKETING',
    status ENUM('DRAFT','PENDING','APPROVED','REJECTED','PAUSED','DISABLED') NOT NULL DEFAULT 'DRAFT',
    meta_template_id VARCHAR(64) NULL,
    components JSON NOT NULL,
    rejection_reason TEXT NULL,
    created_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (whatsapp_account_id) REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY uq_template_name_lang (whatsapp_account_id, name, language),
    INDEX idx_templates_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS contacts (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    phone_normalized VARCHAR(32) NOT NULL,
    email VARCHAR(255) NULL,
    custom_fields JSON NULL,
    created_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE KEY uq_phone_normalized (phone_normalized),
    INDEX idx_contacts_name (name),
    INDEX idx_contacts_phone (phone)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS contact_groups (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT NULL,
    status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    access_mode ENUM('PRIVATE','SHARED') NOT NULL DEFAULT 'PRIVATE',
    created_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_contact_groups_created_by (created_by),
    INDEX idx_contact_groups_status (status),
    INDEX idx_contact_groups_access_mode (access_mode)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS contact_group_members (
    group_id INT UNSIGNED NOT NULL,
    contact_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, contact_id),
    FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    INDEX idx_cgm_contact (contact_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS contact_group_access (
    group_id INT UNSIGNED NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id),
    INDEX idx_cga_user (user_id),
    INDEX idx_cga_group (group_id),
    FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS campaigns (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    campaign_type ENUM('marketing','utility') NOT NULL DEFAULT 'marketing',
    tags JSON NULL,
    priority ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
    notes TEXT NULL,
    whatsapp_account_id INT UNSIGNED NULL,
    template_id INT UNSIGNED NULL,
    contact_group_id INT UNSIGNED NULL,
    status ENUM('draft','pending_approval','scheduled','queued','running','paused','completed','cancelled','failed') NOT NULL DEFAULT 'draft',
    variable_mapping JSON NULL,
    scheduled_at DATETIME NULL,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    total_count INT UNSIGNED NOT NULL DEFAULT 0,
    sent_count INT UNSIGNED NOT NULL DEFAULT 0,
    delivered_count INT UNSIGNED NOT NULL DEFAULT 0,
    read_count INT UNSIGNED NOT NULL DEFAULT 0,
    failed_count INT UNSIGNED NOT NULL DEFAULT 0,
    pending_count INT UNSIGNED NOT NULL DEFAULT 0,
    cost_per_message DECIMAL(10,4) NOT NULL DEFAULT 0,
    total_cost DECIMAL(12,4) NOT NULL DEFAULT 0,
    created_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (whatsapp_account_id) REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE RESTRICT,
    FOREIGN KEY (contact_group_id) REFERENCES contact_groups(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_campaigns_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS campaign_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    campaign_id INT UNSIGNED NOT NULL,
    contact_id INT UNSIGNED NULL,
    phone VARCHAR(32) NOT NULL,
    variables JSON NULL,
    status ENUM('pending','queued','sent','delivered','read','failed','cancelled') NOT NULL DEFAULT 'pending',
    wamid VARCHAR(128) NULL,
    error_code VARCHAR(64) NULL,
    error_message TEXT NULL,
    cost DECIMAL(10,4) NOT NULL DEFAULT 0,
    sent_at DATETIME NULL,
    delivered_at DATETIME NULL,
    read_at DATETIME NULL,
    failed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
    INDEX idx_cm_campaign_status (campaign_id, status),
    INDEX idx_cm_wamid (wamid),
    INDEX idx_cm_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS wallets (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NULL,
    balance DECIMAL(14,4) NOT NULL DEFAULT 0,
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wallets_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS wallet_transactions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    wallet_id INT UNSIGNED NULL,
    user_id INT UNSIGNED NULL,
    type ENUM('credit','debit','refund') NOT NULL,
    amount DECIMAL(14,4) NOT NULL,
    balance_before DECIMAL(14,4) NULL,
    balance_after DECIMAL(14,4) NOT NULL,
    platform_revenue DECIMAL(14,4) NOT NULL DEFAULT 0,
    reference_type VARCHAR(64) NULL,
    reference_id VARCHAR(64) NULL,
    description VARCHAR(512) NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'success',
    created_by INT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_wt_created (created_at),
    INDEX idx_wt_type (type),
    INDEX idx_wt_user_created (user_id, created_at),
    UNIQUE KEY uq_wt_reference (reference_type, reference_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS recharges (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    amount DECIMAL(14,4) NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'INR',
    status ENUM('pending','processing','completed','failed','cancelled','refunded') NOT NULL DEFAULT 'pending',
    gateway VARCHAR(64) NOT NULL DEFAULT 'manual',
    gateway_ref VARCHAR(255) NULL,
    internal_order_id VARCHAR(64) NULL,
    razorpay_order_id VARCHAR(64) NULL,
    razorpay_payment_id VARCHAR(64) NULL,
    razorpay_signature VARCHAR(255) NULL,
    payment_method VARCHAR(64) NULL,
    processing_fee DECIMAL(14,4) NOT NULL DEFAULT 0,
    credited TINYINT(1) NOT NULL DEFAULT 0,
    meta JSON NULL,
    created_by INT UNSIGNED NULL,
    user_id INT UNSIGNED NULL,
    wallet_id INT UNSIGNED NULL,
    completed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE SET NULL,
    INDEX idx_recharges_status (status),
    INDEX idx_recharges_user (user_id),
    UNIQUE KEY uq_recharges_internal_order (internal_order_id),
    UNIQUE KEY uq_recharges_rzp_order (razorpay_order_id),
    UNIQUE KEY uq_recharges_rzp_payment (razorpay_payment_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS message_pricing (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    category VARCHAR(64) NOT NULL UNIQUE,
    cost DECIMAL(10,4) NOT NULL,
    provider_cost DECIMAL(10,4) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NULL,
    type VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NULL,
    meta JSON NULL,
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_notif_user_read (user_id, is_read),
    INDEX idx_notif_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NULL,
    action VARCHAR(128) NOT NULL,
    entity_type VARCHAR(64) NULL,
    entity_id VARCHAR(64) NULL,
    meta JSON NULL,
    ip VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function migrate() {
  const root = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
    ...(config.db.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  await root.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.changeUser({ database: config.db.database });

  for (const sql of statements) {
    await root.query(sql);
  }

  // Additive profile columns for existing databases
  const profileColumns = [
    ['phone', 'VARCHAR(32) NULL'],
    ['language', "VARCHAR(32) NOT NULL DEFAULT 'en'"],
    ['timezone', "VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'"],
    ['date_format', "VARCHAR(32) NOT NULL DEFAULT 'DD/MM/YYYY'"],
    ['bio', 'TEXT NULL'],
    ['email_verified_at', 'DATETIME NULL'],
    ['email_verified', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ];
  for (const [name, definition] of profileColumns) {
    try {
      await root.query(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
      console.log(`Added users.${name}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  // Keep email_verified in sync with email_verified_at for existing rows
  try {
    await root.query(`
      UPDATE users
      SET email_verified = 1
      WHERE email_verified_at IS NOT NULL
        AND CAST(email_verified_at AS CHAR) <> '0000-00-00 00:00:00'
        AND email_verified = 0
    `);
    await root.query(`
      UPDATE users
      SET email_verified = 0
      WHERE email_verified_at IS NULL AND email_verified = 1
    `);
  } catch (err) {
    console.warn('email_verified sync skipped:', err.message);
  }

  // One-time: mark legacy accounts verified only when nobody is waiting on codes/pending
  try {
    await root.query(`
      CREATE TABLE IF NOT EXISTS schema_flags (
        flag_key VARCHAR(64) PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [flags] = await root.query(
      `SELECT flag_key FROM schema_flags WHERE flag_key = 'email_verified_backfill_v2' LIMIT 1`
    );
    if (!flags.length) {
      await root.query(`
        UPDATE users
        SET email_verified = 1,
            email_verified_at = COALESCE(email_verified_at, created_at, NOW())
        WHERE email_verified = 0
          AND email_verified_at IS NULL
          AND id NOT IN (
            SELECT user_id FROM (
              SELECT user_id FROM email_verification_codes WHERE used_at IS NULL
              UNION
              SELECT user_id FROM email_verifications WHERE used_at IS NULL
            ) pending_codes
          )
      `);
      await root.query(`INSERT INTO schema_flags (flag_key) VALUES ('email_verified_backfill_v2')`);
      console.log('Backfilled verified status for legacy users (one-time v2)');
    }
  } catch (err) {
    console.warn('email_verified backfill skipped:', err.message);
  }

  // Move unverified user rows into pending_signups (account is NOT registered until verified)
  try {
    const [unverified] = await root.query(
      `SELECT id, email, name, password_hash FROM users WHERE email_verified = 0 OR email_verified_at IS NULL`
    );
    for (const row of unverified) {
      // Skip if somehow also marked verified inconsistently
      const [check] = await root.query(
        `SELECT email_verified FROM users WHERE id = ? LIMIT 1`,
        [row.id]
      );
      if (check[0] && Number(check[0].email_verified) === 1) continue;

      await root.query(
        `INSERT INTO pending_signups (email, name, password_hash, code_hash, attempts, expires_at, last_sent_at)
         VALUES (?, ?, ?, 'needs_resend', 0, DATE_ADD(NOW(), INTERVAL 10 MINUTE), DATE_SUB(NOW(), INTERVAL 1 HOUR))
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           password_hash = VALUES(password_hash),
           code_hash = 'needs_resend',
           attempts = 0,
           expires_at = VALUES(expires_at)`,
        [row.email, row.name, row.password_hash]
      );
      await root.query(`DELETE FROM refresh_tokens WHERE user_id = ?`, [row.id]);
      await root.query(`DELETE FROM email_verification_codes WHERE user_id = ?`, [row.id]);
      await root.query(`DELETE FROM email_verifications WHERE user_id = ?`, [row.id]);
      await root.query(`DELETE FROM users WHERE id = ?`, [row.id]);
      console.log(`Moved unverified ${row.email} to pending_signups (not registered yet)`);
    }
  } catch (err) {
    console.warn('Unverified→pending cleanup skipped:', err.message);
  }

  // Wallet / Razorpay additive columns for existing databases
  const walletTxColumns = [
    ['balance_before', 'DECIMAL(14,4) NULL'],
    ['status', "VARCHAR(32) NOT NULL DEFAULT 'success'"],
  ];
  for (const [name, definition] of walletTxColumns) {
    try {
      await root.query(`ALTER TABLE wallet_transactions ADD COLUMN ${name} ${definition}`);
      console.log(`Added wallet_transactions.${name}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }
  try {
    await root.query(
      `ALTER TABLE wallet_transactions ADD UNIQUE KEY uq_wt_reference (reference_type, reference_id)`
    );
    console.log('Added wallet_transactions.uq_wt_reference');
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME' && err.code !== 'ER_DUP_ENTRY') {
      // Duplicate rows may block unique index — keep non-fatal
      console.warn('wallet_transactions unique reference index skipped:', err.message);
    }
  }

  const rechargeColumns = [
    ['currency', "VARCHAR(8) NOT NULL DEFAULT 'INR'"],
    ['internal_order_id', 'VARCHAR(64) NULL'],
    ['razorpay_order_id', 'VARCHAR(64) NULL'],
    ['razorpay_payment_id', 'VARCHAR(64) NULL'],
    ['razorpay_signature', 'VARCHAR(255) NULL'],
    ['payment_method', 'VARCHAR(64) NULL'],
    ['credited', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ];
  for (const [name, definition] of rechargeColumns) {
    try {
      await root.query(`ALTER TABLE recharges ADD COLUMN ${name} ${definition}`);
      console.log(`Added recharges.${name}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  // Expand recharges.status enum (safe if already applied)
  try {
    await root.query(`
      ALTER TABLE recharges
      MODIFY COLUMN status
        ENUM('pending','processing','completed','failed','cancelled','refunded')
        NOT NULL DEFAULT 'pending'
    `);
  } catch (err) {
    console.warn('recharges.status enum update skipped:', err.message);
  }

  // Mark completed manual recharges as credited
  try {
    await root.query(`UPDATE recharges SET credited = 1 WHERE status = 'completed' AND credited = 0`);
  } catch (err) {
    console.warn('recharges credited backfill skipped:', err.message);
  }

  for (const [keyName, cols] of [
    ['uq_recharges_internal_order', 'internal_order_id'],
    ['uq_recharges_rzp_order', 'razorpay_order_id'],
    ['uq_recharges_rzp_payment', 'razorpay_payment_id'],
  ]) {
    try {
      await root.query(`ALTER TABLE recharges ADD UNIQUE KEY ${keyName} (${cols})`);
      console.log(`Added recharges.${keyName}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_KEYNAME' && err.code !== 'ER_DUP_ENTRY') {
        console.warn(`recharges.${keyName} skipped:`, err.message);
      }
    }
  }

  // ---- Per-user wallets migration ----
  for (const [name, definition] of [
    ['user_id', 'INT UNSIGNED NULL'],
    ['created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'],
  ]) {
    try {
      await root.query(`ALTER TABLE wallets ADD COLUMN ${name} ${definition}`);
      console.log(`Added wallets.${name}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  for (const [name, definition] of [
    ['wallet_id', 'INT UNSIGNED NULL'],
    ['user_id', 'INT UNSIGNED NULL'],
    ['platform_revenue', 'DECIMAL(14,4) NOT NULL DEFAULT 0'],
  ]) {
    try {
      await root.query(`ALTER TABLE wallet_transactions ADD COLUMN ${name} ${definition}`);
      console.log(`Added wallet_transactions.${name}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  for (const [name, definition] of [
    ['user_id', 'INT UNSIGNED NULL'],
    ['wallet_id', 'INT UNSIGNED NULL'],
    ['processing_fee', 'DECIMAL(14,4) NOT NULL DEFAULT 0'],
  ]) {
    try {
      await root.query(`ALTER TABLE recharges ADD COLUMN ${name} ${definition}`);
      console.log(`Added recharges.${name}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  try {
    await root.query(
      `ALTER TABLE message_pricing ADD COLUMN provider_cost DECIMAL(10,4) NOT NULL DEFAULT 0`
    );
    console.log('Added message_pricing.provider_cost');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // Assign legacy shared wallet balance to first admin (one-time)
  try {
    await root.query(`
      CREATE TABLE IF NOT EXISTS schema_flags (
        flag_key VARCHAR(64) PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [flags] = await root.query(
      `SELECT flag_key FROM schema_flags WHERE flag_key = 'per_user_wallets_v1' LIMIT 1`
    );
    if (!flags.length) {
      const [admins] = await root.query(
        `SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`
      );
      const adminId = admins[0]?.id || null;
      const [legacy] = await root.query(
        `SELECT id, balance, currency FROM wallets WHERE user_id IS NULL ORDER BY id ASC`
      );

      if (adminId && legacy.length) {
        await root.query(`UPDATE wallets SET user_id = ? WHERE id = ?`, [adminId, legacy[0].id]);
        // Drop extra orphan shared rows (keep first)
        for (let i = 1; i < legacy.length; i += 1) {
          await root.query(`DELETE FROM wallets WHERE id = ? AND user_id IS NULL`, [legacy[i].id]);
        }
        console.log(`Assigned legacy shared wallet #${legacy[0].id} to admin #${adminId}`);
      }

      // Create zero wallets for every user missing one
      const [allUsers] = await root.query(`SELECT id FROM users`);
      for (const u of allUsers) {
        const [existing] = await root.query(`SELECT id FROM wallets WHERE user_id = ? LIMIT 1`, [u.id]);
        if (!existing.length) {
          await root.query(`INSERT INTO wallets (user_id, balance, currency) VALUES (?, 0, 'INR')`, [u.id]);
        }
      }

      // Backfill transaction ownership from created_by
      await root.query(`
        UPDATE wallet_transactions wt
        SET user_id = COALESCE(wt.user_id, wt.created_by)
        WHERE wt.user_id IS NULL AND wt.created_by IS NOT NULL
      `);
      await root.query(`
        UPDATE wallet_transactions wt
        INNER JOIN wallets w ON w.user_id = wt.user_id
        SET wt.wallet_id = COALESCE(wt.wallet_id, w.id)
        WHERE wt.wallet_id IS NULL AND wt.user_id IS NOT NULL
      `);
      // Remaining orphan txns → admin wallet if available
      if (adminId) {
        const [aw] = await root.query(`SELECT id FROM wallets WHERE user_id = ? LIMIT 1`, [adminId]);
        if (aw[0]) {
          await root.query(
            `UPDATE wallet_transactions
             SET user_id = COALESCE(user_id, ?), wallet_id = COALESCE(wallet_id, ?)
             WHERE user_id IS NULL OR wallet_id IS NULL`,
            [adminId, aw[0].id]
          );
        }
      }

      await root.query(`
        UPDATE recharges r
        SET user_id = COALESCE(r.user_id, r.created_by)
        WHERE r.user_id IS NULL AND r.created_by IS NOT NULL
      `);
      await root.query(`
        UPDATE recharges r
        INNER JOIN wallets w ON w.user_id = r.user_id
        SET r.wallet_id = COALESCE(r.wallet_id, w.id)
        WHERE r.wallet_id IS NULL AND r.user_id IS NOT NULL
      `);

      await root.query(`INSERT INTO schema_flags (flag_key) VALUES ('per_user_wallets_v1')`);
      console.log('Per-user wallets backfill completed');
    }
  } catch (err) {
    console.warn('Per-user wallets backfill skipped:', err.message);
  }

  try {
    await root.query(`ALTER TABLE wallets ADD UNIQUE KEY uq_wallets_user (user_id)`);
    console.log('Added wallets.uq_wallets_user');
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME' && err.code !== 'ER_DUP_ENTRY') {
      console.warn('wallets.uq_wallets_user skipped:', err.message);
    }
  }

  try {
    await root.query(`ALTER TABLE wallet_transactions ADD INDEX idx_wt_user_created (user_id, created_at)`);
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME') console.warn('idx_wt_user_created skipped:', err.message);
  }

  try {
    await root.query(`ALTER TABLE recharges ADD INDEX idx_recharges_user (user_id)`);
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME') console.warn('idx_recharges_user skipped:', err.message);
  }

  // Consolidate to ONE shared business wallet (user_id IS NULL)
  try {
    await root.query(`
      CREATE TABLE IF NOT EXISTS schema_flags (
        flag_key VARCHAR(64) PRIMARY KEY,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [flags] = await root.query(
      `SELECT flag_key FROM schema_flags WHERE flag_key = 'business_wallet_v1' LIMIT 1`
    );
    if (!flags.length) {
      const [biz] = await root.query(
        `SELECT id, balance FROM wallets WHERE user_id IS NULL ORDER BY id ASC LIMIT 1`
      );
      let businessId = biz[0]?.id;
      if (!businessId) {
        const [first] = await root.query(`SELECT id, balance FROM wallets ORDER BY id ASC LIMIT 1`);
        if (first[0]) {
          await root.query(`UPDATE wallets SET user_id = NULL WHERE id = ?`, [first[0].id]);
          businessId = first[0].id;
        } else {
          const [ins] = await root.query(
            `INSERT INTO wallets (user_id, balance, currency) VALUES (NULL, 0, 'INR')`
          );
          businessId = ins.insertId;
        }
      }

      const [sums] = await root.query(
        `SELECT COALESCE(SUM(balance), 0) AS total FROM wallets WHERE id <> ? OR user_id IS NOT NULL`,
        [businessId]
      );
      // Merge: keep business balance as SUM of all wallets (avoid double-count business itself)
      const [allSum] = await root.query(`SELECT COALESCE(SUM(balance), 0) AS total FROM wallets`);
      await root.query(`UPDATE wallets SET balance = ? WHERE id = ?`, [
        Number(allSum[0].total || 0),
        businessId,
      ]);
      await root.query(`DELETE FROM wallets WHERE id <> ?`, [businessId]);
      await root.query(`UPDATE wallet_transactions SET wallet_id = ? WHERE wallet_id IS NULL OR wallet_id <> ?`, [
        businessId,
        businessId,
      ]);
      await root.query(`UPDATE recharges SET wallet_id = ? WHERE wallet_id IS NULL OR wallet_id <> ?`, [
        businessId,
        businessId,
      ]);
      await root.query(`INSERT INTO schema_flags (flag_key) VALUES ('business_wallet_v1')`);
      console.log(`Consolidated to business wallet #${businessId} (balance merged)`);
      void sums;
    }
  } catch (err) {
    console.warn('Business wallet consolidation skipped:', err.message);
  }

  // Campaign scheduled timezone (display + audit; scheduled_at stored as UTC datetime)
  try {
    await root.query(
      `ALTER TABLE campaigns ADD COLUMN scheduled_timezone VARCHAR(64) NULL AFTER scheduled_at`
    );
    console.log('Added campaigns.scheduled_timezone');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn('campaigns.scheduled_timezone skipped:', err.message);
  }

  try {
    await root.query(`ALTER TABLE campaigns ADD INDEX idx_campaigns_scheduled (scheduled_at)`);
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME') console.warn('idx_campaigns_scheduled skipped:', err.message);
  }

  // Allow member→admin approval workflow on existing DBs
  try {
    await root.query(
      `ALTER TABLE campaigns
       MODIFY COLUMN status ENUM('draft','pending_approval','scheduled','queued','running','paused','completed','cancelled','failed')
       NOT NULL DEFAULT 'draft'`
    );
    console.log('Updated campaigns.status enum (pending_approval)');
  } catch (err) {
    console.warn('campaigns.status enum update skipped:', err.message);
  }

  // Campaign create-wizard metadata (description, type, tags, priority, notes)
  const campaignMetaAlters = [
    `ALTER TABLE campaigns ADD COLUMN description TEXT NULL AFTER name`,
    `ALTER TABLE campaigns ADD COLUMN campaign_type ENUM('marketing','utility') NOT NULL DEFAULT 'marketing' AFTER description`,
    `ALTER TABLE campaigns ADD COLUMN tags JSON NULL AFTER campaign_type`,
    `ALTER TABLE campaigns ADD COLUMN priority ENUM('low','normal','high') NOT NULL DEFAULT 'normal' AFTER tags`,
    `ALTER TABLE campaigns ADD COLUMN notes TEXT NULL AFTER priority`,
  ];
  for (const sql of campaignMetaAlters) {
    try {
      await root.query(sql);
      console.log(`Applied: ${sql.slice(0, 72)}…`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') console.warn('campaign meta alter skipped:', err.message);
    }
  }

  // Allow incomplete drafts (name-only) until WhatsApp number + template are chosen
  try {
    await root.query(`ALTER TABLE campaigns MODIFY whatsapp_account_id INT UNSIGNED NULL`);
    await root.query(`ALTER TABLE campaigns MODIFY template_id INT UNSIGNED NULL`);
    console.log('Campaigns WhatsApp/template columns are nullable for drafts');
  } catch (err) {
    console.warn('campaigns nullable FKs skipped:', err.message);
  }

  // Contact group sharing: status, access_mode, user-access table
  // NOTE: contact_group_members remains contact↔group; contact_group_access is user sharing.
  try {
    await root.query(
      `ALTER TABLE contact_groups
       ADD COLUMN status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE' AFTER description`
    );
    console.log('Added contact_groups.status');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn('contact_groups.status skipped:', err.message);
  }

  try {
    await root.query(
      `ALTER TABLE contact_groups
       ADD COLUMN access_mode ENUM('PRIVATE','SHARED') NOT NULL DEFAULT 'PRIVATE' AFTER status`
    );
    console.log('Added contact_groups.access_mode');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') console.warn('contact_groups.access_mode skipped:', err.message);
  }

  try {
    await root.query(`
      CREATE TABLE IF NOT EXISTS contact_group_access (
        group_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id),
        INDEX idx_cga_user (user_id),
        INDEX idx_cga_group (group_id),
        FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('Ensured contact_group_access table');
  } catch (err) {
    console.warn('contact_group_access skipped:', err.message);
  }

  const contactAccessIndexes = [
    `ALTER TABLE contacts ADD INDEX idx_contacts_created_by (created_by)`,
    `ALTER TABLE contact_groups ADD INDEX idx_contact_groups_created_by (created_by)`,
    `ALTER TABLE contact_groups ADD INDEX idx_contact_groups_status (status)`,
    `ALTER TABLE contact_groups ADD INDEX idx_contact_groups_access_mode (access_mode)`,
    `ALTER TABLE contact_group_members ADD INDEX idx_cgm_contact (contact_id)`,
  ];
  for (const sql of contactAccessIndexes) {
    try {
      await root.query(sql);
      console.log(`Applied: ${sql}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_KEYNAME') console.warn('contact access index skipped:', err.message);
    }
  }

  // First signup must remain active admin (role/status immutable by policy)
  try {
    // Remove automated probe/test accounts so the first real signup stays primary admin
    await root.query(
      `DELETE FROM refresh_tokens WHERE user_id IN (
         SELECT id FROM (
           SELECT id FROM users
           WHERE email LIKE 'probe-%@example.com'
              OR email LIKE 'test-diag-%@example.com'
              OR email = 'admin@example.com'
         ) t
       )`
    );
    await root.query(
      `DELETE FROM wallets WHERE user_id IN (
         SELECT id FROM (
           SELECT id FROM users
           WHERE email LIKE 'probe-%@example.com'
              OR email LIKE 'test-diag-%@example.com'
              OR email = 'admin@example.com'
         ) t
       )`
    );
    await root.query(
      `DELETE FROM users
       WHERE email LIKE 'probe-%@example.com'
          OR email LIKE 'test-diag-%@example.com'
          OR email = 'admin@example.com'`
    );
  } catch (err) {
    console.warn('probe account cleanup skipped:', err.message);
  }

  const reportIndexes = [
    `ALTER TABLE campaigns ADD INDEX idx_campaigns_created_by (created_by)`,
    `ALTER TABLE campaigns ADD INDEX idx_campaigns_created_at (created_at)`,
    `ALTER TABLE campaigns ADD INDEX idx_campaigns_whatsapp (whatsapp_account_id)`,
    `ALTER TABLE campaign_messages ADD INDEX idx_cm_status_created (status, created_at)`,
    `ALTER TABLE campaign_messages ADD INDEX idx_cm_failed_at (failed_at)`,
    `ALTER TABLE campaign_messages ADD INDEX idx_cm_campaign_created (campaign_id, created_at)`,
  ];
  for (const sql of reportIndexes) {
    try {
      await root.query(sql);
    } catch (err) {
      if (err.code !== 'ER_DUP_KEYNAME') console.warn('report index skipped:', err.message);
    }
  }

  try {
    const [firstUsers] = await root.query(
      `SELECT id, email, role, is_active FROM users ORDER BY id ASC LIMIT 1`
    );
    if (firstUsers.length) {
      const first = firstUsers[0];
      if (first.role !== 'admin' || !first.is_active) {
        await root.query(
          `UPDATE users SET role = 'admin', is_active = 1 WHERE id = ?`,
          [first.id]
        );
        console.log(`Restored primary admin privileges for user #${first.id} (${first.email})`);
      }
    }
  } catch (err) {
    console.warn('Primary admin integrity check skipped:', err.message);
  }

  await root.end();
  console.log('Migration completed successfully.');
}

export async function runMigrations() {
  await migrate();
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  migrate().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}
