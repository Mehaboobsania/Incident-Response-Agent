/**
 * Generic On-Call Assistant (Simulates AI WITHOUT Memory)
 * Represents typical LLM or generic runbook response without organizational hindsight.
 */

class GenericAgent {
  constructor() {
    this.name = "Generic OpsBot (Zero-Memory Baseline)";
  }

  analyze(alert) {
    const text = (typeof alert === "string" ? alert : (alert.title || alert.message || "")).toLowerCase();

    const genericSteps = [
      {
        order: 1,
        step: "Inspect Pod / Container Logs",
        command: "kubectl logs -l app=service --tail=200 --timestamps",
        rationale: "Check standard output and standard error for recent stack traces or unhandled exceptions."
      },
      {
        order: 2,
        step: "Check Network Connectivity & Ping Database",
        command: "nc -zv database.internal.net 5432 && ping -c 4 auth-gateway",
        rationale: "Confirm DNS resolution and TCP socket reachability to upstream and downstream services."
      },
      {
        order: 3,
        step: "Perform Rolling Restart of Pods",
        command: "kubectl rollout restart deployment/service",
        rationale: "Clears potential memory leaks, stuck goroutines, or frozen thread pools by resetting containers.",
        isDangerous: true,
        risk: "Generic recommendation. In connection pool or cache storm scenarios, restarts cause catastrophic thundering herds."
      },
      {
        order: 4,
        step: "Scale Pod Replicas Horizontally",
        command: "kubectl scale deployment/service --replicas=16",
        rationale: "Distributes incoming traffic across more compute instances if CPU/memory utilization is elevated.",
        isDangerous: true,
        risk: "If bottleneck is downstream DB connections or fixed partition count, scaling pods worsens contention."
      },
      {
        order: 5,
        step: "Escalate to Database Administrator or Service Owner",
        command: "pagerduty trigger --service 'DBA-OnCall' --note 'Timeouts detected'",
        rationale: "When standard triage steps fail, escalate to senior engineering staff."
      }
    ];

    let contextualGuess = "Generic Service Outage";
    if (text.includes("timeout") || text.includes("database") || text.includes("postgres")) {
      contextualGuess = "Database Communication Degradation";
    } else if (text.includes("401") || text.includes("auth") || text.includes("token")) {
      contextualGuess = "Authentication / Gateway Issue";
    } else if (text.includes("lag") || text.includes("kafka") || text.includes("queue")) {
      contextualGuess = "Message Queue Consumer Delay";
    }

    return {
      agentType: "zero_memory",
      confidence: "Low (No historical organizational context)",
      identifiedCategory: contextualGuess,
      estimatedMttrMinutes: 45,
      systemSpecificKnowledge: "None. Using standard generalist SRE playbook.",
      summary: "Without incident history, this system suggests standard diagnostic commands (log inspection, connectivity tests) and blunt mitigation tactics (pod restart, horizontal scaling).",
      mitigationPlan: genericSteps,
      warnings: [
        "⚠️ No past postmortems indexed. High probability of repeating past mistakes.",
        "⚠️ Recommending pod restart without checking connection pool state risks cascading failover.",
        "⚠️ Average MTTR without memory is 45-60 minutes."
      ]
    };
  }
}

module.exports = GenericAgent;
