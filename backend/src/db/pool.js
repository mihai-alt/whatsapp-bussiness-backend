import mysql from 'mysql2/promise';
import { config } from '../config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 20,
  namedPlaceholders: true,
  timezone: 'Z',
  ...(config.db.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
});

export async function query(sql, params = {}) {
  // mysql2 execute() does not reliably bind LIMIT/OFFSET placeholders.
  // Inline validated integers for those clauses when present.
  let finalSql = sql;
  const finalParams = { ...params };
  if (Object.prototype.hasOwnProperty.call(finalParams, 'limit')) {
    const limit = Math.max(0, Number(finalParams.limit) || 0);
    finalSql = finalSql.replace(/:limit\b/g, String(limit));
    delete finalParams.limit;
  }
  if (Object.prototype.hasOwnProperty.call(finalParams, 'offset')) {
    const offset = Math.max(0, Number(finalParams.offset) || 0);
    finalSql = finalSql.replace(/:offset\b/g, String(offset));
    delete finalParams.offset;
  }
  const [rows] = await pool.execute(finalSql, finalParams);
  return rows;
}

export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
