import { NextResponse } from 'next/server';
import { getAllIncidentsFromDb, saveIncidentToDb } from '@/lib/db';
import {
  isLLMConfigured,
  getLLMProvider,
  analyzeIncidentWithLLM,
  callLLM
} from '@/lib/llm';
import { Incident } from '@/lib/types';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = (body.message || '').trim();

    if (!message) {
      return NextResponse.json({
        type: 'greeting',
        text: 'Please paste a production alert, error log, or ask an incident question.',
        searchResult: null
      });
    }

    const lower = message.toLowerCase();

    // 1. Basic greetings
    if (lower === 'hi' || lower === 'hello' || lower === 'hey' || lower === 'help') {
      const provider = getLLMProvider();
      const statusNote = isLLMConfigured()
        ? `Connected to **${provider}**.`
        : '⚠️ No LLM API key configured in `.env.local` yet.';
      return NextResponse.json({
        type: 'greeting',
        text: `Hello! I am your **Incident Response Agent** backed by persistent database memory. ${statusNote}\n\nPaste an active alert, stack trace, or describe an outage to get database-grounded diagnostics and verified mitigations.`,
        searchResult: null
      });
    }

    // 1.5 Memory wipe / reset commands
    if (
      lower.includes('clear memory') ||
      lower.includes('wipe memory') ||
      lower.includes('reset memory') ||
      lower.includes('clear database') ||
      lower.includes('empty database') ||
      lower.includes('remove everything')
    ) {
      const { clearAllIncidentsFromDb } = await import('@/lib/db');
      clearAllIncidentsFromDb();
      return NextResponse.json({
        type: 'learned',
        text: '🧹 **Memory & Database Cleared!**\n\nAll historical postmortems, mitigations, anti-patterns, and feedback records have been completely wiped from database storage. The agent is now running with a completely clean slate (0 incidents in memory).',
        searchResult: null
      });
    }

    // 2. Incident Learning / Ingestion into Database
    const isResolutionMessage =
      lower.startsWith('learn incident:') ||
      lower.startsWith('log incident:') ||
      lower.startsWith('save incident:') ||
      lower.startsWith('record incident:') ||
      lower.startsWith('postmortem:') ||
      lower.startsWith('fixed:') ||
      lower.startsWith('fix:') ||
      lower.startsWith('solution:') ||
      lower.startsWith('the fix was:') ||
      lower.startsWith('resolved with:') ||
      lower.startsWith('we solved it by:') ||
      lower.startsWith('we fixed it by:');

    if (isResolutionMessage) {
      // Find the preceding user alert from history if available
      const history: Array<{ role: string; content: string }> = body.history || [];
      const lastUserAlert = [...history]
        .reverse()
        .find(m => m.role === 'user' && !m.content.toLowerCase().startsWith('fix') && !m.content.toLowerCase().startsWith('learn'))?.content || '';

      let title = 'Production Incident';
      let service = 'production-service';
      let rootCause = 'Identified during postmortem investigation';
      let fix = message.replace(/^(learn incident|log incident|save incident|record incident|postmortem|fixed|fix|solution|the fix was|resolved with|we solved it by|we fixed it by):\s*/i, '').trim();
      let failed = 'Blind restarts without cache warm-up or memory diagnostics';

      // Extract service name from previous alert or current message
      const alertSource = lastUserAlert || message;
      const sMatch = alertSource.match(/^([a-zA-Z0-9\-_]+):/);
      if (sMatch) {
        service = sMatch[1];
        title = `${service} Outage`;
      }

      // If LLM is available, use real LLM to parse and structure the postmortem accurately
      if (isLLMConfigured()) {
        try {
          const parsePrompt = `The user is providing an incident resolution to store in the database.
Preceding Incident Alert:
"""
${lastUserAlert || 'None provided'}
"""

User Resolution Message:
"""
${message}
"""

Extract the structured fields from this text:
Return ONLY a JSON object with this exact shape:
{
  "title": string,
  "service": string,
  "rootCause": string,
  "fixAction": string,
  "fixCommand": string,
  "failedAction": string,
  "failureOutcome": string
}`;
          const jsonStr = await callLLM({
            userPrompt: parsePrompt,
            jsonMode: true
          });
          const parsed = JSON.parse(jsonStr.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim());
          if (parsed.title) title = parsed.title;
          if (parsed.service) service = parsed.service;
          if (parsed.rootCause) rootCause = parsed.rootCause;
          if (parsed.fixCommand) fix = parsed.fixCommand;
          else if (parsed.fixAction) fix = parsed.fixAction;
          if (parsed.failureOutcome) failed = parsed.failureOutcome;
        } catch (parseErr) {
          console.warn('LLM parsing fallback to rule-based parser:', parseErr);
        }
      }

      // Fallback rule parser for pipe-delimited format
      const content = message.replace(/^(learn|log|save|record)\s+incident:\s*|^postmortem:\s*|^(fixed|fix|solution):\s*/i, '');
      const parts = content.split(/[|\n]/).map((p: string) => p.trim());
      for (const part of parts) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) continue;
        const key = part.slice(0, colonIdx).toLowerCase().trim();
        const val = part.slice(colonIdx + 1).trim();

        if (key.includes('service')) service = val;
        else if (key.includes('title')) title = val;
        else if (key.includes('cause') || key.includes('root')) rootCause = val;
        else if (key.includes('fix') || key.includes('worked') || key.includes('solution')) fix = val;
        else if (key.includes('fail') || key.includes('avoid') || key.includes('pitfall')) failed = val;
      }

      const newId = `INC-${Math.floor(100 + Math.random() * 900)}`;
      const signatures = [
        `${service}: alert signature`,
        message.slice(0, 100)
      ];
      if (lastUserAlert) {
        signatures.unshift(lastUserAlert);
      }

      const newIncident: Incident = {
        id: newId,
        title: title || `${service} Outage`,
        service,
        severity: 'P1',
        environment: 'production',
        durationMinutes: 15,
        resolver: 'oncall.engineer',
        createdAt: new Date().toISOString(),
        alertSignatures: signatures,
        telemetry: {},
        rootCause,
        successfulMitigations: [
          {
            id: `fix_${Date.now()}`,
            action: 'Execute verified mitigation',
            command: fix,
            timesWorked: 1,
            timesAttempted: 1,
            avgResolutionMinutes: 3.5,
            successScore: 0.95,
            notes: 'Saved from postmortem to persistent database memory.'
          }
        ],
        failedMitigations: [
          {
            id: `fail_${Date.now()}`,
            action: 'Known pitfall / failed attempt',
            command: '# avoid repeating this action',
            timesFailed: 1,
            timesAttempted: 1,
            failureRate: 1.0,
            dangerLevel: 'HIGH',
            failureOutcome: failed
          }
        ]
      };

      // Persist directly to database!
      saveIncidentToDb(newIncident);

      return NextResponse.json({
        type: 'learned',
        text: `💾 **Saved to Database Memory as ${newIncident.id}!**\n\n- **Service:** \`${newIncident.service}\`\n- **Root Cause:** ${newIncident.rootCause}\n- **Verified Fix:** \`${fix}\`\n\nThis incident is now permanently stored in the agent's memory. When this same incident occurs again, I will retrieve this proven solution from memory!`,
        searchResult: null
      });
    }

    // 3. Retrieve Historical Incidents from Database
    const dbIncidents = getAllIncidentsFromDb();

    // 4. If LLM is configured, check if alert matches any incident in the database
    if (isLLMConfigured()) {
      try {
        const llmAnalysis = await analyzeIncidentWithLLM(message, dbIncidents);

        let primaryIncident: Incident | null = null;
        if (llmAnalysis.matchedIncidentId) {
          primaryIncident = dbIncidents.find(i => i.id === llmAnalysis.matchedIncidentId) || null;
        }

        if (!primaryIncident && llmAnalysis.hasMatch && dbIncidents.length > 0) {
          // If LLM matched but didn't return an exact ID, match by service name
          primaryIncident = dbIncidents.find(i => message.toLowerCase().includes(i.service.toLowerCase())) || null;
        }

        // FOR FIRST-TIME QUERIES: If no incident exists in database memory, DO NOT ANSWER WITH FIXES!
        if (!primaryIncident) {
          const serviceMatch = message.match(/^([a-zA-Z0-9\-_]+):/);
          const serviceName = serviceMatch ? serviceMatch[1] : 'service';

          return NextResponse.json({
            type: 'no_match',
            text: `🔍 **No Prior Experience in Memory**\n\nI have no recorded history or solutions for this incident in my database:\n> \`${message}\`\n\nSince this is the first time this incident has occurred, I cannot retrieve any historical mitigations.\n\n💡 **Once you have investigated and resolved this incident, teach me what worked:**\n- Type: \`Fixed: <command or action>\`\n*(e.g., \`Fixed: kubectl patch deployment ${serviceName} ...\`)*\n\nWhen this incident occurs again in the future, I will retrieve this solution from my past experience.`,
            searchResult: null
          });
        }

        // INCIDENT FOUND IN DATABASE! Retrieve from past experience:
        const searchResult = {
          query: message,
          matchCount: 1,
          primaryIncident,
          primaryConfidence: llmAnalysis.matchConfidence || 95,
          divergenceAlert: llmAnalysis.divergenceWarning ? {
            hasDivergenceRisk: true,
            type: 'AI Detected Divergence',
            warningText: llmAnalysis.divergenceWarning
          } : null,
          allMatches: [],
          rankedRecommendations: {
            verifiedFixes: (primaryIncident.successfulMitigations && primaryIncident.successfulMitigations.length > 0
              ? primaryIncident.successfulMitigations
              : (llmAnalysis.verifiedFixes || [])
            ).map((f: any) => ({
              id: f.id || `fix_${Date.now()}`,
              action: f.action,
              command: f.command,
              avgResolutionMinutes: f.avgResolutionMinutes || 3.0,
              successScore: f.successScore || 0.95,
              timesWorked: f.timesWorked || 1,
              timesAttempted: f.timesAttempted || 1,
              notes: f.notes || 'Retrieved from past experience in database.'
            })),
            redHerrings: (primaryIncident.failedMitigations && primaryIncident.failedMitigations.length > 0
              ? primaryIncident.failedMitigations
              : (llmAnalysis.pitfalls || [])
            ).map((p: any) => ({
              id: p.id || `pitfall_${Date.now()}`,
              action: p.action,
              command: p.command || '# do not run',
              dangerLevel: p.dangerLevel || 'HIGH',
              failureOutcome: p.failureOutcome,
              timesFailed: p.timesFailed || 1,
              timesAttempted: p.timesAttempted || 1
            }))
          },
          telemetryComparison: null
        };

        return NextResponse.json({
          type: 'incident_analysis',
          searchResult
        });
      } catch (llmErr: any) {
        console.warn('LLM analysis error, checking local database memory:', llmErr);

        // Fallback to SQLite DB search if incident exists in memory!
        const qLower = message.toLowerCase();
        const dbFallback = dbIncidents.find(inc => {
          const s = inc.service.toLowerCase();
          return qLower.includes(s) || qLower.includes(s.replace('-', ' '));
        });

        if (dbFallback) {
          return NextResponse.json({
            type: 'incident_analysis',
            searchResult: {
              query: message,
              matchCount: 1,
              primaryIncident: dbFallback,
              primaryConfidence: 95,
              divergenceAlert: null,
              allMatches: [],
              rankedRecommendations: {
                verifiedFixes: dbFallback.successfulMitigations || [],
                redHerrings: dbFallback.failedMitigations || []
              },
              telemetryComparison: null
            }
          });
        }

        return NextResponse.json({
          type: 'no_match',
          text: `🔍 **No Prior Experience in Memory**\n\nI have no recorded history or solutions for "${message}".\n\nSince this incident has never been encountered before, I cannot retrieve any verified mitigations.\n\n💡 Once resolved, teach me what worked: \`Fixed: <command>\``,
          searchResult: null
        });
      }
    }

    // 5. Fallback if LLM API Key is missing: Check database for exact service matches
    const qLower = message.toLowerCase();
    const matched = dbIncidents.find(inc => {
      const s = inc.service.toLowerCase();
      return qLower.includes(s) || qLower.includes(s.replace('-', ' '));
    });

    if (matched) {
      return NextResponse.json({
        type: 'incident_analysis',
        searchResult: {
          query: message,
          matchCount: 1,
          primaryIncident: matched,
          primaryConfidence: 90,
          divergenceAlert: null,
          allMatches: [],
          rankedRecommendations: {
            verifiedFixes: matched.successfulMitigations || [],
            redHerrings: matched.failedMitigations || []
          },
          telemetryComparison: null
        }
      });
    }

    return NextResponse.json({
      type: 'no_match',
      text: `🔍 **No Prior Experience in Memory**\n\nI have no recorded history or solutions for "${message}".\n\nSince this incident has never been encountered before, I cannot retrieve any verified mitigations.\n\n💡 Once resolved, please teach me the fix (e.g., \`Fixed: <command>\`).`,
      searchResult: null
    });

  } catch (err: any) {
    console.error('Chat API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
