import { Incident } from './types';

export interface LLMAnalysisResult {
  hasMatch: boolean;
  matchedIncidentId: string | null;
  matchConfidence: number;
  isFurtherImprovementRequest?: boolean;
  title?: string;
  service?: string;
  diagnosis: string;
  rootCause: string;
  divergenceWarning: string | null;
  memoryRecallExplanation?: string | null;
  verifiedFixes: Array<{
    id: string;
    action: string;
    command: string;
    avgResolutionMinutes: number;
    successScore?: number;
    notes: string;
    timesWorked?: number;
    timesAttempted?: number;
  }>;
  pitfalls: Array<{
    id: string;
    action: string;
    command: string;
    dangerLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    failureOutcome: string;
    timesFailed?: number;
  }>;
  summary: string;
}

export function isLLMConfigured(): boolean {
  return !!(
    process.env.GROQ_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.OPENAI_API_KEY
  );
}

export function getLLMProvider(): string {
  if (process.env.GROQ_API_KEY) {
    const model = process.env.GROQ_MODEL || process.env.LLM_MODEL || 'qwen/qwen3.8-27b';
    return `Groq (${model})`;
  }
  if (process.env.GEMINI_API_KEY) return 'Google Gemini';
  if (process.env.OPENAI_API_KEY) return 'OpenAI';
  return 'None';
}

/**
 * Invokes the configured LLM (Groq, Gemini, or OpenAI) with zero external package dependencies.
 */
