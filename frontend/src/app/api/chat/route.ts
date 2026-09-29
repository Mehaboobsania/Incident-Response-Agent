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

        if (!llmAnalysis.hasMatch && !primaryIncident) {
          return NextResponse.json({
            type: 'no_match',
            text: `🔍 **Zero-Day / Unrecorded Incident** (Analyzed by ${getLLMProvider()}):\n\n${llmAnalysis.diagnosis}\n\nSince this failure mode has not been recorded in our database yet, you can teach the agent once resolved:\n\n\`Learn incident: Service: your-service | Title: Incident name | Cause: Technical root cause | Fix: kubectl ... | Failed: Pod restart\``,
            searchResult: null
          });
        }

        // Format searchResult for frontend consumption
        const searchResult = {
          query: message,
          matchCount: primaryIncident ? 1 : 0,
          primaryIncident: primaryIncident || {
            id: 'INC-ZERO',
            title: llmAnalysis.diagnosis.slice(0, 60),
            service: 'production-service',
            environment: 'production',
            severity: 'P1' as const,
            createdAt: new Date().toISOString(),
            durationMinutes: 15,
            resolver: 'oncall.engineer',
            alertSignatures: [message],
            telemetry: {},
            rootCause: llmAnalysis.rootCause,
            successfulMitigations: [],
            failedMitigations: []
          },
          primaryConfidence: llmAnalysis.matchConfidence || 85,
          divergenceAlert: llmAnalysis.divergenceWarning ? {
            hasDivergenceRisk: true,
            type: 'AI Detected Divergence',
            warningText: llmAnalysis.divergenceWarning
          } : null,
          allMatches: [],
          rankedRecommendations: {
            verifiedFixes: (llmAnalysis.verifiedFixes || []).map(f => ({
              id: f.id || `fix_${Date.now()}`,
              action: f.action,
              command: f.command,
              avgResolutionMinutes: f.avgResolutionMinutes || 3.0,
              successScore: f.successScore || 0.9,
              timesWorked: 1,
              timesAttempted: 1,
              notes: f.notes || 'Generated by LLM from database historical precedent.'
            })),
            redHerrings: (llmAnalysis.pitfalls || []).map(p => ({
              id: p.id || `pitfall_${Date.now()}`,
              action: p.action,
              command: p.command || '# do not run',
              dangerLevel: p.dangerLevel || 'HIGH',
              failureOutcome: p.failureOutcome,
              timesFailed: 1,
              timesAttempted: 1
            }))
          },
          telemetryComparison: null
        };

        return NextResponse.json({
          type: 'incident_analysis',
          searchResult
        });
      } catch (llmErr: any) {
        console.error('LLM analysis error, falling back to database query:', llmErr);
      }
    }

    // 5. Fallback if LLM API Key is missing: Check database and guide user to set their API key
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
      text: `🔍 **Zero-Day Incident** (No LLM key configured):\n\nNo precedent found in database for "${message}".\n\n💡 **Tip**: Place your \`GEMINI_API_KEY\` or \`OPENAI_API_KEY\` into \`frontend/.env.local\` to enable intelligent AI reasoning across all your production alerts.`,
      searchResult: null
    });

  } catch (err: any) {
    console.error('Chat API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
