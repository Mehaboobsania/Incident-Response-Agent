import { NextResponse } from 'next/server';
import { getHindsightEngine } from '@/lib/hindsight';

export async function GET() {
  const engine = getHindsightEngine();
  engine.loadData();
  return NextResponse.json({
    total: engine.incidents.length,
    incidents: engine.incidents
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const engine = getHindsightEngine();
    const newInc = engine.registerIncident(body);
    return NextResponse.json({
      message: 'Incident recorded into Hindsight memory',
      incident: newInc
    }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
