import {
  ARCHIE_LAUNCH_DECISION_SCHEMA,
  deriveLaunchRequirements,
  digest,
  validateLaunchTarget
} from './archie-launch-contract.mjs';

export const ARCHIE_LAUNCH_CAPABILITY_MANIFEST_SCHEMA = 'archie-launch-capability-manifest/v1';
export const ARCHIE_LAUNCH_PROFILE_RESOLUTION_SCHEMA = 'archie-launch-profile-resolution/v1';

const DIGEST = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const CAPABILITY_LIMIT = 18;
const STATUS = new Set(['admitted', 'experimental', 'absent']);
const NETWORK = new Set(['none', 'optional', 'required']);

function clean(value, field, limit = 10_000) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
  return text;
}

function exactDigest(value, field) {
  const text = clean(value, field, 64).toLowerCase();
  if (!DIGEST.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return text;
}

function exactSha(value, field) {
  const text = clean(value, field, 40).toLowerCase();
  if (!SHA40.test(text)) throw new Error(`${field} must be a 40-character Git SHA.`);
  return text;
}

function uniqueStrings(values, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const output = values.map((value, index) => clean(value, `${field}[${index}]`, 300));
  if (!allowEmpty && !output.length) throw new Error(`${field} must be non-empty.`);
  if (new Set(output).size !== output.length) throw new Error(`${field} contains duplicate values.`);
  return output;
}

function finite(value, field, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`${field} must be a finite number >= ${minimum}.`);
  return number;
}

function integer(value, field, minimum = 0) {
  const number = finite(value, field, minimum);
  if (!Number.isSafeInteger(number)) throw new Error(`${field} must be a safe integer.`);
  return number;
}

function booleanMap(input, field) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${field} must be an object.`);
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, value]) => {
    if (typeof value !== 'boolean') throw new Error(`${field}.${key} must be boolean.`);
    return [clean(key, `${field} key`, 200), value];
  })));
}

function numberMap(input, field) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${field} must be an object.`);
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, value]) => [
    clean(key, `${field} key`, 200),
    finite(value, `${field}.${key}`)
  ])));
}

