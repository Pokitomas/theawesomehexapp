// Deterministic labeled corpus for the Archie Sprawl protocol decoder.
//
// Each example maps a natural-language task prompt to a target protocol: an
// ordered opcode sequence (see protocol-grammar.mjs). Every example carries a
// `group` so the train/development split can be group-disjoint — no family of
// surface variants may straddle the split, mirroring the repository's
// group-wise holdout discipline (see ARCHIE_TRAINING.md).
//
// Intents are a designed target, not a learned taxonomy: the value proven here
// is whether a from-scratch decoder can recover the correct constrained
// protocol from prompt text alone, including on the hard-margin slice.

import { opcodeIds } from './protocol-grammar.mjs';

// Designed intent -> canonical protocol. All nine protocols are distinct.
export const INTENT_PROTOCOL = Object.freeze({
  message: ['OBSERVE', 'DRAFT', 'STOP'],
  objective: ['OBSERVE', 'DRAFT', 'VERIFY', 'STOP'],
  next_action: ['OBSERVE', 'DECOMPOSE', 'STOP'],
  decision: ['OBSERVE', 'COMPARE', 'DRAFT', 'STOP'],
  checklist: ['OBSERVE', 'DECOMPOSE', 'DRAFT', 'STOP'],
  plan: ['RETRIEVE', 'DECOMPOSE', 'ORDER', 'DRAFT', 'STOP'],
  event: ['OBSERVE', 'SCHEDULE', 'DRAFT', 'STOP'],
  errands: ['OBSERVE', 'ORDER', 'SCHEDULE', 'STOP'],
  compound: ['OBSERVE', 'DECOMPOSE', 'ORDER', 'SCHEDULE', 'STOP']
});

export const INTENTS = Object.freeze(Object.keys(INTENT_PROTOCOL));

