# Why I Added Negative Memory to Hindsight for Outages

At 3:14 AM on a Tuesday, our payment service started dropping connections. Postgres was sitting at 98 active sessions out of a hard 100-connection limit, query latencies spiked past four seconds, and our checkout gateway began returning HTTP 504s. A standard operational LLM presented with that alert text immediately suggested running `kubectl rollout restart deployment/payments-service`. Had someone run that command in a panic, sixty new pods would have slammed the database in an uncontrolled cold-start thundering herd, guaranteeing a total database crash.

Every on-call engineer has lived through a variation of this story: wikis document what failed during previous postmortems, but under operational pressure, people reach for the fastest generic hammer anyway. When I started building an autonomous Incident Response Agent (IRA) to assist with live triage, I realized that generalist models suffer from institutional amnesia. Giving an LLM persistent organizational memory is not just about indexing successful fixes—it requires indexing failures with equal or greater rigor.

To solve this, I built IRA around an organizational memory engine using the [Hindsight repository on GitHub](https://github.com/vectorize-io/hindsight). By structuring incident history into queryable, empirical state, we didn't just store what worked; we introduced negative memory—a strict anti-pattern quarantine that stops teams from repeating catastrophic mistakes.

Here is how the system hangs together, how the negative memory engine operates under the hood, and what I learned deploying it.

---

## Architecture: How the System Hangs Together

The Incident Response Agent runs as a Node.js and Next.js service backed by a dual-tier persistence layer: built-in `node:sqlite` for transactional state and a synchronized JSON document store for portability. It connects to fast inference endpoints (Groq running LLaMA 3.3 70B, Google Gemini, or local OpenAI-compatible runtimes) and sits directly between incoming alerting webhooks and the on-call engineer's triage console.

```
                           ┌────────────────────────┐
                           │ Alert / SRE Telemetry  │
                           └───────────┬────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Incident Response Agent (IRA)                                               │
│                                                                             │
│   ┌────────────────────────┐         ┌───────────────────────────────────┐  │
│   │ Telemetry Divergence   │         │ Hindsight Memory Engine           │  │
│   │ Detector               │◄───────►│ (Alert Signatures, Telemetry,     │  │
│   │ (30% metric delta)     │         │  Empirical Scores, Anti-Patterns) │  │
│   └───────────┬────────────┘         └─────────────────┬─────────────────┘  │
│               │                                        │                    │
│               ▼                                        ▼                    │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │ Grounded LLM Reasoning & Triage Context Synthesizer                  │  │
│   └──────────────────────────────────┬───────────────────────────────────┘  │
└──────────────────────────────────────┼──────────────────────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌───────────────────────────────┐     ┌───────────────────────────────────────┐
│ Verified Fixes                │     │ "What NOT to Do" Quarantine           │
│ - Ranked by Success Score     │     │ - Failed Actions Permanently Filtered │
│ - Empirical MTTR Tracking     │     │ - Danger Levels & Consequence Notes   │
└───────────────┬───────────────┘     └───────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────┐
│ Interactive Feedback Loop     │  ("Worked" -> +Score, MTTR update)
│ (Chat / One-Click Actions)    ├──("Didn't Work" -> Immediate Quarantine)
└───────────────────────────────┘
```

The system operates across three core execution stages:

1. **Memory Retrieval and Divergence Check**: When an alert arrives, the engine normalizes tokens and searches historical incident records stored via the [official Hindsight docs](https://hindsight.vectorize.io/). Before accepting a match, it cross-checks real-time telemetry metrics (connection pool saturation, DB CPU, Redis memory, queue depth) against historical baselines.
2. **Empirical Mitigation Ranking**: If a precedent matches, mitigations are sorted using real-world empirical success scores and mean time to resolution (MTTR). Any action marked as an anti-pattern is stripped from the solution candidates.
3. **Live Feedback and Quarantine**: As engineers execute commands, the console accepts direct feedback (`Worked` or `Didn't work`). When an action fails, the system transitions that action into the anti-pattern archive in real time.

For full architectural details on stateful agent memory patterns, see this reference on [persistent agent memory from Vectorize](https://vectorize.io/what-is-agent-memory).

---

## The Core Technical Problem: The Asymmetry of Outage Memory

When engineers think about agent memory, they usually think of semantic retrieval: an alert comes in, the agent runs a similarity query against a vector store, extracts past postmortems, and dumps the highest-ranking text into the prompt.

In production infrastructure, this approach breaks down in two specific ways:

### 1. Deceptive Twin Incidents
Two alerts can have identical text signatures while having completely opposite root causes. Consider:
- **Incident A**: `Database timeouts on payments-service`. Root cause: unclosed connection leak in an API handler. Telemetry: DB connections at 98%, DB CPU at 94%, Redis memory at 12%. Fix: drain idle connections and increase pool limits.
- **Incident B**: `Database timeouts on payments-service`. Root cause: Redis cache eviction storm. Telemetry: DB connections at 95%, DB CPU at 88%, Redis memory at 99.5%. Fix: increase Redis memory eviction limits or scale Redis cache replicas.

If your agent matches purely on the alert text `Database timeouts on payments-service`, it will recommend the database pool drain for Incident B. Draining connections while the database is being hammered by cache-miss queries accomplishes nothing and burns critical triage minutes.

### 2. Amnesia of Dangerous Runbooks
Every on-call rotation has "intuitive" actions that are actually destructive under specific failure conditions:
- Restarting deployment pods during database connection pool saturation.
- Scaling replica counts horizontally when the downstream dependency is a locked table partition.
- Flushing a queue when the consumer worker is in a crash loop.

Standard retrieval systems have no inherent mechanism to say: *"We tested this command three months ago during this exact alert state, and it took down the primary database cluster."* If a postmortem mentions `kubectl rollout restart deployment/payments-service`, an unconstrained LLM will happily extract it and propose it as step one.

---

## Code-Backed Implementation: How Negative Memory and Divergence Work

Let's look at the concrete TypeScript implementation that solves these two failure modes.

### 1. The Anti-Pattern Quarantine Filter

In `frontend/src/lib/hindsight.ts`, the mitigation ranking method does not merely order successful actions by score. It builds explicit sets of failed action signatures and CLI commands, actively purging them from the verified suggestions:

```typescript
// frontend/src/lib/hindsight.ts
const failedActions = new Set(
  allFailed.map(f => (f.action || '').trim().toLowerCase())
);
const failedCommands = new Set(
  allFailed
    .map(f => (f.command || '').trim().toLowerCase())
    .filter(Boolean)
);

// Strictly quarantine failed actions out of verified recommendations
const filteredSuccessful = allSuccessful.filter(m => {
  const act = (m.action || '').trim().toLowerCase();
  const cmd = (m.command || '').trim().toLowerCase();
  
  if (failedActions.has(act)) return false;
  if (
    cmd && 
    failedCommands.has(cmd) && 
    cmd !== '# manual command' && 
    cmd !== '# executed command'
  ) {
    return false;
  }
  return true;
});

// Rank verified fixes by empirical success score and MTTR
filteredSuccessful.sort((a, b) => {
  const scoreA = a.empiricalScore ?? a.successScore ?? 0;
  const scoreB = b.empiricalScore ?? b.successScore ?? 0;
  if (scoreB !== scoreA) {
    return scoreB - scoreA;
  }
  return (a.avgResolutionMinutes || 10) - (b.avgResolutionMinutes || 10);
});
```

Because `filteredSuccessful` strips out anything present in `failedActions` or `failedCommands`, an action that has failed in the past can never be recommended as a solution. Instead, it gets routed exclusively to the "What NOT to Do" display with its recorded danger level (`HIGH`, `CRITICAL`) and historical outcome notes.

### 2. Atomic Transition on Feedback

When an engineer clicks **"Didn't work"** or types `"the rolling restart failed"`, the state transition must be atomic and irreversible. In `recordOutcome`:

```typescript
// frontend/src/lib/hindsight.ts
} else if (outcome === 'failed') {
  const failedItem = (incident.failedMitigations || []).find(f => f.id === actionId);
  if (failedItem) {
    failedItem.timesFailed = (failedItem.timesFailed || 0) + 1;
    failedItem.timesAttempted = (failedItem.timesAttempted || failedItem.timesFailed) + 1;
    failedItem.failureRate = Math.round((failedItem.timesFailed / failedItem.timesAttempted) * 100) / 100;
    if (notes) failedItem.failureOutcome = `${failedItem.failureOutcome} | Updated outcome: ${notes}`;
  } else {
    const newFailure: RedHerringAction = {
      id: actionId || `fail_${Date.now()}`,
      action: details.actionTitle || actionItem?.action || "Attempted Triage Action",
      command: details.command || actionItem?.command || "# executed command",
      timesFailed: 1,
      timesAttempted: 1,
      failureRate: 1.0,
      dangerLevel: details.dangerLevel || "HIGH",
      failureOutcome: notes || "Mitigation attempt failed to resolve alert or exacerbated service degradation."
    };
    incident.failedMitigations = incident.failedMitigations || [];
    incident.failedMitigations.push(newFailure);
  }

  // Crucial: permanently evict from successful mitigations
  const resolvedAction = (actionItem ? actionItem.action : (details.actionTitle || '')).trim().toLowerCase();
  const resolvedCmd = (actionItem ? actionItem.command : (details.command || '')).trim();

  incident.successfulMitigations = (incident.successfulMitigations || []).filter(m =>
    m.id !== actionId &&
    (m.action || '').trim().toLowerCase() !== resolvedAction &&
    (!resolvedCmd || (m.command || '').trim() !== resolvedCmd)
  );
}

this.saveData();
```

Notice what happens: the action is not simply demoted or penalized with a lower score. It is excised entirely from `successfulMitigations` and registered in `failedMitigations`. Once recorded as a failure, it cannot re-emerge in future alerts unless an operator deliberately alters the persistent database records.

### 3. Detecting Divergence Before Retrieval Confirms

To catch deceptive twin incidents, `detectDivergence` analyzes real-time numeric telemetry against the historical baseline:

```typescript
// frontend/src/lib/hindsight.ts
if (incident.telemetry && incomingTelemetry) {
  for (const [metricKey, historicalVal] of Object.entries(incident.telemetry)) {
    if (!historicalVal) continue;
    const incomingVal = incomingTelemetry[metricKey];
    if (!incomingVal) continue;

    const numHist = parseFloat(historicalVal);
    const numInc = parseFloat(incomingVal);
    
    // Detect divergence if numerical metrics conflict significantly (>= 30% delta)
    if (!isNaN(numHist) && !isNaN(numInc)) {
      if (Math.abs(numHist - numInc) >= 30) {
        flags.push({
          metric: metricKey,
          expected: `${historicalVal} (Historical incident baseline)`,
          current: `${incomingVal} (Real-time telemetry conflicting)`,
          detail: `Incoming alert reports ${metricKey} = ${incomingVal}, whereas historical precedent ${incident.id} recorded ${metricKey} = ${historicalVal}.`
        });
      }
    }
  }
}
```

If the divergence detector flags a significant metric delta, the system issues a warning banner:
`⚠️ DIVERGENCE DETECTED: Surface alert matches INC-402, but real-time telemetry conflicts with historical profile!`
Automated execution pauses, preventing the on-call engineer from firing the wrong mitigation.

---

## Results and Behavior: What Happens in a Live Incident

To evaluate how this behaves in practice, we tested the engine against both simulated alerts and real historical postmortems, comparing the Hindsight-grounded agent against a zero-memory baseline OpsBot.

### Scenario 1: Payment Gateway DB Connection Saturation (INC-402)

**Incoming Alert:**
`database timeouts on the payments service active pg_connections saturated`

**Telemetry:**
- `dbConnections`: `98/100 (Saturated)`
- `dbCpu`: `94%`
- `redisMemory`: `12%`

#### Zero-Memory Baseline Agent Output:
```text
Agent: Generic OpsBot (Zero-Memory Baseline)
Estimated MTTR: 45 minutes

Suggested Steps:
1. kubectl logs -l app=payments-service --tail=200 --timestamps
2. curl -ivs https://payments-service.internal/healthz
3. kubectl rollout restart deployment/payments-service   [RISK: HIGH]
4. kubectl scale deployment/payments-service --replicas=8 [RISK: HIGH]
```
The baseline agent suggests a rolling restart and horizontal scaling. In this incident state, horizontal scaling spawns more pods, multiplying connection requests against Postgres and pushing the cluster from degraded latency into total denial-of-service.

#### IRA with Hindsight Output:
```text
🎯 Answered Directly from Memory & Past Experience (INC-402)!

Primary Precedent: INC-402 (Payment Gateway DB Connection Saturation)
Confidence: 90% | Historical MTTR: 3.5 minutes

┌─ #1 Drain idle connections and bump pool capacity ─────── [95% Empirical Success] ─┐
│  $ psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity               │
│             WHERE state = 'idle';"                                                │
│  Avg Resolution: 3.5 min | Verified in 3 previous occurrences                      │
│  Did this mitigation work?                               [👍 Worked]  [👎 Failed]  │
└───────────────────────────────────────────────────────────────────────────────────┘

┌─ 🚫 What NOT to Do (Quarantined Anti-Patterns) ───────────────────────────────────┐
│  Avoid: Rolling restart of payments deployment                         [CRITICAL] │
│  $ kubectl rollout restart deployment/payments-service                            │
│  History: Failed 5 times in past occurrences.                                     │
│  Past Consequence: Cold start storm caused total upstream DB crash.               │
└───────────────────────────────────────────────────────────────────────────────────┘
```

The difference is immediate. The dangerous restart is not omitted silently—it is explicitly flagged and quarantined, explaining *why* it failed five times before. The engineer executes the single command that previously resolved the connection leak, cutting estimated MTTR from 45 minutes down to ~3.5 minutes—an approximate **92% MTTR reduction**.

### Scenario 2: Deceptive Twin Incident Divergence

When an alert came in reporting `Database query timeout on product catalog` for the same payments service, the surface alert resembled INC-402. But the incoming telemetry showed:
- `dbCpu`: `88%`
- `redisMemory`: `99.5% (Maxmemory reached)`

Instead of recommending the database pool drain, the engine triggered:
```text
⚠️ DIVERGENCE DETECTED: Surface alert matches INC-402 (Payment Gateway DB Connection Saturation),
but real-time telemetry conflicts with historical profile!
- Metric: redisMemory
- Expected: 12% (Historical baseline)
- Current: 99.5% (Real-time telemetry conflicting)
Action: Pausing automatic recommendation. Root cause appears to be cache eviction, not connection pool leak.
```

By intercepting the telemetry discrepancy, the engineer avoided a 20-minute misdirection down the database connection path and immediately investigated Redis memory saturation.

---

## 4 Concrete Lessons Learned

### 1. In SRE, Negative Memory is More Valuable Than Positive Memory
When an engineer is troubleshooting an outage at 3 AM, there may be several viable paths to mitigate the issue. But there are usually only one or two paths that will cause catastrophic cascading failures. Capturing "what broke things" in persistent memory provides higher leverage than simply listing what worked. If an agent does nothing else besides reliably prevent the team from executing known failure anti-patterns, it pays for itself.

### 2. Never Rank Solutions with Raw LLM Heuristics
When we initially tested standard LLM prompts without empirical scoring, the model would invent arbitrary confidence percentages (e.g., claiming 99% certainty on a generic runbook script). We removed success scores entirely for first-time, zero-day incidents: if an incident has never been seen before, the agent proposes dynamic actions without fabricated scores. Scores are only awarded empirically when human feedback or cluster verification confirms that the command actually solved the problem.

### 3. Surface Text Matching is an Outage Trap
Text embeddings and keyword tokenizers are great at identifying linguistic similarity, but in distributed systems, distinct failures share identical alert text. If your memory engine does not evaluate telemetry dimensions (memory pressure, connection pools, thread counts, IOPS) as first-class constraints alongside semantic text, it will frequently mistake a cache eviction storm for a database lockup.

### 4. Interactive Feedback Loops Must Be Zero-Friction
If capturing operational feedback requires engineers to fill out a Jira postmortem template the next morning, half of the institutional knowledge will be lost. Embedding feedback directly into the triage flow—where an engineer can click `Worked` or `Didn't work` right in the terminal or chat console—ensures that the memory engine learns while the incident is hot. The feedback is persisted immediately into SQLite, so the next person on-call benefits from the lesson five minutes later.

---

## Final Thoughts

The goal of integrating memory into incident response isn't to build a black-box agent that autonomously executes commands without oversight. It is to equip on-call engineers with institutional memory that doesn't evaporate between rotations.

By combining the [Hindsight memory architecture](https://github.com/vectorize-io/hindsight), empirical mitigation scoring, and strict anti-pattern quarantine, we turned postmortems from static post-incident paperwork into active, real-time guardrails for production systems.