function verifyLaunchDecision(target, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('launch_decision must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_DECISION_SCHEMA) throw new Error(`launch_decision.schema must be ${ARCHIE_LAUNCH_DECISION_SCHEMA}.`);
  const { decision_digest, ...body } = input;
  const verifiedDigest = exactDigest(decision_digest, 'launch_decision.decision_digest');
  if (digest(body) !== verifiedDigest) throw new Error('launch_decision digest mismatch.');
  const requirements = deriveLaunchRequirements(target);
  if (input.target_id !== target.id) throw new Error('launch_decision target mismatch.');
  if (input.requirements_digest !== requirements.requirements_digest) throw new Error('launch_decision requirements mismatch.');
  for (const field of ['candidate_artifact_digest', 'intelligence_report_digest', 'authority_report_digest', 'reproduction_receipt_digest']) {
    exactDigest(input[field], `launch_decision.${field}`);
  }
  return Object.freeze({ ...input, decision_digest: verifiedDigest });
}

function normalizeMachine(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('machine must be an object.');
  const hardware = {
    device_class: clean(input.hardware?.device_class, 'machine.hardware.device_class', 200),
    architecture: clean(input.hardware?.architecture, 'machine.hardware.architecture', 100),
    cpu_threads: integer(input.hardware?.cpu_threads, 'machine.hardware.cpu_threads', 1),
    ram_bytes: integer(input.hardware?.ram_bytes, 'machine.hardware.ram_bytes', 1),
    vram_bytes: integer(input.hardware?.vram_bytes ?? 0, 'machine.hardware.vram_bytes'),
    disk_free_bytes: integer(input.hardware?.disk_free_bytes, 'machine.hardware.disk_free_bytes', 1),
    accelerators: uniqueStrings(input.hardware?.accelerators || [], 'machine.hardware.accelerators'),
    energy_watts_budget: finite(input.hardware?.energy_watts_budget, 'machine.hardware.energy_watts_budget'),
    thermal_celsius_limit: finite(input.hardware?.thermal_celsius_limit, 'machine.hardware.thermal_celsius_limit')
  };
  const operatingSystem = {
    family: clean(input.operating_system?.family, 'machine.operating_system.family', 100),
    version: clean(input.operating_system?.version, 'machine.operating_system.version', 200),
    background_model: clean(input.operating_system?.background_model, 'machine.operating_system.background_model', 200),
    sandbox: clean(input.operating_system?.sandbox, 'machine.operating_system.sandbox', 200)
  };
  const hardwareFingerprint = exactDigest(input.hardware_fingerprint, 'machine.hardware_fingerprint');
  const osFingerprint = exactDigest(input.os_fingerprint, 'machine.os_fingerprint');
  if (digest(hardware) !== hardwareFingerprint) throw new Error('machine.hardware_fingerprint mismatch.');
  if (digest(operatingSystem) !== osFingerprint) throw new Error('machine.os_fingerprint mismatch.');
  const permissions = booleanMap(input.permissions || {}, 'machine.permissions');
  return Object.freeze({
    id: clean(input.id, 'machine.id', 200),
    hardware: Object.freeze(hardware),
    operating_system: Object.freeze(operatingSystem),
    hardware_fingerprint: hardwareFingerprint,
    os_fingerprint: osFingerprint,
    device_fingerprint: exactDigest(input.device_fingerprint, 'machine.device_fingerprint'),
    permissions,
    network_available: Boolean(input.network_available)
  });
}

function normalizeCapability(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`capabilities[${index}] must be an object.`);
  const id = clean(input.id, `capabilities[${index}].id`, 200);
  const status = clean(input.status, `capabilities[${index}].status`, 100);
  if (!STATUS.has(status)) throw new Error(`capabilities[${index}].status is unsupported.`);
  const network = clean(input.network || 'none', `capabilities[${index}].network`, 100);
  if (!NETWORK.has(network)) throw new Error(`capabilities[${index}].network is unsupported.`);
  const evidenceDigests = uniqueStrings(input.evidence_digests || [], `capabilities[${index}].evidence_digests`).map((value, evidenceIndex) => exactDigest(value, `capabilities[${index}].evidence_digests[${evidenceIndex}]`));
  if (status === 'admitted' && !evidenceDigests.length) throw new Error(`capabilities[${index}] cannot be admitted without evidence.`);
  const metrics = numberMap(input.metrics || {}, `capabilities[${index}].metrics`);
  const gates = numberMap(input.gates || {}, `capabilities[${index}].gates`);
  const minimumResources = numberMap(input.minimum_resources || {}, `capabilities[${index}].minimum_resources`);
  const cost = numberMap(input.resource_cost || {}, `capabilities[${index}].resource_cost`);
  return Object.freeze({
    id,
    status,
    families: Object.freeze(uniqueStrings(input.families || [], `capabilities[${index}].families`, { allowEmpty: false })),
    faculties: Object.freeze(uniqueStrings(input.faculties || [], `capabilities[${index}].faculties`, { allowEmpty: false })),
    evidence_digests: Object.freeze(evidenceDigests),
    requires: Object.freeze(uniqueStrings(input.requires || [], `capabilities[${index}].requires`)),
    conflicts: Object.freeze(uniqueStrings(input.conflicts || [], `capabilities[${index}].conflicts`)),
    required_permissions: Object.freeze(uniqueStrings(input.required_permissions || [], `capabilities[${index}].required_permissions`)),
    network,
    metrics,
    gates,
    minimum_resources: minimumResources,
    resource_cost: cost
  });
}

function normalizeFallback(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`fallback_scenarios[${index}] must be an object.`);
  return Object.freeze({
    id: clean(input.id, `fallback_scenarios[${index}].id`, 200),
    permission_overrides: booleanMap(input.permission_overrides || {}, `fallback_scenarios[${index}].permission_overrides`),
    resource_overrides: numberMap(input.resource_overrides || {}, `fallback_scenarios[${index}].resource_overrides`),
    network_available: input.network_available === undefined ? null : Boolean(input.network_available),
    reason: clean(input.reason, `fallback_scenarios[${index}].reason`, 1000)
  });
}

