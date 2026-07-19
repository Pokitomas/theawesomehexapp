export const TOKENS = Object.freeze(['OBSERVE','RETRIEVE','COMPARE','DECOMPOSE','ORDER','SCHEDULE','DRAFT','STOP']);

export const INTENT_PROTOCOL = Object.freeze({
  summary: ['OBSERVE','DRAFT','STOP'],
  checklist: ['OBSERVE','DECOMPOSE','DRAFT','STOP'],
  message: ['OBSERVE','DRAFT','STOP'],
  decision: ['OBSERVE','COMPARE','DRAFT','STOP'],
  study: ['RETRIEVE','DECOMPOSE','ORDER','SCHEDULE','STOP'],
  event: ['OBSERVE','DECOMPOSE','ORDER','SCHEDULE','STOP'],
  errands: ['OBSERVE','ORDER','SCHEDULE','STOP'],
  plan: ['RETRIEVE','DECOMPOSE','ORDER','DRAFT','STOP'],
  next_action: ['OBSERVE','DECOMPOSE','STOP'],
  compound: ['OBSERVE','DECOMPOSE','ORDER','SCHEDULE','STOP']
});

export const INTENTS = Object.freeze(Object.keys(INTENT_PROTOCOL));

export function protocolFor(intent) {
  const protocol = INTENT_PROTOCOL[intent];
  if (!protocol) throw new Error(`Unknown protocol intent: ${intent}`);
  return [...protocol];
}

export function isValidProtocol(protocol) {
  if (!Array.isArray(protocol) || protocol.length < 2 || protocol.at(-1) !== 'STOP') return false;
  if (protocol.slice(0, -1).includes('STOP')) return false;
  if (new Set(protocol).size !== protocol.length) return false;
  return protocol.every(token => TOKENS.includes(token));
}