// Cue-bearing surface families per intent. Families deliberately share the
// discriminative vocabulary of their intent while varying subjects/fillers, so
// that holding out whole families measures generalization over the recurring
// cue words rather than memorization of a fixed string.
const FAMILIES = Object.freeze({
  message: [
    ['Tell Marcus the meeting moved to noon.', 'Tell the landlord the sink is leaking again.', 'Tell the team I am out sick today.'],
    ['Let Dana know I will be ten minutes late.', 'Let the client know the draft is ready.', 'Let mum know I landed safely.'],
    ['Reply to Sam and confirm the invoice was paid.', 'Reply to the recruiter that I am still interested.', 'Reply to Ana and thank her for the referral.'],
    ['Send a quick note to Ravi about the schedule change.', 'Send a note to the group that lunch is cancelled.', 'Send Priya a message that the keys are under the mat.'],
    ['Message the plumber to reschedule for Friday.', 'Message my sister that dinner is at seven.', 'Message the office that I am working from home.'],
    ['Tell the coach that Leo will miss practice.', 'Let the neighbour know the delivery arrived.', 'Message the host that we are running late.'],
    ['Reply to Jordan and confirm Tuesday works.', 'Send a note to the vendor that the order changed.', 'Tell the front desk we need a late checkout.']
  ],
  objective: [
    ['Set the goal for this quarter.', 'Set our main goal for the launch.', 'Set the goal for the fundraising push.'],
    ['Define the objective for the redesign.', 'Define the objective of the pilot program.', 'Define the objective for onboarding.'],
    ['Establish the target for monthly active users.', 'Establish a measurable target for support response time.', 'Establish the revenue target for the year.'],
    ['Pick the north star metric for the product.', 'Pick our guiding aim for the season.', 'Decide the overarching aim for the team.'],
    ['Frame the outcome we are actually trying to reach.', 'Name the single measurable outcome that matters.', 'State the aim the whole project serves.'],
    ['Set the objective for the marketing sprint.', 'Define the measurable goal for the beta.', 'Establish the target for the reading challenge.'],
    ['Decide the overarching aim for the migration.', 'Name the outcome the redesign must reach.', 'Set the guiding goal for the quarter ahead.']
  ],
  next_action: [
    ['The goal is already set, so choose the first concrete move.', 'The plan exists; pick the immediate next step to take now.', 'The aim is fixed, so name the very next action.'],
    ['What is the single next step I should take today?', 'Give me just the next action, nothing more.', 'Tell me the one concrete thing to do right now.'],
    ['We know the objective; identify today the first move.', 'Objective is decided, choose the next tangible step.', 'With the target set, pick the immediate action.'],
    ['Cut to the next physical action on this.', 'Just the next doable step, please.', 'Point me at the very next thing to start.'],
    ['The target is fixed, so choose the next concrete move.', 'We already set the goal; name today the first step.', 'Skip the planning and give the immediate next action.'],
    ['The objective stands, so pick the single next step.', 'Just the one next move I should make now.', 'With the aim decided, point me at the first action.']
  ],
  decision: [
    ['Pick between the two job offers.', 'Choose between the aisle seat and the window seat.', 'Pick between renting and buying.'],
    ['Decide between the red logo and the blue logo.', 'Choose between Postgres and SQLite for this.', 'Decide between the morning slot or the evening slot.'],
    ['Should we go with vendor A or vendor B?', 'Is it better to fly or take the train?', 'Do we ship now or wait a week?'],
    ['Weigh the cheaper plan against the faster plan and choose.', 'Compare the two apartments and settle on one.', 'Contrast the two candidates and make the call.'],
    ['Help me choose one of these three phones.', 'Which of the two contracts should I sign?', 'Between coffee shop and library, where should I work?'],
    ['Pick between the gym membership and the home setup.', 'Choose between the direct flight and the cheaper layover.', 'Decide between hiring now or waiting a quarter.'],
    ['Weigh the two insurance plans against each other and choose.', 'Between the beach trip and the city trip, settle it.', 'Should I take the salary offer or the equity offer?']
  ],
  checklist: [
    ['Give me a checklist for packing the apartment.', 'Give me a checklist for the product launch day.', 'Make a checklist for closing the store at night.'],
    ['I want checkboxes for the move, not a roadmap.', 'Use checkboxes rather than phases for onboarding.', 'Checkable items please, not a strategy.'],
    ['List the items to tick off before the flight.', 'List things to check off for the inspection.', 'Turn this into tickable items I can mark done.'],
    ['A simple to-check list for the camping trip.', 'A tick-box list for the deployment.', 'A checkable list for the audit prep.'],
    ['Make a checklist for the morning open.', 'Give me checkboxes for the event teardown, not phases.', 'A tick-box list for the new-hire setup.'],
    ['List the items to check off before the demo.', 'Checkable items for the rented cabin, not a roadmap.', 'Turn the packing into tickable checkboxes.'],
    // Negation-scope contrast: the requested format is checkboxes; the other
    // format is explicitly negated. Mirrors the plan negation family.
    ['Give me checkboxes for the move, explicitly not a roadmap.', 'A tick-box list for onboarding, not the phases.', 'Checkable items for the launch, not a phased plan.'],
    ['I want a checklist for the rebrand, explicitly not a roadmap.', 'Tick-box items for the relocation, not the phases.', 'Give me checkboxes for the audit, not a staged plan.']
  ],
  plan: [
    ['Give me the migration phases for the database move.', 'Lay out the phases for the office relocation.', 'Break the rollout into phases.'],
    ['I want a roadmap for the redesign, not a task list.', 'Give me a phased plan rather than a checklist.', 'Draw the roadmap for the platform migration.'],
    ['Sketch the strategy in stages for scaling the team.', 'Map the multi-stage plan for the launch.', 'Outline the phased approach to paying down the debt.'],
    ['Sequence the migration into ordered stages.', 'Structure the project as roadmap milestones.', 'Plan the transition in ordered phases.'],
    ['Lay out the migration phases for the billing system, not a task list.', 'Give me a staged roadmap for the rebrand.', 'Break the cloud move into ordered phases.'],
    ['Map the phased plan for onboarding the new region.', 'Draw the roadmap for the warehouse relocation.', 'Outline the multi-stage strategy for the launch.'],
    // Negation-scope contrast: the requested format is phases/roadmap; the other
    // format is explicitly negated. Teaches the boundary hm-24 and hm-14 probe.
    ['Give me the rollout phases, explicitly not checkboxes.', 'A phased roadmap for the office move, not a tick-box list.', 'Lay out the migration phases, not the checklist.'],
    ['I want the redesign roadmap, explicitly not a checklist.', 'Break the launch into ordered phases, not checkboxes.', 'Draw the staged plan for the rebrand, not a task list.']
  ],
  event: [
    ['Coordinate the picnic in the park.', 'Organize the team dinner on Thursday.', 'Set up the birthday gathering.'],
    ['Plan the meetup for the book club.', 'Arrange the housewarming party.', 'Organize the office holiday get-together.'],
    ['Put together the reunion lunch.', 'Sort out the graduation celebration.', 'Host a small dinner for six on Saturday.'],
    ['Coordinate the wedding rehearsal evening.', 'Organize the charity bake sale afternoon.', 'Set up the neighborhood potluck.'],
    ['Organize the retirement party for Dad.', 'Set up the game night for the team.', 'Coordinate the baby shower brunch.'],
    ['Plan the anniversary dinner downtown.', 'Arrange the welcome lunch for the intern.', 'Put together the fundraiser evening.']
  ],
  errands: [
    ['Bread, prescription, then dry cleaning: arrange the trip.', 'Arrange the errands: bank, post office, pharmacy.', 'Route the stops for groceries, hardware store, and gas.'],
    ['Sequence the pickups: kids, dog, package.', 'Order the shopping run across three stores.', 'Plan the trip: return the parcel, then buy milk.'],
    ['Milk, stamps, library book return: order the run.', 'Arrange one trip covering the vet and the grocer.', 'Route my afternoon of errands efficiently.'],
    ['Batch the chores into one outing.', 'Plan the drive that hits the bank and the market.', 'Order these errands so I drive the least.'],
    ['Pharmacy, cleaners, then hardware store: arrange the run.', 'Sequence the stops: gas, grocery, recycling drop.', 'Route the errands: post office, bakery, and pet shop.'],
    ['Order the pickups: laundry, parcel, and the cake.', 'Plan one trip for the bank, market, and clinic.', 'Batch the shopping across the two malls efficiently.']
  ],
  compound: [
    ['Coordinate the reunion and optimize the supply-store trip.', 'Plan the dinner party and route the shopping for it.', 'Organize the move and sequence the errands around it.'],
    ['Handle the launch event and streamline the vendor pickups.', 'Set up the reunion and optimize the grocery run together.', 'Arrange the party and batch the supply errands.'],
    ['Do both the fundraiser and the catering trip efficiently.', 'Combine planning the retreat with routing the equipment pickups.', 'Coordinate the wedding lunch and optimize the flower and cake stops.'],
    ['Organize the game night and optimize the snack-store run.', 'Set up the office party and streamline the supply pickups.', 'Coordinate the bake sale and route the ingredient shopping.'],
    ['Plan the housewarming and batch the furniture-store errands.', 'Handle the recital and optimize the costume pickups together.', 'Arrange the potluck and sequence the grocery stops for it.']
  ]
});

