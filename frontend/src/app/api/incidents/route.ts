import { NextResponse } from 'next/server';
import { getAllIncidentsFromDb, saveIncidentToDb } from '@/lib/db';
import { Incident } from '@/lib/types';

export async function GET() {
  const incidents = getAllIncidentsFromDb();
  return NextResponse.json({
    total: incidents.length,
    incidents
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const newId = body.id || `INC-${Math.floor(100 + Math.random() * 900)}`;

    const newInc: Incident = {
      id: newId,
      title: body.title || 'Untitled Incident',
      service: body.service || 'unknown-service',
      severity: body.severity || 'P1',
      environment: body.environment || 'production',
      rootCause: body.rootCause || '',
      telemetry: body.telemetry || {},
      alertSignatures: body.alertSignatures || [body.title || 'alert'],
      resolver: body.resolver || 'oncall.engineer',
      durationMinutes: body.durationMinutes || 15,
      createdAt: body.createdAt || new Date().toISOString(),
      successfulMitigations: body.successfulMitigations || [],
      failedMitigations: body.failedMitigations || []
    };

    // Save directly into SQLite database
    saveIncidentToDb(newInc);

    return NextResponse.json({
      message: 'Incident persisted into Database',
      incident: newInc
    }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const { clearAllIncidentsFromDb } = await import('@/lib/db');
    clearAllIncidentsFromDb();
    return NextResponse.json({
      success: true,
      message: 'All incidents and feedback records successfully deleted from database memory.',
      total: 0
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
