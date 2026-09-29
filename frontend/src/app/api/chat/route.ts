import { NextResponse } from 'next/server';
import { getHindsightEngine } from '@/lib/hindsight';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const message = body.message || '';
    const engine = getHindsightEngine();

    const lower = message.toLowerCase().trim();

    if (!message || lower === 'hi' || lower === 'hello' || lower === 'hey' || lower === 'help') {
      return NextResponse.json({
        type: 'greeting',
        text: "Hello! I'm your Incident Response Agent. Paste any production alert, stack trace, or describe an outage, and I'll query our historical incident memory to surface verified solutions and warn against dangerous anti-patterns.",
        searchResult: null
      });
    }

    // Check if user is teaching or logging an incident
    if (
      lower.startsWith('learn incident:') ||
      lower.startsWith('log incident:') ||
      lower.startsWith('save incident:') ||
      lower.startsWith('record incident:') ||
      lower.startsWith('postmortem:')
    ) {
      const content = message.replace(/^(learn|log|save|record)\s+incident:\s*|^postmortem:\s*/i, '');
      const parts = content.split(/[|\n]/).map((p: string) => p.trim());

      let service = 'notification-service';
      let title = 'Notification Service OOMKilled Crash Loop';
      let rootCause = 'Unbounded in-memory attachment buffering during batch email dispatch.';
      let fix = 'kubectl set env deployment/notification-service STREAM_ATTACHMENTS=true MAX_CHUNK_MB=5';
      let failed = 'Increasing memory limits or restarting pods — workers consumed memory even faster and crashed worker nodes.';

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

      const registered = engine.registerIncident({
        title: title || `${service} Outage`,
        service,
        severity: 'P1',
        environment: 'production',
        durationMinutes: 18,
        resolver: 'oncall.engineer',
        alertSignatures: [
          `${service}: OutOfMemoryError (OOMKilled) crash loop`,
          `container memory 100% on ${service}`,
          `${service}: memory saturation on email dispatch worker`
        ],
        telemetry: {
          appCpu: '88% (High)',
          redisMemory: '22% (Normal)',
          dbConnections: '18/100 (Safe)',
          queueDepth: '4,500 pending messages',
          errorPattern: 'java.lang.OutOfMemoryError: Java heap space'
        },
        rootCause,
        successfulMitigations: [
          {
            id: `act_${Date.now()}`,
            action: 'Enable streaming attachment buffer & chunk uploads',
            command: fix,
            timesWorked: 1,
            timesAttempted: 1,
            avgResolutionMinutes: 3.2,
            successScore: 0.95,
            notes: 'Streams email attachment payloads in chunks without loading entire PDFs into Java heap.'
          }
        ],
        failedMitigations: [
          {
            id: `fail_${Date.now()}`,
            action: 'Pod rollout restart or bumping memory limit',
            command: 'kubectl rollout restart deployment/' + service,
            timesFailed: 1,
            timesAttempted: 1,
            failureRate: 1.0,
            dangerLevel: 'HIGH',
            failureOutcome: failed
          }
        ]
      });

      return NextResponse.json({
        type: 'learned',
        text: `🎉 **Successfully saved to Hindsight Memory as ${registered.id}!**\n\n- **Service:** \`${registered.service}\`\n- **Root Cause:** ${registered.rootCause}\n- **Verified Fix:** \`${fix}\`\n- **Anti-Pattern Recorded:** ${failed}\n\nNext time an alert fires for **${registered.service}**, I will immediately recognize it, surface this verified fix, and warn against repeating the failed restart!`,
        searchResult: null
      });
    }

    const searchResult = engine.search(message);

    if (!searchResult.primaryIncident || searchResult.primaryConfidence < 20) {
      return NextResponse.json({
        type: 'no_match',
        text: `🔍 **Zero-Day / Unknown Incident**: I couldn't find a prior postmortem in memory matching this alert.\n\nSince this is the first time you are seeing this issue, once you diagnose and resolve it, you can teach me using:\n\n\`Learn incident: Service: notification-service | Title: OOM crash loop | Cause: Buffer overflow | Worked: kubectl set env ... | Failed: Pod restart\`\n\nThen, if the incident ever happens again, I will immediately recall the fix!`,
        searchResult
      });
    }

    return NextResponse.json({
      type: 'incident_analysis',
      searchResult
    });
  } catch (err: any) {
    console.error('Chat API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
