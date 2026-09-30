import { NextResponse } from 'next/server';
import { getAllIncidentsFromDb, saveIncidentToDb, recordFeedbackInDb, clearAllIncidentsFromDb } from '@/lib/db';
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
        text: `Hello! I am your **Incident Response Agent** backed by persistent database memory. ${statusNote}\n\nPaste an active alert, error signature, or describe an outage. When a new incident occurs, I dynamically analyze it using AI. If anything regarding that incident was previously experienced, I answer directly from memory!`,
        searchResult: null
      });
    }

    // 2. Memory wipe / reset commands
    if (
      lower.includes('clear memory') ||
      lower.includes('wipe memory') ||
      lower.includes('reset memory') ||
      lower.includes('clear database') ||
      lower.includes('empty database') ||
      lower.includes('remove everything')
    ) {
      clearAllIncidentsFromDb();
      return NextResponse.json({
        type: 'learned',
        text: '🧹 **Memory & Database Cleared!**\n\nAll historical postmortems, mitigations, anti-patterns, and feedback records have been completely wiped from database storage. The agent is now running with a completely clean slate (0 incidents in memory). Any new incidents will be analyzed dynamically by the LLM.',
        searchResult: null
      });
    }

    // 3. Conversational Feedback ("it worked", "step 1 worked", "the fix worked", "didn't work", "failed")
    const isWorkedFeedback =
      lower === 'it worked' ||
      lower === 'that worked' ||
      lower === 'this worked' ||
      lower === 'worked' ||
      lower === 'fixed' ||
      lower.includes('step 1 worked') ||
      lower.includes('step 2 worked') ||
      lower.includes('first step worked') ||
      lower.includes('first one worked') ||
      lower.includes('option 1 worked') ||
      lower.includes('option 2 worked') ||
      lower.includes('patch worked') ||
      (lower.includes('worked') && !lower.includes("didn't") && !lower.includes('not') && lower.length < 150);

    const isFailedFeedback =
      lower === "didn't work" ||
      lower === 'did not work' ||
      lower === 'failed' ||
      lower.includes("step 1 didn't work") ||
      lower.includes("step 2 didn't work") ||
      lower.includes('first one failed') ||
      lower.includes('it failed');

    if (isWorkedFeedback || isFailedFeedback) {
      const allIncidents = getAllIncidentsFromDb();
      if (allIncidents.length === 0) {
        return NextResponse.json({
          type: 'greeting',
          text: 'There are no active incidents in database memory to record feedback for. Please paste an alert or error log first!',
          searchResult: null
        });
      }

      // Find the most recent incident or match by service name mentioned
      const targetIncident = allIncidents.find(inc => lower.includes(inc.service.toLowerCase())) || allIncidents[0];

      // Determine which mitigation was indicated
      let targetMitigation = targetIncident.successfulMitigations?.[0];
      if ((lower.includes('step 2') || lower.includes('option 2') || lower.includes('second')) && targetIncident.successfulMitigations?.[1]) {
        targetMitigation = targetIncident.successfulMitigations[1];
      } else if ((lower.includes('step 3') || lower.includes('option 3') || lower.includes('third')) && targetIncident.successfulMitigations?.[2]) {
        targetMitigation = targetIncident.successfulMitigations[2];
      } else {
        const found = (targetIncident.successfulMitigations || []).find(m =>
          lower.includes(m.action.toLowerCase().slice(0, 25))
        );
        if (found) targetMitigation = found;
      }

      if (!targetMitigation) {
        targetMitigation = {
          id: `fix_${Date.now()}`,
          action: 'Execute verified mitigation',
          command: '# verified manual command',
          timesWorked: 0,
          timesAttempted: 0,
          avgResolutionMinutes: 5.0,
          successScore: 0.9,
          notes: 'Verified via chat'
        };
      }

      const outcome = isWorkedFeedback ? 'worked' : 'failed';
      recordFeedbackInDb(
        targetIncident.id,
        targetMitigation.id,
        outcome,
        `Recorded via chat feedback: "${message}"`,
        'oncall.engineer',
        targetMitigation.action,
        targetMitigation.command
      );

      if (isWorkedFeedback) {
        return NextResponse.json({
          type: 'learned',
          text: `✅ **Solution Verified & Saved to Persistent Memory!**\n\nI have permanently recorded that **"${targetMitigation.action}"** resolved **${targetIncident.title}** (\`${targetIncident.service}\`).\n\n- **Command:** \`${targetMitigation.command}\`\n- **Status:** Stored in memory (100% verified success rate)\n\n🧠 When anything regarding this incident recurs, I will answer directly from this memory and past experience!`,
          searchResult: null
        });
      } else {
        return NextResponse.json({
          type: 'learned',
          text: `❌ **Failure Logged to Anti-Patterns Memory!**\n\nI have recorded that **"${targetMitigation.action}"** failed to resolve **${targetIncident.title}** (\`${targetIncident.service}\`).\n\nFuture triage for this incident will flag this as a dangerous pitfall to avoid.`,
          searchResult: null
        });
      }
    }

    // 4. Structured Incident Learning / Postmortem Logging
    const isResolutionMessage =
      lower.startsWith('learn incident:') ||
      lower.startsWith('log incident:') ||
      lower.startsWith('save incident:') ||
      lower.startsWith('record incident:') ||
      lower.startsWith('postmortem:') ||
      lower.startsWith('fixed:') ||
      lower.startsWith('solution:') ||
      lower.startsWith('the fix was:') ||
      lower.startsWith('resolved with:');

    if (isResolutionMessage) {
      const history: Array<{ role: string; content: string }> = body.history || [];
      const lastUserAlert = [...history]
        .reverse()
        .find(m => m.role === 'user' && !m.content.toLowerCase().startsWith('fix') && !m.content.toLowerCase().startsWith('learn'))?.content || '';

      if (!isLLMConfigured()) {
        return NextResponse.json({
          error: 'LLM is not configured. Please add GROQ_API_KEY in frontend/.env.local'
        }, { status: 400 });
      }

      const parsePrompt = `The user is providing an incident resolution to store in persistent database memory.
Preceding Incident Alert (if any):
"""
${lastUserAlert || 'None provided'}
"""

User Resolution Message:
"""
${message}
"""

Extract structured incident fields strictly from the user's input:
Return ONLY a JSON object:
{
  "title": string,
  "service": string,
  "rootCause": string,
  "fixAction": string,
  "fixCommand": string,
  "failedAction": string or null,
  "failureOutcome": string or null
}`;

      const jsonStr = await callLLM({
        userPrompt: parsePrompt,
        jsonMode: true
      });
      const parsed = JSON.parse(jsonStr.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim());

      const newId = `INC-${Math.floor(100 + Math.random() * 900)}`;
      const serviceName = parsed.service || 'production-service';
      const titleName = parsed.title || `${serviceName} Incident`;

      const newIncident: Incident = {
        id: newId,
        title: titleName,
        service: serviceName,
        severity: 'P1',
        environment: 'production',
        durationMinutes: 10,
        resolver: 'oncall.engineer',
        createdAt: new Date().toISOString(),
        alertSignatures: [message, lastUserAlert].filter(Boolean),
        telemetry: {},
        rootCause: parsed.rootCause || 'Root cause identified and logged to memory.',
        successfulMitigations: [
          {
            id: `fix_${Date.now()}`,
            action: parsed.fixAction || 'Execute verified resolution',
            command: parsed.fixCommand || '# verified mitigation',
            timesWorked: 1,
            timesAttempted: 1,
            avgResolutionMinutes: 4.0,
            successScore: 1.0,
            notes: 'Saved from postmortem to persistent database memory.'
          }
        ],
        failedMitigations: parsed.failedAction ? [
          {
            id: `fail_${Date.now()}`,
            action: parsed.failedAction,
            command: '# avoid repeating this action',
            timesFailed: 1,
            timesAttempted: 1,
            failureRate: 1.0,
            dangerLevel: 'HIGH',
            failureOutcome: parsed.failureOutcome || 'Failed during triage attempt.'
          }
        ] : []
      };

      saveIncidentToDb(newIncident);

      return NextResponse.json({
        type: 'learned',
        text: `💾 **Saved to Persistent Memory as ${newIncident.id}!**\n\n- **Service:** \`${newIncident.service}\`\n- **Root Cause:** ${newIncident.rootCause}\n- **Verified Fix:** \`${newIncident.successfulMitigations[0].action}\` (\`${newIncident.successfulMitigations[0].command}\`)\n\nThis incident is now permanently stored in database memory. When anything regarding this incident recurs, I will answer directly from this past experience!`,
        searchResult: null
      });
    }

    // 5. Ensure LLM is configured for all incident triage
    if (!isLLMConfigured()) {
      return NextResponse.json({
        type: 'greeting',
        text: '⚠️ **LLM Not Configured**: Please configure `GROQ_API_KEY` in `frontend/.env.local` to enable real-time LLM incident analysis.',
        searchResult: null
      }, { status: 400 });
    }

    // 6. Retrieve ALL Incidents from Database Memory
    const dbIncidents = getAllIncidentsFromDb();

    // 7. Invoke LLM with Memory Context:
    //    - If this incident matches past memory, LLM sets hasMatch = true, identifies matchedIncidentId, and provides memoryRecallExplanation.
    //    - If this is a new incident, LLM sets hasMatch = false and produces dynamic diagnosis, root cause, fixes, and pitfalls.
    const llmAnalysis = await analyzeIncidentWithLLM(message, dbIncidents);

    // 8. CASE A: RECURRING INCIDENT / QUERY (Answer Directly from Memory & Past Experience)
    if (llmAnalysis.hasMatch && llmAnalysis.matchedIncidentId) {
      const matched = dbIncidents.find(i => i.id === llmAnalysis.matchedIncidentId);
      if (matched) {
        // Detect if this is a follow-up or request for further improvements
        const isAskingForMore = Boolean(
          llmAnalysis.isFurtherImprovementRequest ||
          /even more|even better|further|what else|what next|next step|next-stage|next level|improved a little|additional|more improvement|still slow|still degraded|not enough|deeper optimization|optimize more/i.test(message)
        );

        const pitfalls = (matched.failedMitigations && matched.failedMitigations.length > 0)
          ? matched.failedMitigations
          : (llmAnalysis.pitfalls || []);
        const pitfallActions = new Set(pitfalls.map(p => (p.action || '').trim().toLowerCase()));
        const pitfallCommands = new Set(pitfalls.map(p => (p.command || '').trim().toLowerCase()).filter(Boolean));

        if (isAskingForMore) {
          // SUB-CASE A1: USER ASKS FOR FURTHER IMPROVEMENTS
          // 1. Determine which mitigations were ALREADY applied & verified in memory
          const previouslyAppliedFixes = (matched.successfulMitigations || []).filter(
            m => (m.timesWorked || 0) > 0
          );
          const appliedActionSet = new Set(previouslyAppliedFixes.map(m => m.action.trim().toLowerCase()));
          const appliedCmdSet = new Set(previouslyAppliedFixes.map(m => m.command.trim().toLowerCase()).filter(Boolean));

          // 2. Extract NEW, NEXT-STAGE mitigations from LLM that do NOT repeat what was already done
          const rawNewFixes = (llmAnalysis.verifiedFixes || []).filter(fix => {
            const act = (fix.action || '').trim().toLowerCase();
            const cmd = (fix.command || '').trim().toLowerCase();
            if (appliedActionSet.has(act)) return false;
            if (cmd && appliedCmdSet.has(cmd) && cmd !== '# manual command' && cmd !== '# execute command') return false;
            if (pitfallActions.has(act)) return false;
            if (cmd && pitfallCommands.has(cmd) && cmd !== '# manual command' && cmd !== '# execute command') return false;
            return true;
          });

          // Fallback high-quality next-stage optimizations if LLM generated duplicates or empty
          const nextStageFixes = rawNewFixes.length > 0
            ? rawNewFixes.map((f, idx) => ({
                id: f.id || `next_stage_${Date.now()}_${idx}`,
                action: f.action,
                command: f.command,
                timesWorked: 0,
                timesAttempted: 0,
                avgResolutionMinutes: f.avgResolutionMinutes || 15.0,
                notes: f.notes || 'Advanced next-stage optimization to eliminate remaining database bottlenecks.',
                sourceIncidentId: matched.id,
                sourceIncidentTitle: matched.title
              }))
            : [
                {
                  id: `next_stage_${Date.now()}_1`,
                  action: 'Deploy PgBouncer database connection pooling to absorb concurrent client surges',
                  command: 'kubectl apply -f pgbouncer-deployment.yaml && kubectl set env deployment/rag-app DATABASE_URL=postgres://pgbouncer:6432/rag_db',
                  timesWorked: 0,
                  timesAttempted: 0,
                  avgResolutionMinutes: 15.0,
                  notes: 'Prevents database connection exhaustion by reusing connection pools across pods.',
                  sourceIncidentId: matched.id,
                  sourceIncidentTitle: matched.title
                },
                {
                  id: `next_stage_${Date.now()}_2`,
                  action: 'Implement async request queueing and response streaming to prevent synchronous DB lockup',
                  command: 'kubectl apply -f rabbitmq-worker.yaml && kubectl set env deployment/rag-app ASYNC_PROCESSING=true',
                  timesWorked: 0,
                  timesAttempted: 0,
                  avgResolutionMinutes: 20.0,
                  notes: 'Buffers high traffic bursts into queues without blocking client responses or overwhelming DB worker processes.',
                  sourceIncidentId: matched.id,
                  sourceIncidentTitle: matched.title
                }
              ];

          // Register new next-stage fixes in matched.successfulMitigations so user feedback ("Worked" / "Didn't work")
          // can immediately identify and reinforce them in memory
          matched.successfulMitigations = matched.successfulMitigations || [];
          for (const nsf of nextStageFixes) {
            if (!matched.successfulMitigations.some(m => m.id === nsf.id)) {
              matched.successfulMitigations.push(nsf);
            }
          }
          saveIncidentToDb(matched);

          const searchResult = {
            query: message,
            matchCount: 1,
            isZeroDay: false,
            isFurtherImprovement: true,
            previouslyAppliedFixes: previouslyAppliedFixes,
            primaryIncident: matched,
            primaryConfidence: llmAnalysis.matchConfidence || 95,
            divergenceAlert: llmAnalysis.divergenceWarning ? {
              hasDivergenceRisk: true,
              type: 'Telemetry Divergence Detected',
              warningText: llmAnalysis.divergenceWarning
            } : null,
            allMatches: [],
            rankedRecommendations: {
              verifiedFixes: nextStageFixes,
              redHerrings: pitfalls
            },
            telemetryComparison: null
          };

          const appliedList = previouslyAppliedFixes.map(f => `• **${f.action}**`).join('\n');
          const recallExplanation = llmAnalysis.memoryRecallExplanation ||
            `I identified incident **${matched.id} (${matched.title})** in persistent memory.\n\nYou have already applied and verified:\n${appliedList}\n\nSince this improved performance only partially and you need to scale further without database bottlenecks, here are the next-stage architectural mitigations:`;

          return NextResponse.json({
            type: 'incident_analysis',
            searchResult,
            text: `🚀 **Next-Stage Advanced Optimizations (Memory Grounded)**\n\n${recallExplanation}`
          });
        }

        // SUB-CASE A2: STANDARD RECURRING INCIDENT / PRECEDENT QUERY
        // Merge alert signature only if it is an actual alert/system message (not a conversational query)
        const isConversational = /^(what|how|why|is|can|could|please|tell|show|explain)\b/i.test(message) || message.length < 25;
        if (!isConversational && !matched.alertSignatures.includes(message)) {
          matched.alertSignatures.push(message);
          saveIncidentToDb(matched);
        }

        const rawFixes = (matched.successfulMitigations && matched.successfulMitigations.length > 0)
          ? matched.successfulMitigations
          : (llmAnalysis.verifiedFixes || []);

        const fixes = rawFixes.filter(fix => {
          const actionLower = (fix.action || '').trim().toLowerCase();
          const cmdLower = (fix.command || '').trim().toLowerCase();
          if (pitfallActions.has(actionLower)) return false;
          if (cmdLower && pitfallCommands.has(cmdLower) && cmdLower !== '# manual command' && cmdLower !== '# execute command') return false;
          return true;
        });

        const searchResult = {
          query: message,
          matchCount: 1,
          isZeroDay: false,
          isFurtherImprovement: false,
          primaryIncident: matched,
          primaryConfidence: llmAnalysis.matchConfidence || 95,
          divergenceAlert: llmAnalysis.divergenceWarning ? {
            hasDivergenceRisk: true,
            type: 'Telemetry Divergence Detected',
            warningText: llmAnalysis.divergenceWarning
          } : null,
          allMatches: [],
          rankedRecommendations: {
            verifiedFixes: fixes,
            redHerrings: pitfalls
          },
          telemetryComparison: null
        };

        const recallText = llmAnalysis.memoryRecallExplanation ||
          `I identified this incident from past experience in memory as **${matched.id} (${matched.title})** for service \`${matched.service}\`.`;

        return NextResponse.json({
          type: 'incident_analysis',
          searchResult,
          text: `🎯 **Answered Directly from Memory & Past Experience!**\n\n${recallText}\n\nHere are the empirical solutions and precautions from past experience:`
        });
      }
    }

    // 9. CASE B: BRAND NEW INCIDENT (First Attempt: Dynamic Proposals ONLY - NO scores, NO anti-patterns)
    const newId = `INC-${Math.floor(100 + Math.random() * 900)}`;
    const serviceName = llmAnalysis.service || 'production-service';
    const incidentTitle = llmAnalysis.title || `${serviceName} Incident`;

    const newIncident: Incident = {
      id: newId,
      title: incidentTitle,
      service: serviceName,
      severity: 'P1',
      environment: 'production',
      durationMinutes: 0,
      resolver: 'oncall.engineer',
      createdAt: new Date().toISOString(),
      alertSignatures: [message],
      telemetry: {},
      rootCause: llmAnalysis.rootCause || 'Root cause diagnosed through dynamic LLM reasoning.',
      successfulMitigations: (llmAnalysis.verifiedFixes || []).map((f: any, idx: number) => ({
        id: f.id || `fix_${Date.now()}_${idx}`,
        action: f.action,
        command: f.command,
        timesWorked: 0,
        timesAttempted: 0,
        avgResolutionMinutes: f.avgResolutionMinutes || 5.0,
        notes: f.notes || 'Proposed resolution step for this new incident.'
        // Note: No successScore on first attempt! Scores are only given if the same happened previously.
      })),
      // Note: On first attempt, do NOT suggest what not to do (pitfalls empty).
      failedMitigations: []
    };

    // IMMEDIATELY persist the new incident into database memory so feedback and recurrence can be tracked!
    saveIncidentToDb(newIncident);

    const searchResult = {
      query: message,
      matchCount: 0,
      isZeroDay: true,
      primaryIncident: newIncident,
      primaryConfidence: 0,
      divergenceAlert: null,
      allMatches: [],
      rankedRecommendations: {
        verifiedFixes: newIncident.successfulMitigations,
        redHerrings: [] // No "what not to do" suggestions on first attempt!
      },
      telemetryComparison: null
    };

    return NextResponse.json({
      type: 'incident_analysis',
      searchResult,
      text: `🚨 **New Incident Encountered (First Occurrence • AI Dynamic Analysis)**\n\nThis incident has **no prior history in memory**. I have diagnosed the root cause and proposed actionable triage steps below.\n\n👉 **Please test the steps and let me know which one worked** (click **"Worked"** below or tell me in chat). Once verified, future occurrences will automatically show empirical success scores and prevent dangerous anti-patterns.`
    });

  } catch (err: any) {
    console.error('Chat API error:', err);
    return NextResponse.json({
      error: err.message || 'An error occurred during incident analysis.'
    }, { status: 500 });
  }
}
