import { NextResponse } from 'next/server';
import { getHindsightEngine } from '@/lib/hindsight';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const alert = body.alert || body;
    const engine = getHindsightEngine();
    const result = engine.search(alert);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
