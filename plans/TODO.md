# OSMAmenityOverpassServer — Todo & Status-Tracking

**Stand:** 2026-10-15 ~11:20 (Runde 4: Japan-Pivot, osmium-Findings, Coverage-Baseline)
**Legende:** ✅ erledzt · 🔄 in Arbeit · ⬜ offen · ⛔ blockiert/verschoben
**Referenz-Plan:** [`2026-10-14-osm-amenity-overpass-server.md`](2026-10-14-osm-amenity-overpass-server.md) — Runde 4 (§19) ersetzt das Stage-1/2/3-Design von §6; §19.8 ist die kanonische Reihenfolge der nächsten Schritte.

## 1. Repo-Grundlage (Phase 0)

- ✅ Overpass-Proxy-Repo (v1.5.0) analysiert; Upstream-Vertrag verifiziert (buildTileQuery L18–29, fetchTile, proxyTransparent, withUpstream, shouldMarkFailure, probeUpstream, OverpassResponse) → Plan §17
- ✅ Plan R3 + R3.1 geschrieben; R4 angehängt (2026-10-15: Japan-Pivot, osmium-1.14-Ergebnisse, neues Stage-Design §19)
- ✅ Plan von `agents/plans/` nach `plans/` verschoben (User-Entscheidung 2026-10-15)
- ✅ Repo-Scaffold: `package.json` (vitest **4.0.16 exakt gepinnt** — §18.6), `tsconfig.json`, `vitest.config.ts` (Coverage-Gates 0.9/0.85/0.9/0.9), `eslint.config.js`, `.gitignore`, `LICENSE` (wie Overpass-Proxy), `Dockerfile` (node:20-alpine, 2-Stage), `docker-compose.yml.template`
- ✅ `src/` komplett: logger, config, query, output, index/{geohash,shard (OAM1),engine,apply}, replication, stats, server, index
- ✅ `scripts/extract.mjs` Stage 0 (Block-Split, Dual-PBF-Framing-Scanner, Done-Marker, SIGINT/SIGTERM, Resume, `--verify`)
- ✅ `scripts/make-fixture.mjs` (deterministisches LCG-Fixture + Stage-0-Verify)
- ✅ Tests: 10 Dateien, **80/80 grün**; `npm run verify` (lint + build + test) grün
- ✅ `@vitest/coverage-v8` @4.0.16 als devDependency ergänzt (exakt auf die vitest-Pin; vorher war `test:ci` nicht lauffähig — „MISSING DEPENDENCY“)
- ⬜ **Coverage-Gates einhalten:** `test:ci`-Baseline verfehlt 0.9/0.85/0.9/0.9 mit Stmts 88.66 / Branch 70.1 / Funcs 88.79 / Lines 88.84 — Fehlerzweig-Tests ergänzen (Details Plan §19.11): `config.ts` (readInt/readBool-Errors, redis-Flag), `replication.ts` (state-Edges), `engine.ts` (`emptyResult`, korrupter Shard), `server.ts` (500-Pfad), `shard.ts` (Fehlerzweige), `query.ts`/`output.ts`/`stats.ts` (Rest). Neue `scripts/extract/*`-Module ebenfalls abdecken (keine `coverage.include`-Begrenzung)
- ✅ Docs: `README.md`, `specification.md`, `OSMAmenityOverpassServer-Prompt.md`
- ✅ Fixture-Verify (2026-10-14): 17 PBF-Blöcke → 1 Chunk → osmium-Counts == Fixture-Counts (100k/10k/1k)
- ✅ PBF-Blockformat reverse-engineered (osmium 1.14 New-Framing + Classic-Fallback), verifiziert gegen osmcode-Referenzdateien (§18.5)
- ⬜ **Erster Git-Commit** — `master` hat noch **0 Commits**; erst nach Schritt §19.8.7 (Japan-Volllauf + Verifikation + E2E)
- ⬜ README/Specification nach Stage-1–4-Landing aktualisieren (aktuell: `--planet-source`, Planet-Download-Doku, „stage 0 + stubs“-Hinweise)

