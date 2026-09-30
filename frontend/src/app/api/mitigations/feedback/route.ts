import { NextResponse } from 'next/server';
import { recordFeedbackInDb } from '@/lib/db';
import { getHindsightEngine } from '@/lib/hindsight';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { incidentId, actionId, outcome, notes, engineer, actionTitle, command, durationMinutes } = body;

    if (!incidentId || !outcome) {
      return NextResponse.json({ error: 'incidentId and outcome are required' }, { status: 400 });
    }

    // Persist directly into the SQLite database!
    recordFeedbackInDb(incidentId, actionId, outcome, notes, engineer, actionTitle, command);

    // Also update engine in-memory cache if active
    const engine = getHindsightEngine();
    engine.recordOutcome(incidentId, actionId, outcome, {
      notes,
      engineer,
      actionTitle,
      command,
      durationMinutes
    });

    return NextResponse.json({
      success: true,
      incidentId,
      actionId,
      outcome,
      persistedInDatabase: true
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
