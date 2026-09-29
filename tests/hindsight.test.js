/**
 * Verification Test Suite for Incident Response Agent (IRA)
 * Tests semantic recall, failure tracking, success scores, and divergence warnings.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const HindsightEngine = require('../engine/hindsight');
const GenericAgent = require('../engine/generic_agent');

console.log('🧪 Starting Incident Response Agent (IRA) Test Suite...\n');

// 1. Initialize Engine
const testDataPath = path.join(__dirname, 'test_incidents.json');
// Copy baseline data to test path so we don't mutate primary data in tests
fs.copyFileSync(path.join(__dirname, '..', 'data', 'incidents.json'), testDataPath);

const engine = new HindsightEngine(testDataPath);
const generic = new GenericAgent();

console.log('✅ HindsightEngine initialized with', engine.incidents.length, 'incidents.');

// Test 1: Recall on Alert Query
console.log('\n--- Test 1: Query Alert Recall ---');
const alertQuery = 'database timeouts on the payments service active pg_connections saturated';
const searchResult = engine.search(alertQuery);

assert(searchResult.primaryIncident !== null, 'Should find a matching primary incident');
assert.strictEqual(searchResult.primaryIncident.id, 'INC-402', 'Primary match should be INC-402');
console.log(`Matched: ${searchResult.primaryIncident.id} (${searchResult.primaryIncident.title}) with ${searchResult.primaryConfidence}% confidence`);
assert(searchResult.primaryConfidence > 70, 'Confidence should be > 70%');

// Test 2: The Twist - Success Ranking & Failure Tracking
console.log('\n--- Test 2: Mitigation Ranking & Red Herring Flagging ---');
const fixes = searchResult.rankedRecommendations.verifiedFixes;
const redHerrings = searchResult.rankedRecommendations.redHerrings;

assert(fixes.length > 0, 'Should have verified fixes');
assert(redHerrings.length > 0, 'Should have tracked failed mitigations');

console.log('Verified Fix #1:', fixes[0].action, `(Empirical Score: ${Math.round(fixes[0].empiricalScore * 100)}%)`);
console.log('Tracked Red Herring #1:', redHerrings[0].action, `(Failed ${redHerrings[0].timesFailed} times, Danger: ${redHerrings[0].dangerLevel})`);

assert.strictEqual(redHerrings[0].id, 'act_restart_deployment', 'Rolling restart should be flagged as the top red herring');
assert(redHerrings[0].timesFailed >= 5, 'Should track past failed restarts');

// Test 3: Divergence Detection (Twin Alerts with Different Root Causes)
console.log('\n--- Test 3: Divergence Detection (Cache Storm vs DB Pool) ---');
const deceptiveAlert = {
  title: 'Database query timeout on product catalog',
  service: 'payments-service', // mention service
  message: '504 Gateway Timeout during checkout browse',
  telemetry: {
    dbCpu: '88% (High)',
    redisMemory: '99.5% (Maxmemory reached)'
  }
};
const divResult = engine.search(deceptiveAlert);
console.log('Divergence Alert Output:', divResult.divergenceAlert?.warningText);
assert(divResult.divergenceAlert !== null, 'Divergence detector should flag telemetry conflict');
assert(divResult.divergenceAlert.hasDivergenceRisk, 'Should flag divergence risk');

// Test 4: Before / After Comparison Contrast
console.log('\n--- Test 4: Before / After Contrast Evaluation ---');
const genericResult = generic.analyze(alertQuery);
console.log('Zero-Memory AI Estimated MTTR:', genericResult.estimatedMttrMinutes, 'minutes');
console.log('Zero-Memory AI Top Suggestion:', genericResult.mitigationPlan[2].step, '(Risk:', genericResult.mitigationPlan[2].risk, ')');

console.log('IRA with Hindsight MTTR:', fixes[0].avgResolutionMinutes, 'minutes');
console.log('MTTR Reduction:', Math.round((1 - fixes[0].avgResolutionMinutes / genericResult.estimatedMttrMinutes) * 100), '%');
assert(genericResult.mitigationPlan[2].isDangerous === true, 'Generic AI suggests dangerous restart');

// Test 5: Interactive Feedback Loop (Recording Outcome)
console.log('\n--- Test 5: Interactive Feedback Recording ---');
const feedback = engine.recordOutcome('INC-402', 'act_drain_and_bump_pool', 'worked', {
  notes: 'Resolved pool exhaustion in 2.5 minutes during Black Friday prep',
  durationMinutes: 2.5
});
assert.strictEqual(feedback.success, true);
console.log('Updated Action Times Worked:', feedback.updatedIncident.successfulMitigations[0].timesWorked);

// Clean up test file
fs.unlinkSync(testDataPath);
console.log('\n🎉 ALL TESTS PASSED! Incident Response Agent (IRA) core logic verified.');