// The seven documented hard-margin failures, promoted into paired contrastive
// cases (Next Step #2). Each pair sits on a negation-scope, relation-word, or
// mixed-intent boundary. The `hard` member is the exact failing prompt from the
// report; the `foil` is its near-neighbor with the opposite correct intent.
// Foils are added to TRAINING; hard members are held out for evaluation only.
export const HARD_MARGIN_PAIRS = Object.freeze([
  {
    id: 'hm-2', axis: 'mixed-intent',
    hard: { intent: 'decision', prompt: 'Pick between the low-rent apartment and the place near work.' },
    foil: { intent: 'compound', prompt: 'Handle the low-rent apartment paperwork and optimize the moving-truck trip.' }
  },
  {
    id: 'hm-24', axis: 'negation-scope',
    hard: { intent: 'plan', prompt: 'Give me migration phases, explicitly not a task list.' },
    foil: { intent: 'checklist', prompt: 'Give me a task list for the migration, not the phases.' }
  },
  {
    id: 'hm-28', axis: 'mixed-intent',
    hard: { intent: 'compound', prompt: 'Coordinate the picnic and optimize the supply-store trip.' },
    foil: { intent: 'event', prompt: 'Coordinate the picnic in the meadow.' }
  },
  {
    id: 'hm-25', axis: 'relation-word',
    hard: { intent: 'next_action', prompt: 'The goal is already set. Choose today’s first concrete move.' },
    foil: { intent: 'objective', prompt: 'The goal is not set yet. Define the objective for this month.' }
  },
  {
    id: 'hm-14', axis: 'negation-scope',
    hard: { intent: 'checklist', prompt: 'Use checkboxes rather than a roadmap for the move.' },
    foil: { intent: 'plan', prompt: 'Use a roadmap rather than checkboxes for the move.' }
  },
  {
    id: 'hm-8', axis: 'mixed-intent',
    hard: { intent: 'errands', prompt: 'Bread, prescription, parcel return, then frozen food: arrange the trip.' },
    foil: { intent: 'compound', prompt: 'Arrange the grocery trip and coordinate the dinner it is for.' }
  },
  {
    id: 'hm-4', axis: 'relation-word',
    hard: { intent: 'message', prompt: 'Tell Priya I am unavailable Wednesday and offer Friday instead.' },
    foil: { intent: 'errands', prompt: 'Priya’s dry cleaning and the pharmacy: arrange Friday’s trip.' }
  }
]);

function protocolIdsFor(intent) {
  const names = INTENT_PROTOCOL[intent];
  if (!names) throw new Error(`No protocol for intent ${intent}`);
  return opcodeIds(names);
}

// Build the full corpus deterministically. Returns frozen example records:
//   { id, group, intent, prompt, protocol: number[] , slice }
// slice is 'base', 'foil', or 'hard-margin'.
export function buildCorpus() {
  const examples = [];
  let counter = 0;
  const push = (intent, prompt, group, slice) => {
    examples.push(Object.freeze({
      id: `ex-${String(counter).padStart(4, '0')}`,
      group,
      intent,
      prompt,
      protocol: protocolIdsFor(intent),
      slice
    }));
    counter += 1;
  };

  for (const intent of INTENTS) {
    const families = FAMILIES[intent];
    families.forEach((variants, familyIndex) => {
      const group = `${intent}:fam${familyIndex}`;
      for (const prompt of variants) push(intent, prompt, group, 'base');
    });
  }

  // Foils train the model to hold the boundary the hard cases probe.
  for (const pair of HARD_MARGIN_PAIRS) {
    push(pair.foil.intent, pair.foil.prompt, `hard-foil:${pair.id}`, 'foil');
  }

  return Object.freeze(examples);
}

// The hard-margin evaluation slice: the exact failing prompts, held out of
// training entirely.
export function hardMarginSlice() {
  return HARD_MARGIN_PAIRS.map(pair => Object.freeze({
    id: pair.id,
    axis: pair.axis,
    intent: pair.hard.intent,
    prompt: pair.hard.prompt,
    protocol: protocolIdsFor(pair.hard.intent)
  }));
}
