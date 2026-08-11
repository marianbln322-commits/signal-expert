import { config } from "../app/config.mjs";
import { Database } from "../app/database.mjs";
const database = new Database(config.databasePath, config.migrationDirectory);
console.log(`SQLite migrations applied: ${config.databasePath}`);
database.close();
