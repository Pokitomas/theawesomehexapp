#!/usr/bin/env node
// Assemble the hybrid 12-route training corpus from the user's audit export.
//
// Sources (train side only):
//   1. governed corpus heldout rows (metadata.route labels), cleaned of
//      template markers, exact-deduplicated, capped per route for balance;
//   2. v1-generation routing suites (router-real-v1-cases, core-auto-route-v1)
//      — already adaptively consumed by the audit's own process, so they are
//      training material, not evaluation material;
//   3. the repository's authored conversational corpus (10 intents);
//   4. small authored conversational families for objective and clarify.
//
// The three frozen evaluation suites (router-v2-original-heldout,
// router-real-v2-heldout, router-real-v3-final) are excluded by normalized
// exact match and never trained on.
//
//   node foundry/archie-protocol/prepare-route-data.mjs \
//     --audit <audit-files-dir> --out <route-train.json>

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCorpus } from './protocol-corpus.mjs';
import { ROUTES } from './train-route-model.mjs';

const FROZEN_SUITES = ['router-v2-original-heldout', 'router-real-v2-heldout', 'router-real-v3-final'];
const PER_ROUTE_CAP = 260;
// clarify covers both vague requests and the whole red-team abstention space,
// so it gets a higher cap than the semantic routes.
const CLARIFY_CAP = 520;

const AUTHORED = {
  objective: [
    'Set the goal for this quarter.', 'Define the objective for the redesign.', 'What outcome should the team aim at?',
    'Establish the target for support response time.', 'Name the single measurable outcome that matters.',
    'Set our north star for the launch.', 'Decide the overarching aim for the season.', 'Frame the outcome we are actually trying to reach.',
    'Define what success looks like for the pilot.', 'Set the measurable goal for the fundraiser.',
    'Pin down the objective before we start building.', 'State the aim the whole project serves.',
    'Record the objective: ship the mobile beta this month.', 'Log the goal of clearing the support backlog.',
    'Capture the target we agreed on for onboarding time.', 'Note the aim: finish the draft chapter by Sunday.'
  ],
  clarify: [
    'Help me with the thing from before.', 'Can you sort this out?', 'Do what you think is best about it.',
    'Handle it.', 'Make it better somehow.', 'Fix the situation with them.', 'Deal with that issue soon.',
    'Can you just take care of it?', 'You know what I mean, right?', 'Improve things.',
    'Get this whole mess resolved.', 'Do the needful about the stuff we discussed.',
    'Something feels off with the setup, look into it.', 'That thing we talked about — make it happen.',
    'Sort the stuff out before they notice.', 'Just handle whatever is left over.'
  ],
  summary: [
    'Brief me on the vendor negotiation notes.', 'What matters most in the onboarding feedback?',
    'Compress the sprint retro into three bullets.', 'Give me the gist of the security review.',
    'What are the key points of the roadmap discussion?', 'Boil the incident report down to plain language.',
    'Brief me on the chapter about supply chains.', 'What changed in the latest status notes, briefly?',
    'Sum up the interview transcript in a few lines.', 'The short version of the audit findings, please.'
  ],
  event: [
    'Prepare the schedule and logistics for the launch demo.', 'Handle the venue, food, and timing for the team offsite.',
    'Get the birthday gathering organized end to end.', 'Sort the invitations and run of show for the recital.',
    'Line up the speakers, room, and snacks for the meetup.', 'Prepare the logistics for a weekend family reunion.'
  ],
  checklist: [
    'Build a punch list for hosting overnight guests.', 'What do I need to tick off before the inspection?',
    'Turn tomorrow’s opening shift into checkboxes.', 'A checkable list for winterizing the cabin.',
    'List every item to check before submitting the application.', 'Give me tick-boxes for the camera bag before the shoot.'
  ],
  next_action: [
    'Where do I start if the room is a total mess?', 'What now? Three urgent tasks are competing.',
    'The client has not replied — pick one immediate move.', 'Give me the single next step on the visa paperwork.',
    'What should I do first about the overdue invoices?', 'One concrete move to unblock the launch, please.'
  ],
  study: [
    'How should I tackle the thesis chapter?', 'Structure my work on the economics midterm.',
    'Break learning to drive into practice sessions.', 'Organize my revision for the anatomy exam.',
    'Plan how I get through the certification syllabus.', 'Sequence my prep for the language proficiency test.'
  ],
  decision: [
    'What should drive my choice between launching now or waiting a month?', 'Keep the subscription or cancel it?',
    'Help me settle whether to repair the laptop or replace it.', 'Choose between the two contractor bids.',
    'Should I take the transfer or stay put?', 'Make the call: hire a junior now or a senior later.'
  ],
  message: [
    'How should I phrase a note to thank the interviewer for their time?', 'Word a polite nudge about the unpaid invoice.',
    'Draft the text telling the landlord the heater died.', 'Phrase a gentle no to the weekend request.',
    'Write the two-line update for the stakeholders.', 'Compose the apology for missing the call.'
  ],
  plan: [
    'Break shipping the beta into phases.', 'Lay out the stages for the kitchen renovation.',
    'Give me the phased path from prototype to pilot.', 'Structure the migration as milestones with dependencies.',
    'Map the rollout from beta to general availability.', 'Phase the debt payoff over the next year.'
  ],
  errands: [
    'Order Saturday’s stops: pharmacy, bakery, hardware store.', 'Route the returns, the bank, and the grocery run.',
    'Sequence the school pickup, vet visit, and parcel drop.', 'Batch the market, cleaners, and library into one loop.',
    'Arrange the fuel stop, car wash, and tire check efficiently.', 'Plan the shortest run for the post office and chemist.'
  ]
};

