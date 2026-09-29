import fs from 'fs';
import path from 'path';
import { Incident } from './types';

// Dynamically load node:sqlite to support Node 22 built-in SQLite without @types/node mismatches
let DatabaseSyncClass: any = null;
try {
  // @ts-ignore
  const sqlite = typeof require !== 'undefined' ? require('node:sqlite') : null;
  if (sqlite && sqlite.DatabaseSync) {
    DatabaseSyncClass = sqlite.DatabaseSync;
  }
} catch (e) {
  DatabaseSyncClass = null;
}

// Fallback JSON-backed SQLite-like persistent store if node:sqlite is unavailable
function getDbPath(): string {
  const rootDataDir = path.resolve(process.cwd(), '..', 'data');
  if (fs.existsSync(rootDataDir)) {
    return path.join(rootDataDir, 'incidents.db');
  }
  const localDataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }
  return path.join(localDataDir, 'incidents.db');
}

function getJsonFallbackPath(): string {
  const rootDataDir = path.resolve(process.cwd(), '..', 'data');
  if (fs.existsSync(rootDataDir)) {
    return path.join(rootDataDir, 'incidents.json');
  }
  const localDataDir = path.resolve(process.cwd(), 'src', 'lib', 'data');
  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }
  return path.join(localDataDir, 'incidents.json');
}

let dbInstance: any = null;

export function getDatabase(): any {
  if (dbInstance) return dbInstance;

  if (DatabaseSyncClass) {
    try {
      const dbPath = getDbPath();
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const db = new DatabaseSyncClass(dbPath);

      db.exec(`
        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          service TEXT NOT NULL,
          severity TEXT DEFAULT 'P1',
          environment TEXT DEFAULT 'production',
          root_cause TEXT,
          telemetry TEXT,
          alert_signatures TEXT,
          resolver TEXT DEFAULT 'oncall.engineer',
          duration_minutes REAL DEFAULT 15.0,
          created_at TEXT,
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS mitigations (
          id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL,
          action TEXT NOT NULL,
          command TEXT NOT NULL,
          times_worked INTEGER DEFAULT 1,
          times_attempted INTEGER DEFAULT 1,
          avg_resolution_minutes REAL DEFAULT 3.0,
          success_score REAL DEFAULT 0.9,
          notes TEXT
        );

        CREATE TABLE IF NOT EXISTS anti_patterns (
          id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL,
          action TEXT NOT NULL,
          command TEXT,
          times_failed INTEGER DEFAULT 1,
          times_attempted INTEGER DEFAULT 1,
          danger_level TEXT DEFAULT 'HIGH',
          failure_outcome TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS feedback_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          incident_id TEXT NOT NULL,
          action_id TEXT NOT NULL,
          outcome TEXT NOT NULL,
          notes TEXT,
          engineer TEXT DEFAULT 'oncall.engineer',
          created_at TEXT
        );
      `);

      dbInstance = db;
      return db;
    } catch (err) {
      console.warn('SQLite init warning, using persistent store:', err);
    }
  }

  // Fallback persistent storage
  dbInstance = {
    isFallback: true,
    data: [] as Incident[]
  };
  return dbInstance;
}

