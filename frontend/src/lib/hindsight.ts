import fs from 'fs';
import path from 'path';
import {
  Incident,
  SearchResult,
  DivergenceAlert,
  MitigationAction,
  RedHerringAction,
  IncidentTelemetry
} from './types';

export class HindsightEngine {
  private dataPath: string;
  public incidents: Incident[] = [];
  private stopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
    'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
    'to', 'was', 'were', 'will', 'with', 'the', 'this', 'but', 'they'
  ]);

  constructor(customDataPath?: string) {
    this.dataPath = customDataPath || path.join(process.cwd(), 'src', 'lib', 'data', 'incidents.json');
    this.loadData();
  }

  public loadData(): void {
    try {
      const { getAllIncidentsFromDb } = require('./db');
      const fromDb = getAllIncidentsFromDb();
      if (Array.isArray(fromDb) && fromDb.length > 0) {
        this.incidents = fromDb;
        return;
      }
    } catch (dbErr) {
      // fallback
    }

    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        this.incidents = JSON.parse(raw);
      } else {
        const rootPath = path.resolve(process.cwd(), '..', 'data', 'incidents.json');
        if (fs.existsSync(rootPath)) {
          this.incidents = JSON.parse(fs.readFileSync(rootPath, 'utf8'));
        } else {
          this.incidents = [];
        }
      }
    } catch (err) {
      console.error('Failed to load incident memory store:', err);
      this.incidents = [];
    }
  }

  public saveData(): boolean {
    try {
      fs.writeFileSync(this.dataPath, JSON.stringify(this.incidents, null, 2), 'utf8');
      return true;
    } catch (err) {
      console.error('Failed to persist incident memory store:', err);
      return false;
    }
  }

  private normalizeWord(word: string): string {
    if (!word) return '';
    let w = word.toLowerCase().trim();
    if (w.endsWith('s') && w.length > 3) w = w.slice(0, -1);
    if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
    if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
    return w;
  }

  public tokenize(text: string): string[] {
    if (!text || typeof text !== 'string') return [];
    const tokens = new Set<string>();
    const rawWords = text.toLowerCase().split(/[^a-z0-9]+/);
    for (const w of rawWords) {
      if (w.length > 1 && !this.stopWords.has(w)) {
        tokens.add(w);
        const norm = this.normalizeWord(w);
        if (norm) tokens.add(norm);
      }
    }
    const hyphenated = text.toLowerCase().match(/[a-z0-9]+-[a-z0-9]+/g);
    if (hyphenated) {
      for (const h of hyphenated) tokens.add(h);
    }
    return Array.from(tokens);
  }

  private extractKeywords(incident: Incident): string[] {
    const textPieces = [
      incident.title,
      incident.service,
      incident.service ? incident.service.replace('-', ' ') : '',
      incident.rootCause,
      incident.environment,
      ...(incident.alertSignatures || []),
      incident.telemetry?.errorPattern || '',
      incident.slackContext || ''
    ];
    return this.tokenize(textPieces.join(' '));
  }

  public search(queryAlert: string | { title?: string; service?: string; message?: string; errorPattern?: string; alertSignature?: string; telemetry?: IncidentTelemetry }): SearchResult {
    this.loadData();
    let alertText = '';
    let incomingService = '';
    let incomingTelemetry: IncidentTelemetry = {};

    if (typeof queryAlert === 'string') {
      alertText = queryAlert;
      for (const inc of this.incidents) {
        const sName = inc.service.toLowerCase();
        const sClean = sName.replace('-', ' ');
        if (alertText.toLowerCase().includes(sName) || alertText.toLowerCase().includes(sClean)) {
          incomingService = inc.service;
          break;
        }
      }
    } else if (typeof queryAlert === 'object' && queryAlert !== null) {
      alertText = [
        queryAlert.title || '',
        queryAlert.service || '',
        queryAlert.message || '',
        queryAlert.errorPattern || '',
        queryAlert.alertSignature || ''
      ].join(' ');
      incomingService = queryAlert.service || '';
      incomingTelemetry = queryAlert.telemetry || {};
    }

    const queryTokens = this.tokenize(alertText);

    const scoredIncidents = this.incidents.map(incident => {
      const incKeywords = this.extractKeywords(incident);
      const incKeywordSet = new Set(incKeywords);

      let matchedCount = 0;
      for (const token of queryTokens) {
        if (incKeywordSet.has(token)) {
          matchedCount++;
        }
      }

      const matchRatio = queryTokens.length > 0 ? (matchedCount / queryTokens.length) : 0;

      let serviceMatch = false;
      const sName = incident.service.toLowerCase();
      const sClean = sName.replace('-', ' ');
      const qLower = alertText.toLowerCase();
      if (incomingService && incident.service.toLowerCase() === incomingService.toLowerCase()) {
        serviceMatch = true;
      } else if (qLower.includes(sName) || qLower.includes(sClean)) {
        serviceMatch = true;
      }

      let errorPatternMatch = false;
      if (incident.telemetry?.errorPattern && qLower.includes(incident.telemetry.errorPattern.toLowerCase().slice(0, 25))) {
        errorPatternMatch = true;
      }

      let totalScore = matchRatio * 55;
      if (serviceMatch) totalScore += 35;
      if (errorPatternMatch) totalScore += 20;

      if (serviceMatch && matchedCount >= 2) {
        totalScore = Math.max(totalScore, 75);
      }

      const confidencePercent = Math.min(99, Math.round(totalScore * 10) / 10);
      const divergence = this.detectDivergence(incident, incomingTelemetry, alertText);

      return {
        incident,
        confidencePercent,
        serviceMatch,
        errorPatternMatch,
        divergence
      };
    });

    scoredIncidents.sort((a, b) => b.confidencePercent - a.confidencePercent);
    const topMatches = scoredIncidents.filter(item => item.confidencePercent > 20);
    const bestMatch = topMatches.length > 0 ? topMatches[0] : null;

    const rankedRecommendations = this.rankMitigations(topMatches);

    return {
      query: queryAlert,
      matchCount: topMatches.length,
      primaryIncident: bestMatch ? bestMatch.incident : null,
      primaryConfidence: bestMatch ? bestMatch.confidencePercent : 0,
      divergenceAlert: bestMatch ? bestMatch.divergence : null,
      allMatches: topMatches,
      rankedRecommendations,
      telemetryComparison: bestMatch ? this.compareTelemetry(bestMatch.incident, incomingTelemetry) : null
    };
  }

  public detectDivergence(incident: Incident, incomingTelemetry: IncidentTelemetry, alertText: string): DivergenceAlert | null {
    if (!incomingTelemetry || Object.keys(incomingTelemetry).length === 0) {
      if (incident.divergenceWarning) {
        return {
          hasDivergenceRisk: true,
          type: "documented_divergence_warning",
          warningText: incident.divergenceWarning,
          guidance: "Historical note on deceptive alert patterns."
        };
      }
      return null;
    }

    const flags: Array<{ metric: string; expected: string; current: string; detail: string }> = [];

    // Dynamic telemetry comparison based strictly on database records
    if (incident.telemetry && incomingTelemetry) {
      for (const [metricKey, historicalVal] of Object.entries(incident.telemetry)) {
        if (!historicalVal) continue;
        const incomingVal = incomingTelemetry[metricKey];
        if (!incomingVal) continue;

        const numHist = parseFloat(historicalVal);
        const numInc = parseFloat(incomingVal);
        if (!isNaN(numHist) && !isNaN(numInc)) {
          // Detect divergence if numerical metrics conflict significantly (>= 30% difference)
          if (Math.abs(numHist - numInc) >= 30) {
            flags.push({
              metric: metricKey,
              expected: `${historicalVal} (Historical incident baseline)`,
              current: `${incomingVal} (Real-time telemetry conflicting)`,
              detail: `Incoming alert reports ${metricKey} = ${incomingVal}, whereas historical precedent ${incident.id} recorded ${metricKey} = ${historicalVal}.`
            });
          }
        }
      }
    }

    if (flags.length > 0) {
      return {
        hasDivergenceRisk: true,
        type: "active_telemetry_divergence",
        warningText: `⚠️ DIVERGENCE DETECTED: Surface alert matches ${incident.id} (${incident.title}), but real-time telemetry conflicts with historical profile!`,
        flags,
        recommendedAction: "Pause automated execution. Inspect telemetry flags before applying fixes to prevent exacerbating an unrelated root cause."
      };
    }

    if (incident.divergenceWarning) {
      return {
        hasDivergenceRisk: true,
        type: "documented_divergence_warning",
        warningText: incident.divergenceWarning,
        guidance: "Historical note on deceptive alert patterns."
      };
    }

    return null;
  }

  public rankMitigations(matches: Array<{ incident: Incident; confidencePercent: number }>): {
    verifiedFixes: MitigationAction[];
    redHerrings: RedHerringAction[];
  } {
    if (!matches || matches.length === 0) {
      return { verifiedFixes: [], redHerrings: [] };
    }

    const allSuccessful: MitigationAction[] = [];
    const allFailed: RedHerringAction[] = [];

    for (const match of matches) {
      const inc = match.incident;
      if (inc.successfulMitigations) {
        for (const m of inc.successfulMitigations) {
          allSuccessful.push({
            ...m,
            sourceIncidentId: inc.id,
            sourceIncidentTitle: inc.title,
            matchConfidence: match.confidencePercent,
            empiricalScore: m.successScore || ((m.timesWorked + 1) / (m.timesAttempted + 2))
          });
        }
      }

      if (inc.failedMitigations) {
        for (const f of inc.failedMitigations) {
          allFailed.push({
            ...f,
            sourceIncidentId: inc.id,
            sourceIncidentTitle: inc.title,
            matchConfidence: match.confidencePercent,
            failureRate: f.failureRate || (f.timesFailed / (f.timesAttempted || 1))
          });
        }
      }
    }

    allSuccessful.sort((a, b) => {
      const scoreA = a.empiricalScore ?? a.successScore ?? 0;
      const scoreB = b.empiricalScore ?? b.successScore ?? 0;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return (a.avgResolutionMinutes || 10) - (b.avgResolutionMinutes || 10);
    });

    allFailed.sort((a, b) => b.timesFailed - a.timesFailed);

    return {
      verifiedFixes: allSuccessful,
      redHerrings: allFailed
    };
  }

  private compareTelemetry(incident: Incident, incomingTelemetry: IncidentTelemetry) {
    if (!incomingTelemetry || Object.keys(incomingTelemetry).length === 0) {
      return null;
    }

    const comparison: Record<string, { historical: string; current: string }> = {};
    const keys = new Set([
      ...Object.keys(incident.telemetry || {}),
      ...Object.keys(incomingTelemetry || {})
    ]);

    for (const key of keys) {
      comparison[key] = {
        historical: incident.telemetry?.[key] || 'N/A',
        current: incomingTelemetry[key] || 'Not provided'
      };
    }

    return comparison;
  }

  public recordOutcome(
    incidentId: string,
    actionId: string,
    outcome: 'worked' | 'failed',
    details: {
      notes?: string;
      engineer?: string;
      durationMinutes?: number;
      actionTitle?: string;
      command?: string;
      dangerLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'FATAL';
    } = {}
  ) {
    const incident = this.incidents.find(i => i.id === incidentId);
    if (!incident) {
      return { success: false, message: `Incident ${incidentId} not found in memory.` };
    }

    const { notes, durationMinutes } = details;
    const actionItem = (incident.successfulMitigations || []).find(a => a.id === actionId);

    if (outcome === 'worked') {
      if (actionItem) {
        actionItem.timesWorked = (actionItem.timesWorked || 0) + 1;
        actionItem.timesAttempted = (actionItem.timesAttempted || actionItem.timesWorked) + 1;
        if (durationMinutes) {
          actionItem.avgResolutionMinutes = Math.round(((actionItem.avgResolutionMinutes || 5) + durationMinutes) / 2 * 10) / 10;
        }
        actionItem.successScore = Math.round(((actionItem.timesWorked + 1) / (actionItem.timesAttempted + 2)) * 100) / 100;
        if (notes) actionItem.notes = `${actionItem.notes || ''} [Latest: ${notes}]`;
      } else {
        const newFix: MitigationAction = {
          id: actionId || `act_${Date.now()}`,
          action: details.actionTitle || "Custom Live Resolution Action",
          command: details.command || "# executed manually in cluster",
          timesWorked: 1,
          timesAttempted: 1,
          avgResolutionMinutes: durationMinutes || 4.0,
          successScore: 0.67,
          notes: notes || "Recorded via IRA live feedback loop."
        };
        incident.successfulMitigations = incident.successfulMitigations || [];
        incident.successfulMitigations.push(newFix);
      }
    } else if (outcome === 'failed') {
      const failedItem = (incident.failedMitigations || []).find(f => f.id === actionId);
      if (failedItem) {
        failedItem.timesFailed = (failedItem.timesFailed || 0) + 1;
        failedItem.timesAttempted = (failedItem.timesAttempted || failedItem.timesFailed) + 1;
        failedItem.failureRate = Math.round((failedItem.timesFailed / failedItem.timesAttempted) * 100) / 100;
        if (notes) failedItem.failureOutcome = `${failedItem.failureOutcome} | Updated outcome: ${notes}`;
      } else {
        const newFailure: RedHerringAction = {
          id: actionId || `fail_${Date.now()}`,
          action: details.actionTitle || "Attempted Triage Action",
          command: details.command || "# executed command",
          timesFailed: 1,
          timesAttempted: 1,
          failureRate: 1.0,
          dangerLevel: details.dangerLevel || "HIGH",
          failureOutcome: notes || "Mitigation attempt failed to resolve alert or exacerbated service degradation."
        };
        incident.failedMitigations = incident.failedMitigations || [];
        incident.failedMitigations.push(newFailure);
      }

      if (actionItem) {
        actionItem.timesAttempted = (actionItem.timesAttempted || actionItem.timesWorked) + 1;
        actionItem.successScore = Math.round(((actionItem.timesWorked + 1) / (actionItem.timesAttempted + 2)) * 100) / 100;
      }
    }

    this.saveData();

    return {
      success: true,
      incidentId,
      actionId,
      outcome,
      updatedIncident: incident
    };
  }

  public registerIncident(newIncident: Partial<Incident>): Incident {
    if (!newIncident.id) {
      newIncident.id = `INC-${Math.floor(100 + Math.random() * 900)}`;
    }
    newIncident.createdAt = newIncident.createdAt || new Date().toISOString();
    const completeInc = newIncident as Incident;
    this.incidents.unshift(completeInc);
    this.saveData();
    return completeInc;
  }

  public generatePostmortem(incidentId: string): string | null {
    const inc = this.incidents.find(i => i.id === incidentId);
    if (!inc) return null;

    const successfulList = (inc.successfulMitigations || [])
      .map(s => `- **${s.action}** (Success Rate: ${Math.round((s.successScore || 0.9) * 100)}%, Avg MTTR: ${s.avgResolutionMinutes}m)\n  \`\`\`bash\n  ${s.command}\n  \`\`\`\n  *Notes:* ${s.notes}`)
      .join('\n\n');

    const failedList = (inc.failedMitigations || [])
      .map(f => `- **🚫 ${f.action}** [Danger Level: ${f.dangerLevel}]\n  \`\`\`bash\n  ${f.command}\n  \`\`\`\n  *What Failed:* ${f.failureOutcome}`)
      .join('\n\n');

    return `# Postmortem Report: ${inc.id} - ${inc.title}

## Overview
- **Incident ID:** ${inc.id}
- **Service:** \`${inc.service}\`
- **Severity:** \`${inc.severity}\`
- **Environment:** \`${inc.environment}\`
- **Resolver:** ${inc.resolver}
- **Duration / MTTR:** ${inc.durationMinutes} minutes

---

## Root Cause Analysis
${inc.rootCause}

---

## Real-Time Telemetry Snapshot
- **DB Connections:** ${inc.telemetry?.dbConnections || 'N/A'}
- **DB CPU:** ${inc.telemetry?.dbCpu || 'N/A'}
- **Redis Memory:** ${inc.telemetry?.redisMemory || 'N/A'}
- **Error Signature:** \`${inc.telemetry?.errorPattern || 'N/A'}\`

---

## 🛠️ Verified Mitigations (What Worked)
${successfulList || 'No verified mitigations recorded.'}

---

## ⚠️ Proven Red Herrings (What FAILED - Do Not Repeat)
> [!WARNING]
> IRA Memory Twist: Documenting failed actions is as vital as documenting successful ones to prevent junior and on-call engineers from exacerbating outages.

${failedList || 'No failed mitigations recorded.'}

---

## 🔍 Divergence & Disambiguation Guidance
${inc.divergenceWarning || 'Standard service signature.'}

---

## Key Lessons & Action Items
${inc.postmortemKeyTakeaways || 'Follow standard SRE reliability principles.'}

*Generated automatically by Incident Response Agent (IRA) Hindsight Memory Engine.*
`;
  }
}

let globalEngine: HindsightEngine | null = null;
export function getHindsightEngine(): HindsightEngine {
  if (!globalEngine) {
    globalEngine = new HindsightEngine();
  }
  return globalEngine;
}
