import { GenericAgentResult, GenericAgentPlanStep } from './types';

export class GenericAgent {
  public name = "Generic OpsBot (Zero-Memory Baseline)";

  public analyze(alert: string | { title?: string; message?: string; service?: string }): GenericAgentResult {
    const rawText = typeof alert === 'string' ? alert : [alert.title, alert.message, alert.service].filter(Boolean).join(' ');
    const text = rawText.toLowerCase();

    // Extract dynamic service identifier if present
    const serviceMatch = text.match(/([a-z0-9_-]+(?:service|api|worker|gateway|app))/i);
    const targetService = (typeof alert === 'object' && alert.service) ? alert.service : (serviceMatch ? serviceMatch[1] : 'application');

    const steps: GenericAgentPlanStep[] = [
      {
        order: 1,
        step: `Inspect Pod & Container Logs for ${targetService}`,
        command: `kubectl logs -l app=${targetService} --tail=200 --timestamps`,
        rationale: "Generic initial step: check stdout and stderr for unhandled exceptions or error codes."
      },
      {
        order: 2,
        step: `Check Network Reachability & Upstream Dependencies`,
        command: `curl -ivs https://${targetService}.internal/healthz || ping -c 3 ${targetService}`,
        rationale: "Generic connectivity check to verify whether pods are actively listening on network sockets."
      },
      {
        order: 3,
        step: `Perform Rolling Restart of Pods`,
        command: `kubectl rollout restart deployment/${targetService}`,
        rationale: "Generic recovery attempt: restart containers to release memory leaks, stuck goroutines, or hung connections.",
        isDangerous: true,
        risk: "Dangerous without incident memory. In cache stampede or connection pool saturation, restarts trigger massive cold start thundering herds that collapse upstream databases."
      },
      {
        order: 4,
        step: `Scale Replicas Horizontally`,
        command: `kubectl scale deployment/${targetService} --replicas=8`,
        rationale: "Generic scaling attempt: distribute load across more pods.",
        isDangerous: true,
        risk: "If the failure is caused by backend database connection saturation or locked partitions, increasing pods multiplies connection pressure."
      }
    ];

    return {
      agentType: "zero_memory",
      confidence: "Low (Zero historical organizational memory)",
      identifiedCategory: `Unindexed ${targetService} Incident`,
      estimatedMttrMinutes: 45,
      systemSpecificKnowledge: "None. Blind guessing using standard textbook runbooks.",
      summary: `Standard generalist AI with zero memory. It blindly suggests container restarts and scaling without knowing whether restarts caused outages previously.`,
      mitigationPlan: steps,
      warnings: [
        "⚠️ No past postmortems indexed. High probability of repeating past mistakes.",
        "⚠️ Recommending pod restarts blindly risks triggering cascading system collapse.",
        "⚠️ Estimated MTTR without memory is 45-60 minutes of trial-and-error."
      ]
    };
  }
}

let genericAgentInstance: GenericAgent | null = null;
export function getGenericAgent(): GenericAgent {
  if (!genericAgentInstance) {
    genericAgentInstance = new GenericAgent();
  }
  return genericAgentInstance;
}
