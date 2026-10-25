import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import { buildConfigHash, type ShardElement } from './shard.js';
import type { BoundingBox } from './geohash.js';
export const DATABASE_FORMAT = 'OAM-SQLITE-1';
export const DATABASE_FILE = 'index.sqlite';
export const objectKey = (object: {
    type: string;
    id: number;
}): string => `${object.type}:${object.id}`;
export interface RawObject {
    type: 'node' | 'way' | 'relation';
    id: number;
    version: number;
    timestamp?: number;
    changeset?: number;
    lat?: number;
    lon?: number;
    tags?: Record<string, string>;
    nodeIds?: number[];
    members?: {
        type: string;
        ref: number;
        role: string;
    }[];
    deleted?: boolean;
}
const encode = (element: ShardElement): string => JSON.stringify({ ...element, memberCoords: [...element.memberCoords] });
const decode = (payload: string): ShardElement => {
    const value = JSON.parse(payload);
    value.memberCoords = new Map(value.memberCoords);
    return value as ShardElement;
};
/** One local database per baseline. Diffs commit in place; rebuilds use a new directory. */
export class IndexDatabase {
    public readonly db: DatabaseSync;
    private statements = new Map<string, StatementSync>();
    public constructor(root: string, { create = false, readOnly = false, cacheMb = 64 } = {}) {
        this.db = new DatabaseSync(path.join(root, DATABASE_FILE), { readOnly });
        try {
            this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA cache_size=-${Math.max(1024, Math.floor(cacheMb * 1024))}; PRAGMA temp_store=FILE;`);
            if (create) {
                const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get();
                if (existing && (this.getMetadata('format') !== DATABASE_FORMAT || this.db.prepare('PRAGMA user_version').get()?.user_version !== 1)) {
                    throw new Error('unsupported index database format; perform a fresh import');
                }
                this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
                this.db.exec(`
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS raw_objects(key TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS baseline_versions(key TEXT PRIMARY KEY, version INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS geometry(row_id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, is_main INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS spatial USING rtree(row_id, south, north, west, east);
          CREATE TABLE IF NOT EXISTS dependencies(main_key TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(main_key, object_key)) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS dependency_object ON dependencies(object_key, main_key);
          CREATE TABLE IF NOT EXISTS helpers(main_key TEXT NOT NULL, helper_key TEXT NOT NULL, PRIMARY KEY(main_key, helper_key)) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS helper_object ON helpers(helper_key);
          CREATE TABLE IF NOT EXISTS counters(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
          INSERT OR IGNORE INTO counters VALUES('main',0),('geometry',0);
          CREATE TRIGGER IF NOT EXISTS geometry_insert AFTER INSERT ON geometry BEGIN
            UPDATE counters SET value=value+1 WHERE key='geometry';
            UPDATE counters SET value=value+new.is_main WHERE key='main';
          END;
          CREATE TRIGGER IF NOT EXISTS geometry_delete AFTER DELETE ON geometry BEGIN
            DELETE FROM spatial WHERE row_id=old.row_id;
            UPDATE counters SET value=value-1 WHERE key='geometry';
            UPDATE counters SET value=value-old.is_main WHERE key='main';
          END;
          CREATE TRIGGER IF NOT EXISTS geometry_main AFTER UPDATE OF is_main ON geometry BEGIN
            UPDATE counters SET value=value+new.is_main-old.is_main WHERE key='main';
          END;
          PRAGMA user_version=1;
        `);
                this.setMetadata('format', DATABASE_FORMAT);
                this.db.exec('COMMIT');
            }
            if (this.getMetadata('format') !== DATABASE_FORMAT || this.db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
                throw new Error('unsupported index database format; perform a fresh import');
            }
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    public statement(sql: string): StatementSync {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.db.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }
    public getMetadata<T = unknown>(key: string): T | undefined {
        const row = this.statement('SELECT value FROM metadata WHERE key=?').get(key);
        return row ? JSON.parse(String(row.value)) as T : undefined;
    }
    public setMetadata(key: string, value: unknown): void {
        this.statement('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    }
    public getRaw(key: string): RawObject | null {
        const row = this.statement('SELECT payload FROM raw_objects WHERE key=?').get(key);
        return row ? JSON.parse(String(row.payload)) as RawObject : null;
    }
    public putRaw(object: RawObject): boolean {
        return Number(this.statement(`INSERT INTO raw_objects VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version,payload=excluded.payload
      WHERE excluded.version>raw_objects.version`).run(objectKey(object), object.version, JSON.stringify(object)).changes) > 0;
    }
    public getGeometry(key: string): ShardElement | null {
        const row = this.statement('SELECT payload FROM geometry WHERE key=?').get(key);
        return row ? decode(String(row.payload)) : null;
    }
    public isMain(key: string): boolean {
        return this.statement('SELECT 1 FROM geometry WHERE key=? AND is_main=1').get(key) !== undefined;
    }
    public affectedMains(key: string): string[] {
        return this.statement('SELECT main_key FROM dependencies WHERE object_key=?').all(key).map((row) => String(row.main_key));
    }
    public putGeometry(element: ShardElement, main = false): void {
        const key = objectKey(element);
        // A helper can also be a main amenity; never demote it or overwrite its complete main bounds.
        this.statement(`INSERT INTO geometry(key,is_main,payload) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET
      payload=CASE WHEN excluded.is_main=1 OR geometry.is_main=0 THEN excluded.payload ELSE geometry.payload END,
      is_main=max(geometry.is_main,excluded.is_main)`).run(key, main ? 1 : 0, encode(element));
        if (main) {
            const row = this.statement('SELECT row_id FROM geometry WHERE key=?').get(key)!;
            const [s, w, n, e] = element.bbox;
            if (![s, w, n, e].every(Number.isFinite) || s > n || w > e)
                throw new Error(`invalid geometry bounds: ${key}`);
            this.statement('INSERT OR REPLACE INTO spatial VALUES(?,?,?,?,?)').run(Number(row.row_id), s, n, w, e);
        }
    }
    public clearMain(key: string): string[] {
        const oldHelpers = this.statement('SELECT helper_key FROM helpers WHERE main_key=?').all(key).map((row) => String(row.helper_key));
        this.statement('DELETE FROM dependencies WHERE main_key=?').run(key);
        this.statement('DELETE FROM helpers WHERE main_key=?').run(key);
        this.statement('DELETE FROM spatial WHERE row_id=(SELECT row_id FROM geometry WHERE key=?)').run(key);
        this.statement('UPDATE geometry SET is_main=0 WHERE key=?').run(key);
        return [key, ...oldHelpers];
    }
    public setMain(element: ShardElement, helpers: ShardElement[], dependencies: Iterable<string>): string[] {
        const key = objectKey(element);
        const obsolete = this.clearMain(key);
        for (const helper of helpers) {
            if (objectKey(helper) === key)
                continue;
            this.putGeometry(helper);
            this.statement('INSERT OR IGNORE INTO helpers VALUES(?,?)').run(key, objectKey(helper));
        }
        this.putGeometry(element, true);
        for (const dependency of dependencies)
            this.statement('INSERT OR IGNORE INTO dependencies VALUES(?,?)').run(key, dependency);
        this.statement('INSERT OR IGNORE INTO dependencies VALUES(?,?)').run(key, key);
        return obsolete;
    }
    public pruneGeometry(keys: Iterable<string>): void {
        for (const key of keys)
            this.statement(`DELETE FROM geometry WHERE key=? AND is_main=0 AND NOT EXISTS(SELECT 1 FROM helpers WHERE helper_key=geometry.key)`).run(key);
    }
    public query(bbox: BoundingBox, amenity: string): ShardElement[] {
        return this.statement(`SELECT g.payload FROM spatial s JOIN geometry g USING(row_id)
      WHERE s.south<=? AND s.north>=? AND s.west<=? AND s.east>=?
      AND json_extract(g.payload,'$.tags.amenity')=?`).all(bbox.north, bbox.south, bbox.east, bbox.west, amenity).map((row) => decode(String(row.payload)));
    }
    public related(key: string): ShardElement[] {
        return this.statement('SELECT g.payload FROM helpers h JOIN geometry g ON g.key=h.helper_key WHERE h.main_key=?').all(key).map((row) => decode(String(row.payload)));
    }
    public counts(): {
        mainUnique: number;
        supportObjects: number;
        duplicatedRecords: number;
        shardRecords: number;
    } {
        const main = Number(this.statement("SELECT value FROM counters WHERE key='main'").get()!.value);
        const total = Number(this.statement("SELECT value FROM counters WHERE key='geometry'").get()!.value);
        return { mainUnique: main, supportObjects: total - main, duplicatedRecords: 0, shardRecords: total };
    }
    public validate(): void {
        const manifest = this.getMetadata<{
            format: string;
            amenities: string[];
            shardPrecision: number;
            configHash: string;
        }>('manifest');
        if (manifest && (manifest.format !== DATABASE_FORMAT || manifest.configHash !== buildConfigHash({ amenities: manifest.amenities, precision: manifest.shardPrecision }).toString('hex')))
            throw new Error('database manifest config hash mismatch');
        const result = this.db.prepare('PRAGMA quick_check').get();
        if (result?.quick_check !== 'ok')
            throw new Error(`index database check failed: ${JSON.stringify(result)}`);
        if (this.db.prepare(`SELECT 1 FROM helpers h LEFT JOIN geometry g ON g.key=h.helper_key WHERE g.key IS NULL LIMIT 1`).get())
            throw new Error('missing helper geometry');
        if (Number(this.db.prepare('SELECT count(*) AS n FROM spatial').get()!.n) !== this.counts().mainUnique)
            throw new Error('spatial index count mismatch');
    }
    public close(): void { this.statements.clear(); this.db.close(); }
}
