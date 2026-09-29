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

    // 2. Incident Learning / Ingestion into Database
    if (
      lower.startsWith('learn incident:') ||
      lower.startsWith('log incident:') ||
      lower.startsWith('save incident:') ||
      lower.startsWith('record incident:') ||
      lower.startsWith('postmortem:')
    ) {
      let title = 'Production Incident';
      let service = 'production-service';
      let rootCause = 'Identified during postmortem investigation';
      let fix = 'kubectl rollout restart';
      let failed = 'Blind restarts without cache warm-up';

      // If LLM is available, use real LLM to parse and structure the postmortem accurately
      if (isLLMConfigured()) {
        try {
          const parsePrompt = `The user is providing an incident postmortem to store in the database.
Extract the structured fields from this text:
"""
${message}
"""

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
          if (parsed.failureOutcome) failed = parsed.failureOutcome;
        } catch (parseErr) {
          console.warn('LLM parsing fallback to rule-based parser:', parseErr);
        }
      }

      // Fallback rule parser for pipe-delimited format
      const content = message.replace(/^(learn|log|save|record)\s+incident:\s*|^postmortem:\s*/i, '');
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
      const newIncident: Incident = {
        id: newId,
        title: title || `${service} Outage`,
        service,
        severity: 'P1',
        environment: 'production',
        durationMinutes: 15,
        resolver: 'oncall.engineer',
        createdAt: new Date().toISOString(),
        alertSignatures: [
          `${service}: alert signature`,
          message.slice(0, 100)
        ],
        telemetry: {
          appCpu: '80%',
          redisMemory: 'Normal',
          dbConnections: 'Normal'
        },
        rootCause,
        successfulMitigations: [
          {
            id: `act_${Date.now()}`,
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
        text: `💾 **Saved directly to Database as ${newIncident.id}!**\n\n- **Service:** \`${newIncident.service}\`\n- **Root Cause:** ${newIncident.rootCause}\n- **Verified Fix:** \`${fix}\`\n- **Anti-Pattern Recorded:** ${failed}\n\nThis incident is now permanently stored in the database. Future alerts matching this issue will immediately surface this solution!`,
        searchResult: null
      });
    }

    // 3. Retrieve Historical Incidents from Database
    const dbIncidents = getAllIncidentsFromDb();

    // 4. If LLM is configured, run Real LLM Reasoning grounded in the Database
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

        let activeIncident: Incident;
        const isZeroDay = !primaryIncident;

        if (primaryIncident) {
          activeIncident = primaryIncident;
        } else {
          // Zero-day incident: synthesize an incident from LLM reasoning and persist into memory!
          const serviceMatch = message.match(/^([a-zA-Z0-9\-_]+):/);
          const serviceName = serviceMatch ? serviceMatch[1] : (message.split(' ')[0] || 'production-service');
          const autoId = `INC-${Math.floor(100 + Math.random() * 900)}`;

          activeIncident = {
            id: autoId,
            title: llmAnalysis.diagnosis ? llmAnalysis.diagnosis.slice(0, 65) : 'Zero-Day Production Incident',
            service: serviceName,
            environment: 'production',
            severity: 'P1' as const,
            createdAt: new Date().toISOString(),
            durationMinutes: 15,
            resolver: 'ai.incident-agent',
            alertSignatures: [message],
            telemetry: {},
            rootCause: llmAnalysis.rootCause || 'Zero-day failure under active investigation',
            successfulMitigations: (llmAnalysis.verifiedFixes || []).map((f, idx) => ({
              id: f.id || `fix_${idx + 1}`,
              action: f.action,
              command: f.command,
              avgResolutionMinutes: f.avgResolutionMinutes || 3.0,
              successScore: f.successScore || 0.88,
              timesWorked: 1,
              timesAttempted: 1,
              notes: f.notes || 'Proposed by AI reasoning.'
            })),
            failedMitigations: (llmAnalysis.pitfalls || []).map((p, idx) => ({
              id: p.id || `pitfall_${idx + 1}`,
              action: p.action,
              command: p.command || '# do not execute',
              dangerLevel: p.dangerLevel || 'HIGH',
              failureOutcome: p.failureOutcome,
              timesFailed: 1,
              timesAttempted: 1
            }))
          };

          // Save directly into SQLite memory so it becomes precedent for future incidents!
          saveIncidentToDb(activeIncident);
        }

        // Format searchResult for frontend consumption
        const searchResult = {
          query: message,
          matchCount: 1,
          primaryIncident: activeIncident,
          primaryConfidence: isZeroDay ? 90 : (llmAnalysis.matchConfidence || 95),
          divergenceAlert: llmAnalysis.divergenceWarning ? {
            hasDivergenceRisk: true,
            type: 'AI Detected Divergence',
            warningText: llmAnalysis.divergenceWarning
          } : null,
          allMatches: [],
          rankedRecommendations: {
            verifiedFixes: (llmAnalysis.verifiedFixes && llmAnalysis.verifiedFixes.length > 0
              ? llmAnalysis.verifiedFixes
              : activeIncident.successfulMitigations || []
            ).map((f: any) => ({
              id: f.id || `fix_${Date.now()}`,
              action: f.action,
              command: f.command,
              avgResolutionMinutes: f.avgResolutionMinutes || 3.0,
              successScore: f.successScore || 0.9,
              timesWorked: f.timesWorked || 1,
              timesAttempted: f.timesAttempted || 1,
              notes: f.notes || (isZeroDay ? 'AI synthesized mitigation. Test and mark feedback below.' : 'Grounded in historical postmortem.')
            })),
            redHerrings: (llmAnalysis.pitfalls && llmAnalysis.pitfalls.length > 0
              ? llmAnalysis.pitfalls
              : activeIncident.failedMitigations || []
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
          text: `⚠️ **AI Inference Notice** (${getLLMProvider()}):\n\n${llmErr?.message || 'Error occurred while contacting Groq AI.'}\n\nPlease check your \`GROQ_API_KEY\` and configuration in \`frontend/.env.local\`.`,
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
          primaryConfidence: 85,
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
      text: `🔍 **Zero-Day Incident** (No precedent in database memory):\n\nNo precedent found in database for "${message}".\n\n💡 **Tip**: Place your \`GROQ_API_KEY\`, \`GEMINI_API_KEY\`, or \`OPENAI_API_KEY\` into \`frontend/.env.local\` to enable intelligent AI reasoning across all production alerts.`,
      searchResult: null
    });

  } catch (err: any) {
    console.error('Chat API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
