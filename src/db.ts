import { Database } from "bun:sqlite";

const db = new Database("data/koreader-sync.db", {
  create: true,
});

// Initialize tables
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    document TEXT NOT NULL,
    progress TEXT NOT NULL,
    percentage REAL NOT NULL,
    device TEXT NOT NULL,
    device_id TEXT NOT NULL,
    filename TEXT,
    title TEXT,
    authors TEXT,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, document)
  )
`);

// Migrate existing databases to include metadata columns
const progressColumns = db
  .prepare(`PRAGMA table_info(progress)`)
  .all() as { name: string }[];
const existingColumnNames = new Set(progressColumns.map((c) => c.name));
for (const column of ["filename", "title", "authors"]) {
  if (!existingColumnNames.has(column)) {
    db.run(`ALTER TABLE progress ADD COLUMN ${column} TEXT`);
  }
}

// Create indexes for better performance
db.run(
  `CREATE INDEX IF NOT EXISTS idx_progress_document ON progress(document)`
);
db.run(`CREATE INDEX IF NOT EXISTS idx_progress_user_id ON progress(user_id)`);

export { db };
