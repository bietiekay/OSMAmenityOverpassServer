# OSMAmenityOverpassServer — eigenständige Overpass-Datenquelle (Plan, Runde 4)

- **Datum:** 2026-10-14 (R4-Nachtrag 2026-10-15)
- **Status:** Plan Runde 4: Japan als Dev/Test-Ziel, osmium-1.14-Ergebnisse, Stages 1–4 revidiert (§19); Defaults bestätigt
- **Soll-Ort im Repo:** `plans/2026-10-14-osm-amenity-overpass-server.md` im **neuen** Repo `OSMAmenityOverpassServer` (2026-10-15 von `agents/plans/` nach `plans/` verschoben — User-Entscheidung; dazugehörig: `plans/TODO.md`, das Status-Tracking)
- **Ziel-Repo:** `/home/bietiekay/code/OSMAmenityOverpassServer` (`master`, Stand R4: Scaffold + `src/` + `tests/` + `scripts/` vorhanden, 0 Commits — Details `plans/TODO.md`) — dort entsteht der gesamte Projekt-Rahmen (§16)
- **Kunden-Repo (bleibt unverändert):** `Overpass-Proxy` v1.5.0 (`/home/bietiekay/code/Overpass-Proxy`) — der Proxy nutzt den neuen Server rein konfiguriert als Upstream (§17), null Codeänderungen
- **Vertrag im Kunden-Repo (verifiziert):** `src/upstream.ts` (`fetchTile`, `proxyTransparent`, `withUpstream`, `shouldMarkFailure`, `probeUpstream`), `src/interpreter.ts` (transparente Endpoints), `src/store.ts` (`OverpassResponse`), `src/tests/integration/mock-overpass.ts`

## 0. Entscheidungslog (Feedback → Entscheidung)

| # | Feedback (User) | Entscheidung |
|---|---|---|
| 1 | Region: weltweit, datenoptimiert, nur vorkonfigurierte Amenities | Planet-Extraktion; der **gelegte Endindex enthält nur konfigurierte Werte** (§5). Alle `amenity=*`-Objekte bleiben als Zwischenstufe auf Disk, um Re-Index zu ermöglichen (§6.5) |
| 2 | Erst `toilets`, konfigurierbar; neue Amenities aus Rohdaten neu erzeugbar; vollständiger Re-Index erlaubt | `OSM_AMENITY_AMENITIES` (default `toilets`). Re-Index-Pfade: neuer **Value** → nur Stage 3 (Minuten); neuer **Key** → Stage 1–3; voller Re-Extract wöchentlich als Drift-Guard (§6.5) |
| 3 | Planet-Minuten-Diffs; keine Minuten-Updates nötig; Vorschlag: möglichst live + wenig wiederkehrende Arbeit | **Catch-up-Modell**, Granularität = Intervall. Default **hourly** (24 Jobs/Tag, Freshness ≤ 1 h); `minute` als Config-Option; Update-Aufwand ist index-unabhängig (§7) |
| 4 | Fehlender Changeset akzeptabel; Frage: was ist konkret in den Infos? | Quelle = offizielles OSM-Planet-File → **vollständige Meta vorhanden** (version/timestamp/changeset), Bedenken entfallen. Konkrete Erklärung §4 |
| 5 | Remote upstream als Fallback behalten | Fallback bleibt: Out-of-Scope-Queries antwortet der Server mit 501, der Proxy failt auf die Remote-Instanzen weiter (§17) |
| 6 | Extraktion auf dieser Maschine; iterativ, abbrechbar, vorkonfigurierbarer RAM-Rahmen, Arbeitspakete, resumebar, parallel skalierbar | 4-Stage-Pipeline; Block-Splitt-Chunks (~90 Work Units); Done-Marker pro Unit; hartes RAM-Budget + Worker-Cap; Chunk-Verzeichnis selbständig → Multi-Core **und** Multi-Maschine (§6) |
| 7 | Cache: von 24 h, je nach Last schrittweise absenken; erst Erfahrungen sammeln | TTL zunächst 24 h + **Update-getriebene Invalidierung** (effektive Freshness = Update-Intervall); Latenz-Messung über Stats; datengetriebene Schritt-Policy nach Messphase (§9) |
| – | Plan + Entscheidungen im Repo dokumentieren, Ordner `agents/plans/` | Dieser Plan. In Plan-Mode ist Schreibzugriff ins Repo gesperrt; bei Agent-Wechsel wird die Datei 1:1 im neuen Repo unter `agents/plans/2026-10-14-osm-amenity-overpass-server.md` angelegt |
| R3-1 | Neues Repo `OSMAmenityOverpassServer`: dort das gesamte Projekt (Plan, Agent-Setup, Doku, Docker, License); OverpassProxy-Code **unangetastet**, muss gegen den neuen Server funktionieren; Server eigenständig betreibbar, hält sich selbst aktuell | **Standalone-Server** (eigener Prozess, eigener Container) mit Overpass-kompatiblen Endpoints; Proxy-Integration = reine Config (`UPSTREAM_URLS`), null Codeänderungen im Proxy (§16, §17) |
| R3-2 | hourly gut · Präzision 5 passt · Chunks auf Disk behalten (einstellbar, für Regelbetrieb nicht nötig) · Alle-Values-Zwischenstufe behalten (einstellbar/abschaltbar) · 8 GB total / 2 GB pro Worker — Worker-Anzahl und GB-Grenze pro Worker einstellbar · wöchentlicher Re-Extract ok, aber „warum notwendig?“ | Alle bestätigt: hourly-Default, p5-Shards, `--keep-chunks` (default true), `--all-amenity-values` (default true, abschaltbar), `--workers` + `--worker-ram-mb` separat einstellbar, wöchentlicher Drift-Re-Extract (Begründung: §7.4) |

## 1. Scope

