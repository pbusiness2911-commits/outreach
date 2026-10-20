import { createDb, migrate } from './db.js';
import { config } from '../config.js';

const db = await createDb({ url: config.databaseUrl });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await db.close();