## 2. Daten / Quellen

- ✅ osmium-tool 1.14.0 installiert (libosmium 2.18.0; zlib/lz4/none)
- ✅ Planet `planet-latest.osm.bz2` (167 GB) am 2026-10-14 geladen, md5 `b8ae8035c85335bae7186059ab5fbeaf` verifiziert → **am 2026-10-15 gelöscht** (User-Entscheidung: Dev/Test nur Japan; §19.1)
- ✅ Japan-PBF: Geofabrik `japan-latest.osm.pbf` → `japan-261014.osm.pbf` (Dump 2026-10-14, 2.55 GB) → `/ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf`
- ⬜ **Fixture neu generieren** — Dateien auf Disk stammen von älterer Generator-Version (building-Count 8571 vs. 7143 erwartet, §19.7); vor erstem Commit: `npm run make-fixture -- --verify`
- ⛔ Weltweite `amenity`-Zahlen via taginfo — aus Sandbox nicht erreichbar; auf netzwerkfähiger Maschine messen (Japan-Referenz: 1.432.136 Objekte, alle Values)

## 3. Pipeline Stages 0–4 (Design: Plan §19.3/§19.4)

- ✅ **Stage 0** — Block-Split (Byte-Kopie, OSMHeader pro Chunk, atomic tmp+rename, Resume)
- ⬜ **Stage 1** — `osmium cat chunk.pbf -f osm` → OSM-XML (temp) → **pure-Node-Streaming-Filter** → `stage1/amen_cNNNN.lines` + `stage1/ids_cNNNN.lines`. Design abgeschlossen (Plan §19.3/§19.4), Umsetzung noch nicht gestartet. *(tags-filter wegen §19.2-Bug NICHT nutzbar — harte Entscheidung, kein Umweg über Lua: `osmium run` existiert nicht in diesem Build)*
- ⬜ **Stage 2** — globale Way-IDs (`W`-Zeilen) → `osmium getid --default-type way` pro Chunk → `stage2/ways_cNNNN.xml` → Parse → Way-Lines + nd-Refs in Node-ID-Menge mergen
- ⬜ **Stage 3** — globale Node-IDs → `osmium getid --default-type node` pro Chunk → `stage3/nodes_cNNNN.xml` (id → lat/lon)
- ⬜ **Stage 4** — pure Node: Line-Files + Node-Map → Zellen-Assign (§19.5 Vertrag) → `stage4/cells/<geohash>.rec` (u32le-Länge + Record) → pro Zelle `writeShard()` aus `dist/index/shard.js` (Auto-`npm run build` falls `dist/` fehlt) → `data/shards/*.bin` atomar + `manifest.json` + `state.json` (`lastSeq: 0`, `dataTimestamp` = Source-Mtime)
- ⬜ vitest-Tests: XML-Stream-Filter, Line-Format-Parser (Roundtrip, encodierte Tags, leere Rolle, 0 Tags, fehlendes timestamp), Stage-4-Assembly (Zellen-Zuordnung, Way/Relation-Duplizierung, Member-Platzierung, Dedupe, manifest/state) — Coverage-Gates einhalten
- ⬜ **Japan-Volllauf:** `node scripts/extract.mjs --source /ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf --data-dir /home/osm-amenity/japan --stages 0-4 --chunk-mb 256 --all-amenity-values true`
- ⬜ Verifikation: unabhängige osmium-Zählung (show-based, ANSI-strip) vs. `manifest.json`-Counts; Tokyo-Stichprobe (z. B. 35.681/139.767)
- ⬜ Abbruch/Resume-Test auf Japan (SIGINT in Stage 0/1, Weiterlauf)
- ⛔ **Planet-Produktionslauf** — vom User verschoben (2026-10-15); Maschine mit ≥ 200 GB frei nötig (§19.6); Pipeline ist Source-agnostisch, kein Japan-Code-Pfad

## 4. Server & Endpoints (Code fertig, E2E outstanding)

