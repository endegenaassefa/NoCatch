'use strict';
const { readConfig, createAuthenticator } = require('./auth');
const { createProvider } = require('./providers');
const { createManagedServer } = require('./app');
async function main() {
  const config = readConfig();
  const authenticate = await createAuthenticator(config);
  const app = createManagedServer({ config, authenticate, provider: createProvider(config) });
  app.server.listen(config.port, config.host, () => console.log(`Managed AI listening on port ${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
  return app;
}
if (require.main === module) main().catch(error => { console.error(`Managed service could not start: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
