import { protocolFor } from './protocol-grammar.mjs';

const DEFINITIONS = {
  summary: {
    train: [
      'Summarize the article into three key points.', 'Give me a concise summary of these notes.', 'Condense this report without adding advice.',
      'Turn this long update into a short recap.', 'Extract the main ideas from this passage.', 'Write a brief overview of the meeting transcript.',
      'Reduce this document to its essential facts.', 'Provide a plain-language synopsis of the memo.', 'What is the gist of this text?',
      'Create a compact recap of the research.', 'Summarize what happened in this conversation.', 'Shorten this explanation while preserving meaning.',
      'Give me the top takeaways only.', 'Produce a neutral abstract of the draft.', 'Compress these paragraphs into a quick read.',
      'Recap the content without proposing actions or next steps.'
    ],
    dev: ['What does this document basically say?', 'Boil this down to the essentials.', 'Recap the discussion without proposing next steps.']
  },
  checklist: {
    train: [
      'Make a checklist for moving apartments.', 'Turn these chores into checkboxes.', 'List the packing tasks I need to complete.',
      'Give me a task list for cleaning the kitchen.', 'Convert this project into a simple to-do list.', 'I need checkboxes, not a strategic roadmap.',
      'Write only the concrete tasks for launch day.', 'Break this into items I can tick off.', 'Create a completion checklist for the application.',
      'List actions rather than phases.', 'Make an ordered task list for the repair.', 'Give me a checklist and no long-term plan.',
      'Use checkboxes instead of milestones.', 'Turn the instructions into discrete tasks.', 'Create a punch list for the final inspection.',
      'Give me boxes to tick rather than phases or a roadmap.'
    ],
    dev: ['Give me boxes to tick for the garage cleanup.', 'Convert the move into individual tasks.', 'List what must be done, not the overall strategy.']
  },
  message: {
    train: [
      'Draft an email asking Maya for Friday availability.', 'Write a text telling Alex I will be late.', 'Reply to the recruiter and thank them for the update.',
      'Compose a short message declining the invitation.', 'Tell Jordan I can meet next Tuesday.', 'Write a professional follow-up to the hiring manager.',
      'Draft a polite note requesting the invoice.', 'Respond that the proposed time does not work.', 'Write a message apologizing for the delay.',
      'Email my professor asking for clarification.', 'Compose a friendly reminder about the payment.', 'Tell Priya I need to reschedule our call.',
      'Draft a concise response confirming receipt.', 'Write a note asking when the package will arrive.', 'Reply with my updated phone number.',
      'Compose the words I should send, not a plan.'
    ],
    dev: ['Write to Sam that Thursday works for me.', 'Draft a polite response asking for more details.', 'Send a brief note confirming the appointment.']
  },
  decision: {
    train: [
      'Help me choose between renting and buying.', 'Compare the two job offers and make a call.', 'Decide whether I should repair or replace the car.',
      'Which laptop should I buy, the Air or the Pro?', 'Pick between the cheap flight and the direct flight.', 'Evaluate option A versus option B.',
      'Give me a decision between staying and moving.', 'Compare these apartments and recommend one.', 'Should I study tonight or wake up early?',
      'Choose the safer of these two plans.', 'Weigh the tradeoffs and tell me which route wins.', 'Make a call between speed and lower cost.',
      'Compare monthly rent against commute time.', 'Help me decide which deadline to prioritize.', 'Select one of these alternatives with reasons.',
      'I need a choice, not a checklist.'
    ],
    dev: ['Which is better: the cheaper lease or the shorter commute?', 'Make the call between taking cash and accepting equity.', 'Compare both options and choose one.']
  },
  study: {
    train: [
      'Break my history essay into a study schedule.', 'Plan how to finish the calculus assignment before Friday.', 'Organize revision for the economics exam.',
      'Turn this class project into research and drafting phases.', 'Create a study plan for the biology test.', 'Schedule the reading, outline, draft, and revision.',
      'Help me sequence the homework over three evenings.', 'Plan the steps for completing my term paper.', 'Build an exam preparation timetable.',
      'Divide the assignment into manageable sessions.', 'Create a deadline-aware study roadmap.', 'Organize my research project from sources to submission.',
      'Map the coursework into ordered study blocks.', 'Plan my essay workflow around the rubric.', 'Schedule practice problems and review sessions.',
      'Lay out how to prepare for the final exam with study sessions.'
    ],
    dev: ['Lay out how I should prepare for the chemistry final.', 'Schedule the stages of my literature paper.', 'Organize this assignment across the next four days.']
  },
  event: {
    train: [
      'Plan a birthday dinner for twelve people.', 'Organize the picnic including guests, food, and timing.', 'Coordinate a small community meetup.',
      'Create the run of show for the launch party.', 'Plan the volunteer day from setup through cleanup.', 'Organize a family barbecue this weekend.',
      'Coordinate the meeting location, invitations, and supplies.', 'Plan a photo shoot with schedule and backup location.', 'Set up a graduation celebration.',
      'Organize the guest list, food, and timeline.', 'Build an event plan for the fundraiser.', 'Coordinate a workshop with speakers and materials.',
      'Plan the dinner reservation and arrival schedule.', 'Organize a pop-up event with setup tasks.', 'Create a timeline for the neighborhood gathering.',
      'Plan the office farewell lunch from invitations through cleanup.'
    ],
    dev: ['Coordinate a small outdoor movie night.', 'Plan the office farewell lunch from invitations to cleanup.']
  },
  errands: {
    train: [
      'Arrange my grocery, pharmacy, and post office stops.', 'Optimize this list of errands by location.', 'Plan the fastest route for these pickups.',
      'Order the bank, dry cleaner, and supermarket trip.', 'Sequence my stops so frozen food is last.', 'Group these errands into one efficient run.',
      'Plan the pickup and drop-off route.', 'Arrange the shopping trip around store closing times.', 'Order my appointments and purchases for Saturday.',
      'Make an efficient route for returns and groceries.', 'Sequence the pharmacy before the parcel drop.', 'Optimize the drive between these stores.',
      'Group nearby stops and put perishables last.', 'Arrange the errands by urgency and distance.', 'Plan the supply-store run with a route.',
      'I need a trip order, not an event plan.'
    ],
    dev: ['Order the hardware store, pharmacy, and grocery stops.', 'Arrange my returns and pickups into the shortest run.']
  },
  plan: {
    train: [
      'Give me a roadmap for migrating the database.', 'Plan the phases of moving the website to a new host.', 'Create a step-by-step strategy for launching the service.',
      'Map the project from discovery through delivery.', 'Give me milestones for the office relocation.', 'Create an implementation roadmap for the new system.',
      'Lay out phases rather than individual checkboxes.', 'Build a structured plan for changing careers.', 'Organize the renovation into dependencies and stages.',
      'Plan the rollout across preparation, pilot, and release.', 'Give me a roadmap, explicitly not a task list.', 'Define the phases and sequence for the migration.',
      'Create a strategic plan with milestones.', 'Show dependencies between the workstreams.', 'Plan the transition from old process to new process.',
      'I need a roadmap rather than checkboxes.'
    ],
    dev: ['Lay out the phases for replacing the billing system.', 'Create a roadmap for opening the new location.', 'Organize the migration into milestones and dependencies.']
  },
  next_action: {
    train: [
      'What is the first concrete thing I should do today?', 'I am stuck; give me only the next action.', 'Choose the smallest useful step right now.',
      'The goal is set, tell me the immediate move.', 'What should I do next?', 'Pick one action I can finish in ten minutes.',
      'Give me the first step, not the full roadmap.', 'Tell me the next visible action.', 'I already have a plan; choose today\'s move.',
      'Identify the smallest reversible next step.', 'What is one thing I can do before lunch?', 'Select the immediate action that creates information.',
      'Do not plan everything; tell me what to do now.', 'Give me one concrete move and stop.', 'I know the objective, choose the next step.',
      'Point me to the first unfinished action.'
    ],
    dev: ['Tell me the single next move.', 'I have the goal already; what do I do right now?']
  },
  compound: {
    train: [
      'Coordinate the workshop and optimize the supply pickup route.', 'Plan the picnic and arrange the grocery run.', 'Organize the event while sequencing all store stops.',
      'Set up the photo shoot and route the equipment pickups.', 'Plan the volunteer day plus the donation collection route.', 'Coordinate the dinner and optimize errands beforehand.',
      'Organize the launch party and schedule material pickups.', 'Plan the meetup together with the fastest supply run.', 'Coordinate the move and order the truck and hardware stops.',
      'Organize the fundraiser and sequence the shopping trip.', 'Plan the class event and arrange the printing pickup.', 'Coordinate the barbecue and optimize the food-store route.',
      'Plan the gathering while ordering the pharmacy and grocery stops.', 'Organize the workshop plus the equipment-return route.', 'Coordinate the celebration and schedule the cake pickup.',
      'Plan the community event and optimize the supply run.'
    ],
    dev: ['Coordinate the open house and arrange all supply pickups.', 'Plan the team retreat while optimizing the grocery and equipment run.']
  }
};

