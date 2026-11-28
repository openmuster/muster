/**
 * The board's routes by name, and which of them a sandbox's agent may call. They are here, apart from the
 * server and from the runners' network policy, because both hold a sandbox to the same list.
 */

/** What a client may call. `scheduleTick` is the ticker's, never a client's. */
export const ROUTES = [
  'post', 'reply', 'edit', 'remove', 'label', 'react', 'createChannel', 'workflowRequest',
  'readChannel', 'readThread', 'events', 'channels', 'search', 'actors', 'head', 'cursorGet', 'cursorSet',
  'taskCreate', 'taskPlan', 'taskClaim', 'taskRenew', 'taskRelease', 'taskComplete', 'taskFail', 'taskBlock',
  'taskUnblock', 'taskReopen', 'taskCancel', 'taskAssign', 'taskNeeds', 'taskList', 'task', 'taskReport',
  'scheduleCreate', 'scheduleCancel', 'scheduleList', 'schemaAdd', 'schemaList', 'filePut', 'fileGet', 'budgetSet', 'budgets',
] as const

/**
 * What a sandbox's agent may call, by name: reading and writing the board, never running it. A route
 * is here because an agent doing a task needs it. A new route is closed to sandboxes until it is added.
 */
export const SANDBOX_ROUTES = [
  'post', 'reply', 'edit', 'remove', 'label', 'react', 'createChannel',
  'readChannel', 'readThread', 'events', 'channels', 'search', 'actors', 'head',
  'taskCreate', 'taskPlan', 'taskClaim', 'taskRenew', 'taskRelease', 'taskComplete', 'taskFail', 'taskBlock',
  'taskUnblock', 'taskReopen', 'taskCancel', 'taskAssign', 'taskNeeds', 'taskList', 'task',
  'schemaList', 'filePut', 'fileGet', 'budgets',
] as const satisfies readonly (typeof ROUTES)[number][]

/**
 * What stays closed, and why: schedules and schemas change what the board does later, a budget is the
 * owner's to set, and a stored cursor is how a watcher knows where it is, so moving one silences it.
 * A workflow request starts work beyond the sandbox: workers on the daemon's machine, which a steered
 * agent in a sandbox must not be able to set going. A report of how agents did and what they cost is the
 * owner's to read: an agent doing a task has no need of it.
 */
export const SANDBOX_CLOSED = ['scheduleCreate', 'scheduleCancel', 'scheduleList', 'schemaAdd', 'budgetSet', 'cursorGet', 'cursorSet', 'workflowRequest', 'taskReport'] as const satisfies readonly (typeof ROUTES)[number][]