// Compound requests in the audit's evaluation world are two single-intent
// requests conjoined. Synthesize training compounds by conjoining short
// single-intent prompts with the natural connective patterns.
const CONNECTIVES = [
  (a, b) => `${a}; also ${b.charAt(0).toLowerCase()}${b.slice(1)}`,
  (a, b) => `${a}. After that, ${b.charAt(0).toLowerCase()}${b.slice(1)}`,
  (a, b) => `${a} and then ${b.charAt(0).toLowerCase()}${b.slice(1)}`,
  (a, b) => `First ${a.charAt(0).toLowerCase()}${a.slice(1)}, then ${b.charAt(0).toLowerCase()}${b.slice(1)}`
];

function synthesizeCompounds(byRoute, push, count) {
  const donors = [];
  for (const route of ROUTES) {
    if (route === 'compound' || route === 'clarify') continue;
    for (const row of byRoute.get(route)) {
      const prompt = row.prompt.replace(/[.?!]+$/, '');
      if (prompt.length >= 18 && prompt.length <= 80) donors.push(prompt);
    }
  }
  donors.sort();
  let made = 0;
  for (let i = 0; made < count && i < donors.length * 4; i += 1) {
    const a = donors[(i * 137) % donors.length];
    const b = donors[(i * 137 + 61) % donors.length];
    if (a === b) continue;
    const joined = CONNECTIVES[i % CONNECTIVES.length](a, b);
    const before = byRoute.get('compound').length;
    push('compound', joined, 'synthesized-compound');
    if (byRoute.get('compound').length > before) made += 1;
  }
}

