const { AsyncLocalStorage } = require('async_hooks');

const branchContext = new AsyncLocalStorage();

function runWithBranchContext(scope, callback) {
  return branchContext.run({
    branchId: Number.isInteger(Number(scope?.branchId)) ? Number(scope.branchId) : null,
    isSuperAdmin: Boolean(scope?.isSuperAdmin),
  }, callback);
}

function getBranchContext() {
  return branchContext.getStore() || {
    branchId: null,
    isSuperAdmin: true,
  };
}

module.exports = {
  getBranchContext,
  runWithBranchContext,
};
