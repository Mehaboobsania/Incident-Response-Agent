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

/**
 * Robust directory resolver to ensure persistent storage works identically
 * whether running Next.js from `Incident-Response-Agent` or `Incident-Response-Agent/frontend`.
 */
function getStoragePaths() {
  const cwd = process.cwd();
  
  // Find project root data directory
  let rootDataDir: string;
  if (path.basename(cwd).toLowerCase() === 'frontend') {
    rootDataDir = path.resolve(cwd, '..', 'data');
  } else if (fs.existsSync(path.join(cwd, 'data'))) {
    rootDataDir = path.join(cwd, 'data');
  } else {
    rootDataDir = path.resolve(cwd, 'data');
  }

  if (!fs.existsSync(/*turbopackIgnore: true*/ rootDataDir)) {
    try {
      fs.mkdirSync(rootDataDir, { recursive: true });
    } catch (e) {}
  }

  const dbPath = path.join(rootDataDir, 'incidents.db');
  const rootJsonPath = path.join(rootDataDir, 'incidents.json');
  
  // Also check local frontend data directory for Next.js bundling fallback
  let frontendJsonPath = path.join(cwd, 'src', 'lib', 'data', 'incidents.json');
  if (path.basename(cwd).toLowerCase() !== 'frontend' && fs.existsSync(/*turbopackIgnore: true*/ path.join(cwd, 'frontend'))) {
    frontendJsonPath = path.join(cwd, 'frontend', 'src', 'lib', 'data', 'incidents.json');
  }

  return { rootDataDir, dbPath, rootJsonPath, frontendJsonPath };
}

let dbInstance: any = null;
let memoryCache: Incident[] = [];

