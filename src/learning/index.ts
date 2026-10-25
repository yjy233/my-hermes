import * as reference from './reference.js';
import * as exercises from './exercises.js';
import type { Algorithms, Mode } from './types.js';
export type { Algorithms, Mode } from './types.js';
export { ExerciseNotImplemented } from '../core/errors.js';
export function loadAlgorithms(mode: Mode): Algorithms {
  if (mode === 'reference') return reference;
  if (mode === 'learner') return exercises;
  throw new Error('mode must be reference or learner');
}
