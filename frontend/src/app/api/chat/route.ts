import { NextResponse } from 'next/server';
import { getAllIncidentsFromDb, saveIncidentToDb, recordFeedbackInDb } from '@/lib/db';
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
        text: `Hello! I am your **Incident Response Agent** backed by persistent database memory. ${statusNote}\n\nPaste an active alert, stack trace, or describe an outage to get diagnostics and solutions.`,
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

    // 2. Conversational Feedback ("it worked", "step 1 worked", "the fix worked")
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

    if (isWorkedFeedback) {
      const allIncidents = getAllIncidentsFromDb();
      if (allIncidents.length === 0) {
        return NextResponse.json({
          type: 'greeting',
          text: 'I do not have an active incident in memory to attach this resolution to. Please paste an alert or error log first!',
          searchResult: null
        });
      }

      // Find the most recent incident or match by service name mentioned
      const targetIncident = allIncidents.find(inc => lower.includes(inc.service.toLowerCase())) || allIncidents[0];

      // Determine which mitigation was indicated
      const wantsSecond = lower.includes('step 2') || lower.includes('option 2') || lower.includes('second');
      const targetMitigation = (wantsSecond && targetIncident.successfulMitigations?.[1])
        ? targetIncident.successfulMitigations[1]
        : (targetIncident.successfulMitigations?.[0] || {
            id: `fix_${Date.now()}`,
            action: 'Execute verified mitigation',
            command: 'kubectl patch ...',
            timesWorked: 0,
            timesAttempted: 0,
            avgResolutionMinutes: 3.0,
            successScore: 0.9,
            notes: 'Verified via chat'
          });

      // Record feedback in database
      recordFeedbackInDb(
        targetIncident.id,
        targetMitigation.id,
        'worked',
        'Confirmed effective by user in chat feedback.'
      );

      return NextResponse.json({
        type: 'learned',
        text: `✅ **Solution Verified & Saved to Persistent Memory!**\n\nI have permanently recorded that **"${targetMitigation.action}"** resolved **${targetIncident.title}** (\`${targetIncident.service}\`).\n\n- **Command:** \`${targetMitigation.command}\`\n- **Status:** Stored in database memory (100% success rate)\n\n🧠 When this incident or a similar alert recurs, I will immediately retrieve this proven solution from memory!`,
        searchResult: null
      });
    }

    // 2.5 Structured Incident Learning / Postmortem Logging
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
      const history: Array<{ role: string; content: string }> = body.history || [];
      const lastUserAlert = [...history]
        .reverse()
        .find(m => m.role === 'user' && !m.content.toLowerCase().startsWith('fix') && !m.content.toLowerCase().startsWith('learn'))?.content || '';

      let title = 'Production Incident';
      let service = 'production-service';
      let rootCause = 'Identified during postmortem investigation';
      let fix = message.replace(/^(learn incident|log incident|save incident|record incident|postmortem|fixed|fix|solution|the fix was|resolved with|we solved it by|we fixed it by):\s*/i, '').trim();
      let failed = 'Blind restarts without cache warm-up or memory diagnostics';

      const alertSource = lastUserAlert || message;
      const sMatch = alertSource.match(/^([a-zA-Z0-9\-_]+):/);
      if (sMatch) {
        service = sMatch[1];
        title = `${service} Outage`;
      }

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
            successScore: 0.99,
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

      saveIncidentToDb(newIncident);

      return NextResponse.json({
        type: 'learned',
        text: `💾 **Saved to Database Memory as ${newIncident.id}!**\n\n- **Service:** \`${newIncident.service}\`\n- **Root Cause:** ${newIncident.rootCause}\n- **Verified Fix:** \`${fix}\`\n\nThis incident is now permanently stored in memory. When this incident occurs again, I will retrieve this proven solution!`,
        searchResult: null
      });
    }

    // 3. Retrieve Historical Incidents from Database
    const dbIncidents = getAllIncidentsFromDb();

    // Check if any incident in DB has VERIFIED mitigations (timesWorked > 0)
    const verifiedIncidents = dbIncidents.filter(inc =>
      (inc.successfulMitigations || []).some(m => (m.timesWorked || 0) > 0)
    );

    // 4. Try matching against VERIFIED historical incidents
    let matchedVerifiedIncident: Incident | null = null;
    const qLower = message.toLowerCase();

    // Direct service or signature match
    matchedVerifiedIncident = verifiedIncidents.find(inc => {
      const s = inc.service.toLowerCase();
      const inQuery = qLower.includes(s) || qLower.includes(s.replace('-', ' '));
      const sigMatch = (inc.alertSignatures || []).some(sig =>
        qLower.includes(sig.toLowerCase().slice(0, 40)) || sig.toLowerCase().includes(qLower.slice(0, 40))
      );
      return inQuery || sigMatch;
    }) || null;

    // If verified incident is matched, this is INCIDENT 2 (Recurring Incident from Memory!)
    if (matchedVerifiedIncident) {
      const searchResult = {
        query: message,
        matchCount: 1,
        isZeroDay: false,
        primaryIncident: matchedVerifiedIncident,
        primaryConfidence: 100,
        divergenceAlert: null,
        allMatches: [],
        rankedRecommendations: {
          verifiedFixes: matchedVerifiedIncident.successfulMitigations || [],
          redHerrings: matchedVerifiedIncident.failedMitigations || []
        },
        telemetryComparison: null
      };

      return NextResponse.json({
        type: 'incident_analysis',
        searchResult,
        text: `🎯 **Historical Precedent Matched!**\n\nI identified a prior resolved outage in persistent database memory for \`${matchedVerifiedIncident.service}\`. Here is the empirically verified solution that resolved this exact incident:`
      });
    }

    // 5. FIRST-TIME / ZERO-DAY INCIDENT: Propose solutions using AI reasoning!
    if (isLLMConfigured()) {
      try {
        const llmAnalysis = await analyzeIncidentWithLLM(message, dbIncidents);

        // Check if LLM matched an existing verified incident ID
        if (llmAnalysis.hasMatch && llmAnalysis.matchedIncidentId) {
          const inc = dbIncidents.find(i => i.id === llmAnalysis.matchedIncidentId);
          if (inc && (inc.successfulMitigations || []).some(m => (m.timesWorked || 0) > 0)) {
            return NextResponse.json({
              type: 'incident_analysis',
              searchResult: {
                query: message,
                matchCount: 1,
                isZeroDay: false,
                primaryIncident: inc,
                primaryConfidence: llmAnalysis.matchConfidence || 95,
                divergenceAlert: llmAnalysis.divergenceWarning ? {
                  hasDivergenceRisk: true,
                  type: 'AI Detected Divergence',
                  warningText: llmAnalysis.divergenceWarning
                } : null,
                allMatches: [],
                rankedRecommendations: {
                  verifiedFixes: inc.successfulMitigations,
                  redHerrings: inc.failedMitigations
                },
                telemetryComparison: null
              },
              text: `🎯 **Historical Precedent Matched!**\n\nI identified a prior resolved outage in database memory for \`${inc.service}\`. Here is the verified mitigation:`
            });
          }
        }

        // New Incident (Zero-Day): Suggest proposed solutions to solve this!
        const serviceMatch = message.match(/^([a-zA-Z0-9\-_]+):/);
        const serviceName = serviceMatch ? serviceMatch[1] : 'production-service';
        const newId = `INC-${Math.floor(100 + Math.random() * 900)}`;

        const newIncident: Incident = {
          id: newId,
          title: `${serviceName} Incident`,
          service: serviceName,
          severity: 'P1',
          environment: 'production',
          durationMinutes: 0,
          resolver: 'oncall.engineer',
          createdAt: new Date().toISOString(),
          alertSignatures: [message],
          telemetry: {},
          rootCause: llmAnalysis.rootCause || 'Zero-day incident under triage',
          successfulMitigations: (llmAnalysis.verifiedFixes || []).map((f: any, idx: number) => ({
            id: f.id || `fix_${Date.now()}_${idx}`,
            action: f.action,
            command: f.command,
            timesWorked: 0, // 0 times worked because it's first-time
            timesAttempted: 0,
            avgResolutionMinutes: f.avgResolutionMinutes || 5.0,
            successScore: 0.70,
            notes: f.notes || 'Proposed by AI reasoning (first occurrence - unverified).'
          })),
          failedMitigations: (llmAnalysis.pitfalls || []).map((p: any, idx: number) => ({
            id: p.id || `pit_${Date.now()}_${idx}`,
            action: p.action,
            command: p.command || '# do not run',
            dangerLevel: p.dangerLevel || 'HIGH',
            failureOutcome: p.failureOutcome,
            timesFailed: 0,
            timesAttempted: 0
          }))
        };

        // Persist zero-day incident to SQLite DB so it has an ID and can receive feedback!
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
            redHerrings: newIncident.failedMitigations
          },
          telemetryComparison: null
        };

        return NextResponse.json({
          type: 'incident_analysis',
          searchResult,
          text: `🚨 **New Incident Encountered (First Occurrence)**\n\nThis incident has **no prior history in memory**. Based on the error symptoms, I have diagnosed the root cause and proposed actionable triage steps below.\n\n👉 **Please test the steps and let me know which one worked** (click **"Worked"** below or tell me in chat) so I can record it in memory for future recurring incidents.`
        });
      } catch (llmErr: any) {
        console.warn('LLM analysis error, generating rule-based proposed triage steps:', llmErr);
      }
    }

    // 6. Rule-based Fallback for First-Time Incidents if LLM unavailable
    const serviceMatch = message.match(/^([a-zA-Z0-9\-_]+):/);
    const serviceName = serviceMatch ? serviceMatch[1] : 'production-service';
    const newId = `INC-${Math.floor(100 + Math.random() * 900)}`;

    const fallbackIncident: Incident = {
      id: newId,
      title: `${serviceName} Incident`,
      service: serviceName,
      severity: 'P1',
      environment: 'production',
      durationMinutes: 0,
      resolver: 'oncall.engineer',
      createdAt: new Date().toISOString(),
      alertSignatures: [message],
      telemetry: {},
      rootCause: 'Hypothesis: Resource saturation or queue backlog on dispatch worker.',
      successfulMitigations: [
        {
          id: `fix_${Date.now()}_1`,
          action: 'Increase container memory limit and rollout restart',
          command: `kubectl patch deployment ${serviceName} -p '{"spec":{"template":{"spec":{"containers":[{"name":"${serviceName}","resources":{"limits":{"memory":"2Gi"},"requests":{"memory":"1Gi"}}}]}}}}'`,
          timesWorked: 0,
          timesAttempted: 0,
          avgResolutionMinutes: 5.0,
          successScore: 0.70,
          notes: 'Increases container memory allocation to relieve memory pressure and prevent OOMKill.'
        },
        {
          id: `fix_${Date.now()}_2`,
          action: 'Scale out replicas to distribute processing load',
          command: `kubectl scale deployment ${serviceName} --replicas=3`,
          timesWorked: 0,
          timesAttempted: 0,
          avgResolutionMinutes: 3.0,
          successScore: 0.65,
          notes: 'Distributes queue processing across multiple worker pods.'
        }
      ],
      failedMitigations: [
        {
          id: `pit_${Date.now()}_1`,
          action: 'Blind restart without increasing memory limits',
          command: `kubectl rollout restart deployment ${serviceName}`,
          dangerLevel: 'HIGH',
          failureOutcome: 'Triggers instant crash loop on restart because queue backlog immediately exhausts container memory.',
          timesFailed: 0,
          timesAttempted: 0
        }
      ]
    };

    saveIncidentToDb(fallbackIncident);

    return NextResponse.json({
      type: 'incident_analysis',
      searchResult: {
        query: message,
        matchCount: 0,
        isZeroDay: true,
        primaryIncident: fallbackIncident,
        primaryConfidence: 0,
        divergenceAlert: null,
        allMatches: [],
        rankedRecommendations: {
          verifiedFixes: fallbackIncident.successfulMitigations,
          redHerrings: fallbackIncident.failedMitigations
        },
        telemetryComparison: null
      },
      text: `🚨 **New Incident Encountered (First Occurrence)**\n\nThis incident has **no prior history in memory**. I have generated proposed diagnostic steps and trial mitigations below.\n\n👉 **Please test the steps and let me know which one worked** (click **"Worked"** below or tell me in chat) so I can record it in memory.`
    });

  } catch (err: any) {
    console.error('Chat API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
