import assert from 'assert';
import fs from 'fs';
import path from 'path';

// 1. Ensure env is loaded
const envPath = fs.existsSync('.env.local') ? path.resolve('.env.local') : path.resolve('frontend/.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [k, ...v] = trimmed.split('=');
      process.env[k.trim()] = v.join('=').trim();
    }
  }
}

import {
  saveIncidentToDb,
  getAllIncidentsFromDb,
  clearAllIncidentsFromDb,
  recordFeedbackInDb
} from '../frontend/src/lib/db';
import { analyzeIncidentWithLLM } from '../frontend/src/lib/llm';
import { POST as chatRoute } from '../frontend/src/app/api/chat/route';
import { POST as feedbackRoute } from '../frontend/src/app/api/mitigations/feedback/route';
import { GET as postmortemRoute } from '../frontend/src/app/api/postmortem/[id]/route';

async function runProductionTestSuite() {
  console.log('🚀 Running Production-Ready End-to-End Verification Suite...\n');

  // Test 1: Clean State Initialization
  console.log('--- Test 1: Memory Clean State ---');
  clearAllIncidentsFromDb();
  let incidents = getAllIncidentsFromDb();
  assert.strictEqual(incidents.length, 0, 'Database should be initialized cleanly');
  console.log('✅ Clean state verified (0 incidents in database).\n');

  // Test 2: First-Attempt Zero-Day Incident
  console.log('--- Test 2: First Attempt (Zero-Day Incident) ---');
  const zeroDayAlert = "High error rate 503 on checkout payment service. Circuit breaker tripped due to connection pool exhaustion.";
  const req1 = new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: zeroDayAlert })
  });

  const res1 = await chatRoute(req1 as any);
  const data1 = await res1.json();
  assert.strictEqual(res1.status, 200, 'Chat route should return HTTP 200');
  assert.strictEqual(data1.type, 'incident_analysis');
  assert.strictEqual(data1.searchResult.isZeroDay, true, 'First attempt must be marked isZeroDay: true');

  // Rule Verification: No scores and no pitfalls on first attempt!
  const zeroDayFixes = data1.searchResult.rankedRecommendations.verifiedFixes;
  assert.ok(zeroDayFixes.length >= 2, 'Must propose at least 2 dynamic mitigation steps');
  for (const fix of zeroDayFixes) {
    assert.strictEqual(fix.successScore, undefined, `First attempt fix "${fix.action}" must NOT have a success score`);
  }
  const zeroDayPitfalls = data1.searchResult.rankedRecommendations.redHerrings;
  assert.strictEqual(zeroDayPitfalls.length, 0, 'First attempt must NOT suggest what not to do (pitfalls must be empty [])');
  console.log(`✅ Zero-Day verified: ${zeroDayFixes.length} dynamic fixes proposed, 0 scores shown, 0 pitfalls shown.\n`);

  const createdIncidentId = data1.searchResult.primaryIncident.id;
  const fixToWork = zeroDayFixes[0];
  const fixToFail = zeroDayFixes[1];

  // Test 3: Interactive Feedback (Worked & Didn't work)
  console.log('--- Test 3: Interactive Human Feedback Recording ---');
  // Mark fix 1 as Worked
  const workedReq = new Request('http://localhost:3000/api/mitigations/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      incidentId: createdIncidentId,
      actionId: fixToWork.id,
      outcome: 'worked',
      actionTitle: fixToWork.action,
      notes: 'Successfully recovered pool connections.'
    })
  });
  const workedRes = await feedbackRoute(workedReq as any);
  assert.strictEqual(workedRes.status, 200);

  // Mark fix 2 as Didn't work
  const failedReq = new Request('http://localhost:3000/api/mitigations/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      incidentId: createdIncidentId,
      actionId: fixToFail.id,
      outcome: 'failed',
      actionTitle: fixToFail.action,
      notes: 'Restart caused thundering herd and worsened database crash.'
    })
  });
  const failedRes = await feedbackRoute(failedReq as any);
  assert.strictEqual(failedRes.status, 200);

  // Verify memory in database
  const updatedIncidents = getAllIncidentsFromDb();
  const memoryInc = updatedIncidents.find(i => i.id === createdIncidentId);
  assert.ok(memoryInc, 'Incident must be permanently saved in database memory');
  assert.ok(memoryInc.successfulMitigations.some(m => m.id === fixToWork.id && (m.timesWorked || 0) > 0), 'Worked fix must be recorded with positive timesWorked');
  assert.ok(!memoryInc.successfulMitigations.some(m => m.id === fixToFail.id), 'Failed fix must be completely removed from successful mitigations');
  assert.ok(memoryInc.failedMitigations.some(f => f.action === fixToFail.action), 'Failed fix must be recorded as an anti-pattern (What NOT to do)');
  console.log('✅ Feedback verified: Worked action reinforced in memory; failed action converted to anti-pattern.\n');

  // Test 4: Recurring Incident Recall
  console.log('--- Test 4: Recurring Incident Recall (Answer Directly From Memory) ---');
  const reqRecur = new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: "Checkout payment service connection pool exhaustion 503 error" })
  });

  const resRecur = await chatRoute(reqRecur as any);
  const dataRecur = await resRecur.json();
  assert.strictEqual(resRecur.status, 200);
  assert.strictEqual(dataRecur.searchResult.isZeroDay, false, 'Recurring incident must NOT be zeroDay');
  assert.strictEqual(dataRecur.searchResult.primaryIncident.id, createdIncidentId, 'Must match the previously recorded incident');
  assert.ok(dataRecur.text.includes('Answered Directly from Memory'), 'Must indicate memory recall');

  // Rule Verification: Empirical scores shown, and pitfall warning shown!
  const recurFixes = dataRecur.searchResult.rankedRecommendations.verifiedFixes;
  assert.ok(recurFixes.length >= 1);
  const matchedWorkedFix = recurFixes.find((f: any) => f.id === fixToWork.id);
  assert.ok(matchedWorkedFix, 'Verified fix from memory must be present');
  assert.ok(matchedWorkedFix.successScore !== undefined, 'Recurring fix MUST have empirical successScore');

  const recurPitfalls = dataRecur.searchResult.rankedRecommendations.redHerrings;
  assert.ok(recurPitfalls.length >= 1, 'Recurring incident MUST show pitfalls preventing what NOT to do');
  assert.ok(recurPitfalls.some((p: any) => p.action === fixToFail.action), 'Pitfalls must prevent the previously failed action');
  console.log(`✅ Recurrence verified: Answered directly from memory with empirical scores (${Math.round((matchedWorkedFix.successScore || 0) * 100)}%) and anti-pattern warnings (${recurPitfalls[0].action}).\n`);

  // Test 5: Follow-Up / Further Improvements
  console.log('--- Test 5: Follow-Up Request ("Improved a little bit but need more better") ---');
  const reqFollowUp = new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: "This improved a little bit but I need to make the application even more better" })
  });

  const resFollowUp = await chatRoute(reqFollowUp as any);
  const dataFollowUp = await resFollowUp.json();
  assert.strictEqual(resFollowUp.status, 200);
  assert.strictEqual(dataFollowUp.searchResult.isFurtherImprovement, true, 'Must detect further improvement request');
  assert.ok(dataFollowUp.searchResult.previouslyAppliedFixes.length >= 1, 'Must track previously applied fixes');
  
  const nextStageFixes = dataFollowUp.searchResult.rankedRecommendations.verifiedFixes;
  assert.ok(nextStageFixes.length >= 1, 'Must propose fresh next-stage fixes');
  // Must NOT repeat previously applied fix
  for (const nsf of nextStageFixes) {
    assert.notStrictEqual(nsf.action.toLowerCase(), fixToWork.action.toLowerCase(), 'Must NOT repeat previously verified fix');
  }
  console.log(`✅ Follow-up verified: Identified ${dataFollowUp.searchResult.previouslyAppliedFixes.length} applied fixes, proposed ${nextStageFixes.length} distinct next-stage optimizations.\n`);

  // Test 6: Postmortem API
  console.log('--- Test 6: Automated Postmortem Generation ---');
  const postmortemParams = Promise.resolve({ id: createdIncidentId });
  const postmortemRes = await postmortemRoute(new Request(`http://localhost:3000/api/postmortem/${createdIncidentId}`), { params: postmortemParams });
  const postmortemData = await postmortemRes.json();
  assert.strictEqual(postmortemRes.status, 200);
  assert.ok(postmortemData.markdown.includes('Postmortem Report'), 'Postmortem markdown generated successfully');
  assert.ok(postmortemData.markdown.includes('Verified Solutions'), 'Includes verified solutions');
  assert.ok(postmortemData.markdown.includes('Known Pitfalls & Anti-Patterns'), 'Includes known pitfalls');
  console.log('✅ Postmortem verified: Complete markdown postmortem generated from memory.\n');

  console.log('🎉 ALL PRODUCTION READINESS CHECKS PASSED WITH 100% SUCCESS!');
}

runProductionTestSuite().catch(err => {
  console.error('❌ Production test failure:', err);
  process.exit(1);
});
