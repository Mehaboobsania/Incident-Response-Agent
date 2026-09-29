import { NextResponse } from 'next/server';
import { getAllIncidentsFromDb } from '@/lib/db';
import { getHindsightEngine } from '@/lib/hindsight';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const dbIncidents = getAllIncidentsFromDb();
    const inc = dbIncidents.find(i => i.id === id);

    if (inc) {
      const successfulList = (inc.successfulMitigations || [])
        .map(s => `- **${s.action}** (Success Rate: ${Math.round((s.successScore || 0.9) * 100)}%, Avg MTTR: ${s.avgResolutionMinutes}m)\n  \`\`\`bash\n  ${s.command}\n  \`\`\`\n  *Notes:* ${s.notes}`)
        .join('\n\n');

      const failedList = (inc.failedMitigations || [])
        .map(f => `- **🚫 ${f.action}** [Danger Level: ${f.dangerLevel}]\n  \`\`\`bash\n  ${f.command}\n  \`\`\`\n  *What Failed:* ${f.failureOutcome}`)
        .join('\n\n');

      const markdown = `# Postmortem Report: ${inc.id} - ${inc.title}

## Overview
- **Incident ID:** ${inc.id}
- **Service:** \`${inc.service}\`
- **Severity:** \`${inc.severity}\`
- **Environment:** \`${inc.environment}\`
- **Resolver:** ${inc.resolver || 'oncall.engineer'}
- **Duration / MTTR:** ${inc.durationMinutes || 5} minutes

---

## Root Cause Analysis
${inc.rootCause}

---

## Mitigations & Actions
### Verified Solutions (What Worked)
${successfulList || '_None recorded yet_'}

### Known Pitfalls & Anti-Patterns (What Failed)
${failedList || '_None recorded_'}
`;

      return NextResponse.json({
        incidentId: id,
        markdown
      });
    }

    const engine = getHindsightEngine();
    const markdown = engine.generatePostmortem(id);

    if (!markdown) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    return NextResponse.json({
      incidentId: id,
      markdown
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
