export interface MitigationAction {
  id: string;
  action: string;
  command: string;
  timesWorked: number;
  timesAttempted: number;
  avgResolutionMinutes: number;
  successScore?: number;
  notes: string;
  sourceIncidentId?: string;
  sourceIncidentTitle?: string;
  matchConfidence?: number;
  empiricalScore?: number;
}

export interface RedHerringAction {
  id: string;
  action: string;
  command: string;
  timesFailed: number;
  timesAttempted?: number;
  failureRate?: number;
  dangerLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'FATAL';
  failureOutcome: string;
  sourceIncidentId?: string;
  sourceIncidentTitle?: string;
  matchConfidence?: number;
}

export interface IncidentTelemetry {
  dbConnections?: string;
  dbCpu?: string;
  redisMemory?: string;
  appCpu?: string;
  queueDepth?: string;
  errorPattern?: string;
  [key: string]: string | undefined;
}

export interface Incident {
  id: string;
  title: string;
  service: string;
  environment: string;
  severity: 'P1' | 'P2' | 'P3';
  createdAt: string;
  resolvedAt?: string;
  durationMinutes: number;
  resolver: string;
  alertSignatures: string[];
  telemetry: IncidentTelemetry;
  rootCause: string;
  slackContext?: string;
  successfulMitigations: MitigationAction[];
  failedMitigations: RedHerringAction[];
  divergenceWarning?: string;
  postmortemKeyTakeaways?: string;
}

export interface DivergenceAlert {
  hasDivergenceRisk: boolean;
  type: string;
  warningText: string;
  flags?: Array<{
    metric: string;
    expected: string;
    current: string;
    detail: string;
  }>;
  recommendedAction?: string;
  guidance?: string;
}

export interface SearchResult {
  query: string | object;
  matchCount: number;
  isZeroDay?: boolean;
  isFurtherImprovement?: boolean;
  previouslyAppliedFixes?: MitigationAction[];
  primaryIncident: Incident | null;
  primaryConfidence: number;
  divergenceAlert: DivergenceAlert | null;
  allMatches: Array<{
    incident: Incident;
    confidencePercent: number;
    serviceMatch: boolean;
    errorPatternMatch: boolean;
    divergence: DivergenceAlert | null;
  }>;
  rankedRecommendations: {
    verifiedFixes: MitigationAction[];
    redHerrings: RedHerringAction[];
  };
  telemetryComparison: Record<string, { historical: string; current: string }> | null;
}

export interface GenericAgentPlanStep {
  order: number;
  step: string;
  command: string;
  rationale: string;
  isDangerous?: boolean;
  risk?: string;
}

export interface GenericAgentResult {
  agentType: string;
  confidence: string;
  identifiedCategory: string;
  estimatedMttrMinutes: number;
  systemSpecificKnowledge: string;
  summary: string;
  mitigationPlan: GenericAgentPlanStep[];
  warnings: string[];
}

export interface ComparisonResult {
  zeroMemoryAgent: GenericAgentResult;
  iraAgent: SearchResult;
  metricsComparison: {
    mttrZeroMinutes: number;
    mttrIraMinutes: number;
    mttrReductionPercent: number;
    falseActionAvoided: string;
    estimatedOutageSavedMinutes: number;
    divergenceRiskDetected: boolean;
  };
}
