const { app, prepareApp } = require('../src/app');

let readyPromise = null;

module.exports = async (req, res) => {
  if (!readyPromise) {
    readyPromise = prepareApp().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }

  await readyPromise;
  return app(req, res);
};
