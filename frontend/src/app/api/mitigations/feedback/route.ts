import { NextResponse } from 'next/server';
import { getHindsightEngine } from '@/lib/hindsight';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { incidentId, actionId, outcome, notes, engineer, actionTitle, command, durationMinutes } = body;

    if (!incidentId || !outcome) {
      return NextResponse.json({ error: 'incidentId and outcome are required' }, { status: 400 });
    }

    const engine = getHindsightEngine();
    const result = engine.recordOutcome(incidentId, actionId, outcome, {
      notes,
      engineer,
      actionTitle,
      command,
      durationMinutes
    });

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
