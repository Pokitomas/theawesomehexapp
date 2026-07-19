// Constrained protocol grammar for the Archie Sprawl protocol decoder.
//
// The report's Next Step #1 asks for "a compact decoder over OBSERVE, RETRIEVE,
// ASK, DECOMPOSE, ORDER, COMPARE, DRAFT, SCHEDULE, VERIFY, and STOP" and its
// release gate requires "100% protocol syntax". This module encodes the opcode
// vocabulary and a small, explicit grammar. Decoding is masked against this
// grammar at every step, so every emitted sequence is valid by construction —
// syntax validity does not depend on how well the model was trained.

// Ordered opcode vocabulary. The index is the class id used by the decoder.
export const OPCODES = Object.freeze([
  'OBSERVE',   // 0 - ground the request in the stated facts/state
  'RETRIEVE',  // 1 - pull in external/prior information before acting
  'ASK',       // 2 - request a missing decision-critical input
  'DECOMPOSE', // 3 - split the request into parts/phases
  'ORDER',     // 4 - impose an ordering / sequence over parts
  'COMPARE',   // 5 - weigh options against each other
  'DRAFT',     // 6 - produce the concrete written output
  'SCHEDULE',  // 7 - place actions on a timeline / route
  'VERIFY',    // 8 - check the result against the constraints
  'STOP'       // 9 - terminate the protocol
]);

export const OPCODE_INDEX = Object.freeze(Object.fromEntries(OPCODES.map((name, index) => [name, index])));
export const STOP = OPCODE_INDEX.STOP;
export const NUM_OPCODES = OPCODES.length;

// A decoder input token per opcode plus a dedicated START token. START is an
// input-only token (never emitted), so the input vocabulary is one larger than
// the output vocabulary.
export const START_TOKEN = NUM_OPCODES;
export const NUM_INPUT_TOKENS = NUM_OPCODES + 1;

// Opcodes that may legally open a protocol: an intake/grounding step must come
// first. Everything else is a "body" opcode used at most once.
export const INTAKE = Object.freeze(['OBSERVE', 'RETRIEVE'].map(name => OPCODE_INDEX[name]));
const INTAKE_SET = new Set(INTAKE);

// Hard structural bounds. Length counts opcodes including the terminal STOP.
export const MIN_LENGTH = 2; // e.g. [OBSERVE, STOP]
export const MAX_LENGTH = 6;
export const MAX_POSITIONS = MAX_LENGTH; // one-hot position feature width

// Return a boolean mask of length NUM_OPCODES: mask[i] === true means opcode i
// is a legal next token given the partial sequence `prefix` (an array of opcode
// ids that does not yet contain STOP). The grammar:
//   1. position 0 must be an intake opcode (OBSERVE or RETRIEVE);
//   2. every non-STOP opcode may appear at most once;
//   3. an opcode may not immediately repeat the previous opcode;
//   4. STOP is legal only once the sequence has reached MIN_LENGTH and is the
//      only legal token once it has reached MAX_LENGTH - 1 body tokens;
//   5. STOP terminates — nothing is emitted after it.
export function legalNextMask(prefix) {
  const mask = new Array(NUM_OPCODES).fill(false);
  const length = prefix.length;
  if (length >= MAX_LENGTH || prefix.includes(STOP)) return mask; // nothing after STOP / over budget

  const used = new Set(prefix);
  const previous = length > 0 ? prefix[length - 1] : -1;

  if (length === 0) {
    for (const intake of INTAKE) mask[intake] = true;
    return mask;
  }

  // STOP becomes legal once the minimum useful length is reached.
  if (length + 1 >= MIN_LENGTH) mask[STOP] = true;

  // If we are one slot away from the hard cap, force termination.
  if (length + 1 >= MAX_LENGTH) {
    for (let i = 0; i < NUM_OPCODES; i += 1) mask[i] = i === STOP;
    return mask;
  }

  for (let opcode = 0; opcode < NUM_OPCODES; opcode += 1) {
    if (opcode === STOP) continue;
    if (INTAKE_SET.has(opcode)) continue; // intake only opens a protocol
    if (used.has(opcode)) continue;       // at most once
    if (opcode === previous) continue;     // no immediate repeat
    mask[opcode] = true;
  }
  return mask;
}

// Validate a complete protocol sequence against the grammar. Returns
// { valid, reason }. Used by tests and by the eval harness to double-check that
// constrained decoding really did stay in-grammar.
export function validateProtocol(sequence) {
  if (!Array.isArray(sequence) || sequence.length < MIN_LENGTH) {
    return { valid: false, reason: 'too-short' };
  }
  if (sequence.length > MAX_LENGTH) return { valid: false, reason: 'too-long' };
  if (sequence[sequence.length - 1] !== STOP) return { valid: false, reason: 'missing-terminal-stop' };
  if (!INTAKE_SET.has(sequence[0])) return { valid: false, reason: 'non-intake-open' };

  const seen = new Set();
  for (let i = 0; i < sequence.length; i += 1) {
    const opcode = sequence[i];
    if (!Number.isInteger(opcode) || opcode < 0 || opcode >= NUM_OPCODES) {
      return { valid: false, reason: 'out-of-range-opcode' };
    }
    if (opcode === STOP && i !== sequence.length - 1) return { valid: false, reason: 'early-stop' };
    if (opcode !== STOP) {
      if (seen.has(opcode)) return { valid: false, reason: 'duplicate-opcode' };
      if (i > 0 && sequence[i - 1] === opcode) return { valid: false, reason: 'immediate-repeat' };
      if (i > 0 && INTAKE_SET.has(opcode)) return { valid: false, reason: 'late-intake' };
      seen.add(opcode);
    }
  }
  return { valid: true, reason: 'ok' };
}

export function opcodeNames(sequence) {
  return sequence.map(index => OPCODES[index]);
}

export function opcodeIds(names) {
  return names.map(name => {
    const index = OPCODE_INDEX[name];
    if (index === undefined) throw new Error(`Unknown opcode: ${name}`);
    return index;
  });
}
