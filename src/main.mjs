// Starts the web app.
import { loadConfig } from './config.mjs';
import { run } from './exec.mjs';
import { createGithub } from './github.mjs';
import { createProjects } from './projects.mjs';
import { createServer } from './server.mjs';
import { createStore } from './store.mjs';

const config = loadConfig();
const store = createStore(config.dataDir);
const github = createGithub({ run, ghPath: config.ghPath });
const projects = createProjects({ store, github });
const server = createServer({ projects, store, allowedHosts: config.allowedHosts });

server.listen(config.port, config.host, () => {
  console.log(`Nightshift is listening on http://${config.host}:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
