import { Incident } from './types';

export interface LLMAnalysisResult {
  hasMatch: boolean;
  matchedIncidentId: string | null;
  matchConfidence: number;
  diagnosis: string;
  rootCause: string;
  divergenceWarning: string | null;
  verifiedFixes: Array<{
    id: string;
    action: string;
    command: string;
    avgResolutionMinutes: number;
    successScore: number;
    notes: string;
  }>;
  pitfalls: Array<{
    id: string;
    action: string;
    command: string;
    dangerLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    failureOutcome: string;
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
    const model = process.env.GROQ_MODEL || process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
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

  // 1. Groq API (First-class ultra-fast inference)
  if (groqKey) {
    const model = process.env.GROQ_MODEL || process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
    const url = 'https://api.groq.com/openai/v1/chat/completions';

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const body: any = {
      model,
      messages,
      temperature: 0.1
    };

    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

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
      throw new Error(`Groq API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Groq API returned an empty response.');
    }
    return content;
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
 * Analyzes an alert using real LLM reasoning grounded in database postmortems.
 */
export async function analyzeIncidentWithLLM(
  alertMessage: string,
  historicalIncidents: Incident[]
): Promise<LLMAnalysisResult> {
  const systemPrompt = `You are the Incident Response Agent (IRA), an expert Site Reliability Engineer (SRE).
Your mission is to analyze incoming production alerts and ground your recommendations in historical incident postmortems stored in organizational memory.

RULES:
1. Compare the incoming alert against the provided historical incidents.
2. If there is a strong historical precedent (same service, same error pattern, or matching root cause), set hasMatch = true, identify the matched incident ID, and calculate matchConfidence (0-100%).
3. If no incident in memory matches (it's a zero-day / unknown incident), set hasMatch = false, matchedIncidentId = null, matchConfidence = 0.
4. If the alert looks like a deceptive twin (e.g. looks like connection exhaustion but has different telemetry such as idle DB and full cache), formulate a clear divergenceWarning.
5. Provide actionable, verified fixes with exact runnable shell commands (e.g., kubectl, psql, systemctl).
6. Flag dangerous pitfalls / anti-patterns (actions that engineers must avoid because they fail or worsen downtime).
7. Respond ONLY with valid JSON conforming to the requested schema.`;

  const memoryContext = historicalIncidents.map(inc => ({
    id: inc.id,
    title: inc.title,
    service: inc.service,
    rootCause: inc.rootCause,
    alertSignatures: inc.alertSignatures,
    telemetry: inc.telemetry,
    successfulMitigations: inc.successfulMitigations?.map(m => ({
      action: m.action,
      command: m.command,
      successScore: m.successScore,
      notes: m.notes
    })),
    failedMitigations: inc.failedMitigations?.map(f => ({
      action: f.action,
      command: f.command,
      dangerLevel: f.dangerLevel,
      failureOutcome: f.failureOutcome
    }))
  }));

  const userPrompt = `INCOMING PRODUCTION ALERT:
"""
${alertMessage}
"""

HISTORICAL INCIDENTS IN DATABASE MEMORY:
${JSON.stringify(memoryContext, null, 2)}

Provide your analysis in JSON format with exactly this structure:
{
  "hasMatch": boolean,
  "matchedIncidentId": string or null,
  "matchConfidence": number (between 0 and 100),
  "diagnosis": string,
  "rootCause": string,
  "divergenceWarning": string or null,
  "verifiedFixes": [
    {
      "id": string (e.g. "fix_1"),
      "action": string,
      "command": string,
      "avgResolutionMinutes": number,
      "successScore": number (between 0 and 1),
      "notes": string
    }
  ],
  "pitfalls": [
    {
      "id": string (e.g. "pitfall_1"),
      "action": string,
      "command": string,
      "dangerLevel": "HIGH" | "CRITICAL" | "MEDIUM" | "LOW",
      "failureOutcome": string
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
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse LLM JSON output:', rawJson);
    throw new Error('Failed to parse structured analysis from LLM.');
  }
}