export function getDatabase(): any {
  if (dbInstance) return dbInstance;

  const { dbPath } = getStoragePaths();

  if (DatabaseSyncClass) {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) {
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
          times_worked INTEGER DEFAULT 0,
          times_attempted INTEGER DEFAULT 0,
          avg_resolution_minutes REAL DEFAULT 3.0,
          success_score REAL DEFAULT 0.7,
          notes TEXT
        );

        CREATE TABLE IF NOT EXISTS anti_patterns (
          id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL,
          action TEXT NOT NULL,
          command TEXT,
          times_failed INTEGER DEFAULT 0,
          times_attempted INTEGER DEFAULT 0,
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
        inc.durationMinutes || 0,
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
            m.timesWorked ?? 0,
            m.timesAttempted ?? 0,
            m.avgResolutionMinutes || 5.0,
            m.successScore || 0.7,
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
            f.timesFailed ?? 0,
            f.timesAttempted ?? 0,
            f.dangerLevel || 'HIGH',
            f.failureOutcome || ''
          );
        }
      }
    } catch (e) {
      console.error('Error saving incident to SQLite:', e);
    }
  }

  // Update in-memory cache for instant zero-latency retrieval
  const memIdx = memoryCache.findIndex(i => i.id === inc.id);
  if (memIdx >= 0) {
    memoryCache[memIdx] = inc;
  } else {
    memoryCache.unshift(inc);
  }

  // Also persist to disk JSON so both SQLite and JSON stay synchronized
  const { rootJsonPath, frontendJsonPath } = getStoragePaths();
  const pathsToSync = [rootJsonPath, frontendJsonPath].filter(p => p && fs.existsSync(/*turbopackIgnore: true*/ path.dirname(p)));

  for (const jsonPath of pathsToSync) {
    try {
      let list: Incident[] = [];
      if (fs.existsSync(/*turbopackIgnore: true*/ jsonPath)) {
        const raw = fs.readFileSync(/*turbopackIgnore: true*/ jsonPath, 'utf8').trim();
        if (raw) {
          list = JSON.parse(raw);
        }
      }
      const idx = list.findIndex(i => i.id === inc.id);
      if (idx >= 0) {
        list[idx] = inc;
      } else {
        list.unshift(inc);
      }
      fs.writeFileSync(jsonPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (err) {
      console.error(`Failed to sync incident to disk (${jsonPath}):`, err);
    }
  }
}

export function getAllIncidentsFromDb(): Incident[] {
  try {
    const db = getDatabase();

  if (db && !db.isFallback) {
    try {
      const incRows: any[] = db.prepare('SELECT * FROM incidents ORDER BY created_at DESC').all();
        const result = incRows.map(row => {
          const mitigations: any[] = db.prepare('SELECT * FROM mitigations WHERE incident_id = ?').all(row.id);
          const antiPatterns: any[] = db.prepare('SELECT * FROM anti_patterns WHERE incident_id = ?').all(row.id);

          const antiPatternActionSet = new Set(antiPatterns.map(f => (f.action || '').trim().toLowerCase()));
          const antiPatternCmdSet = new Set(antiPatterns.map(f => (f.command || '').trim().toLowerCase()).filter(Boolean));

          const cleanMitigations = mitigations.filter(m => {
            const act = (m.action || '').trim().toLowerCase();
            const cmd = (m.command || '').trim().toLowerCase();
            if (antiPatternActionSet.has(act)) return false;
            if (cmd && antiPatternCmdSet.has(cmd) && cmd !== '# manual command' && cmd !== '# execute command') return false;
            return true;
          });

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
            successfulMitigations: cleanMitigations.map(m => ({
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

        if (result.length > 0) {
          memoryCache = result;
          return result;
        }
      } catch (e) {
        console.error('Error reading from SQLite:', e);
      }
    }

    // Fallback to disk JSON only if SQLite was empty or unavailable
    const { rootJsonPath, frontendJsonPath } = getStoragePaths();
    const searchPaths = [rootJsonPath, frontendJsonPath];
    for (const p of searchPaths) {
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
        try {
          const raw = fs.readFileSync(/*turbopackIgnore: true*/ p, 'utf8').trim();
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const res = parsed.map((inc: Incident) => {
                const failedSet = new Set((inc.failedMitigations || []).map(f => (f.action || '').trim().toLowerCase()));
                const failedCmds = new Set((inc.failedMitigations || []).map(f => (f.command || '').trim().toLowerCase()).filter(Boolean));
                return {
                  ...inc,
                  successfulMitigations: (inc.successfulMitigations || []).filter(m => {
                    const act = (m.action || '').trim().toLowerCase();
                    const cmd = (m.command || '').trim().toLowerCase();
                    if (failedSet.has(act)) return false;
                    if (cmd && failedCmds.has(cmd) && cmd !== '# manual command' && cmd !== '# execute command') return false;
                    return true;
                  })
                };
              });
              memoryCache = res;
              return res;
            }
          }
        } catch (err) {
          console.error('Failed to read fallback incidents:', err);
        }
      }
    }

    return memoryCache.length > 0 ? memoryCache : [];
  } catch (outerErr) {
    return memoryCache;
  }
}

export function clearAllIncidentsFromDb(): void {
  memoryCache = [];
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
  const { rootJsonPath, frontendJsonPath } = getStoragePaths();
  for (const p of [rootJsonPath, frontendJsonPath]) {
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
      try {
        fs.writeFileSync(p, '[]', 'utf8');
      } catch (e) {
        console.error(`Error clearing ${p}:`, e);
      }
    }
  }
}

export function recordFeedbackInDb(
  incidentId: string,
  actionId: string,
  outcome: 'worked' | 'failed',
  notes: string = '',
  engineer: string = 'oncall.engineer',
  actionTitle?: string,
  command?: string
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
          const newScore = Math.min(1.0, Math.round(((timesWorked + 1) / (timesAttempted + 1)) * 100) / 100);

          db.prepare(`
            UPDATE mitigations
            SET times_worked = ?, times_attempted = ?, success_score = ?
            WHERE id = ?
          `).run(timesWorked, timesAttempted, newScore, actionId);
        } else {
          db.prepare(`
            INSERT INTO mitigations (id, incident_id, action, command, times_worked, times_attempted, avg_resolution_minutes, success_score, notes)
            VALUES (?, ?, ?, ?, 1, 1, 5.0, 1.0, ?)
          `).run(actionId, incidentId, actionTitle || 'Verified Resolution Action', command || '# manual command', notes || '');
        }

        // Remove from anti_patterns if it was previously considered a failure
        try {
          db.prepare(`
            DELETE FROM anti_patterns
            WHERE incident_id = ? AND (action = ? OR (command != '' AND command != '# manual command' AND command = ?))
          `).run(incidentId, actionTitle || '', command || '');
        } catch (e) {}
      } else {
        const mitRow: any = db.prepare('SELECT * FROM mitigations WHERE id = ?').get(actionId);
        const resolvedAction = (mitRow ? mitRow.action : (actionTitle || 'Attempted Triage Action')).trim();
        const resolvedCmd = (mitRow ? mitRow.command : (command || '# attempted command')).trim();

        // 1. Remove permanently from mitigations table so it is NEVER suggested again as a solution!
        try {
          db.prepare(`
            DELETE FROM mitigations
            WHERE id = ? OR (incident_id = ? AND (action = ? OR (command != '' AND command != '# manual command' AND command = ?)))
          `).run(actionId, incidentId, resolvedAction, resolvedCmd);
        } catch (e) {}

        // 2. Add or update anti_patterns table
        const existingAnti: any = db.prepare(`
          SELECT * FROM anti_patterns
          WHERE incident_id = ? AND (action = ? OR (command != '' AND command != '# attempted command' AND command = ?))
        `).get(incidentId, resolvedAction, resolvedCmd);

        if (existingAnti) {
          db.prepare(`
            UPDATE anti_patterns
            SET times_failed = times_failed + 1, times_attempted = times_attempted + 1, failure_outcome = ?
            WHERE id = ?
          `).run(notes || existingAnti.failure_outcome, existingAnti.id);
        } else {
          const failId = `anti_${Date.now()}`;
          db.prepare(`
            INSERT INTO anti_patterns (id, incident_id, action, command, times_failed, times_attempted, danger_level, failure_outcome)
            VALUES (?, ?, ?, ?, 1, 1, 'HIGH', ?)
          `).run(failId, incidentId, resolvedAction, resolvedCmd, notes || 'Failed during triage attempt.');
        }
      }
    } catch (e) {
      console.error('Error logging feedback to SQLite:', e);
    }
  }

  // Update memoryCache immediately
  const cachedInc = memoryCache.find(i => i.id === incidentId);
  if (cachedInc) {
    if (outcome === 'worked') {
      const mit = (cachedInc.successfulMitigations || []).find(m => m.id === actionId);
      if (mit) {
        mit.timesWorked = (mit.timesWorked || 0) + 1;
        mit.timesAttempted = (mit.timesAttempted || 0) + 1;
        mit.successScore = Math.min(1.0, Math.round(((mit.timesWorked + 1) / (mit.timesAttempted + 1)) * 100) / 100);
        if (notes) mit.notes = `${mit.notes} [Confirmed: ${notes}]`;
      } else {
        cachedInc.successfulMitigations = cachedInc.successfulMitigations || [];
        cachedInc.successfulMitigations.push({
          id: actionId,
          action: actionTitle || 'Verified Resolution Action',
          command: command || '# manual command',
          timesWorked: 1,
          timesAttempted: 1,
          avgResolutionMinutes: 5.0,
          successScore: 1.0,
          notes: notes || 'Verified via user feedback'
        });
      }
      cachedInc.failedMitigations = (cachedInc.failedMitigations || []).filter(
        f => f.action.trim().toLowerCase() !== (actionTitle || mit?.action || '').trim().toLowerCase()
      );
    } else {
      const mit = (cachedInc.successfulMitigations || []).find(m => m.id === actionId);
      const resolvedAction = (mit ? mit.action : (actionTitle || 'Attempted Triage Action')).trim();
      const resolvedCmd = (mit ? mit.command : (command || '# attempted command')).trim();
      cachedInc.successfulMitigations = (cachedInc.successfulMitigations || []).filter(
        m => m.id !== actionId && m.action.trim().toLowerCase() !== resolvedAction.toLowerCase()
      );
    }
  }

  // Also update disk storage
  const { rootJsonPath, frontendJsonPath } = getStoragePaths();
  for (const jsonPath of [rootJsonPath, frontendJsonPath]) {
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ jsonPath)) {
        const raw = fs.readFileSync(/*turbopackIgnore: true*/ jsonPath, 'utf8').trim();
        if (!raw) continue;
        const list: Incident[] = JSON.parse(raw);
        const inc = list.find(i => i.id === incidentId);
        if (inc) {
          if (outcome === 'worked') {
            const mit = (inc.successfulMitigations || []).find(m => m.id === actionId);
            if (mit) {
              mit.timesWorked = (mit.timesWorked || 0) + 1;
              mit.timesAttempted = (mit.timesAttempted || 0) + 1;
              mit.successScore = Math.min(1.0, Math.round(((mit.timesWorked + 1) / (mit.timesAttempted + 1)) * 100) / 100);
              if (notes) {
                mit.notes = `${mit.notes} [Confirmed: ${notes}]`;
              }
            } else {
              inc.successfulMitigations = inc.successfulMitigations || [];
              inc.successfulMitigations.push({
                id: actionId,
                action: actionTitle || 'Verified Resolution Action',
                command: command || '# manual command',
                timesWorked: 1,
                timesAttempted: 1,
                avgResolutionMinutes: 5.0,
                successScore: 1.0,
                notes: notes || 'Verified via user feedback'
              });
            }

            // Remove from failedMitigations if present
            inc.failedMitigations = (inc.failedMitigations || []).filter(
              f => f.action.trim().toLowerCase() !== (actionTitle || mit?.action || '').trim().toLowerCase()
            );
          } else {
            const mit = (inc.successfulMitigations || []).find(m => m.id === actionId);
            const resolvedAction = (mit ? mit.action : (actionTitle || 'Attempted Triage Action')).trim();
            const resolvedCmd = (mit ? mit.command : (command || '# attempted command')).trim();

            // 1. Remove permanently from successfulMitigations!
            inc.successfulMitigations = (inc.successfulMitigations || []).filter(
              m => m.id !== actionId &&
                   m.action.trim().toLowerCase() !== resolvedAction.toLowerCase() &&
                   (!resolvedCmd || resolvedCmd === '# attempted command' || resolvedCmd === '# manual command' || m.command.trim() !== resolvedCmd)
            );

            // 2. Add or update in failedMitigations
            inc.failedMitigations = inc.failedMitigations || [];
            const existingAnti = inc.failedMitigations.find(
              f => f.action.trim().toLowerCase() === resolvedAction.toLowerCase() ||
                   (resolvedCmd && resolvedCmd !== '# attempted command' && resolvedCmd !== '# manual command' && f.command?.trim() === resolvedCmd)
            );

            if (existingAnti) {
              existingAnti.timesFailed = (existingAnti.timesFailed || 1) + 1;
              existingAnti.timesAttempted = (existingAnti.timesAttempted || existingAnti.timesFailed) + 1;
              existingAnti.failureRate = 1.0;
              if (notes) existingAnti.failureOutcome = notes;
            } else {
              inc.failedMitigations.push({
                id: `fail_${Date.now()}`,
                action: resolvedAction,
                command: resolvedCmd,
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
      console.error(`Error syncing feedback to disk (${jsonPath}):`, err);
    }
  }

  return true;
}