export function saveIncidentToDb(inc: Incident): void {
  const db = getDatabase();

  if (db && !db.isFallback) {
    try {
      const insertInc = db.prepare(`
        INSERT OR REPLACE INTO incidents (
          id, title, service, severity, environment, root_cause, telemetry, alert_signatures, resolver, duration_minutes, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertInc.run(
        inc.id,
        inc.title,
        inc.service,
        inc.severity || 'P1',
        inc.environment || 'production',
        inc.rootCause || '',
        JSON.stringify(inc.telemetry || {}),
        JSON.stringify(inc.alertSignatures || []),
        inc.resolver || 'oncall.engineer',
        inc.durationMinutes || 15.0,
        inc.createdAt || new Date().toISOString(),
        inc.resolvedAt || ''
      );

      if (inc.successfulMitigations) {
        const insertMit = db.prepare(`
          INSERT OR REPLACE INTO mitigations (
            id, incident_id, action, command, times_worked, times_attempted, avg_resolution_minutes, success_score, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const m of inc.successfulMitigations) {
          insertMit.run(
            m.id,
            inc.id,
            m.action,
            m.command,
            m.timesWorked || 1,
            m.timesAttempted || 1,
            m.avgResolutionMinutes || 3.0,
            m.successScore || 0.9,
            m.notes || ''
          );
        }
      }

      if (inc.failedMitigations) {
        const insertAnti = db.prepare(`
          INSERT OR REPLACE INTO anti_patterns (
            id, incident_id, action, command, times_failed, times_attempted, danger_level, failure_outcome
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const f of inc.failedMitigations) {
          insertAnti.run(
            f.id,
            inc.id,
            f.action,
            f.command || '',
            f.timesFailed || 1,
            f.timesAttempted || 1,
            f.dangerLevel || 'HIGH',
            f.failureOutcome || ''
          );
        }
      }
    } catch (e) {
      console.error('Error saving incident to SQLite:', e);
    }
  }

  // Also persist to disk JSON so both SQLite and JSON stay synchronized
  const jsonPath = getJsonFallbackPath();
  try {
    let list: Incident[] = [];
    if (fs.existsSync(jsonPath)) {
      list = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    const idx = list.findIndex(i => i.id === inc.id);
    if (idx >= 0) {
      list[idx] = inc;
    } else {
      list.unshift(inc);
    }
    fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to sync incident to disk:', err);
  }
}

export function getAllIncidentsFromDb(): Incident[] {
  const db = getDatabase();

  if (db && !db.isFallback) {
    try {
      const incRows: any[] = db.prepare('SELECT * FROM incidents ORDER BY created_at DESC').all();
      return incRows.map(row => {
        const mitigations: any[] = db.prepare('SELECT * FROM mitigations WHERE incident_id = ?').all(row.id);
        const antiPatterns: any[] = db.prepare('SELECT * FROM anti_patterns WHERE incident_id = ?').all(row.id);

        return {
          id: row.id,
          title: row.title,
          service: row.service,
          severity: row.severity,
          environment: row.environment,
          rootCause: row.root_cause,
          telemetry: JSON.parse(row.telemetry || '{}'),
          alertSignatures: JSON.parse(row.alert_signatures || '[]'),
          resolver: row.resolver,
          durationMinutes: row.duration_minutes,
          createdAt: row.created_at,
          resolvedAt: row.resolved_at,
          successfulMitigations: mitigations.map(m => ({
            id: m.id,
            action: m.action,
            command: m.command,
            timesWorked: m.times_worked,
            timesAttempted: m.times_attempted,
            avgResolutionMinutes: m.avg_resolution_minutes,
            successScore: m.success_score,
            notes: m.notes,
            sourceIncidentId: row.id,
            sourceIncidentTitle: row.title
          })),
          failedMitigations: antiPatterns.map(f => ({
            id: f.id,
            action: f.action,
            command: f.command,
            timesFailed: f.times_failed,
            timesAttempted: f.times_attempted,
            dangerLevel: f.danger_level,
            failureOutcome: f.failure_outcome,
            sourceIncidentId: row.id,
            sourceIncidentTitle: row.title
          }))
        };
      });
    } catch (e) {
      console.error('Error reading from SQLite:', e);
    }
  }

  // Fallback to disk JSON only if SQLite was unavailable
  const jsonPath = getJsonFallbackPath();
  if (fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      console.error('Failed to read fallback incidents:', err);
    }
  }
  return [];
}

export function clearAllIncidentsFromDb(): void {
  const db = getDatabase();

  if (db && !db.isFallback) {
    try {
      db.exec(`
        DELETE FROM mitigations;
        DELETE FROM anti_patterns;
        DELETE FROM feedback_logs;
        DELETE FROM incidents;
      `);
    } catch (e) {
      console.error('Error clearing SQLite tables:', e);
    }
  }

  // Clear JSON storage files
  const rootDataDir = path.resolve(process.cwd(), '..', 'data');
  const rootJson = path.join(rootDataDir, 'incidents.json');
  if (fs.existsSync(rootJson)) {
    try {
      fs.writeFileSync(rootJson, '[]', 'utf8');
    } catch (e) {
      console.error('Error clearing root incidents.json:', e);
    }
  }

  const localJson = path.resolve(process.cwd(), 'src', 'lib', 'data', 'incidents.json');
  if (fs.existsSync(localJson)) {
    try {
      fs.writeFileSync(localJson, '[]', 'utf8');
    } catch (e) {
      console.error('Error clearing local incidents.json:', e);
    }
  }
}

export function recordFeedbackInDb(
  incidentId: string,
  actionId: string,
  outcome: 'worked' | 'failed',
  notes: string = '',
  engineer: string = 'oncall.engineer'
): boolean {
  const db = getDatabase();

  if (db && !db.isFallback) {
    try {
      db.prepare(`
        INSERT INTO feedback_logs (incident_id, action_id, outcome, notes, engineer, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(incidentId, actionId, outcome, notes, engineer, new Date().toISOString());

      if (outcome === 'worked') {
        const row: any = db.prepare('SELECT * FROM mitigations WHERE id = ?').get(actionId);
        if (row) {
          const timesWorked = (row.times_worked || 0) + 1;
          const timesAttempted = (row.times_attempted || 0) + 1;
          const newScore = Math.min(0.99, Math.round((timesWorked / timesAttempted) * 100) / 100);

          db.prepare(`
            UPDATE mitigations
            SET times_worked = ?, times_attempted = ?, success_score = ?
            WHERE id = ?
          `).run(timesWorked, timesAttempted, newScore, actionId);
        }
      } else {
        const mitRow: any = db.prepare('SELECT * FROM mitigations WHERE id = ?').get(actionId);
        if (mitRow) {
          const timesAttempted = (mitRow.times_attempted || 0) + 1;
          const timesWorked = mitRow.times_worked || 0;
          const newScore = Math.max(0.1, Math.round((timesWorked / timesAttempted) * 100) / 100);

          db.prepare(`
            UPDATE mitigations
            SET times_attempted = ?, success_score = ?
            WHERE id = ?
          `).run(timesAttempted, newScore, actionId);

          const failId = `anti_${Date.now()}`;
          db.prepare(`
            INSERT INTO anti_patterns (id, incident_id, action, command, times_failed, times_attempted, danger_level, failure_outcome)
            VALUES (?, ?, ?, ?, 1, 1, 'HIGH', ?)
          `).run(failId, incidentId, mitRow.action, mitRow.command, notes || 'Failed during triage attempt.');
        }
      }
    } catch (e) {
      console.error('Error logging feedback to SQLite:', e);
    }
  }

  // Also update disk storage
  const jsonPath = getJsonFallbackPath();
  try {
    if (fs.existsSync(jsonPath)) {
      const list: Incident[] = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const inc = list.find(i => i.id === incidentId);
      if (inc) {
        if (outcome === 'worked') {
          const mit = (inc.successfulMitigations || []).find(m => m.id === actionId);
          if (mit) {
            mit.timesWorked = (mit.timesWorked || 0) + 1;
            mit.timesAttempted = (mit.timesAttempted || 0) + 1;
            mit.successScore = Math.min(0.99, Math.round((mit.timesWorked / mit.timesAttempted) * 100) / 100);
          }
        } else {
          const mit = (inc.successfulMitigations || []).find(m => m.id === actionId);
          if (mit) {
            mit.timesAttempted = (mit.timesAttempted || 0) + 1;
            mit.successScore = Math.max(0.1, Math.round(((mit.timesWorked || 0) / mit.timesAttempted) * 100) / 100);

            inc.failedMitigations = inc.failedMitigations || [];
            inc.failedMitigations.push({
              id: `fail_${Date.now()}`,
              action: mit.action,
              command: mit.command,
              timesFailed: 1,
              timesAttempted: 1,
              failureRate: 1.0,
              dangerLevel: 'HIGH',
              failureOutcome: notes || 'Failed during triage attempt.'
            });
          }
        }
        fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
      }
    }
  } catch (err) {
    console.error('Error syncing feedback to disk:', err);
  }

  return true;
}