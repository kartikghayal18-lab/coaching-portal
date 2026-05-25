require('../config/env');

// Main runtime now lives in routes/app-routes.js so client copies can keep
// server boot, shared services, and deployment config separated by concern.
require('../routes/app-routes');
