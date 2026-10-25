import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase, DATABASE_FILE, DATABASE_FORMAT } from '../../dist/index/database.js';
export async function hasDatabase(root) {
    return fs.access(path.join(root, DATABASE_FILE)).then(() => true, (error) => { if (error.code === 'ENOENT')
        return false; throw error; });
}
/** Database metadata is authoritative; JSON sidecars exist only for diagnostics. */
export async function readMetadata(root) {
    if (await hasDatabase(root)) {
        const index = new IndexDatabase(root, { readOnly: true });
        try {
            index.db.exec('BEGIN');
            const result = { manifest: index.getMetadata('manifest'), state: index.getMetadata('state') };
            index.db.exec('COMMIT');
            return result;
        }
        finally {
            index.close();
        }
    }
    return {
        manifest: await fs.readFile(path.join(root, 'manifest.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT')
            return null; throw error; }),
        state: JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'))
    };
}
export async function writeState(root, state) {
    if (await hasDatabase(root)) {
        const index = new IndexDatabase(root);
        try {
            index.setMetadata('state', state);
        }
        finally {
            index.close();
        }
    }
    await fs.writeFile(path.join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}
export async function writeSidecars(root, manifest, state) {
    // Sidecars must never govern cursor checks or serving in the database path.
    for (const [name, value] of [['manifest', manifest], ['state', state]]) {
        const tmp = path.join(root, `${name}.json.tmp-${process.pid}`);
        await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
        await fs.rename(tmp, path.join(root, `${name}.json`));
    }
}
export { DATABASE_FORMAT };