export function validateLaunchCapabilityManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch capability manifest must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_CAPABILITY_MANIFEST_SCHEMA) throw new Error(`Manifest schema must be ${ARCHIE_LAUNCH_CAPABILITY_MANIFEST_SCHEMA}.`);
  const target = validateLaunchTarget(input.launch_target);
  const launchDecision = verifyLaunchDecision(target, input.launch_decision);
  const release = {
    id: clean(input.release?.id, 'release.id', 200),
    runtime_abi: clean(input.release?.runtime_abi, 'release.runtime_abi', 200),
    code_revision: exactSha(input.release?.code_revision, 'release.code_revision'),
    model_artifact_digest: exactDigest(input.release?.model_artifact_digest, 'release.model_artifact_digest'),
    checkpoint_digest: exactDigest(input.release?.checkpoint_digest, 'release.checkpoint_digest')
  };
  if (release.model_artifact_digest !== launchDecision.candidate_artifact_digest) throw new Error('Release model artifact does not match the admitted launch decision.');
  const machine = normalizeMachine(input.machine);
  if (machine.device_fingerprint !== digest({ hardware_fingerprint: machine.hardware_fingerprint, os_fingerprint: machine.os_fingerprint })) {
    throw new Error('machine.device_fingerprint mismatch.');
  }
  if (!Array.isArray(input.capabilities) || !input.capabilities.length) throw new Error('capabilities must be non-empty.');
  if (input.capabilities.length > CAPABILITY_LIMIT) throw new Error(`capabilities may not exceed ${CAPABILITY_LIMIT} in v1.`);
  const capabilities = input.capabilities.map(normalizeCapability);
  if (new Set(capabilities.map(item => item.id)).size !== capabilities.length) throw new Error('Capability IDs must be unique.');
  const ids = new Set(capabilities.map(item => item.id));
  for (const capability of capabilities) {
    for (const dependency of capability.requires) if (!ids.has(dependency)) throw new Error(`Capability ${capability.id} requires unknown capability ${dependency}.`);
    for (const conflict of capability.conflicts) if (!ids.has(conflict)) throw new Error(`Capability ${capability.id} conflicts with unknown capability ${conflict}.`);
  }
  const preferences = uniqueStrings(input.selection_preferences || [], 'selection_preferences');
  for (const preference of preferences) if (!ids.has(preference)) throw new Error(`Unknown selection preference ${preference}.`);
  const fallbacks = Array.isArray(input.fallback_scenarios) ? input.fallback_scenarios.map(normalizeFallback) : [];
  if (new Set(fallbacks.map(item => item.id)).size !== fallbacks.length) throw new Error('Fallback scenario IDs must be unique.');
  const body = {
    schema: ARCHIE_LAUNCH_CAPABILITY_MANIFEST_SCHEMA,
    release: Object.freeze(release),
    launch_target: target,
    launch_decision: launchDecision,
    machine,
    capabilities: Object.freeze(capabilities),
    selection_preferences: Object.freeze(preferences),
    fallback_scenarios: Object.freeze(fallbacks),
    claim_boundary: clean(input.claim_boundary, 'claim_boundary', 3000)
  };
  return Object.freeze({ ...body, manifest_digest: digest(body) });
}

function resourceValue(machine, context, key) {
  if (Object.prototype.hasOwnProperty.call(context.resources, key)) return context.resources[key];
  const aliases = {
    ram_bytes: machine.hardware.ram_bytes,
    vram_bytes: machine.hardware.vram_bytes,
    disk_free_bytes: machine.hardware.disk_free_bytes,
    cpu_threads: machine.hardware.cpu_threads,
    energy_watts_budget: machine.hardware.energy_watts_budget,
    thermal_celsius_limit: machine.hardware.thermal_celsius_limit
  };
  return aliases[key];
}

function metricGatePasses(metric, thresholdName, threshold) {
  if (thresholdName.endsWith('_max')) return metric <= threshold;
  if (thresholdName.endsWith('_min')) return metric >= threshold;
  throw new Error(`Capability gate ${thresholdName} must end in _min or _max.`);
}

