import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { query } from './pool.js';

async function seed() {
  const users = await query('SELECT COUNT(*) AS c FROM users');
  if (users[0].c === 0) {
    const hash = await bcrypt.hash('Admin@12345', 12);
    await query(
      `INSERT INTO users (email, password_hash, name, role, email_verified, email_verified_at)
       VALUES (:email, :password_hash, :name, 'admin', 1, NOW())`,
      { email: 'admin@example.com', password_hash: hash, name: 'Admin' }
    );
    console.log('Seeded admin user: admin@example.com / Admin@12345');
  }

  const wallets = await query('SELECT COUNT(*) AS c FROM wallets WHERE user_id IS NULL');
  if (wallets[0].c === 0) {
    const any = await query('SELECT id FROM wallets ORDER BY id ASC LIMIT 1');
    if (any.length) {
      await query(`UPDATE wallets SET user_id = NULL WHERE id = :id`, { id: any[0].id });
      console.log('Marked existing wallet as shared business wallet');
    } else {
      await query(`INSERT INTO wallets (user_id, balance, currency) VALUES (NULL, 1000.0000, 'INR')`);
      console.log('Seeded shared business wallet with balance 1000 INR');
    }
  }

  const pricing = await query('SELECT COUNT(*) AS c FROM message_pricing');
  if (pricing[0].c === 0) {
    await query(
      `INSERT INTO message_pricing (category, cost) VALUES
       ('MARKETING', :cost),
       ('UTILITY', :cost),
       ('AUTHENTICATION', :cost),
       ('DEFAULT', :cost)`,
      { cost: config.defaultMessageCost }
    );
    console.log('Seeded message pricing');
  }

  console.log('Seed completed.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