function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanPrompt(text) {
  return String(text).replace(/\s*\/no_think\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function userPrompt(row) {
  const message = (row.messages || []).find(m => m.role === 'user');
  return message ? message.content : null;
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i === -1 ? fallback : args[i + 1]; };
  const auditDir = value('--audit', null);
  const outPath = value('--out', 'route-train.json');
  if (!auditDir) throw new Error('Usage: --audit <audit files dir> --out <route-train.json>');
  const evalsDir = path.join(auditDir, 'artifacts', 'evals');
  const corpusDir = path.join(auditDir, 'artifacts', 'corpus', 'archie-core-v1');

  const frozen = new Set();
  for (const name of FROZEN_SUITES) {
    for (const item of readJsonl(path.join(evalsDir, `${name}.jsonl`))) frozen.add(normalize(item.text));
  }
  // Also freeze every prompt of the reconstructed 80-case admission suite (the
  // head-to-head benchmark), supplied as a JSON file of {text} rows.
  const suitePath = value('--freeze-suite', null);
  if (suitePath) {
    for (const item of JSON.parse(fs.readFileSync(suitePath, 'utf8'))) frozen.add(normalize(item.text));
  }

  // Candidates are collected first; duplicate prompts with conflicting labels
  // are resolved by majority vote (deterministic tie-break by route name), so
  // context-dependent templates train toward their dominant label instead of
  // whichever row happened to arrive first.
  const candidates = new Map(); // key -> { prompt, source, votes: Map(route -> n) }
  const push = (route, prompt, source) => {
    if (!ROUTES.includes(route)) return;
    const cleaned = cleanPrompt(prompt);
    const key = normalize(cleaned);
    if (!cleaned || !key || frozen.has(key)) return;
    let entry = candidates.get(key);
    if (!entry) { entry = { prompt: cleaned, source, votes: new Map() }; candidates.set(key, entry); }
    entry.votes.set(route, (entry.votes.get(route) || 0) + 1);
  };
  const byRoute = new Map(ROUTES.map(route => [route, []]));
  const resolveCandidates = () => {
    for (const entry of candidates.values()) {
      const winner = [...entry.votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      byRoute.get(winner).push({ prompt: entry.prompt, route: winner, source: entry.source });
    }
  };

  // 1. governed corpus rows — including the audit's own negative (abstention)
  // training file, which is Q6's clarify training material, and the
  // first-generation red-team suite (v2 is frozen for the head-to-head).
  for (const file of ['heldout.jsonl', 'negative-heldout.jsonl', 'negative-train.jsonl']) {
    const full = path.join(corpusDir, file);
    if (!fs.existsSync(full)) continue;
    for (const row of readJsonl(full)) {
      const route = row.metadata && row.metadata.route;
      const prompt = userPrompt(row);
      if (route && prompt) push(route, prompt, 'governed-corpus');
    }
  }

  // 2. v1-generation suites
  const realV1 = path.join(evalsDir, 'router-real-v1-cases.jsonl');
  if (fs.existsSync(realV1)) for (const item of readJsonl(realV1)) push(item.expected, item.request || item.text, 'router-real-v1');
  const autoV1 = path.join(evalsDir, 'core-auto-route-v1.jsonl');
  if (fs.existsSync(autoV1)) {
    for (const row of readJsonl(autoV1)) {
      const route = row.metadata && (row.metadata.route || row.metadata.expected_route);
      const prompt = userPrompt(row);
      if (route && prompt) push(route, prompt, 'auto-route-v1');
    }
  }
  const redteamV1 = path.join(evalsDir, 'core-redteam-v1.jsonl');
  if (fs.existsSync(redteamV1)) {
    for (const row of readJsonl(redteamV1)) {
      const route = (row.metadata && row.metadata.route) || 'clarify';
      const prompt = userPrompt(row) || row.text || row.request;
      if (prompt) push(route, prompt, 'redteam-v1');
    }
  }

  // 3. repository authored corpus (intents == routes for the shared ten)
  const repo = buildCorpus();
  for (const row of [...repo.train, ...repo.development, ...repo.hard]) push(row.intent, row.prompt, 'repo-corpus');

  // 4. authored conversational phrasing families per route
  for (const [route, prompts] of Object.entries(AUTHORED)) for (const prompt of prompts) push(route, prompt, 'authored');

  // Resolve conflicting duplicate labels by majority vote before synthesis.
  resolveCandidates();

  // 5. synthesized compound conjunctions from single-intent donors
  const directPush = (route, prompt, source) => {
    const cleaned = cleanPrompt(prompt);
    const key = normalize(cleaned);
    if (!cleaned || !key || frozen.has(key) || candidates.has(key)) return;
    candidates.set(key, { resolved: true });
    byRoute.get(route).push({ prompt: cleaned, route, source });
  };
  synthesizeCompounds(byRoute, directPush, 300);

  // Balance: cap over-represented routes deterministically (stable order).
  const rows = [];
  for (const route of ROUTES) {
    const list = byRoute.get(route);
    rows.push(...list.slice(0, route === 'clarify' ? CLARIFY_CAP : PER_ROUTE_CAP));
  }

  fs.writeFileSync(outPath, JSON.stringify(rows));
  const counts = Object.fromEntries(ROUTES.map(route => [route, rows.filter(r => r.route === route).length]));
  const sources = {};
  for (const row of rows) sources[row.source] = (sources[row.source] || 0) + 1;
  console.log(JSON.stringify({ ok: true, out: outPath, rows: rows.length, route_counts: counts, sources }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
