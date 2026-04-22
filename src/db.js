const { Pool: PgPool } = require('pg');
const { Pool: NeonPool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
require('dotenv').config({ quiet: true });

let pool = null;

neonConfig.webSocketConstructor = ws;

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || '').trim();

  // basic validation
  if (!value || !value.startsWith('postgresql://')) {
    console.error("❌ DATABASE_URL missing or invalid");
    return null;
  }

  const url = new URL(value);

  // ensure ssl
  if (!url.searchParams.has('sslmode')) {
    url.searchParams.set('sslmode', 'require');
  }

  return url.toString();
}

function getPool() {
  if (!pool) {
    const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);

    if (!connectionString) {
      throw new Error("DATABASE_URL not set properly");
    }

    const hostname = new URL(connectionString).hostname;
    const PoolImpl = hostname.includes('.neon.tech') ? NeonPool : PgPool;

    pool = new PoolImpl({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
  }

  return pool;
}

module.exports = { getPool };