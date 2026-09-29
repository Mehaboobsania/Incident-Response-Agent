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

    const searchResult = engine.search(message);

    if (!searchResult.primaryIncident || searchResult.primaryConfidence < 20) {
      return NextResponse.json({
        type: 'no_match',
        text: `I couldn't find an exact historical match in memory for that query (confidence was too low). Try providing a service name (e.g. payments-service, catalog-search, checkout-api), an alert signature, or an error pattern.`,
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
