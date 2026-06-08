require('./env');

// Database configuration lives here. Each client deployment should set its
// own DATABASE_URL in .env, while the SQL helper API stays unchanged.
const { Pool: PgPool } = require('pg');
const { Pool: NeonPool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const { measurePerfOperation } = require('../src/performance');

let pool = null;

neonConfig.webSocketConstructor = ws;

function isServerlessRuntime() {
  return Boolean(
    process.env.VERCEL
    || process.env.AWS_LAMBDA_FUNCTION_NAME
    || process.env.NETLIFY
  );
}

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || '').trim();

  if (!value || !value.startsWith('postgresql://')) {
    console.error('DATABASE_URL missing or invalid');
    return null;
  }

  const url = new URL(value);
  if (!url.searchParams.has('sslmode')) {
    url.searchParams.set('sslmode', 'require');
  }

  return url.toString();
}

function getPool() {
  if (!pool) {
    const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);

    if (!connectionString) {
      throw new Error('DATABASE_URL not set properly');
    }

    const hostname = new URL(connectionString).hostname;
    const PoolImpl = hostname.includes('.neon.tech') ? NeonPool : PgPool;

    pool = new PoolImpl({
      connectionString,
      max: isServerlessRuntime() ? 1 : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
  }

  return pool;
}

function translatePlaceholders(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

function normalizeResult(result) {
  return {
    rows: result.rows || [],
    rowCount: Number(result.rowCount || 0),
  };
}

async function query(executor, sql, params = []) {
  const translatedSql = translatePlaceholders(sql);
  const sqlLabel = String(sql || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const result = await measurePerfOperation(
    'sql',
    sqlLabel,
    () => executor.query(translatedSql, params),
    { rows: Array.isArray(params) ? params.length : 0 }
  );
  return normalizeResult(result);
}

function inferInsertId(result) {
  const row = result.rows && result.rows[0];
  if (!row || typeof row !== 'object') return null;

  if (row.id !== undefined && row.id !== null) {
    return row.id;
  }

  const firstKey = Object.keys(row)[0];
  return firstKey ? row[firstKey] : null;
}

function shouldAppendReturning(sql) {
  const trimmed = String(sql || '').trim().toLowerCase().replace(/;$/, '');
  return trimmed.startsWith('insert ') && !/\breturning\b/.test(trimmed);
}

async function run(sql, params = []) {
  let statement = String(sql);
  if (shouldAppendReturning(statement)) {
    statement = `${statement.replace(/;\s*$/, '')} RETURNING id`;
  }

  const result = await query(getPool(), statement, params);
  return {
    changes: result.rowCount,
    rowCount: result.rowCount,
    lastID: inferInsertId(result),
    rows: result.rows,
  };
}

async function get(sql, params = []) {
  const result = await query(getPool(), sql, params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result = await query(getPool(), sql, params);
  return result.rows;
}

function createTransactionHelpers(client) {
  return {
    run: async (sql, params = []) => {
      let statement = String(sql);
      if (shouldAppendReturning(statement)) {
        statement = `${statement.replace(/;\s*$/, '')} RETURNING id`;
      }

      const result = await query(client, statement, params);
      return {
        changes: result.rowCount,
        rowCount: result.rowCount,
        lastID: inferInsertId(result),
        rows: result.rows,
      };
    },
    get: async (sql, params = []) => {
      const result = await query(client, sql, params);
      return result.rows[0] || null;
    },
    all: async (sql, params = []) => {
      const result = await query(client, sql, params);
      return result.rows;
    },
  };
}

async function withTransaction(work) {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const tx = createTransactionHelpers(client);
    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (!pool) return;
  const currentPool = pool;
  pool = null;
  await currentPool.end();
}

const db = {
  close(callback) {
    closePool()
      .then(() => {
        if (typeof callback === 'function') callback();
      })
      .catch((error) => {
        if (typeof callback === 'function') callback(error);
      });
  },
};

module.exports = {
  getPool,
  run,
  get,
  all,
  withTransaction,
  closePool,
  db,
};