- **Region:** gesamte Erde (OSM Planet).
- **Inhalt:** nur Objekte mit konfiguriertem `amenity`-Wert (Start: `toilets`). Keine anderen Keys, keine offene Wertemenge.
- **Ziel:** eigenständiger, self-updating Overpass-Daten-Server (neues Repo `OSMAmenityOverpassServer`), der den Proxy-Vertrag erfüllt (`node[amenity=X](s,w,n,e);out ...`); minimale Speicherkosten; unveränderter OverpassProxy nutzt ihn als Upstream, Remote-Instanzen bleiben Fallback (Entscheidung #5, R3-1).
- **Nicht im Scope:** OSM-Historie, alle Objekte, andere Keys. Das Design lässt eine spätere Key-Erweiterung zu, ohne den Endindex-Kern zu ändern (§6.5).

## 2. Verifizierte Fakten (2026-10-13)

| Fakt | Wert | Quelle |
|---|---|---|
| `planet-latest.osm.pbf` | **89 GB**, Stand 2026-10-08, md5 `d3b708ffc28873cf24a053e092dfd731` | planet.openstreetmap.org |
| `planet.osm` (XML bz2) | 167 GB (nicht benötigt) | ebd. |
| Minute-Diffs | `replication/minute/NNN/NNN/NNN.osc.gz`, 20–130 KB/min, state seq 7327518 (2026-10-13T18:33Z) | ebd. |
| Hour-Diffs | `replication/hour/NNN/NNN/NNN.osc.gz`, neueste (000/123/467) ≈ **5,8 MB**, state seq 123467 | ebd. |
| Day-Diffs | `replication/day/NNN/NNN/NNN.osc.gz`, neueste (000/005/144) ≈ **105 MB** (typ. 40–80 MB, Spitze 300–400 MB), state seq 5144 | ebd. + OSM-Wiki |
| State-Cursor | Jede Granularität hat **eigene** `state.txt`; Zählbasen sind **nicht** ineinander konvertierbar (hour-seq × 60 ≠ minute-seq) | ebd. |
| Planet-Metadaten | Offizielles Planet-File enthält **alle** Felder (version, timestamp, changeset, user, uid); nur Geofabrik-Extrakte sind GDPR-stripped (version+timestamp) | OSM-Wiki, Planet.osm (Extracts-Tabelle) |
| `amenity`-Zahlen | Japan (Runde 1): 1.432.136 Objekte, alle Werte. Weltweite Zahlen: **Phase 0 messen** (taginfo aus Sandbox nicht erreichbar) | taginfo (extern) |
| Schätzung Endindex `toilets` | ~30–250 MB (Welt); Zwischenstufe alle `amenity`-Values ~2–15 GB | Schätzung, Phase 0/1 misst real |

## 3. Datenquellen

- **Baseline:** `planet-latest.osm.pbf` (89 GB) — einmaliger Download (md5-verifiziert, resume-fähig, `curl -C`).
- **Updates:** OSM-Planet-Replikation; Granularität passend zum Update-Intervall (§7): `minute/`, `hour/`, `day/`; jeweils `.osc.gz` + `state.txt`.
- **Fallback-Quelle:** bestehende Remote-Overpass-Pools (unverändert, Entscheidung #5).
- Geofabrik wird nicht mehr als Baseline genutzt (GDPR-Strip, Länder-Navigation); bleibt nur als optionale Regional-Quelle für künftige Szenarien (`OSM_AMENITY_*`-Design lässt das zu).

## 4. Metainfos — was ist konkret drin (Antwort zu Q4)

Overpass `out ... meta` hängt pro Element `meta: {version, timestamp, changeset}` an:

- **`version`** — Versionsnummer des OSM-Objekts; wird bei jeder Änderung hochgezählt. Dient dem Edit-History-Tracking (welche Version sieht ein Client; Vergleich bei Updates).
- **`timestamp`** — Zeitpunkt der letzten Änderung, ISO 8601 (z. B. `2026-10-12T18:22:31Z`).
- **`changeset`** — numerische ID des OSM-Changesets, in dem das Objekt zuletzt bearbeitet wurde → `https://www.openstreetmap.org/changesets/<ID>` zeigt **wer** geändert hat, mit welchem **Kommentar/Tool** und im welchem Gebiet.

**Bedeutung:** Provenance/Fehlerdiagnose (schlechte Toilettendaten auf die konkrete Edit zurückführen), Frische-Heuristik. Funktional nutzt sie der Proxy nicht — sie sind Pass-through-Daten für Clients.

**Konsequenz für uns: keine Lücke.** Quelle ist das offizielle OSM-Planet-File (nicht Geofabrik) → alle Baseline-Objekte tragen vollständige `version` + `timestamp` + `changeset`; die `.osc.gz`-Updates ebenso. Das Round-1-Bedenken (fehlender `changeset` durch Geofabrik-GDPR-Strip) betrifft nur Geofabrik-Extrakte und damit nicht unser Setup. (`user`/`uid` sind ohnehin kein Teil des Standard-Overpass-`meta`-Outputs.)

Umsetzung: Felder werden im Index gespeichert (§5) und bei `out ... meta` in JSON sowie standardmäßig als XML-Attribute ausgegeben.

## 5. Indexformat (Endspeicher)

- **Sharding:** Geohash-Präzision **5** (default, `OSM_AMENITY_SHARD_PRECISION`) = Proxy-Kachel-Präzision → 1 Kachel-Query = 1 Shard. p5-Zelle ≈ 4,9 km × 4,9 km; typische BBox berührt ~1–20 Shards.
- **Datei pro Shard** `data/shards/<geohash5>.bin` — Custom-Binary, pure-TS-Reader (DataView), keine nativen Deps:
  - Header: Magic `OAM1`, Formatversion, Shard-Geohash, Elementanzahl, Offsets (Daten, ID-Index, Node-Ref-Index), Build-Sequence (Minute-seq des Builds), Config-Hash, CRC.
  - Element-Record: Typ (node/way/relation), id (u64), version (u32), timestamp (u32 Unix), changeset (u64), lat/lon (i32 × 1e-7, Nodes) bzw. Member-IDs + **inline Member-Koordinaten** (für exaktes BBox-Filtern und `>;out skel qt` ohne Extra-Shard-Load), Element-BBox (s,w,n,e), Tags (Key/Value-Indizes in Shard-String-Pool).
  - **ID-Index:** sortiert id → Offset (Update-by-id).
  - **Node-Ref-Index:** node id → Element-Offsets (Member-Update/Delete-Pfade).
- **Duplizierung:** Node in genau einem Shard (Zelle des eigenen Punkts). Way/Relation in **allen** überschneidenden p5-Zellen (Duplizierungsfaktor für Amenities klein, typ. 1–4). Dedupe by id in Query-Antworten.
- **Globale Inverted Index:** `data/index/elements.bin`: element id → [(shard, offset)] (effizientes Löschen bei Value-Wechsel/Delete; ~13 B × Duplizierung pro Element).
- **Manifest/Meta:** `data/manifest.json` (Shard-Liste, Counts, Data-Sequence), `data/meta.json` (Config-Hash, Extraktions-Parameter, Build-Zeit, Quelle).
- **Nur konfigurierte Werte** landen hier (Filter in Stage 3) — das ist der datenoptimierte Endindex gemäß Requirement #1.

## 6. Extraktions-Pipeline (weltweit; iterativ, abbrechbar, RAM-begrenzt, parallel, resumebar)

Prinzip: **Arbeitspakete (Work Packages)** = selbständige Units mit **Done-Marker** in `work/state/`. Jeder Worker-Prozess arbeitet streamend in einem **vorkonfigurierbaren RAM-Rahmen** — kein unendliches Allokieren. Abbrechen jederzeit (SIGTERM/kill); Resume = Done-Marker-Scan, erledigte Units werden übersprungen. Alle Outputs werden atomar geschrieben (tmp + rename).

**⚠️ Runde 4 (2026-10-15):** Das Stage-1/2/3-Design dieses Abschnitts ist **ersetzt** durch §19.3/§19.4 (osmium-1.14-Ergebnisse §19.2: kein `osmium run`/Lua, `tags-filter`-Bug). Stage 0 und die Prinzipien (Work-Packages, Done-Marker, atomare Writes, RAM-Budgets, Resume) bleiben gültig.

**RAM-Budget (Config, bestätigt R3):** `--ram-mb` (Gesamt-Budget, Default 8192) und `--worker-ram-mb` (Grenze pro Worker, Default 2048) sind **getrennt einstellbar**; `--workers N` (Worker-Anzahl, Default: Auto = `min(Cores, floor(ram-mb / worker-ram-mb))`) ebenfalls. Effektive Konkurrenz = `min(--workers, floor(ram-mb / worker-ram-mb))`. Chunk-Zielgröße Default 1 GB. Jedes Worker-Output-Stream arbeitet rein streaming (keine Voll-Datei-Buffer), damit die Pro-Worker-Grenze eingehalten wird.

```
planet-latest.osm.pbf (89 GB)
        │ Stage 0: Block-Split (Byte-Kopie, 1 Pass)
        ▼
work/chunks/c0000.pbf … cNNNN.pbf   (~90 Chunks à ~1 GB, jeweils valides PBF)
        │ Stage 1: amenity-Extraktion (osmium+Lua, parallel pro Chunk)
        ▼
work/out/amenity.cNNN.pbf           (alle amenity-* Objekte, volle Meta)
work/out/members.cNNN.ids           (Member-Node-/Way-IDs als u64-Liste)
        │ Stage 2: Merge + Member-Koordinaten (parallel pro Chunk)
        ▼
work/members.ids (global, sortiert) + work/out/member-nodes.cNNN.pbf
        │ Stage 3: Shard-Assembly (pure TS, parallel pro Shard-Gruppe)
        ▼
data/shards/*.bin + data/index/elements.bin + data/manifest.json + data/meta.json
```

### Stage 0 — Block-Split (pure TS, Byte-Kopie, Single-Pass)
- PBF-Datei = OSMHeader-Block + OSMData-Blöcke; jeder Block auf Disk = `varint(uncompressed_len) + komprimierte Bytes`.
- Der Splitter liest **nur die Varint-Längen** und kopiert **komplette Blöcke** byte-exakt in Chunk-Dateien (Zielgröße ~1 GB → ~90 Chunks). In jede Chunk wird der OSMHeader kopiert. **Kein Decodieren** → schnell (~5–20 min für 89 GB), RAM ≈ Konstante (Block-Puffer).
- Output: `work/chunks/cNNNN.pbf` (jeweils selbständig lesbar) + `work/manifest.json` (Chunk → Bytebereich).
- **Verifikation (Phase 0, zwingend):** `osmium cat --num-objects` pro Chunk; Summe == Planet-Objektanzahl. Stellt sicher, dass kein Objekt eine Blockgrenze überschreitet (osmium-Writer-Splitt-Verhalten; Edge-Case: Chunk über das Objektende hinaus verlängern).
- Work Unit = Chunk; resume per Chunk.

### Stage 1 — Amenity-Extraktion (osmium + Lua, parallel pro Chunk)
- Input: ein Chunk (valides PBF, unabhängig lesbar → Chunks sind auf mehrere Maschinen kopierbar).
- Lua-Handler hält **alle** Objekte mit Key `amenity` (jeder Value — Entscheidung für schnellen Re-Index, §6.5) und schreibt:
  - `work/out/amenity.cNNN.pbf` (Objekte mit voller Meta),
  - `work/out/members.cNNN.ids` (u64 LE: Node-IDs von gehaltenen Ways/Relations + Way-IDs von gehaltenen Relations, die selbst nicht gehalten sind).
- osmium-Reader streamt (RAM ≈ wenige hundert MB pro Worker); Worker-Cap durch den Coordinator nach RAM-Budget.
- Work Unit = Chunk; resume per Chunk.

### Stage 2 — Member-IDs mergen + Koordinaten (parallel pro Chunk)
- **2a:** Externes Merge aller `members.cNNN.ids` → sortiert, unique `work/members.ids` (pure TS, RAM-begrenzt; Schätzung 0,2–2 GB Disk).
- **2b (bedingt):** Falls gehaltene Relations externe (nicht gehaltene) Ways referenzieren: Way-Chunks gegen diese Way-ID-Liste scannen, deren Node-IDs ergänzen, neu mergen. Selten; bleibt ein dokumentierter Pfad.
- **2c:** Pro Chunk **Merge-Scan** (zwei Zeiger: Chunk-Node-Stream vs. `members.ids`) → `work/out/member-nodes.cNNN.pbf` nur mit passenden Nodes.
  - Lua-Throughput ~1–3 M Obj/s → ~12 B Nodes ≈ 70–120 min single-thread; mit 16 Workern ≈ 5–10 min. Fallback bei zu langsamer Ausführung: osmium-C++-Plugin (~100 M Obj/s). Als Performance-Open-Item dokumentiert.
- Work Unit = Chunk; resume per Chunk.

### Stage 3 — Shard-Assembly (pure TS, parallel pro Shard-Gruppe)
- Input: alle `amenity.cNN.pbf` + `member-nodes.cNNN.pbf` (zusammen nur wenige GB).
- Baut die End-Shards (§5): Node → eigene p5-Zelle; Way/Relation → alle überschneidenden Zellen; **Filter auf die konfigurierten Values**; ID- + Node-Ref-Indizes, String-Pool, globale `elements.bin`, `manifest.json`/`meta.json`.
- Atomic pro Shard; Work Unit = Shard-Gruppe; resume.
- Nach Abschluss: Verifikation (Counts pro Shard, Stichproben-Queries, `osmium check` auf `work/out`), danach optional `work/chunks/` löschen (Default: behalten — Re-Index ohne Re-Download).

### 6.5 Re-Index-Pfade (Requirement #2, R3-Bestätigungen)

**Runde 4:** Stage-Nummern gelten neu (§19.3): "Stage 3 neu laufen" heißt heute **Stage 4 (Assembly)**; "Stage 1–3" heißt **Stage 1–4**.

- **Neuer Value** (z. B. `drinking_water`): Stage 4 neu laufen → **Minuten**, kein Planet-Zugriff (alle Values liegen in `work/stage1/*.lines`).
- **Alle-Values-Zwischenstufe einstellbar/abschaltbar** (R3-4): `--all-amenity-values` (Default **an**). Bei `an`: Stage 1 hält alle `amenity=*`-Objekte → neue Values per Stage-3-Re-Run. Bei `aus`: Stage 1 hält nur die konfigurierten Values (Endindex identisch, Zwischenstufe kleiner) → ein neuer Value braucht Stage 1–3 neu (Chunks vorhanden) oder einen vollen Re-Extract.
- **Chunks auf Disk behalten, einstellbar** (R3-3): `--keep-chunks` (Default **an**). Chunks (~89–92 GB) sind nur für Re-Index/Re-Extract ohne Re-Download nötig, für den Regelbetrieb nicht; bei `aus` wird `work/chunks/` nach Stage 2 gelöscht.
- **Neuer Key** / große Konfig-Änderung: Stage 1–3 neu (Chunks vorhanden → kein Re-Download; ~45–90 min). Chunks nicht mehr auf Disk → Stage 0–3 komplett (~1–2 h inkl. Download).
- **Drift-Guard:** voller Re-Extract von frischem Planet, Default **wöchentlich** (`OSM_AMENITY_REEXTRACT_EVERY_SECONDS=604800`, bestätigt R3-6), atomarer `data/`-Verzeichnis-Swap erst nach Parity-Check. Begründung des Drift-Guards: §7.4.

## 7. Update-Pipeline (Catch-up) — Vorschlag zu Q3

**Modell:** Cursor **pro Granularität** (`state.json`: `{granularity, last_seq, updated_at}`), da die Zählbasen von `minute/`/`hour/`/`day/` **nicht** ineinander konvertierbar sind (verifiziert: hour-seq 123467 × 60 ≠ minute-seq 7327518).

Schleife pro Wecker:
1. `state.txt` der konfigurierten Granularität laden (kleiner GET).
2. Alle Dateien `(last_seq, current_seq]` laden (Catch-up nach Downtime automatisch, aufsteigend anwenden).
3. Anwenden: osmchange **streamend** parsen (pure TS; `zlib` für gzip, keine Voll-Bufferung):
   - Filter auf relevante Objekte: `amenity` ∈ konfigurierte Values (create/modify/delete), Member-/Tag-Änderungen gespeicherter Elemente, Node-Koordinaten-Updates über den Node-Ref-Index.
   - **Version-Guard:** anwenden nur wenn `new.version > stored.version` → **idempotent** (Überlappung/Double-Apply sicher).
   - Nicht-konfigurierte Values: ignorieren (Datenoptimierung #1).
4. Nach Batch: betroffene Shards atomar neu schreiben (tmp + rename), interne LRU-Einträge für betroffene Shards verwerfen, globale Indizes + Manifest + Data-Sequence aktualisieren, State atomic persistieren, `lastSeq/lastUpdate` aktualisieren. Proxy-seitige Frische kommt über die TTL-Strategie (§9); optional kann der Server zusätzlich die Tile-Keys des Proxy-Redis direkt invalidieren, wenn er eine `REDIS_URL` erhält (Key-Schema aus `Overpass-Proxy/src/store.ts`).
5. Konsistenz-Pass: gespeicherte Ways/Relations mit fehlenden Member-Nodes → löschen (OSM-Referenzintegrität: existieren dort nicht mehr).

**Granularität = Intervall:** `minute` → `minute/NNN/NNN/NNN.osc.gz`; `hour` → `hour/NNN/NNN/NNN.osc.gz`; `day` → `day/NNN/NNN/NNN.osc.gz` (alle `.osc.gz`, verifiziert). **Granularitätswechsel erfordert vollen Re-Extract** (andere Cursor-Basis) — seltene Konfig-Änderung, dokumentiert.

**Frequenz-Vorschläge:**

| Option | Wecker/Tag | Download/Tag | Freshness | Wiederkehrender Aufwand |
|---|---|---|---|---|
| Minute | 1440 | ~50–200 MB (20–130 KB/min) | ≤ ~1 min | 1 Timer; pro Wecker nur Parse+Filter, CPU-negligibel |
| **Hourly (Default-Empfehlung)** | 24 | typ. 20–150 MB | ≤ 1 h | minimal |
| Daily | 1 | ~40–100 MB (Spitze 300–400) | ≤ 24 h | minimal, aber Freshness schlecht |
| Adaptive Batching (Refinement, Phase 4) | Poll 60 s, Apply-Batch bei ≥ N KB oder ≥ T min | wie Minute | variabel | wenige Jobs in inaktiven Phasen |

**Kern-Erkenntnis für Q3:** Der Update-Aufwand pro Diff ist **index-unabhängig** — bei amenity-only-Index + Version-Guard-Upsert ist er nur „Diff parsen + auf konfigurierte Values filtern“, ein konstanter kleiner Bruchteil der Diff-Größe, unabhängig von der Granularität. Die Index-Wahl begrenzt also nicht die Update-Arbeit; die Granularität bestimmt nur Request-Anzahl und Freshness. Die **wirklich wiederkehrende Arbeit** ist der wöchentliche Drift-Re-Extract + Parity, nicht das Diff-Polling.

→ **Empfehlung:** Default **hourly** (Balance „live“ vs. minimaler wiederkehrender Aufwand); `minute` per Config für echte Live-Fähigkeit (Kosten trivial); `day` nur als Spar-Fallback.

### 7.4 Warum ein periodischer voller Re-Extract (Antwort zu Q6)

Der inkrementelle Diff-Weg kann **nicht alle** Änderungen verlässlich abbilden, und er kann seine eigenen Lücken nicht erkennen:

1. **Stille Ausfälle:** Der Updater agiert nur auf Änderungen, die seinen Filter treffen (konfigurierte Values + gespeicherte Elemente + deren Member). Edge-Cases — z. B. ein Element, dessen `amenity`-Wert vorübergehend aus der Konfiguration raus- und später wieder reinkommt (Delete + Create im Diff), Relation-Member-Swaps, die die Member-Node-Menge ändern, oder Node-Löschungen, die erst die Referenzintegrität einer gespeicherten Way brechen — können den Index still falsch lassen. Es gibt keinen Fehler; die Daten divergieren nur.
2. **Version-Guard-Grenze:** Der Guard „anwenden nur bei `new.version > stored.version`“ ist für Überlappung idempotenzsicher, aber ein historisches Restore/Reimport kann Inhalte mit ≤ Versionsnummer liefern, die dann verworfen werden.
3. **Baseline↔Diff-Lücke:** Die wöchentliche Planet-Baseline (planet-dump) und die Minutendiffs (osmdbt) stammen aus unterschiedlichen Pipelines; Referenz-Integritätskorrekturen auf einer Seite werden auf der anderen nicht zwingend restated.
4. **Kumulierte Rewrite-Residuen:** Shards werden über Zeit durch Updates neu geschrieben; kleine Layout-/Kompaktierungsfehler akkumulieren.

Der wöchentliche Re-Extract ist der **periodische Reset auf die Wahrheit**: aus einer einzigen autoritativen Quelle (frisches Planet-File) wird der komplette Index neu gebaut, mit Parity-Check vor dem atomaren Swap. Er ist zugleich das Re-Index-Vehikel bei Konfig-Änderungen (Q2) und der wiederkehrende Anker der Validierung. **Wöchentlich ist ausreichend**: die tagesaktuelle Frische kommt vom hourly Catch-up (≤ 1 h Alter); der Re-Extract braucht nur die *Drift* zu begrenzen, nicht die Edit-Latenz. Kosten: ~1–2 h Maschinenzeit pro Woche, unbeaufsichtigt, ohne Downtime (atomarer Swap).

## 8. Local Engine (Query-Pfad, in-Prozess, pure TS)

- **Eingabe:** amenity-Value + BBox + Output-Format (json|xml) — eigene Implementierung, 1:1 übernommen aus `Overpass-Proxy/src/bbox.ts` (`extractAmenityValue`, `hasAmenityFilter`, Normalisierung `trim().toLowerCase()`).
- **Shard-Auflösung:** BBox → p5-Zellmenge (typ. 1–20; Hard-Cap analog `MAX_TILES_PER_REQUEST`).
- **Laden:** Shard-Dateien via **LRU-Byte-Cache** (`OSM_AMENITY_SHARD_CACHE_MB`, Default 256 MB) — RAM hart begrenzt, veraltete Shards verwerfen.
- **Filter:** Value-Gleichheit + BBox (Node: Punkt; Way/Relation: Element-BBox-Intersection, dann Member-Koordinaten-Präzision).
- **Dedupe by id** (duplizierte Ways/Relations aus Nachbar-Shards).
- **Output:**
  - **JSON:** exakt dieselbe Shape wie `OverpassResponse` in `Overpass-Proxy/src/store.ts` (`version`/`generator`/`osm3s`/`elements`, inkl. `meta` bei `out ... meta`) → der Proxy speichert das Tile-Payload unverändert in Redis; Cache-Vertrag (Key, ETag, `expiresAt`) bleibt unverändert (§17).
  - **XML:** Overpass-konformes `<osm version="0.6" generator="...">`-Dokument; `node`/`way`/`relation` mit `version`/`timestamp`/`changeset`-Attributen (Standard-Overpass-XML-Verhalten) → bedient Queries **ohne** `out:json` wie das Beispiel `node[amenity=toilets](35.7986,139.7103,35.8351,139.7925);out;` lokal.
- **ETag** aus Content-Hash; `expiresAt = now + TTL`.
- **Unterstützte Out-Formen:** `out` (= body), `out body [meta]`, `out skel [meta] [qt]`, `out tags [meta]`, `out geom [meta]`, jeweils als `json` oder XML; der `>`-Rekursivitätsoperator (Member-Nodes) wird aus den inline gespeicherten Member-Koordinaten bedient. Nicht unterstützte QL (`around()`, `is_member`, mehrere Bereiche, andere Keys …) → **HTTP 501** `{"error":"out of scope"}` → der unveränderte Proxy failt auf den Remote-Pool weiter (keine Funktionalitäts-Lücke; Entscheidung #5, §17).

## 9. TTL/Cache-Strategie (Q7)

- **Start:** `CACHE_TTL_SECONDS=86400` (24 h) bleibt — Sicherheitsnetz für unangetastete Tiles.
- **Frische-Mechanik (Standalone-Architektur):** Der Server hat standardmäßig keinen Zugriff auf das Proxy-Redis. Frische auf Proxy-Seite entsteht über die TTL des Proxy-Caches: nach jedem Update-Batch (hourly) sind höchstens ein Intervall alte Tiles möglich — bei 24-h-TTL ist das im Regelfall kein Problem, weil die meisten Tiles selten nachgefragt werden. Optional: Server erhält `REDIS_URL` und invalidiert nach jedem Batch die Tile-Keys der betroffenen p5-Zellen direkt (Key-Schema aus `Overpass-Proxy/src/store.ts`) → Frische = Update-Intervall, TTL bleibt Sicherheitsnetz.
- **Messphase (Phase 4, ~1 Woche):** Stats erfassen lokale Query-Latenz (p50/p95), Shard-Cache-Hit-Rate, Update-Batch-Zeiten, Diff-Größen.
- **Schrittweises Absenken (datengetrieben, nicht spekulativ):** wenn p95 < Ziel (Start: 20 ms) **und** Hit-Rate hoch, TTL stufenweise senken: 24 h → 6 h → 1 h → 15 min (mind. 24 h Probstufe, dokumentiert). Bei Latenz-Degradation (große Shards, Cache-Miss-Spitzen, hohe Last) eine Stufe zurück.
- **Endentscheidung** nach Messphase in diesem Plan + `README` dokumentieren.

## 10. Standalone-Server: Runtime, Endpoints, Betrieb (R3)

Der Server ist ein **eigenständiger Prozess/Container** im neuen Repo `OSMAmenityOverpassServer`. Overpass-Proxy bleibt **code-seitig unverändert** (R3-1); er nimmt den Server nur als zusätzlichen Upstream in `UPSTREAM_URLS` (§17). Der Server hält sich **selbst aktuell** (in-Prozess-Catch-up, §7) und ist auch eigenständig betreibbar.

- **Prozessmodell:** ein Node/TS-Dienst (Stack wie Proxy: Fastify + pino + ngeohash), zwei Teile:
  - **Query-Engine** (§8): dient `/api/interpreter` aus dem Index.
  - **Self-Update-Loop** (§7): Timer (Default hourly) → Catch-up-Diffs anwenden; optional wöchentlicher Drift-Re-Extract (§6.5) als Subprozess/Job, danach atomarer `data/`-Swap.
- **Endpoints (Overpass-kompatibel):**
  - `POST/GET /api/interpreter` — in-Scope (amenity-Filter + BBox + konfigurierte Values) → Engine, JSON oder XML (§8); out-of-scope → **501** `{"error":"out of scope"}` (§17).
  - `GET /api/status` → Overpass-Stil + `localEngine`-Block `{shards, elements, lastSeq, lastUpdate, lagSeconds, updateIntervalSeconds}`.
  - `GET /api/timestamp` → aktueller Data-Sequence-Zeitstempel (eigenständig; Proxy nutzt ihn transparent weiter).
  - `POST /api/kill_my_queries` → 200 no-op (keine Query-Queue lokal).
  - **HEAD** auf Basis-URL → 2xx (Upstream-Recovery-Probe, §17).
- **Stats (eigener Provider):** Queries, Latenz p50/p95, Shard-Cache-Hits/Misses, Update-Lag, Batch-Größen, Fehler → Grundlage für die TTL-Tuning-Messphase (§9).
- **Deployment (neues Repo):** `Dockerfile` (node:20-alpine, 2-Stage wie Proxy) + `docker-compose.yml.template` mit `amenity-server`-Service + read-only Data-Volume; Extraktion läuft auf der Host-Maschine, nicht im Serving-Container. Full-Stack-Template: `proxy` + `redis` + `amenity-server`, Proxy zeigt per `UPSTREAM_URLS` auf beide (lokal + Remote).

## 11. Config-Oberfläche (neue Env-Var's des Servers)

Server (Runtime):

| Var | Default | Bedeutung |
|---|---|---|
| `PORT` | `8081` | HTTP-Port des Servers (8080 ist beim Proxy belegt) |
| `OSM_AMENITY_DATA_DIR` | – | Pfad zu `data/` (Shards, Indizes, Manifest, `state.json`) |
| `OSM_AMENITY_AMENITIES` | `toilets` | kommagetrennte Values (Normalisierung `trim().toLowerCase()`) |
| `OSM_AMENITY_SHARD_PRECISION` | `5` | Geohash-Präzision (= Proxy-Kachel-Präzision) |
| `OSM_AMENITY_SHARD_CACHE_MB` | `256` | LRU-Byte-Budget der Engine |
| `OSM_AMENITY_UPDATE_INTERVAL_SECONDS` | `3600` | 60 / 3600 / 86400 (bestimmt Granularität, bestätigt R3) |
| `OSM_AMENITY_UPDATE_BASE_URL` | `https://planet.openstreetmap.org/replication` | Replikations-Root |
| `OSM_AMENITY_REEXTRACT_EVERY_SECONDS` | `604800` | Drift-Guard-Re-Extract (0 = aus, bestätigt R3) |
| `OSM_AMENITY_REDIS_URL` | – (optional) | Proxy-Redis erreichen; nach Update-Batch die Tile-Keys der betroffenen p5-Zellen direkt invalidieren (§9) |

Extraktions-CLI (`scripts/extract.mjs`, offline-Tool; R3-Bestätigungen eingepflegt):
`--workers N` (Anzahl, Default Auto = `min(Cores, floor(ram-mb/worker-ram-mb))`) · `--ram-mb` (Gesamt-Budget, Default 8192) · `--worker-ram-mb` (Grenze pro Worker, Default 2048) · `--chunk-mb` (Default 1024) · `--stages 0..3` · `--keep-chunks` (Default true, R3-3) · `--all-amenity-values` (Default true, abschaltbar, R3-4) · `--data-dir` · `--amenities` · `--planet-source`.

## 12. Tests & Verifikation

- **Unit:** Geohash BBox→Zellen, Binary-Reader/Writer-Roundtrip, osmchange-Parser, Version-Guard, Dedupe, BBox-Filter, ETag, XML-Renderer.
- **Integration:** Fixture-Mini-Planet → Pipeline (klein) → Engine-Queries → Vergleich mit erwarteter Overpass-JSON/XML; eigener Test-Harness im neuen Repo (Aufbau angelehnt an `Overpass-Proxy/src/tests/integration/mock-overpass.ts`).
- **E2E gegen unveränderten Proxy:** Overpass-Proxy (v1.5.0, unverändert) zeigt per `UPSTREAM_URLS` auf Server + Remote-Pool → Kachel-Queries werden vom Server bedient, Out-of-Scope-Queries fallen auf Remote zurück (§17).
- **Parity:** `scripts/parity.mjs` — N zufällige BBoxes × konfigurierte Values: lokal vs. Live-Overpass, diff-frei erwartet. **Achtung:** aus dieser Sandbox sind öffentliche Overpass-Instanzen nicht erreichbar (Runde 1: 406/Timeout) → Parity auf einer netzwerkfähigen Maschine.
- **Performance-Benchmark:** Shard-Load, Query p50/p95, Update-Batch-Zeit mit echter Hour-Datei → Datenbasis für die TTL-Entscheidung (§9).
- **Extraktions-Verifikation:** Objekt-Counts (Chunk-Summe == Planet), `osmium check` auf `work/out/*`, Stichproben-Queries gegen die fertigen Shards.

## 13. Phasen & Meilensteine

| Phase | Inhalt | Aufwand | Abnahme |
|---|---|---|---|
| 0 | Env (osmium-tool), Block-Split-Validierung am echten Planet (Objekt-Counts, Header-Verhalten), taginfo-Zahlen (extern), Fixture-Bau | ~0,5 Tag | Chunks valid, Counts == Planet, Größen-Schätzungen real |
| 1 | Pipeline Stages 0–3 + `scripts/extract.mjs` + Resume-Protokoll; **erster weltweiter Lauf**; Verifikation | 1–2 Tage Code + 1–2 h Laufzeit | `data/` vollständig, Counts korrekt, `osmium check` grün, Abbruch/Resume getestet |
| 2 | Local Engine + Update-Pipeline + Unit/Integration-Tests | 2–3 Tage | alle Tests grün; Hour-Diff-Apply < 1 min; RAM-Budget eingehalten |
| 3 | Deployment & E2E: Docker/compose-Templates, unveränderter Proxy zeigt per `UPSTREAM_URLS` auf Server + Remote, E2E-Tests (Tile-Query, XML-Query, 501-Failover, Probes), Docs (`README`, `specification.md`, `plans/`) | ~1 Tag | Proxy-Vertrag erfüllt; Beispiel-Query lokal in JSON + XML; Out-of-Scope-Failover getestet |
| 4 | ~1 Woche Betrieb: Latenz-/Last-Messung, TTL-Stufen, Parity-Lauf, erster Drift-Re-Extract | 1 Woche | TTL-Endentscheidung dokumentiert; Parity-Diff = 0 (oder erklärt) |

**Status (R4, 2026-10-15):** Phase 0 ✅ (s. §18.8). Phase 1 🔄 — Stages 1–4 werden auf **Japan** implementiert und verifiziert (statt erstem Planet-Lauf, s. §19.1); Stage 0 ✅. Phase 2–4 ⬜. Detailierter, laufender Status: [`plans/TODO.md`](TODO.md).

## 14. Risiken

1. **89 GB Download** (Bandbreite/Zeit) — md5-Check nach Abschluss, resume-fähiger Download; Disk-Total ~180–220 GB (User bestätigt Kapazität).
2. **osmium-tool als Offline-Tool** (Installation/Bau auf der Maschine); reine-TS-PBF-Reader wäre an den nativen Blosc-Codec gebunden → osmium bevorzugt, bleibt dokumentierte Voraussetzung.
3. **Stage 2c Lua-Throughput** (12 B Nodes) — parallel ~5–15 min (16 Worker); Fallback: osmium-C++-Plugin.
4. **Objekt- vs. Block-Grenzen im Chunk-Split** — Phase-0-Verifikation per Objekt-Count; Edge-Case (Objekt überschreitet Blockgrenze) im Splitter behandelt.
5. **Worst-case Day-Diff ~105 MB** — Day-Granularität nur bewusst; Parser streamt ohnehin.
6. **Cursor-Basen pro Granularität** — eigener Cursor pro Granularität + Re-Extract bei Granularitätswechsel + Version-Guard als zweite Verteidigung.
7. **Öffentliche Overpass aus Sandbox nicht erreichbar** — Parity-/Remote-Performance-Vergleiche extern laufen.
8. **Disk-Kapazität ~200 GB** — final in Phase 0 prüfen (User: ausreichend vorhanden).

## 15. Defaults — bestätigt (Runde 3)

1. **Update-Intervall: hourly als Default** (`minute` per Config für Live-Betrieb) — bestätigt.
2. **Shard-Präzision 5** (passt zur Proxy-Kachel-Präzision) — bestätigt.
3. **Planet-File + Chunks auf Disk behalten** (`--keep-chunks`, Default true; für Regelbetrieb nicht nötig, nur Re-Index) — bestätigt, einstellbar.
4. **Zwischenstufe mit allen `amenity`-Values** (~2–15 GB) → Re-Index für neue Values in Minuten (Stage 3 nur) — bestätigt, einstellbar/abschaltbar (`--all-amenity-values`).
5. **RAM-Budget Extraktion: 8 GB total, 2 GB/Worker** — bestätigt; `--workers` und `--worker-ram-mb` separat einstellbar.
6. **Drift-Guard-Re-Extract: wöchentlich**, Parity-Check vor `data/`-Swap — bestätigt (Begründung §7.4).

Offene Defaults: keine.

## 16. Neues Repo: `OSMAmenityOverpassServer` — Projekt-Rahmen (R3)

Ziel: `/home/bietiekay/code/OSMAmenityOverpassServer` (aktuell leer, `master`, keine Commits). Der Rahmen entsteht im ersten Implementierungs-Schritt (Plan-Mode schließt Schreibzugriff ins Repo aus), danach läuft die Implementierung nach §13 dort:

```
OSMAmenityOverpassServer/
├── LICENSE                                # 1:1-Kopie von Overpass-Proxy/LICENSE (gleiche Lizenz, R3)
├── README.md                              # Überblick, Endpoints, Betrieb (Extract/Update/Parity), Config-Tabelle, Deployment
├── specification.md                       # Protokoll- + Format-Spezifikation: Shard-Binary (OAM1, §5), osmchange-Vertrag (§7), QL-Subset (§8), Overpass-Antwort-Shapes
├── OSMAmenityOverpassServer-Prompt.md     # Agent-Setup-Brief (Vorbild: Overpass-Proxy/Overpass-Proxy-Prompt.md): Zweck, Architektur, Invarianten (keine nativen Runtime-Deps, RAM-Budgets, Resume-Protokoll, Proxy-Vertrag §17), Phasen-Gates
├── plans/
│   ├── 2026-10-14-osm-amenity-overpass-server.md   # dieser Plan (R3 + R4, 2026-10-15)
│   └── TODO.md                                    # Status-Tracking aller Schritte (living document)
├── package.json                           # name osm-amenity-overpass-server, 0.1.0, type module, node>=20
│                                          # deps: fastify, @fastify/formbody, ngeohash, pino
│                                          # devDeps: typescript, vitest, tsx, eslint-Suite (wie Proxy)
│                                          # scripts: build / dev / test / verify / extract / parity
├── tsconfig.json · vitest.config.ts · eslint.config.js · .gitignore
├── Dockerfile                             # node:20-alpine, 2-Stage (wie Proxy-Dockerfile)
├── docker-compose.yml.template            # amenity-server + Data-Volume; Full-Stack: proxy + redis + amenity-server (UPSTREAM_URLS: lokal + Remote)
├── scripts/
│   ├── extract.mjs                        # Extraktions-CLI: Stages 0–3, Worker-Pool, Resume-Protokoll (§6)
│   ├── extract/amenity-filter.lua         # osmium-Lua: Stage 1 (amenity-* halten, Member-IDs sammeln)
│   ├── extract/member-scan.lua            # osmium-Lua: Stage 2c (Merge-Scan gegen members.ids)
│   └── parity.mjs                         # lokal vs. Live-Overpass (netzwerkfähig)
└── src/
    ├── index.ts                           # Entry: Config → Index-Load → Server + Self-Update-Loop
    ├── config.ts                          # OSM_AMENITY_*-Env-Var's (§11)
    ├── server.ts                          # Fastify: /api/interpreter (POST+GET), /api/status, /api/timestamp, /api/kill_my_queries, HEAD
    ├── query.ts                           # QL-Subset-Parser: amenity-Filter + BBox + Out-Formen (json|xml; out/body/skel/tags/geom, meta, `>`-Rekursivität)
    ├── output.ts                          # JSON-Renderer (OverpassResponse-Shape) + Overpass-XML-Renderer
    ├── index/
    │   ├── geohash.ts                     # BBox → p5-Zellen (ngeohash), Zell-Intersection für Ways
    │   ├── shard.ts                       # OAM1-Shard-Reader/-Writer (DataView, String-Pool, Indizes)
    │   ├── engine.ts                      # LRU-Shard-Cache, Filter, Dedupe, Antwort-Assembly
    │   └── apply.ts                       # osmchange-Anwenden: Version-Guard, Shard-Rewrite, LRU-Invalidierung
    ├── replication.ts                     # state.txt-Read, Catch-up-Download (.osc.gz), Batch-Anwendung
    └── stats.ts                           # Latenz/Lag/Counts (Basis für /api/status + TTL-Tuning §9)
tests/                                     # Unit + Integration (Fixture-Mini-Planet durch die Pipeline)
```

- **Stack-Entscheidung:** wie der Proxy (Node 20+, TypeScript, Fastify, vitest, eslint) → null neue nativen Runtime-Deps im Serving-Pfad; osmium-tool ist **nur** Offline-Tool für Extraktion/Verifikation (keine Container-Dependency des Serving-Images).
- **Datendateien:** `data/` (Live-Index: Shards, Indizes, Manifest, `state.json`), `work/` (Chunks + Zwischenstufen, `--keep-chunks`), `data.new/` (Staging während Re-Extract → atomarer Swap).
- **Agent-Setup:** Prompt-File + Plan + `TODO.md` in `plans/` = Startbasis für die Implementierungs-Session in diesem Repo.
- **Lizenz:** identisch mit Overpass-Proxy (Miataru/BSD-Stil, Copyright-Daniel-Kirstenpfad-Header wie dort).

## 17. Overpass-Proxy-Vertrag (verifiziert am v1.5.0-Quellcode, unverändert)

Quellen: `src/upstream.ts` (`buildTileQuery` L18, `fetchTile` L1205, `proxyTransparent` L1247, `withUpstream` L1069, `shouldMarkFailure`, `probeUpstream`), `src/interpreter.ts` (transparente Endpoints L749), `src/store.ts` (`OverpassResponse`, `filterElementsByBbox`), `src/tests/integration/mock-overpass.ts`.

**Kachel-Fetch (der Hauptpfad):** `POST {upstream}/api/interpreter`, Form-Body `data=<Kachelquery>` (`Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`). Kachelquery (exakt, `buildTileQuery`):
`[out:json][timeout:120];(node["amenity"]="X"(s,w,n,e);way["amenity"]="X"(s,w,n,e);relation["amenity"]="X"(s,w,n,e););out body meta;\n >;\nout skel qt;`
Antwort muss **200 JSON mit `elements`-Array** sein (`parseUpstreamResponse` verwerft alles andere → Upstream-Failure → Failover). Retry am selben Upstream: 2× bei 403/408/413/500/502/503/504 — **501 wird nicht retryt** (sofort Failover).

**Transparenter Pfad (nicht-cacheable Queries):** Method/URL/Headers/Body 1:1 weitergeleitet. Upstream **5xx oder 429 → Failover** auf den nächsten Upstream (mit Backoff-Markierung des gescheiterten); **andere 4xx → direkt ans Client** (kein Failover).

**Out-of-Scope-Vertrag des neuen Servers:** In-Scope = amenity-Tagfilter + BBox + konfigurierte Values + json|xml-Output → aus dem Index (§8). Alles andere (andere Keys, keine BBox, exotische QL) → **HTTP 501** + `{"error":"out of scope"}` → Proxy failt auf den nächsten Upstream zurück (Remote-Pool = Fallback, Entscheidung #5). Seiteneffekt: der lokale Upstream erhält ein Failure-Mark/Backoff — selbstheilend, trifft nur Out-of-Scope-Queries (in dieser App selten). Kachel-Fetches sind immer In-Scope → der Server bleibt im Regelfall der bevorzugte Upstream (EWMA-Latenz).

**Recovery-Probe:** `HEAD` auf die Upstream-Basis-URL (`probeUpstream`); Status < 500 und ≠ 429 → Upstream als verfügbar markiert. Server muss HEAD auf der Basis-URL (und auf allen Endpoints) mit 2xx beantworten (Fastify: GET-Routen beantworten HEAD automatisch).

**Deployment (Proxy-Config nur, null Code):**
`UPSTREAM_URLS: http://amenity-server:8081/api/interpreter, https://overpass-api.de/api/interpreter, https://overpass.kumi.systems/api/interpreter`
Proxy-Cache/SWR/Stats bleiben unverändert; das Tile-Payload-Format ist identisch (`OverpassResponse`-Shape, ETag, `expiresAt`).

---

# Runde 3.1 — Ergänzungen (2026-10-14)

Nebenentscheidungen aus der Umsetzung am 2026-10-14; gültig neben allen obigen
Abschnitten.

## 18.1 Diagnose-Schnittstelle (Antwort zu Q6)

- `GET /api/status` enthält ein **konformes Overpass-Block** mit den exakten
  Feldnamen anderer Overpass-Implementierungen:
  `version`, `osm_osm_change`, `time_used`, `memory_used`, `output_format`.
- `osm_osm_change` = **Minute-Sequenznummer** des zuletzt angewendeten
  Updates, als String (`"0"` ohne Daten). Externer Monitor holt die Live-Sequenz
  aus `minute/state.txt` (`sequenceNumber=`) der Update-Base-URL und
  vergleicht: `liveSeq − osm_osm_change` = Anzahl verpasster Minuten-Diffs.
- Zusätzlich (nicht-konforme Erweiterung) Block `localEngine`:
  `shards, elements, amenities, shardPrecision, lastSeq, lastUpdate,
  dataTimestamp, updateIntervalSeconds, updateBaseUrl, stats{queries, errors,
  shardCacheHits, shardCacheMisses, latencyP50Ms, latencyP95Ms, lastQueryAt}`.
- Konform dazu umgesetzt: `GET /api/timestamp` (text/plain, Data-Sequence-
  Zeitstempel, Fallback = jetzt), `POST /api/kill_my_queries` (200 no-op),
  `HEAD` auf Basis-URL → 2xx (Proxy-Recovery-Probe).

## 18.2 Cursor = Minute-Sequenz; Update-Quelle = immer Minute-Dateien

- Kanonischer Aktualitäts-Cursor ist die **Minute-Sequenznummer** (einzelner
  Zähler, keine Stunde/Tage-Basis); `state.json.lastSeq` trägt sie, `/api/status`
  gibt sie als `osm_osm_change` aus.
- Update-Quelle ist **ausschließlich** `minute/NNN/NNN/NNN.osc.gz` (7-stellige
  Sequenz, Split 3/3/1). Der Loop-Intervall
  (`OSM_AMENITY_UPDATE_INTERVAL_SECONDS`, Default 3600) steuert nur, wie oft
  Catch-up läuft — nicht, welche Dateien herkommen.
- Stunden-/Tages-Datei-Catch-up: dokumentierte zukünftige Optimierung, nicht
  erforderlich für Korrektheit (Sequenz-Basen sind nicht umrechnbar →
  Minute-Sequenz bleibt kanonisch).

## 18.3 Planet-Quelle geändert (gemessen 2026-10-14)

- planet.openstreetmap.org liefert **kein PBF** mehr:
  `/planet/planet-latest.osm.pbf` → 404, `/planet/latest/` → 404,
  `/planet/2026/` listet nur wöchentliche `.bz2`-Dumps.
- Pipeline: `planet-latest.osm.bz2` (~167 GB) laden (302 →
  `/planet/2026/planet-261005.osm.bz2`, Dump 2026-10-05, md5
  `b8ae8035c85335bae7186059ab5fbeaf`) → `osmium cat` → PBF (~89 GB) →
  bz2 löschen. Download mit `curl -C -` resumierbar.

## 18.4 Disk-Platzierung (gemessen, Zielmaschine)

| Volume | Frei (2026-10-14) | Belegung |
|---|---|---|
| `/home` | ~133 GB | PBF (~89 GB) + finale Shards (~5 GB) |
| `/ssdbuffer` | ~183 GB | bz2 während Download (Peak ~167 GB), danach `work/` + Chunks (~90 GB) |
| `/hauswolke` | ~163 GB / 1 TB | nur Overflow |

Stage 0 bleibt Byte-Kopie-Chunks (passt mit Split-Platzierung).

## 18.5 PBF-Block-Format (gemessen mit osmium 1.14 / libosmium 2.18)

- **Neue Framing** (osmium ≥ 1.14): `[u32be BlobHeader-Länge][BlobHeader-Bytes]
  [datasize-Bytes Blob]`. BlobHeader (Protobuf): Feld 1 = Typ-String
  (`"OSMHeader"`/`"OSMData"`), Feld 3 = varint `datasize`. EOF = Länge 0.
  Verifiziert: Referenzdateien `test/formats/f1*.osm.pbf` aus osmcode/libosmium
  werden exakt konsumiert; Fixture-Planet (966.678 B, 17 Blöcke) ebenso.
- **Klassische Framing** (OSM-Planet-PBF 2016+): `[varint
  BlobHeader-Länge][BlobHeader][blobSize-Bytes]`, BlobHeader Feld 1 = varint
  Blob-Größe, Feld 2 = varint Typ-Enum (1=OSMHeader, 2=OSMData). Bleibt als
  Fallback implementiert (Detection am ersten Block).
- Konsequenz für Stage 0: Scanner liest nur Header-Bytes (kein Payload-
  Decompress); Chunk-Grenzen liegen auf Block-Grenzen → Chunks sind
  validierbare PBF-Dateien (osmium zählt daraus die Objekte).

## 18.6 npm/Arborist-Notiz

- Frische Auflösung der Peer-Tree von **vitest 4.1.11** crash't npm 10.8.2
  arborist (`Cannot read properties of null (reading 'edgesOut')`) ohne
  Lockfile; Umgehung `--legacy-peer-deps`.
- vitest ist jetzt **exakt auf `4.0.16`** gepinnt (Proxy-Referenzversion);
  frische Auflösung mit 4.0.16 läuft ohne `--legacy-peer-deps`. Lockfile ist
  committed → danach immer plain `npm install` aus dem Lockfile.

## 18.7 Test-Notiz (supertest/Fastify)

- supertest `.type('form')` + `.field(...)` liefert gegen den Fastify-Server
  HTTP 415 (Content-Type-Parser-Anbindung); Lösung: String-Body via
  `new URLSearchParams({ data: q }).toString()` — 1:1 wie die
  Overpass-Proxy-Integrationstests (`formBody`-Helper).
- `app.inject()`-Responses tragen `statusCode` (nicht `status`) — bei
  injektionsbasierten Tests darauf achten.

## 18.8 Phase-0-Akzeptanz (erfüllt am 2026-10-14)

- `make-fixture --verify`: Fixture-Planet (100k nodes / 10k ways / 1k relations,
  17 PBF-Blöcke) → Stage-0-Split (1 Chunk, 1-MB-Target) → `osmium show`-Zählung
  der Chunks == Zählung des Planeten → `VERIFY OK`.
- Repo: 80/80 Tests grün, lint + build grün, Lockfile mit vitest 4.0.16.

---

# Runde 4 — 2026-10-15: Japan als Dev/Test-Ziel, osmium-Ergebnisse, neues Stage-Design

## 19.1 User-Entscheidung (2026-10-15): Entwicklung & Test auf Japan

> „can you do the develoment and testing with a smaller map like japan and make it configurable so that peoduction deployments can use the full planet?“

- **Dev/Test-Ziel ist jetzt das Geofabrik-Japan-Extrakt**, nicht der Planet.
  Source-PBF: `/ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf` (2,55 GB;
  302 → `japan-261014.osm.pbf`, Dump 2026-10-14, Geofabrik).
- **Planet-bz2 (167 GB) wurde am 2026-10-15 von `/ssdbuffer` gelöscht.**
  (Download vom 2026-10-14, md5 `b8ae8035c85335bae7186059ab5fbeaf` verifiziert
  — war also gültig, wird aber für Dev nicht gebraucht.)
- **Produktion bleibt der Planet** — exakt dieselbe Pipeline, nur `--source`
  zeigt auf den Planet-PBF. Kein separates Japan-Code-Pfad, keine
  Region-Hardcodierung: die Pipeline ist Source-agnostisch (`--source <irgendein.pbf>`).
- **Grund der Umstellung:** Disk. Auf dieser Maschine passen bz2 (167G) +
  Planet-PBF (89G) + Chunks (~90G) nicht gleichzeitig (gemessen: `/home` 131G,
  `/ssdbuffer` nach bz2-Download nur ~9G frei). Japan (2,4 GB) lässt sich
  komplett lokal halten, und die volle Pipeline-Logik (Chunking, Parallel,
  Resume, atomare Writes) wird 1:1 geübt.
- CLI-Folge: `--planet-source` wird zu `--source` (Alias bleibt akzeptiert).

## 19.2 osmium-1.14-Ergebnisse (gemessen 2026-10-15, osmium 1.14.0 / libosmium 2.18.0)

| Befehl | Ergebnis | Konsequenz |
|---|---|---|
| `osmium run` (Lua) | **existiert nicht** in diesem Build | Kein Lua-Filter — ursprüngliches Stage-1/2c-Design (Lua) fällt weg; Stages neu designed (§19.3) |
| `osmium tags-filter` | **Bug in diesem Build:** überliefert ~2–4 % Nicht-Matches, sobald die Datei Ways/Relations enthält. Fixture: 14.489 Objekte statt 10.540 erwarteter für `amenity=toilets` (3.030 ungetaggte Nodes + 525 `drinking_water` + Rest). Reproduziert mit **XML- und PBF-Input**; reine Node-Dateien (200k) werden korrekt gefiltert. Wahre Matches gehen nie verloren (Superset-Verhalten) | **tags-filter NICHT für Stage 1 verwenden.** Stattdessen `osmium cat` → OSM-XML + pure-Node-Filter (deterministisch, vitest-testbar) |
| `osmium getid` | Zuverlässig (Node- und Way-Lookup verifiziert). ID-File-Format: `n<id>` / `w<id>` / `r<id>` pro Zeile (Ein-Zeichen-Präfix, **kein Slash** — `node/7` → Fehler „illegal id: 'ode/7'“), **oder** bare IDs + `--default-type node\|way\|relation`. `--verbose-ids` meldet gefundene/fehlende IDs. Output = OSM-XML mit voller Meta (version/timestamp/changeset, lat/lon, Tags, `nd`-Refs). **Peak-RAM ~1,2–1,3 GB pro Prozess** auch für winzige Input-Dateien (libosmium-Baseline) → Worker-Zahl strikt über das RAM-Budget steuern | Stage 2 (Ways) und Stage 3 (Nodes) auf `getid`-Basis |
| `osmium cat` | Zuverlässiger PBF→XML-Passthrough (Fixture-Counts identisch) | Stage-1-XML-Quelle |
| `osmium show` | Output enthält ANSI-Farbcodes → vor dem Zählen stripen (`osmiumNumObjects` in extract.mjs macht das bereits via awk-gsub) | Verify-Routinen bleiben wie gehabt |
| `osmium fileinfo -e` | Objekt-Counts (nodes/ways/relations) liefert | Verify-Helfer |
| `osmium tags-count` | Verlässlich (Key-Counts; Fixture: `amenity`=23.397 = 22.857 Nodes + 500 Ways + 40 Relations) | Cross-Check-Helfer |
| CLI-Notizen | `osmium cat INPUT -o OUTPUT --overwrite` (positional Input, **kein** `-i`); kein `--num-objects`-Flag; Objektzählung via `osmium show FILE \| awk` (ANSI-strip) | — |

**Verifikation der Bug-Diagnose (2026-10-15):**
- Fixture (100k Nodes + 10k Ways + 1k Relations): `tags-filter "amenity=toilets"`
  → 13.791 Nodes (erwartet 10.000), `getid` zeigt für die „Extra“-Nodes die
  korrekten Tags → PBF intakt, Reader korrekt, nur der Filter-Pfad übergreift.
- Synthetic 200k Nodes, keine Ways/Relations: korrekt (20.000/20.000).
- Synthetic 60k Nodes + 6k Ways + 600 Relations: **falsch** (8.240 statt
  6.000; via XML- und PBF-Input identisch) → Trigger = Ways/Relations in der Datei.
- Conclusion: unabhängig von Input-Format nicht verlässlich → weglassen.

## 19.3 Revidiertes Stage-Design (ersetzt §6 Stages 1–3; Stage 4 neu)

```
<source>.pbf (Japan dev / planet prod — Source-agnostisch)
        │ Stage 0: Block-Split (Byte-Kopie, unverändert, ✅)
        ▼
work/chunks/cNNNN.pbf  (je Chunk mit OSMHeader → selbständig lesbar)
        │ Stage 1 (pro Chunk, parallel): osmium cat → OSM-XML (temp, danach löschen)
        │   + Node-Streaming-Filter (pure Node, vitest-getestet)
        ▼
work/stage1/amen_cNNNN.lines   (Amenity-Objekte, Line-Format §19.4)
work/stage1/ids_cNNNN.lines    (W <wayId> + N <nodeId> IDs, §19.4)
        │ Merge (sort -u): stage2/way-ids.lines, stage3/node-ids.lines
        ▼
Stage 2 (pro Chunk, parallel): osmium getid -i way-ids.lines --default-type way
        → work/stage2/ways_cNNNN.xml  (Member-Ways + nd-Refs + Tags)
        │  (nd-Refs aus ways_*.xml → in node-ids.lines mergen)
        ▼
Stage 3 (pro Chunk, parallel): osmium getid -i node-ids.lines --default-type node
        → work/stage3/nodes_cNNNN.xml  (id → lat/lon)
        ▼
Stage 4 (1 Prozess, pure Node): alle .lines + nodes → Zellen → Records
        → OAM1-Shards (writeShard aus dist/index/shard.js) → data/shards/*.bin
        + data/manifest.json + data/state.json
```

- **Sequenz zwingend:** Stage 1 (alle Chunks) → Stage 2 (alle Chunks) →
  Stage 3 (alle Chunks) → Stage 4. Stage 3 braucht die nd-Refs aus Stage 2
  (Member-Ways), Stage 2 die Relation-Members aus Stage 1.
- **Stage 1:** `osmium cat chunk.pbf -f osm -o work/tmp/cNNNN.xml` (C++, schnell),
  dann Node-Filter liest die XML zeilenweise (kein DOM): Objekt-Start/Ende
  erkennen, Tags + Member-Refs sammeln, Amenity-Match (`amenity` ∈ konfigurierte
  Values; bei `--all-amenity-values`: Key-Präsenz). Match → Line nach §19.4,
  dazu `W`-/`N`-IDs in das ids-File. Temp-XML danach löschen. Work Unit = Chunk,
  Done-Marker `stage1/cNNNN.done` wie Stage 0.
- **Stage 2:** globale Way-ID-Menge aus allen `ids_*.lines` (nur `W`-Zeilen,
  `sort -u`). Pro Chunk `osmium getid -i way-ids.lines chunk.pbf
  --default-type way -o stage2/ways_cNNNN.xml`. Output wird geparst → Way-Lines
  (id, ver, ts, cs, nd-Refs, Tags); ihre nd-Refs erweitern die Node-ID-Menge
  (darum Stage 3 danach).
- **Stage 3:** globale Node-ID-Menge (`N`-Zeilen Stage 1 + nd-Refs aus
  Stage-2-Ways). Pro Chunk `osmium getid --default-type node` →
  `stage3/nodes_cNNNN.xml` (id → lat/lon). Ein Node existiert in genau einem
  Chunk → jede ID erscheint genau einmal über alle Chunks (sonst Warnung).
- **Stage 4:** reines Node-Modul. Lädt die Node-Map (id → [lat7,lon7]);
  streamt alle amen-Lines + Way-Lines; berechnet Zellen (§19.5); schreibt
  Records (u32le-Länge + Record-Bytes) in `stage4/cells/<geohash>.rec`
  (LRU-Offene-Dateien-Cache, z. B. 256 Dateien); pro Zelle: Records lesen →
  `ShardElement[]` → `writeShard(geohash, elements, buildSequence=0, configHash)`
  → atomar nach `data/shards/<geohash>.bin`. Danach `manifest.json`
  (Counts, source, config) + `state.json` (`lastSeq: 0`, `lastUpdate`,
  `dataTimestamp` = Source-Mtime). `dist/index/shard.js` fehlt → erst
  `npm run build` (wird vom CLI automatisch angestoßen).
- **Re-Index-Update (§6.5 neu nummeriert):** neuer Value → **Stage 4 neu**
  (Minuten, alle Values liegen in `stage1/*.lines`); neuer Key → Stage 1–4;
  Drift-Re-Extract → Stage 0–4.

## 19.4 Line-Format (Stage-1/2-Output, IDs-Files)

Eine Zeile pro Objekt, Felder durch Leerzeichen, Tags URL-encodiert
(`encodeURIComponent` → kein Leerzeichen mehr im Feld); `-` trennt
Geometrie/Member von Tags (steht immer, auch bei 0 Tags):

```
N <id> <ver> <ts> <cs> <lat7> <lon7> - [k=v ...]
W <id> <ver> <ts> <cs> <nd1> <nd2> ... - [k=v ...]
R <id> <ver> <ts> <cs> [t:ref:role ...] - [k=v ...]
```

- `ts` = Unix-Sekunden (ISO-String aus der XML → epoch; leeres/fehlendes
  timestamp → 0). `lat7/lon7` = Koordinaten × 1e7 als i32 (wie OAM1).
- `t` ∈ {`n`,`w`,`r`}; Rolle darf leer sein (`w:123:`).
- IDs-Files (`ids_cNNNN.lines`): `W <id>` (Way-Member einer Amenity-Relation)
  bzw. `N <id>` (nd-Ref einer Amenity-Way bzw. Node-Member einer
  Amenity-Relation). Für `getid` umformatiert auf `<id>` + `--default-type`
  (oder Präfix `n`/`w` — beides verifiziert, §19.2).
- Parser ist pure Node, vitest-geprüft (Roundtrip + Edge-Cases: leere Rolle,
  encodierte Keys/Values, 0 Tags, fehlendes timestamp).

## 19.5 Shard-Inhalt-Vertrag (was Stage 4 liefern muss — abgeleitet aus engine.ts)

- **Amenity-Node** → genau eine Zelle (Zelle des eigenen Punkts, `pointToCell`);
  `bbox = [lat,lon,lat,lon]` (eigener Punkt).
- **Amenity-Way** → **alle** Zellen, deren BBox den Way-BBox schneidet; jede
  Kopie trägt die **vollen Member-Koordinaten inline** (`memberCoords`) —
  die Engine bedient `out geom` und `>;`-Member-Nodes ausschließlich daraus,
  ohne extra Shard-Load. Way-BBox = min/max über Member-Koordinaten.
- **Amenity-Relation** → alle Zellen der **Union-BBox** (direkte
  Member-Node-Punkte ∪ BBoxes der Member-Ways); Member-Liste 1:1
  (Typ/Ref/Rolle) — die Engine rendert Member-Relations selbst nicht,
  aber die Refs müssen im Antwort-Skeleton stehen.
- **Member-Ways** (selbst ohne Amenity-Tag) → **nur** in den Zellen der
  Relations, die sie referenzieren (nie Haupt-Element → keine eigenen
  BBox-Zellen nötig). Die Engine findet sie via `shard.elements.find(...)`
  **im selben Shard** wie die Relation. nd-Refs + Tags mitnehmen
  (Skel-Output + Zukunft), **keine** Koordinaten nötig (Engine gibt
  Member-Ways nur als `skel` aus).
- **Direkte Member-Nodes von Relations** → müssen als **Node-Elemente** in
  denselben Zellen existieren wie die Relation (Engine-Lookup in
  `shard.elements`; sonst fehlt der `>`-Node in der Antwort).
- **Dedupe** innerhalb einer Zelle by id (z. B. Amenity-Way, der zugleich
  Member-Way ist): Version mit `memberCoords` bzw. höhere Version gewinnt;
  `memberCoords`-Maps werden mergt.
- **buildSequence = 0** im Initial-Build (Geofabrik-Snapshot kennt keine
  Minute-Sequenz); `configHash = buildConfigHash({amenities, shardPrecision})`
  — Engine validiert aktuell nicht, Update-Pfad (Phase 2) wird es tun.
- **Bekannte Einschränkung (v1):** Relation→Relation-Member werden nicht
  aufgelöst (deren Ways landen nicht in den Zellen; BBox nur aus direkten
  Members). Geringe Relevanz für amenity-Use-Cases, dokumentiert bleiben.

## 19.6 RAM-/Disk-Budgets (Japan-Dev auf dieser Maschine, 2026-10-15)

| Item | Pfad | Größe |
|---|---|---|
| Source-PBF | `/ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf` | 2,55 GB (unverändert) |
| Work-Dir | `/home/osm-amenity/japan/work/` | Chunks ~2,5 GB + transient Temp-XML pro Chunk |
| Data-Dir | `/home/osm-amenity/japan/data/` | Shards + Manifest (Schätzung < 1 GB, ~1,43M Amenity-Objekte alle Values) |

- **Dev-Lauf mit `--chunk-mb 256`** (~10 Chunks statt 3): Temp-XML pro Chunk
  ~4–6 GB statt ~17 GB (Fixture-Ratio ~17×), bessere Worker-Auslastung
  (24 Cores). `--workers` entsprechend (Default-Formel bleibt:
  `min(Cores, floor(ram-mb/worker-ram-mb))`).
- **Stage-4-RAM:** ~1,43M Objekte in Maps ≈ 0,5–1 GB → unter 2 GB/Worker.
- **Planet-Produktion (später, andere Maschine):** ~17 GB Temp-XML pro
  1-GB-Chunk (sequenziell pro Chunk, danach löschen); ≥ ~200 GB frei nötig
  (bz2/PBF-Platzierung s. §18.3/§18.4, neu zu messen).

## 19.7 Fixture-Stand (Action vor erstem Commit)

- `fixtures/` auf Disk (fixture.osm.xml + .pbf, 2026-10-14 17:22) stammen von
  einer **älteren** make-fixture-Version: building-Tag-Count 8.571 statt 7.143,
  wie sie der aktuelle Generator erzeugt (XML und PBF untereinander
  konsistent: Counts 100k/10k/1k, getid-Stichproben OK — nur das
  Nicht-Amenity-Rauschen ist veraltet).
- **Action:** Fixture vor dem ersten Commit regenerieren:
  `npm run make-fixture -- --verify` (LCG-Seed 20261014 fixiert →
  deterministisch; `fixtures/` steht in `.gitignore`, wird nicht committet).

## 19.8 Nächste Schritte (exakte Reihenfolge)

1. **Fixture regenerieren** + `make-fixture --verify` grün (§19.7).
2. **Stages 1–4 implementieren** in `scripts/extract.mjs` (+ Line-Format-
   Parser, `--source`-Alias, Auto-`npm run build` für Stage 4).
3. **vitest-Tests** für XML-Stream-Filter, Line-Format-Parser/Writer,
   Stage-4-Assembly (Zellen-Zuordnung, Dedupe, Member-Platzierung,
   manifest/state); Coverage-Gates 0.9/0.85/0.9/0.9 einhalten.
4. **Japan-Volllauf:**
   `node scripts/extract.mjs --source /ssdbuffer/osm-amenity/planet/japan-latest.osm.pbf --data-dir /home/osm-amenity/japan --stages 0-4 --chunk-mb 256 --all-amenity-values true`
5. **Verifikation:** unabhängige osmium-Zählung (show-based, ANSI-strip) vs.
   `manifest.json`-Counts (alle amenity-Values + Member-Objekte);
   Tokyo-Stichprobe (bekannt hohe Toilettendichte, z. B. 35.681/139.767
   Bahnhofsbereich) per `osmium show`-Stichprobe gegen Shard-Inhalt.
6. **Server-Start** auf Japan-Data (`OSM_AMENITY_DATA_DIR=/home/osm-amenity/japan/data`);
   E2E: JSON-Query, XML-Query, `>;`-Rekursion, Out-of-Scope → 501,
   `/api/status`-Sinnhaftigkeit (shards/elements/lastUpdate).
7. **Git-Initial-Commit** (alles, inkl. `plans/` + `TODO.md`; master hat
   bislang 0 Commits).
8. **(Netzwerk nötig)** Parity vs. öffentliche Overpass — Sandbox blockiert
   (406/Timeout, §14-Risiko 7); auf netzwerkfähiger Maschine.
9. **(Netzwerk + Proxy-Checkout)** Proxy-E2E: unveränderter Overpass-Proxy,
   `UPSTREAM_URLS: http://amenity-server:8081/api/interpreter, <remote>`;
   Failover/Probes/Tile-Query (§17).
10. **Phase 2:** Update-Loop im Server verdrahten (Timer → `state.txt` →
    Minute-Diffs streamend anwenden → atomare Shard-Rewrites → `state.json`
    persistieren) + Re-Extract-Job; E2E mit echten Planet-Minuten-Diffs
    gegen den Japan-Index (Region wirkt als natürlicher Filter) oder
    synthetischem osmchange am Fixture.
11. **TTL-Messphase (§9):** nach ~1 Woche Japan-Betrieb Latenz p50/p95 +
    Cache-Hit-Rate auswerten, TTL-Stufen 24h → 6h → 1h → 15min.
12. **(Verschoben, User-Entscheidung)** Planet-Produktionslauf.

## 19.9 Langfrist-Ziele & offene Items

- **Planet-Index (Produktion)** über dieselbe Pipeline (`--source
  planet-latest.osm.pbf`) — erst nach japanischem E2E-Grünllicht + Maschine
  mit ≥ 200 GB frei.
- **Selbstaktualisierender Server:** Minute-Catch-up, Freshness ≤ 1 h
  (Default hourly, `OSM_AMENITY_UPDATE_INTERVAL_SECONDS`); kanonischer Cursor
  = Minute-Sequenz in `state.json` → `/api/status.osm_osm_change` (§18.2).
- **Proxy nutzt amenity-server als bevorzugten Upstream** (EWMA-Latenz),
  Remote-Pool bleibt Fallback für Out-of-Scope (501-Failover, §17).
- **Cache-TTL datengetrieben** von 24 h abschätzen (§9, nach Messphase).
- **Optional/Refinements:** Redis-Invalidierung (`OSM_AMENITY_REDIS_URL`),
  hour/day-Diff-Catch-up (Cursor-Basen nicht umrechnbar → nur
  Optimierungs-Option), weitere Keys (nur Stage 1–4 nötig, Endindex-Kern
  bleibt, §1 Scope), Relation→Relation-Auflösung (§19.5-Einschränkung).
- **Weltweite amenity-Zahlen** (taginfo) aus Sandbox nicht erreichbar →
  auf netzwerkfähiger Maschine messen (Japan-Referenz: 1.432.136 Objekte,
  alle Values, R1).

## 19.10 Dev-Environment-Inventur (2026-10-15)

- Maschine: 24 CPU, ~89 GB RAM (~26 GB frei bei Messung), Ubuntu 22.04.5,
  root. node v22.23.3, npm 10.8.2, osmium-tool 1.14.0 (libosmium 2.18.0;
  zlib/lz4/none). Git-User „Daniel Kirstenpfad“ <bietiekay@gmail.com>.
- Disk (nach bz2-Löschung): `/home` ~131 GB frei (Japan-Work/Data-Dirs),
  `/ssdbuffer` ~178 GB frei (nur noch Japan-PBF 2,4 GB + Logs),
  `/hauswolke` ~163 GB / 1 TB (nur Overflow).
- **npm:** immer aus dem committed Lockfile installieren (plain `npm
  install`). Vitest exakt **4.0.16** gepinnt — frische Auflösung ≥4.1.11
  crash't npm-10.8.2-Arborist (Peer-Tree, `edgesOut`-Null) ohne Lockfile
  (§18.6).
- **Test-Notiz:** supertest `.type('form')`+`.field()` → 415 gegen Fastify;
  stattdessen String-Body via `new URLSearchParams({data: q}).toString()`
  (§18.7). `app.inject()`-Responses tragen `statusCode`.

## 19.11 Test-Infra / Coverage (2026-10-15)

- `@vitest/coverage-v8` **@4.0.16** als devDependency ergänzt (exakt auf die
  vitest-Pin 4.0.16, §18.6; plain `npm install` aus dem Lockfile, npm 10.8.2
  ohne Arborist-Crash). Vorher war `npm run test:ci` gar nicht lauffähig
  („MISSING DEPENDENCY @vitest/coverage-v8“).
- **Baseline-Lauf `test:ci`: 80/80 Tests grün, aber die Coverage-Gates
  (0.9/0.85/0.9/0.9) werden verfehlt:** Statements 88.66 %, Branches 70.1 %,
  Functions 88.79 %, Lines 88.84 %. Schwächste Dateien: `engine.ts`
  (72.9 % Stmts: `emptyResult`-Pfad + korrupter-Shard-Pfad), `config.ts`
  (71.4 %: `readInt`/`readBool`-Fehlerzweige, `redisInvalidationEnabled`),
  `replication.ts` (73.9 %: state-Edge-Cases), `shard.ts` (Fehlerzweige),
  `server.ts` (Interpreter-500-Pfad).
- **Action vor dem ersten Commit:** Fehlerzweig-Tests ergänzen, bis
  `test:ci` an den Gates grün ist (Liste in `TODO.md` §1/§4).
- Achtung: `vitest.config.ts` hat **keine** `coverage.include`-Begrenzung →
  neue `scripts/extract/*.mjs`-Module, die in Tests geladen werden, zählen
  ebenfalls mit (deren Tests müssen die Gates also auch erfüllen).
