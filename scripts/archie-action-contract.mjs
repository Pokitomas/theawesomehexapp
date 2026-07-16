const clean = (value, limit = 500) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function normalizeAction(value, field) {
  const action = clean(value, 300);
  if (!/^[^:]+:[^:]+$/.test(action)) throw new Error(`${field} must be a tool:action identifier.`);
  return action;
}

function normalizeUniqueActions(values, field) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const actions = values.map((value, index) => normalizeAction(value, `${field}[${index}]`));
  if (new Set(actions).size !== actions.length) throw new Error(`${field} must not contain duplicates.`);
  return actions;
}

function normalizeOrdering(values = []) {
  if (!Array.isArray(values)) throw new Error('action_contract.ordering must be an array.');
  return values.map((constraint, index) => {
    if (!Array.isArray(constraint) || constraint.length !== 2) {
      throw new Error(`action_contract.ordering[${index}] must be a [before, after] pair.`);
    }
    const before = normalizeAction(constraint[0], `action_contract.ordering[${index}][0]`);
    const after = normalizeAction(constraint[1], `action_contract.ordering[${index}][1]`);
    if (before === after) throw new Error(`action_contract.ordering[${index}] may not order an action before itself.`);
    return Object.freeze([before, after]);
  });
}

export function normalizeActionContract(contract = {}, { reference_actions = [] } = {}) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw new Error('action_contract must be an object.');
  const required = normalizeUniqueActions(contract.required_actions ?? reference_actions, 'action_contract.required_actions');
  const optional = normalizeUniqueActions(contract.optional_actions, 'action_contract.optional_actions');
  const forbidden = normalizeUniqueActions(contract.forbidden_actions, 'action_contract.forbidden_actions');
  const ordering = normalizeOrdering(contract.ordering);
  const allowedExtras = contract.allow_unlisted_actions === true;

  const requiredSet = new Set(required);
  const optionalSet = new Set(optional);
  const forbiddenSet = new Set(forbidden);
  for (const action of requiredSet) {
    if (optionalSet.has(action) || forbiddenSet.has(action)) throw new Error(`Action ${action} has conflicting action-contract roles.`);
  }
  for (const action of optionalSet) {
    if (forbiddenSet.has(action)) throw new Error(`Action ${action} is both optional and forbidden.`);
  }
  const declared = new Set([...required, ...optional, ...forbidden]);
  for (const [before, after] of ordering) {
    if (!declared.has(before) || !declared.has(after)) {
      throw new Error(`Ordering constraint ${before} -> ${after} references an undeclared action.`);
    }
  }

  return Object.freeze({
    schema: 'archie-action-contract/v1',
    required_actions: Object.freeze(required),
    optional_actions: Object.freeze(optional),
    forbidden_actions: Object.freeze(forbidden),
    ordering: Object.freeze(ordering),
    allow_unlisted_actions: allowedExtras
  });
}

function firstIndex(actions, target) {
  return actions.indexOf(target);
}

export function evaluateActionContract(actionsInput, contractInput, options = {}) {
  if (!Array.isArray(actionsInput)) throw new Error('Candidate actions must be an array.');
  const actions = actionsInput.map((value, index) => normalizeAction(value, `actions[${index}]`));
  const contract = normalizeActionContract(contractInput, options);
  const observed = new Set(actions);
  const requiredMissing = contract.required_actions.filter(action => !observed.has(action));
  const forbiddenObserved = contract.forbidden_actions.filter(action => observed.has(action));
  const declaredAllowed = new Set([...contract.required_actions, ...contract.optional_actions]);
  const unlistedObserved = contract.allow_unlisted_actions
    ? []
    : [...observed].filter(action => !declaredAllowed.has(action) && !contract.forbidden_actions.includes(action));
  const orderingViolations = contract.ordering.flatMap(([before, after]) => {
    const beforeIndex = firstIndex(actions, before);
    const afterIndex = firstIndex(actions, after);
    if (beforeIndex === -1 || afterIndex === -1 || beforeIndex < afterIndex) return [];
    return [{ before, after, before_index: beforeIndex, after_index: afterIndex }];
  });

  const satisfied = requiredMissing.length === 0
    && forbiddenObserved.length === 0
    && unlistedObserved.length === 0
    && orderingViolations.length === 0;

  return Object.freeze({
    schema: 'archie-action-contract-evaluation/v1',
    satisfied,
    actions: Object.freeze(actions),
    contract,
    required_missing: Object.freeze(requiredMissing),
    forbidden_observed: Object.freeze(forbiddenObserved),
    unlisted_observed: Object.freeze(unlistedObserved),
    ordering_violations: Object.freeze(orderingViolations.map(Object.freeze))
  });
}
