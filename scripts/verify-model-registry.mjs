#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const registryPath = path.resolve(process.argv[2] || "MODEL_REGISTRY.json");
const fail = (message) => {
  console.error(`MODEL_REGISTRY invalid: ${message}`);
  process.exitCode = 1;
};

let registry;
try {
  registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
} catch (error) {
  fail(`cannot parse ${registryPath}: ${error.message}`);
  process.exit();
}

if (registry.schema !== "archie-model-registry/v1") fail("unsupported schema");
if (registry.system_name !== "Archie") fail("system_name must be Archie");
if (typeof registry.claim_boundary !== "string" || registry.claim_boundary.length < 40) {
  fail("claim_boundary must be explicit");
}
if (!Array.isArray(registry.artifacts) || registry.artifacts.length === 0) {
  fail("artifacts must be a non-empty array");
  process.exit();
}

const artifacts = new Map();
const isNonnegativeIntegerOrNull = (value) => value === null || (Number.isInteger(value) && value >= 0);
const isSha256OrNull = (value) => value === null || /^[0-9a-f]{64}$/.test(value);
const requireArray = (artifact, key) => {
  if (!Array.isArray(artifact[key])) fail(`${artifact.artifact_id}.${key} must be an array`);
};

for (const artifact of registry.artifacts) {
  const id = artifact?.artifact_id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    fail(`invalid artifact_id: ${JSON.stringify(id)}`);
    continue;
  }
  if (artifacts.has(id)) fail(`duplicate artifact_id: ${id}`);
  artifacts.set(id, artifact);

  if (typeof artifact.display_name !== "string" || !artifact.display_name.trim()) {
    fail(`${id}.display_name is required`);
  }
  if (typeof artifact.artifact_type !== "string" || !artifact.artifact_type.trim()) {
    fail(`${id}.artifact_type is required`);
  }
  if (typeof artifact.objective !== "string" || !artifact.objective.trim()) {
    fail(`${id}.objective is required`);
  }
  if (typeof artifact.status !== "string" || !artifact.status.trim()) {
    fail(`${id}.status is required`);
  }
  if (typeof artifact.promotion !== "string" || !artifact.promotion.trim()) {
    fail(`${id}.promotion is required`);
  }

  if (typeof artifact.weights !== "object" || artifact.weights === null) {
    fail(`${id}.weights is required`);
  } else {
    if (typeof artifact.weights.exist !== "boolean") fail(`${id}.weights.exist must be boolean`);
    if (typeof artifact.weights.repository_committed !== "boolean") {
      fail(`${id}.weights.repository_committed must be boolean`);
    }
    if (!isSha256OrNull(artifact.weights.sha256)) fail(`${id}.weights.sha256 must be null or lowercase SHA-256`);
    const hashBlocker = artifact.weights.hash_blocker;
    const hasHashBlocker = typeof hashBlocker === "string" && hashBlocker.trim().length >= 12;
    if (artifact.weights.exist === false && artifact.weights.sha256 !== null) {
      fail(`${id} cannot name a weight digest when weights.exist is false`);
    }
    if (artifact.weights.exist === true && artifact.weights.sha256 === null && !hasHashBlocker) {
      fail(`${id} has existing weights without sha256 or an explicit weights.hash_blocker`);
    }
    if (artifact.weights.sha256 !== null && hashBlocker != null) {
      fail(`${id} cannot retain weights.hash_blocker after a sha256 is known`);
    }
    if (artifact.weights.exist === false && hashBlocker != null) {
      fail(`${id} cannot use weights.hash_blocker when no weights exist`);
    }
  }

  if (typeof artifact.initialization !== "object" || artifact.initialization === null) {
    fail(`${id}.initialization is required`);
  } else if (typeof artifact.initialization.kind !== "string" || !artifact.initialization.kind.trim()) {
    fail(`${id}.initialization.kind is required`);
  }

  const parameters = artifact.architecture?.parameters;
  if (!isNonnegativeIntegerOrNull(parameters)) fail(`${id}.architecture.parameters must be a nonnegative integer or null`);

  const steps = artifact.training?.optimizer_steps;
  const tokens = artifact.training?.tokens_seen;
  const corpusTokens = artifact.training?.corpus_tokens;
  if (!isNonnegativeIntegerOrNull(steps)) fail(`${id}.training.optimizer_steps must be a nonnegative integer or null`);
  if (!isNonnegativeIntegerOrNull(tokens)) fail(`${id}.training.tokens_seen must be a nonnegative integer or null`);
  if (!isNonnegativeIntegerOrNull(corpusTokens)) fail(`${id}.training.corpus_tokens must be a nonnegative integer or null`);
  if (steps === 0 && tokens !== 0) fail(`${id} with zero optimizer steps must have zero tokens_seen`);

  if (!Array.isArray(artifact.measured_capability)) fail(`${id}.measured_capability must be an array`);
  requireArray(artifact, "predecessor_ids");
  requireArray(artifact, "successor_ids");
  requireArray(artifact, "blocking_issues");
  if (Array.isArray(artifact.blocking_issues) && artifact.blocking_issues.some((value) => !Number.isInteger(value) || value < 1)) {
    fail(`${id}.blocking_issues must contain positive issue numbers`);
  }

  if (artifact.status.includes("planned") && artifact.weights?.exist !== false) {
    fail(`${id} is planned but claims existing weights`);
  }
  if (artifact.promotion === "not-admitted" && artifact.status === "admitted") {
    fail(`${id} has contradictory admission fields`);
  }
}

for (const [id, artifact] of artifacts) {
  for (const relation of ["predecessor_ids", "successor_ids"]) {
    for (const target of artifact[relation] || []) {
      if (typeof target !== "string") {
        fail(`${id}.${relation} contains a non-string reference`);
      } else if (!target.startsWith("external-") && !artifacts.has(target)) {
        fail(`${id}.${relation} references unknown artifact ${target}`);
      }
    }
  }
}

for (const [id, artifact] of artifacts) {
  for (const successor of artifact.successor_ids || []) {
    if (successor.startsWith("external-") || !artifacts.has(successor)) continue;
    const reverse = artifacts.get(successor).predecessor_ids || [];
    if (!reverse.includes(id)) fail(`${id} -> ${successor} is missing the reverse predecessor relation`);
  }
}

if (process.exitCode) process.exit();
console.log(JSON.stringify({
  schema: registry.schema,
  artifacts: registry.artifacts.length,
  existing_weight_artifacts: registry.artifacts.filter((item) => item.weights.exist).length,
  unresolved_weight_hashes: registry.artifacts.filter((item) => item.weights.exist && item.weights.sha256 === null).length,
  admitted_artifacts: registry.artifacts.filter((item) => item.promotion.startsWith("admitted")).length,
  status: "valid"
}, null, 2));