function evaluateEligibility(manifest, scenario = null) {
  const permissions = { ...manifest.machine.permissions, ...(scenario?.permission_overrides || {}) };
  const resources = { ...(scenario?.resource_overrides || {}) };
  const networkAvailable = scenario?.network_available === null || scenario?.network_available === undefined
    ? manifest.machine.network_available
    : scenario.network_available;
  const context = { permissions, resources, networkAvailable };
  const blockers = new Map();

  for (const capability of manifest.capabilities) {
    const reasons = [];
    if (capability.status !== 'admitted') reasons.push(`status:${capability.status}`);
    if (!capability.evidence_digests.length) reasons.push('missing-evidence');
    for (const permission of capability.required_permissions) {
      if (permissions[permission] !== true) reasons.push(`permission:${permission}`);
    }
    if (capability.network === 'required' && !networkAvailable) reasons.push('network:unavailable');
    for (const [resource, minimum] of Object.entries(capability.minimum_resources)) {
      const available = resourceValue(manifest.machine, context, resource);
      if (available === undefined || available < minimum) reasons.push(`resource:${resource}`);
    }
    for (const [gate, threshold] of Object.entries(capability.gates)) {
      const metricName = gate.replace(/_(min|max)$/, '');
      const observed = capability.metrics[metricName];
      if (observed === undefined || !metricGatePasses(observed, gate, threshold)) reasons.push(`metric:${gate}`);
    }
    blockers.set(capability.id, reasons);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const capability of manifest.capabilities) {
      const reasons = blockers.get(capability.id);
      for (const dependency of capability.requires) {
        if ((blockers.get(dependency) || []).length && !reasons.includes(`dependency:${dependency}`)) {
          reasons.push(`dependency:${dependency}`);
          changed = true;
        }
      }
    }
  }

  const eligible = manifest.capabilities.filter(capability => blockers.get(capability.id).length === 0);
  return { eligible, blockers, context };
}

function compatible(set, capability, byId) {
  for (const existingId of set) {
    const existing = byId.get(existingId);
    if (capability.conflicts.includes(existingId) || existing.conflicts.includes(capability.id)) return false;
  }
  return true;
}

function validDependencyClosure(set, byId) {
  for (const id of set) {
    for (const dependency of byId.get(id).requires) if (!set.has(dependency)) return false;
  }
  return true;
}

function maximalCompatibleSets(eligible) {
  if (!eligible.length) return [new Set()];
  const byId = new Map(eligible.map(item => [item.id, item]));
  const ordered = [...eligible].sort((a, b) => a.id.localeCompare(b.id));
  const valid = [];
  function visit(index, set) {
    if (index === ordered.length) {
      if (validDependencyClosure(set, byId)) valid.push(new Set(set));
      return;
    }
    visit(index + 1, set);
    const capability = ordered[index];
    if (compatible(set, capability, byId)) {
      set.add(capability.id);
      visit(index + 1, set);
      set.delete(capability.id);
    }
  }
  visit(0, new Set());
  return valid.filter((candidate, index) => !valid.some((other, otherIndex) => {
    if (index === otherIndex || other.size <= candidate.size) return false;
    return [...candidate].every(id => other.has(id));
  }));
}

function profileFromSet(set, manifest, requiredFaculties) {
  const byId = new Map(manifest.capabilities.map(item => [item.id, item]));
  const capabilities = [...set].sort();
  const faculties = [...new Set(capabilities.flatMap(id => byId.get(id).faculties))].sort();
  const families = [...new Set(capabilities.flatMap(id => byId.get(id).families))].sort();
  const requiredCoverage = requiredFaculties.filter(faculty => faculties.includes(faculty));
  const resourceCost = {};
  for (const id of capabilities) {
    for (const [key, value] of Object.entries(byId.get(id).resource_cost)) resourceCost[key] = (resourceCost[key] || 0) + value;
  }
  const body = {
    capabilities,
    faculties,
    families,
    required_faculty_coverage: requiredCoverage,
    resource_cost: resourceCost
  };
  return Object.freeze({ ...body, profile_digest: digest(body) });
}

function preferenceVector(profile, preferences) {
  return preferences.map(id => Number(profile.capabilities.includes(id)));
}

