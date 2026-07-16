import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIL_SCHEMA,
  compareArchiePrograms,
  compileArchieProgram,
  parseArchieLanguage,
  printArchieLanguage,
  validateArchieProgram
} from '../archie-language.mjs';

const base = `AIL/1
world repo {"name":"theawesomehexapp"}
actor owner {"kind":"human"}
source pr394 {"uri":"github:Pokitomas/theawesomehexapp#394"}
fact head {"expr":"pr394.head = exact_sha","evidence":["pr394"]}
goal deployed {"expr":"served.sha = main.sha","priority":1}
protect truth {"expr":"receipts describe observed reality"}
capability inspect_pr {"operation":"github.fetch_pr","effect":"read"}
capability merge_pr {"operation":"github.merge_pr","effect":"external-write"}
grant merge_authority {"actor":"owner","capability":"merge_pr","scope":"Pokitomas/theawesomehexapp"}
step inspect {"operation":"inspect_pr","after":[],"requires":[],"expect":["pr.open"]}
step merge {"operation":"merge_pr","after":["inspect"],"requires":["merge_authority"],"expect":["main.sha = merge.sha"]}
verify sentinel {"expr":"served.sha = main.sha","after":["merge"],"evidence":["head"]}
learn deployment_skill {"from":["sentinel"],"skill":"exact-sha deployment convergence","outcome":"accepted"}
halt complete {"expr":"sentinel verified and receipt bound","after":["deployment_skill"]}
presentation butler {"shell":"warm butler","tone":"deferential"}
`;

test('AIL parses, validates, prints canonically, and schedules executable cognition', () => {
  const parsed = parseArchieLanguage(base);
  assert.equal(parsed.schema, AIL_SCHEMA);
  const printed = printArchieLanguage(parsed);
  assert.equal(parseArchieLanguage(printed).semantic_digest, parsed.semantic_digest);
  const compiled = compileArchieProgram(parsed);
  assert.deepEqual(compiled.schedule.map(item => item.id), ['inspect', 'merge', 'sentinel', 'deployment_skill', 'complete']);
  assert.equal(compiled.presentation[0].shell, 'warm butler');
});

test('presentation changes source identity without changing directive semantics', () => {
  const butler = parseArchieLanguage(base);
  const scientist = parseArchieLanguage(base.replace(
    'presentation butler {"shell":"warm butler","tone":"deferential"}',
    'presentation scientist {"shell":"skeptical scientist","tone":"terse"}'
  ));
  const comparison = compareArchiePrograms(butler, scientist);
  assert.equal(comparison.same_semantics, true);
  assert.equal(comparison.same_source, false);
});

test('directive changes alter semantic identity even when presentation is constant', () => {
  const original = parseArchieLanguage(base);
  const changed = parseArchieLanguage(base.replace(
    'goal deployed {"expr":"served.sha = main.sha","priority":1}',
    'goal deployed {"expr":"draft artifact exists","priority":1}'
  ));
  assert.equal(compareArchiePrograms(original, changed).same_semantics, false);
});

test('external and irreversible effects require explicit grants', () => {
  const withoutGrant = base
    .replace('grant merge_authority {"actor":"owner","capability":"merge_pr","scope":"Pokitomas/theawesomehexapp"}\n', '')
    .replace('"requires":["merge_authority"]', '"requires":[]');
  assert.throws(() => parseArchieLanguage(withoutGrant), /explicit grant/);
});

test('dependencies and evidence references fail closed', () => {
  assert.throws(() => parseArchieLanguage(base.replace('"evidence":["head"]', '"evidence":["invented"]')), /missing instruction invented/);
  assert.throws(() => validateArchieProgram({
    schema: AIL_SCHEMA,
    instructions: [
      { kind: 'capability', id: 'read', operation: 'read', effect: 'read' },
      { kind: 'step', id: 'a', operation: 'read', after: ['b'] },
      { kind: 'step', id: 'b', operation: 'read', after: ['a'] }
    ]
  }), /dependency cycle/);
});

test('canonical kernel objects do not require a personal owner ontology', () => {
  const institutional = parseArchieLanguage(base
    .replace('actor owner {"kind":"human"}', 'actor council {"kind":"institution","members":5}')
    .replace('"actor":"owner"', '"actor":"council"'));
  assert.equal(institutional.instructions.find(item => item.kind === 'actor').id, 'council');
});