export const HARD_DEVELOPMENT = Object.freeze([
  { id:'hm-2', axis:'mixed-intent', intent:'decision', prompt:'Pick between the low-rent apartment and the place near work.' },
  { id:'hm-24', axis:'negation-scope', intent:'plan', prompt:'Give me migration phases, explicitly not a task list.' },
  { id:'hm-28', axis:'mixed-intent', intent:'compound', prompt:'Coordinate the picnic and optimize the supply-store trip.' },
  { id:'hm-25', axis:'relation-word', intent:'next_action', prompt:'The goal is already set. Choose today’s first concrete move.' },
  { id:'hm-14', axis:'negation-scope', intent:'checklist', prompt:'Use checkboxes rather than a roadmap for the move.' },
  { id:'hm-8', axis:'mixed-intent', intent:'errands', prompt:'Bread, prescription, parcel return, then frozen food: arrange the trip.' },
  { id:'hm-4', axis:'relation-word', intent:'message', prompt:'Tell Priya I am unavailable Wednesday and offer Friday instead.' }
]);

function row(intent, prompt, id, split) {
  return Object.freeze({ id, split, intent, prompt, expected: protocolFor(intent) });
}

export function buildCorpus() {
  const train = [];
  const development = [];
  let ti = 0;
  let di = 0;
  for (const [intent, def] of Object.entries(DEFINITIONS)) {
    for (const prompt of def.train) train.push(row(intent, prompt, `tr-${String(++ti).padStart(4, '0')}`, 'train'));
    for (const prompt of def.dev) development.push(row(intent, prompt, `ex-${String(++di).padStart(4, '0')}`, 'development'));
  }
  const hard = HARD_DEVELOPMENT.map(x => row(x.intent, x.prompt, x.id, 'hard-development'));
  return Object.freeze({ train: Object.freeze(train), development: Object.freeze(development), hard: Object.freeze(hard) });
}