export async function callLLM(options: {
  systemPrompt?: string;
  userPrompt: string;
  jsonMode?: boolean;
}): Promise<string> {
  const { systemPrompt, userPrompt, jsonMode = false } = options;

  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!groqKey && !geminiKey && !openaiKey) {
    throw new Error(
      'No LLM API key configured. Please add GROQ_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY in frontend/.env.local'
    );
  }

  // 1. Groq API (Ultra-fast inference)
  if (groqKey) {
    const candidateModels = [
      process.env.GROQ_MODEL,
      process.env.LLM_MODEL,
      'qwen/qwen3.8-27b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b'
    ].filter(Boolean) as string[];
    const modelsToTry = Array.from(new Set(candidateModels));
    const url = 'https://api.groq.com/openai/v1/chat/completions';

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    let lastError: Error | null = null;

    for (const model of modelsToTry) {
      const body: any = {
        model,
        messages,
        temperature: 0.1
      };

      if (jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`
          },
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          const errText = await res.text();
          if (
            res.status === 404 ||
            res.status === 429 ||
            errText.includes('model_not_found') ||
            errText.includes('rate_limit_exceeded') ||
            errText.includes('does not exist')
          ) {
            console.warn(`Groq model ${model} unavailable (${res.status}), attempting next fallback...`);
            lastError = new Error(`Groq model ${model} error (${res.status}): ${errText}`);
            continue;
          }
          throw new Error(`Groq API error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error(`Groq model ${model} returned an empty response.`);
        }
        return content;
      } catch (err: any) {
        lastError = err;
        if (
          err.message?.includes('404') ||
          err.message?.includes('429') ||
          err.message?.includes('rate_limit') ||
          err.message?.includes('model_not_found')
        ) {
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('All Groq candidate models failed.');
  }

  // 2. Google Gemini API
  if (geminiKey) {
    const model = process.env.GEMINI_MODEL || process.env.LLM_MODEL || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

    const contents: any[] = [];
    if (systemPrompt) {
      contents.push({
        role: 'user',
        parts: [{ text: `[SYSTEM INSTRUCTION]\n${systemPrompt}` }]
      });
      contents.push({
        role: 'model',
        parts: [{ text: 'Understood. I will follow all instructions.' }]
      });
    }

    contents.push({
      role: 'user',
      parts: [{ text: userPrompt }]
    });

    const body: any = { contents };
    if (jsonMode) {
      body.generationConfig = {
        temperature: 0.1,
        responseMimeType: 'application/json'
      };
    } else {
      body.generationConfig = {
        temperature: 0.2
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) {
      throw new Error('Gemini API returned an empty response.');
    }
    return candidate;
  }

  // 3. OpenAI / OpenAI-Compatible (Ollama, OpenRouter, DeepSeek)
  if (openaiKey) {
    const baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = process.env.OPENAI_MODEL || process.env.LLM_MODEL || 'gpt-4o-mini';
    const url = `${baseURL}/chat/completions`;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const body: any = {
      model,
      messages,
      temperature: 0.2
    };

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI API returned an empty response.');
    }
    return content;
  }

  throw new Error('No supported LLM configuration found.');
}

/**
 * Analyzes an alert using real LLM reasoning grounded in persistent memory.
 * - If an incident regarding this alert was already given to the LLM or exists in memory,
 *   it answers directly from the memory and past experience that it had.
 * - If it is a new incident, the LLM dynamically analyzes it and formulates actionable mitigations.
 */
export async function analyzeIncidentWithLLM(
  alertMessage: string,
  historicalIncidents: Incident[]
): Promise<LLMAnalysisResult> {
  const systemPrompt = `You are the Incident Response Agent (IRA), an expert Site Reliability Engineer (SRE).
Your mission is to analyze incoming production alerts and questions, drawing strictly upon organizational memory and past incident experiences when available.

MEMORY RECALL & REASONING RULES:
1. Carefully examine all HISTORICAL INCIDENTS IN DATABASE MEMORY.
2. Determine if the incoming alert or question relates to, asks about, or is a recurrence of ANY incident already present in memory:
   - Matches the same service experiencing the same or similar issue
   - Matches an error pattern, signature, or symptom previously recorded
   - Asks a question or follow-up regarding an incident previously analyzed or resolved in memory
3. IF A MATCH OR RECURRENCE IS FOUND (the incident happened previously in the past):
   - Set "hasMatch": true
   - Set "matchedIncidentId": "<matched incident ID, e.g. INC-123>"
   - Set "matchConfidence": integer (between 75 and 100)

   SUB-CASE 3A: USER ASKS FOR FURTHER IMPROVEMENTS / NEXT STEPS / ADVANCED OPTIMIZATIONS:
   (e.g., user reports that initial fixes improved things a little bit but needs further improvements, asks "what else can we do?", "what next?", or wants to make the application even better without bottlenecks):
   - Set "isFurtherImprovementRequest": true
   - In "memoryRecallExplanation": Formulate a clear answer acknowledging the initial mitigations already applied/verified from memory, and explain that you are now recommending next-stage advanced architectural and system optimizations to eliminate remaining bottlenecks.
   - For "verifiedFixes": Propose 2-3 NEW, ADVANCED, NEXT-STAGE architectural/operational optimizations specifically targeting the remaining bottlenecks (e.g. database connection pooling with PgBouncer, async request queues/worker decoupling, semantic query caching, LLM response streaming, query optimization/indexing).
     * DO NOT repeat or recommend the mitigations that were already applied and worked!
     * Since these new next-stage fixes haven't been tested yet, omit "successScore" or set to null.
   - For "pitfalls": PREVENT THE USER FROM WHAT NOT TO DO. Return any known pitfalls / anti-patterns from memory.

   SUB-CASE 3B: STANDARD RECURRENCE OR RE-QUERYING AN INCIDENT:
   - Set "isFurtherImprovementRequest": false
   - Set "memoryRecallExplanation": Formulate a clear, direct answer synthesizing the past experience:
     State clearly what happened previously, the verified root cause, what worked, and what failed.
   - For "verifiedFixes": Return the verified fixes from memory, INCLUDING the empirical "successScore" (number between 0.1 and 1.0) and resolution times confirmed by past experience.
   - For "pitfalls": PREVENT THE USER FROM WHAT NOT TO DO. Return the pitfalls / anti-patterns that failed or caused harm during previous occurrences of this incident.

   CRITICAL SEPARATION (WHAT TO DO VS WHAT NOT TO DO):
   * Any resolution method, action, or command that has failed, was marked as "didn't work", or is listed in "failedMitigations" MUST ONLY appear under "pitfalls" (What NOT to Do).
   * NEVER include or recommend any failed action under "verifiedFixes". It must NEVER appear under both lists!
   * If incoming telemetry conflicts with the historical profile, formulate a clear "divergenceWarning".

4. IF NO MATCH EXISTS (FIRST ATTEMPT - brand new incident that hasn't been asked in the past):
   - Set "hasMatch": false
   - Set "matchedIncidentId": null
   - Set "matchConfidence": 0
   - Set "isFurtherImprovementRequest": false
   - Set "memoryRecallExplanation": null
   - Dynamically diagnose the root cause from the error text.
   - Propose 2-3 realistic, actionable triage/mitigation commands (e.g., kubectl, systemctl, psql, redis-cli) with reasonable resolution times and explanations.
   - CRITICAL RULES FOR FIRST ATTEMPT:
     * DO NOT assign or provide scores for resolution steps! (Omit "successScore" or set to null, because this is the first attempt with no empirical history).
     * DO NOT suggest what NOT to do! (Set "pitfalls": [] - do not suggest anti-patterns or prohibited actions on the first attempt).
   - Extract a descriptive "service" name and "title".
5. Respond ONLY with valid JSON conforming to the requested schema.`;

  const memoryContext = historicalIncidents.map(inc => ({
    id: inc.id,
    title: inc.title,
    service: inc.service,
    rootCause: inc.rootCause,
    alertSignatures: inc.alertSignatures,
    telemetry: inc.telemetry,
    successfulMitigations: inc.successfulMitigations?.map(m => ({
      id: m.id,
      action: m.action,
      command: m.command,
      timesWorked: m.timesWorked || 0,
      timesAttempted: m.timesAttempted || 0,
      successScore: m.successScore,
      alreadyAppliedAndWorked: (m.timesWorked || 0) > 0,
      notes: m.notes
    })),
    failedMitigations: inc.failedMitigations?.map(f => ({
      id: f.id,
      action: f.action,
      command: f.command,
      timesFailed: f.timesFailed || 0,
      dangerLevel: f.dangerLevel,
      failureOutcome: f.failureOutcome
    }))
  }));

  const userPrompt = `INCOMING PRODUCTION ALERT / QUERY:
"""
${alertMessage}
"""

HISTORICAL INCIDENTS IN DATABASE MEMORY:
${memoryContext.length > 0 ? JSON.stringify(memoryContext, null, 2) : "No incidents in database memory yet (Memory is clean)."}

Provide your analysis strictly in JSON format with this exact structure:
{
  "hasMatch": boolean,
  "matchedIncidentId": string or null,
  "matchConfidence": number,
  "isFurtherImprovementRequest": boolean,
  "title": string,
  "service": string,
  "diagnosis": string,
  "rootCause": string,
  "divergenceWarning": string or null,
  "memoryRecallExplanation": string or null,
  "verifiedFixes": [
    {
      "id": "fix_1",
      "action": "Resolution step description",
      "command": "kubectl or shell command to execute",
      "avgResolutionMinutes": 5,
      "successScore": 0.95,
      "notes": "Technical rationale"
    }
  ],
  "pitfalls": [
    {
      "id": "pitfall_1",
      "action": "Dangerous action to avoid (ONLY for recurring incidents with past failure history; empty [] for first attempt)",
      "command": "dangerous command",
      "dangerLevel": "HIGH",
      "failureOutcome": "Why this failed previously"
    }
  ],
  "summary": string
}`;

  const rawJson = await callLLM({
    systemPrompt,
    userPrompt,
    jsonMode: true
  });

  try {
    const cleaned = rawJson.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed: LLMAnalysisResult = JSON.parse(cleaned);

    const rawFixes = Array.isArray(parsed.verifiedFixes)
      ? parsed.verifiedFixes
      : Array.isArray((parsed as any).proposedFixes)
      ? (parsed as any).proposedFixes
      : Array.isArray((parsed as any).mitigations)
      ? (parsed as any).mitigations
      : Array.isArray((parsed as any).fixes)
      ? (parsed as any).fixes
      : [];

    if (parsed.isFurtherImprovementRequest) {
      // ADVANCED NEXT-STAGE PROPOSAL:
      // Omit successScore because these are brand new proposals for this incident,
      // but retain proven pitfalls from memory to prevent dangerous anti-patterns.
      parsed.verifiedFixes = rawFixes.map((fix: any, idx: number) => ({
        id: fix.id || `next_stage_${Date.now()}_${idx}`,
        action: fix.action || 'Execute recommended next-stage optimization',
        command: fix.command || '# execute command',
        avgResolutionMinutes: typeof fix.avgResolutionMinutes === 'number' ? fix.avgResolutionMinutes : 15.0,
        notes: fix.notes || ''
      }));

      const rawPitfalls = Array.isArray(parsed.pitfalls)
        ? parsed.pitfalls
        : Array.isArray((parsed as any).antiPatterns)
        ? (parsed as any).antiPatterns
        : [];

      parsed.pitfalls = rawPitfalls.map((pit: any, idx: number) => ({
        id: pit.id || `pit_${Date.now()}_${idx}`,
        action: pit.action || 'Action proven to fail in past experience',
        command: pit.command || '# do not run',
        dangerLevel: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(pit.dangerLevel) ? pit.dangerLevel : 'HIGH',
        failureOutcome: pit.failureOutcome || 'Failed during past triage attempt.'
      }));
    } else if (!parsed.hasMatch) {
      // FIRST ATTEMPT:
      // 1. Must NOT suggest what should not be doing (pitfalls MUST be empty)
      // 2. Must NOT give scores for resolution steps
      parsed.pitfalls = [];
      parsed.verifiedFixes = rawFixes.map((fix: any, idx: number) => ({
        id: fix.id || `fix_${Date.now()}_${idx}`,
        action: fix.action || 'Execute recommended mitigation',
        command: fix.command || '# execute command',
        avgResolutionMinutes: typeof fix.avgResolutionMinutes === 'number' ? fix.avgResolutionMinutes : 5.0,
        notes: fix.notes || ''
        // successScore intentionally omitted on first attempt!
      }));
    } else {
      // RECURRING INCIDENT:
      // 1. Give scores for each resolution step based on past experience
      // 2. Prevent the user from what not doing (proven pitfalls from past experience)
      parsed.verifiedFixes = rawFixes.map((fix: any, idx: number) => {
        let score = fix.successScore;
        if (typeof score === 'number' && score > 1.0) {
          score = Math.round((score / 100) * 100) / 100;
        } else if (typeof score !== 'number' || isNaN(score)) {
          score = 0.95;
        }
        return {
          id: fix.id || `fix_${Date.now()}_${idx}`,
          action: fix.action || 'Execute recommended mitigation',
          command: fix.command || '# execute command',
          avgResolutionMinutes: typeof fix.avgResolutionMinutes === 'number' ? fix.avgResolutionMinutes : 5.0,
          successScore: Math.min(1.0, Math.max(0.1, score)),
          notes: fix.notes || ''
        };
      });

      const rawPitfalls = Array.isArray(parsed.pitfalls)
        ? parsed.pitfalls
        : Array.isArray((parsed as any).antiPatterns)
        ? (parsed as any).antiPatterns
        : [];

      parsed.pitfalls = rawPitfalls.map((pit: any, idx: number) => ({
        id: pit.id || `pit_${Date.now()}_${idx}`,
        action: pit.action || 'Action proven to fail in past experience',
        command: pit.command || '# do not run',
        dangerLevel: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(pit.dangerLevel) ? pit.dangerLevel : 'HIGH',
        failureOutcome: pit.failureOutcome || 'Failed during past triage attempt.'
      }));

      // Strictly ensure NO action in verifiedFixes matches any pitfall in action or command
      const pitfallActions = new Set(parsed.pitfalls.map((p: any) => (p.action || '').trim().toLowerCase()));
      const pitfallCommands = new Set(parsed.pitfalls.map((p: any) => (p.command || '').trim().toLowerCase()).filter(Boolean));

      parsed.verifiedFixes = parsed.verifiedFixes.filter((fix: any) => {
        const act = (fix.action || '').trim().toLowerCase();
        const cmd = (fix.command || '').trim().toLowerCase();
        if (pitfallActions.has(act)) return false;
        if (cmd && pitfallCommands.has(cmd) && cmd !== '# execute command' && cmd !== '# manual command') return false;
        return true;
      });
    }

    return parsed;
  } catch (e) {
    console.error('Failed to parse LLM JSON output:', rawJson);
    throw new Error('Failed to parse structured analysis from LLM.');
  }
}
