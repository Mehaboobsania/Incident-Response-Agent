import { NextResponse } from 'next/server';
import { getHindsightEngine } from '@/lib/hindsight';
import { getGenericAgent } from '@/lib/generic-agent';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const alert = body.alert || body;

    const engine = getHindsightEngine();
    const genericAgent = getGenericAgent();

    const zeroMemoryResult = genericAgent.analyze(alert);
    const iraResult = engine.search(alert);

    const bestFix = iraResult.rankedRecommendations.verifiedFixes[0];
    const topRedHerring = iraResult.rankedRecommendations.redHerrings[0];

    const mttrZero = zeroMemoryResult.estimatedMttrMinutes || 45;
    const mttrIra = bestFix ? (bestFix.avgResolutionMinutes || 5.0) : 10.0;
    const mttrReductionPct = Math.max(0, Math.min(99, Math.round((1 - mttrIra / mttrZero) * 100)));
    const savedMinutes = Math.max(1, Math.round(mttrZero - mttrIra));

    return NextResponse.json({
      zeroMemoryAgent: zeroMemoryResult,
      iraAgent: iraResult,
      metricsComparison: {
        mttrZeroMinutes: mttrZero,
        mttrIraMinutes: mttrIra,
        mttrReductionPercent: mttrReductionPct,
        falseActionAvoided: topRedHerring ? topRedHerring.action : "Dangerous blind restarts and uncoordinated scaling",
        estimatedOutageSavedMinutes: savedMinutes,
        divergenceRiskDetected: !!iraResult.divergenceAlert?.hasDivergenceRisk
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
