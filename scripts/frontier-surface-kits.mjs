import { eccentricKit, familiarKit, inversionKit } from './frontier-surface-kits-a.mjs';
import { expressiveKit, offlineKit, recombinationKit } from './frontier-surface-kits-b.mjs';

export const ROLE_ORDER = Object.freeze([
  'familiar-control',
  'assumption-inversion',
  'eccentric-transfer',
  'loser-recombination',
  'low-resource-offline',
  'maximal-expressive-variance'
]);

const KIT_BUILDERS = Object.freeze({
  'familiar-control': familiarKit,
  'assumption-inversion': inversionKit,
  'eccentric-transfer': eccentricKit,
  'loser-recombination': recombinationKit,
  'low-resource-offline': offlineKit,
  'maximal-expressive-variance': expressiveKit
});

export function buildSurfaceKit(role, candidate, context) {
  const builder = KIT_BUILDERS[role];
  if (!builder) throw new Error(`Unsupported frontier candidate role: ${role || 'missing'}.`);
  return builder(candidate, context);
}
