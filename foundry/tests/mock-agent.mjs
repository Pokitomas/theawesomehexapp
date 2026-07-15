import fs from 'node:fs/promises';
import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const assignment = JSON.parse(input);
if (process.env.MOCK_FOUNDRY_MUTATE === '1') {
  await fs.writeFile('agent-mutation.txt', assignment.role);
}
const distance = assignment.role === 'architecture-heretic'
  ? 'heretical'
  : assignment.role === 'frontier-cartographer'
    ? 'conservative'
    : 'adjacent';
console.log(JSON.stringify({
  assignment_id: assignment.assignment_id,
  role: assignment.role,
  claims: [{
    id: `claim:${assignment.role}`,
    statement: `${assignment.role} produced a bounded hypothesis.`,
    confidence: 0.5,
    evidence: ['mock-agent'],
    contradicts: [],
    hypothesis_id: `hypothesis:${assignment.role}`,
    status: 'hypothesis'
  }],
  proposals: [{
    candidate_id: `candidate:${assignment.role}`,
    family: 'mock-family',
    distance,
    mechanism: `Mechanism proposed by ${assignment.role}.`,
    falsifier: 'Fails matched proxy evaluation.',
    cost: 1,
    expected_information_gain: 2,
    matched_compute_baseline: 'Mock matched baseline.',
    hidden_evaluation: 'Mock hidden evaluation.',
    reproduction_seeds: 2,
    novelty_tags: [assignment.role]
  }],
  external_resources: [],
  uncertainty: 'Mock report.'
}));
