import { NextResponse } from 'next/server';
import { getHindsightEngine } from '@/lib/hindsight';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
