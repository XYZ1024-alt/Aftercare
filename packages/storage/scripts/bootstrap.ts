import { bootstrapLocalCluster } from '../src/admin/index.ts';
import { readDatabaseEndpoint } from '../src/index.ts';

await bootstrapLocalCluster(process.env);
const { host, port, databases } = readDatabaseEndpoint(process.env);
console.log(
  `bootstrapped roles and databases on ${host}:${port} (development: ${databases.development}, test: ${databases.test})`,
);
