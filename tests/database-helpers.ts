import { IndexDatabase } from '../src/index/database.js';
export function databaseElements(root: string) {
    const index = new IndexDatabase(root, { readOnly: true });
    try {
        return index.db.prepare('SELECT key FROM geometry ORDER BY key').all().map(row => index.getGeometry(String(row.key))!);
    }
    finally {
        index.close();
    }
}