- ✅ Fastify: `POST/GET /api/interpreter` (501 `out of scope`, 400 `missing query in form field "data"`), `GET /api/status` (konformes Overpass-Block + `localEngine`), `GET /api/timestamp`, `POST /api/kill_my_queries` (200 no-op), HEAD auf Basis-URL → 2xx
- ✅ Engine: LRU-Byte-Cache (256 MB Default), BBox-Filter, Dedupe by id, JSON/XML-Renderer, ETag
- ⬜ E2E mit echten Japan-Daten (JSON, XML, `>;`-Rekursion, Out-of-Scope → 501, `/api/status`-Sinnhaftigkeit) → §19.8.6
- ⬜ Proxy-E2E: unveränderter Overpass-Proxy v1.5.0, `UPSTREAM_URLS: http://amenity-server:8081/api/interpreter, <remote>` → Tile-Query, 501-Failover, Recovery-Probe (§17; braucht Proxy-Checkout + Netzwerk)

## 5. Update-Pipeline (Phase 2)

- ✅ Bausteine + Tests: `replication.ts` (state.txt-Parse, Minute-URL-Build, Catch-up-Liste), `apply.ts` (`shouldApply` Version-Guard, `upsertElement`/`deleteElement`, `affectedCells`)
- ⬜ Self-Update-Loop im Server: Timer (`OSM_AMENITY_UPDATE_INTERVAL_SECONDS`, Default 3600) → `minute/state.txt` → alle Diffs `(lastSeq, currentSeq]` laden → osmchange streamend parsen → Filter (konfigurierte Values + gespeicherte Elemente) → Version-Guard → Shards atomar neu schreiben → LRU invalidieren → `state.json` persistieren
- ⬜ **Persistenter Shard-Rewrite** (aktuell nur In-Memory-Helfer in apply.ts) — inkl. Node-Ref-Index-Update + `buildSequence`-Bump
- ⬜ Re-Extract-Job: `OSM_AMENITY_REEXTRACT_EVERY_SECONDS` (Default 604800) steht in Config, Job-Logik fehlt (Stage 0–4 + Parity-Check + atomarer `data/`-Swap)
- ⬜ E2E: echte Planet-Minuten-Diffs gegen Japan-Index anwenden (Region = natürlicher Filter) **oder** synthetischer osmchange am Fixture
- ⬜ Optional: `OSM_AMENITY_REDIS_URL` → Tile-Key-Invalidierung im Proxy-Redis nach jedem Batch

## 6. Betrieb / Messung (Phase 4)

- ⬜ TTL-Messphase (§9): Latenz p50/p95, Shard-Cache-Hit-Rate, Batch-Zeiten sammeln; danach datengetrieben 24 h → 6 h → 1 h → 15 min (mind. 24 h Probstufe)
- ⬜ Parity vs. Live-Overpass (`scripts/parity.mjs` fehlt noch — nur Package-Skript-Stub) — **nur auf netzwerkfähiger Maschine** (Sandbox: 406/Timeout)
- ⬜ Performance-Benchmark: Shard-Load, Query p50/p95, Update-Batch mit echter Hour-Datei
- ⬜ docker-compose Full-Stack (`proxy` + `redis` + `amenity-server`) mit Japan-Data testen

## 7. Langfrist-Ziele (jenseits von Japan)

1. Planet-Index über dieselbe Pipeline (`--source planet-latest.osm.pbf`) — s. §19.1/§19.6
2. Selbstaktualisierender Server: Minute-Catch-up, Freshness ≤ 1 h, kanonischer Cursor = Minute-Sequenz → `/api/status.osm_osm_change` (§18.2)
3. amenity-server als bevorzugter Proxy-Upstream (EWMA-Latenz); Remote-Pool bleibt Fallback
4. Cache-TTL datengetrieben optimiert (nach Messphase)
5. Optionale Erweiterungen: weitere Keys (nur Stage 1–4 nötig), Redis-Invalidierung, hour/day-Diff-Catch-up, Relation→Relation-Auflösung (§19.5)
