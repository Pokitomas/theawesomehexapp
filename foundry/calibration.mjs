import { asFiniteNumber, asText, assertNoSecrets, digest } from './util.mjs';

export const CALIBRATION_SCHEMA = 'sideways-foundry-calibration/v1';
export const CALIBRATION_BLEND_SCHEMA = 'sideways-foundry-calibrated-blend/v1';

const POLICY = Object.freeze({
  cold_start_factor: 0.5,
  cold_start_weight: 0.2,
  prior_observations: 4,
  minimum_observed_ratio: 0,
  maximum_observed_ratio: 1.5,
  minimum_reliability: 0.1
});

const rounded = value => Number(Number(value).toFixed(12));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

function normalizeObservation(value, historyIndex, observationIndex) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`calibrationHistories[${historyIndex}].observations[${observationIndex}] must be an object.`);
  }
  const predicted = asFiniteNumber(
    value.predicted ?? value.estimate ?? value.expected_information_gain,
    `calibrationHistories[${historyIndex}].observations[${observationIndex}].predicted`,
    { min: 0 }
  );
  const realized = asFiniteNumber(
    value.realized ?? value.outcome ?? value.realized_information_gain,
    `calibrationHistories[${historyIndex}].observations[${observationIndex}].realized`,
    { min: 0 }
  );
  return Object.freeze({
    predicted,
    realized,
    ...(value.candidate_id ? { candidate_id: asText(value.candidate_id, 'calibration observation candidate_id', 200) } : {}),
    ...(value.receipt_digest ? { receipt_digest: asText(value.receipt_digest, 'calibration observation receipt_digest', 200) } : {})
  });
}

export function normalizeCalibrationHistories(inputs = []) {
  if (!Array.isArray(inputs)) throw new Error('calibrationHistories must be an array.');
  assertNoSecrets(inputs);
  const seen = new Set();
  const histories = inputs.map((value, historyIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`calibrationHistories[${historyIndex}] must be an object.`);
    }
    if (value.schema && value.schema !== CALIBRATION_SCHEMA) {
      throw new Error(`calibrationHistories[${historyIndex}].schema must be ${CALIBRATION_SCHEMA}.`);
    }
    const role = asText(value.role, `calibrationHistories[${historyIndex}].role`, 120);
    if (seen.has(role)) throw new Error(`Duplicate calibration history for role ${role}.`);
    seen.add(role);
    if (!Array.isArray(value.observations)) {
      throw new Error(`calibrationHistories[${historyIndex}].observations must be an array.`);
    }
    const observations = value.observations.map((entry, observationIndex) => normalizeObservation(entry, historyIndex, observationIndex));
    const body = { schema: CALIBRATION_SCHEMA, role, observations };
    return Object.freeze({ ...body, history_digest: digest(body) });
  });
  return Object.freeze(histories.sort((left, right) => left.role.localeCompare(right.role)));
}

export function calibrateRole(roleInput, calibrationHistories = []) {
  const role = asText(roleInput, 'role', 120);
  const histories = normalizeCalibrationHistories(calibrationHistories);
  const history = histories.find(item => item.role === role);
  const observations = history?.observations || [];
  const sampleCount = observations.length;
  const predictedTotal = observations.reduce((sum, item) => sum + item.predicted, 0);
  const realizedTotal = observations.reduce((sum, item) => sum + item.realized, 0);
  const observedRatio = sampleCount === 0
    ? POLICY.cold_start_factor
    : predictedTotal === 0
      ? (realizedTotal === 0 ? 1 : POLICY.maximum_observed_ratio)
      : clamp(realizedTotal / predictedTotal, POLICY.minimum_observed_ratio, POLICY.maximum_observed_ratio);
  const meanNormalizedError = sampleCount === 0
    ? 1
    : observations.reduce((sum, item) => sum + Math.abs(item.predicted - item.realized) / (1 + Math.max(item.predicted, item.realized)), 0) / sampleCount;
  const evidenceFraction = sampleCount / (sampleCount + POLICY.prior_observations);
  const reliability = sampleCount === 0
    ? POLICY.minimum_reliability
    : clamp(1 - meanNormalizedError, POLICY.minimum_reliability, 1);
  const calibrationFactor = POLICY.cold_start_factor * (1 - evidenceFraction) + observedRatio * evidenceFraction;
  const weight = POLICY.cold_start_weight + (1 - POLICY.cold_start_weight) * evidenceFraction * reliability;
  return Object.freeze({
    schema: CALIBRATION_SCHEMA,
    role,
    status: sampleCount ? 'history-calibrated' : 'cold-start-prior',
    sample_count: sampleCount,
    predicted_total: rounded(predictedTotal),
    realized_total: rounded(realizedTotal),
    observed_ratio: rounded(observedRatio),
    mean_normalized_error: rounded(meanNormalizedError),
    evidence_fraction: rounded(evidenceFraction),
    reliability: rounded(reliability),
    calibration_factor: rounded(calibrationFactor),
    weight: rounded(weight),
    history_digest: history?.history_digest || null,
    policy: POLICY
  });
}

function normalizeEstimate(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`estimates[${index}] must be an object.`);
  }
  return Object.freeze({
    role: asText(value.role, `estimates[${index}].role`, 120),
    source_assignment_id: asText(value.source_assignment_id, `estimates[${index}].source_assignment_id`, 300),
    raw_estimate: asFiniteNumber(value.raw_estimate, `estimates[${index}].raw_estimate`, { min: 0 })
  });
}

export function blendCalibratedEstimates(estimateInputs, calibrationHistories = []) {
  if (!Array.isArray(estimateInputs) || estimateInputs.length === 0) throw new Error('At least one information-gain estimate is required.');
  assertNoSecrets(estimateInputs);
  const histories = normalizeCalibrationHistories(calibrationHistories);
  const estimates = estimateInputs.map(normalizeEstimate).map(estimate => {
    const calibration = calibrateRole(estimate.role, histories);
    return Object.freeze({
      role: estimate.role,
      source_assignment_id: estimate.source_assignment_id,
      raw_estimate: rounded(estimate.raw_estimate),
      calibration_factor: calibration.calibration_factor,
      weight: calibration.weight,
      adjusted_estimate: rounded(estimate.raw_estimate * calibration.calibration_factor),
      calibration_status: calibration.status,
      sample_count: calibration.sample_count,
      reliability: calibration.reliability,
      history_digest: calibration.history_digest
    });
  }).sort((left, right) => `${left.role}:${left.source_assignment_id}`.localeCompare(`${right.role}:${right.source_assignment_id}`));
  const totalWeight = estimates.reduce((sum, item) => sum + item.weight, 0);
  const blendedEstimate = estimates.reduce((sum, item) => sum + item.adjusted_estimate * item.weight, 0) / totalWeight;
  const body = {
    schema: CALIBRATION_BLEND_SCHEMA,
    policy: POLICY,
    histories_digest: digest(histories),
    total_weight: rounded(totalWeight),
    blended_estimate: rounded(blendedEstimate),
    estimates
  };
  return Object.freeze({ ...body, blend_digest: digest(body) });
}