function compareProfiles(left, right, preferences) {
  if (left.required_faculty_coverage.length !== right.required_faculty_coverage.length) {
    return right.required_faculty_coverage.length - left.required_faculty_coverage.length;
  }
  const leftVector = preferenceVector(left, preferences);
  const rightVector = preferenceVector(right, preferences);
  for (let index = 0; index < preferences.length; index += 1) {
    if (leftVector[index] !== rightVector[index]) return rightVector[index] - leftVector[index];
  }
  if (left.capabilities.length !== right.capabilities.length) return right.capabilities.length - left.capabilities.length;
  const leftEnergy = left.resource_cost.energy_watts || 0;
  const rightEnergy = right.resource_cost.energy_watts || 0;
  if (leftEnergy !== rightEnergy) return leftEnergy - rightEnergy;
  return left.profile_digest.localeCompare(right.profile_digest);
}

function resolveScenario(manifest, requirements, scenario = null) {
  const eligibility = evaluateEligibility(manifest, scenario);
  const sets = maximalCompatibleSets(eligibility.eligible);
  const profiles = sets
    .map(set => profileFromSet(set, manifest, requirements.faculties.map(item => item.id)))
    .sort((a, b) => compareProfiles(a, b, manifest.selection_preferences));
  const selected = profiles[0];
  const disabled = manifest.capabilities
    .filter(capability => (eligibility.blockers.get(capability.id) || []).length)
    .map(capability => ({ id: capability.id, reasons: [...eligibility.blockers.get(capability.id)].sort() }));
  const allRequiredCovered = requirements.faculties.every(item => selected.faculties.includes(item.id));
  return Object.freeze({
    scenario_id: scenario?.id || 'default',
    scenario_reason: scenario?.reason || 'exact admitted machine state',
    network_available: eligibility.context.networkAvailable,
    selected_profile: selected,
    maximal_profiles: profiles,
    disabled_capabilities: disabled,
    all_required_faculties_covered: allRequiredCovered,
    strongest_profile_proof: {
      selected_is_inclusion_maximal: true,
      candidate_maximal_profile_count: profiles.length,
      selected_wins_explicit_preference_order: true,
      preference_order: [...manifest.selection_preferences],
      no_hidden_canonical_interface: true
    }
  });
}

export function resolveLaunchProfile(input) {
  const manifest = validateLaunchCapabilityManifest(input);
  const requirements = deriveLaunchRequirements(manifest.launch_target);
  const defaultResolution = resolveScenario(manifest, requirements);
  const fallbacks = manifest.fallback_scenarios.map(scenario => resolveScenario(manifest, requirements, scenario));
  const launchDecisionAdmitted = manifest.launch_decision.decision === 'admitted-maximal-launch';
  const admitted = launchDecisionAdmitted && defaultResolution.all_required_faculties_covered;
  const body = {
    schema: ARCHIE_LAUNCH_PROFILE_RESOLUTION_SCHEMA,
    manifest_digest: manifest.manifest_digest,
    release_id: manifest.release.id,
    candidate_id: manifest.launch_decision.candidate_id,
    model_artifact_digest: manifest.release.model_artifact_digest,
    checkpoint_digest: manifest.release.checkpoint_digest,
    runtime_abi: manifest.release.runtime_abi,
    code_revision: manifest.release.code_revision,
    machine: {
      id: manifest.machine.id,
      device_fingerprint: manifest.machine.device_fingerprint,
      hardware_fingerprint: manifest.machine.hardware_fingerprint,
      os_fingerprint: manifest.machine.os_fingerprint
    },
    decision: admitted ? 'admitted-maximal-machine-profile' : 'rejected-machine-profile',
    intelligence_and_authority_admitted: launchDecisionAdmitted,
    default_profile: defaultResolution,
    fallbacks,
    claim_boundary: admitted
      ? 'This exact release and machine may expose the selected profile; fallbacks remain separately labeled and may not overwrite the maximal claim.'
      : 'This release or machine must not claim the maximal product profile; disabled capabilities and missing required faculties remain explicit.'
  };
  return Object.freeze({ ...body, resolution_digest: digest(body) });
}
