require('../config/env');

const { all, get, closePool } = require('../config/database');
const { runWithBranchContext } = require('../src/branch-context');

const ISOLATED_TABLES = [
  'users',
  'batches',
  'attendance',
  'fees',
  'test_papers',
  'batch_notes',
  'answer_upload_requests',
  'notification_logs',
  'whatsapp_logs',
  'whatsapp_settings',
  'whatsapp_parent_sessions',
  'student_fee_structure',
];

async function verifyBranch(branch, otherBranch) {
  return runWithBranchContext({ branchId: branch.id, isSuperAdmin: false }, async () => {
    const visibleBranch = await get(`SELECT id, name FROM branches WHERE id = ?`, [branch.id]);
    const hiddenBranch = await get(`SELECT id FROM branches WHERE id = ?`, [otherBranch.id]);
    if (!visibleBranch || hiddenBranch) {
      throw new Error(`Branch table isolation failed for ${branch.name}`);
    }

    for (const tableName of ISOLATED_TABLES) {
      const leaked = await get(
        `SELECT COUNT(*) AS total FROM ${tableName} WHERE branch_id <> ?`,
        [branch.id]
      );
      if (Number(leaked?.total || 0) !== 0) {
        throw new Error(`${tableName} leaked cross-branch rows for ${branch.name}`);
      }
    }

    const counts = {};
    for (const tableName of ISOLATED_TABLES) {
      const row = await get(`SELECT COUNT(*) AS total FROM ${tableName}`, []);
      counts[tableName] = Number(row?.total || 0);
    }
    return counts;
  });
}

async function main() {
  const branches = await runWithBranchContext({ isSuperAdmin: true }, () => all(
    `SELECT b.id, b.code, b.name
     FROM branches b
     JOIN coaching_classes cc ON cc.id = b.coaching_id
     WHERE cc.slug = 'scc' AND b.code IN ('satpur', 'meri')
     ORDER BY b.code`
  ));

  if (branches.length !== 2) {
    throw new Error('Expected both SCC branches. Run npm run migrate:branches and npm run seed:branches first.');
  }

  for (const branch of branches) {
    const otherBranch = branches.find((candidate) => candidate.id !== branch.id);
    const counts = await verifyBranch(branch, otherBranch);
    console.log(`${branch.name}: isolation passed`, counts);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
