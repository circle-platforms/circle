/**
 * The thinking depths a model request can ask for. A module of its own so that the desktop's interface code, which
 * reads subagent and extension types, never compiles the model client to get them.
 */
export const EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
