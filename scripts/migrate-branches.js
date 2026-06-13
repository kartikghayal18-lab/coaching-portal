const fs = require('fs');
const path = require('path');
require('../config/env');

const { getPool, closePool } = require('../config/database');

async function migrateBranches() {
  const migrationPath = path.join(__dirname, '..', 'migrations', '007_multi_branch_tenancy.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  const client = await getPool().connect();

  try {
    await client.query(`SELECT set_config('app.is_super_admin', 'true', false)`);
    await client.query(migrationSql);
    console.log('Applied migration 007_multi_branch_tenancy.sql');
  } finally {
    try {
      await client.query('RESET app.branch_id; RESET app.is_super_admin;');
    } finally {
      client.release();
    }
  }
}

migrateBranches()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
