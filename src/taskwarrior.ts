import { runCommand } from './exec.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'completed' | 'deleted' | 'waiting' | 'recurring';
export type Priority = 'H' | 'M' | 'L';

export interface TaskAnnotation {
  entry: string;
  description: string;
}

export interface Task {
  id: number;
  uuid: string;
  description: string;
  status: TaskStatus;
  entry: string;
  modified: string;
  urgency: number;
  project?: string;
  priority?: Priority;
  tags?: string[];
  due?: string;
  scheduled?: string;
  wait?: string;
  until?: string;
  depends?: string[];
  annotations?: TaskAnnotation[];
  start?: string;
  end?: string;
  owner_agent?: string;
  lease_until?: string;
  claimed_at?: string;
  last_renewed_at?: string;
}

export interface FilterParams {
  status?: TaskStatus | 'all';
  project?: string;
  tags?: string[];
  priority?: Priority;
  dueBefore?: string;
  dueAfter?: string;
}

export interface TaskFields {
  description?: string;
  project?: string;
  priority?: Priority;
  tags?: string[];
  removeTags?: string[];
  due?: string;
  scheduled?: string;
  wait?: string;
  until?: string;
  depends?: string[];
}

// ─── Arg builders ─────────────────────────────────────────────────────────────

export function buildModifyArgs(fields: TaskFields): string[] {
  const args: string[] = [];

  if (fields.description !== undefined) args.push(fields.description);
  if (fields.project !== undefined) args.push(`project:${fields.project}`);
  if (fields.priority !== undefined) args.push(`priority:${fields.priority}`);
  if (fields.due !== undefined) args.push(`due:${fields.due}`);
  if (fields.scheduled !== undefined) args.push(`scheduled:${fields.scheduled}`);
  if (fields.wait !== undefined) args.push(`wait:${fields.wait}`);
  if (fields.until !== undefined) args.push(`until:${fields.until}`);

  for (const tag of fields.tags ?? []) args.push(`+${tag}`);
  for (const tag of fields.removeTags ?? []) args.push(`-${tag}`);
  for (const dep of fields.depends ?? []) args.push(`depends:${dep}`);

  return args;
}

function buildFilterArgs(filter: FilterParams): string[] {
  const args: string[] = [];

  if (filter.status && filter.status !== 'all') args.push(`status:${filter.status}`);
  if (filter.project) args.push(`project:${filter.project}`);
  if (filter.priority) args.push(`priority:${filter.priority}`);
  if (filter.dueBefore) args.push(`due.before:${filter.dueBefore}`);
  if (filter.dueAfter) args.push(`due.after:${filter.dueAfter}`);
  for (const tag of filter.tags ?? []) args.push(`+${tag}`);

  return args;
}

// ─── Operations ───────────────────────────────────────────────────────────────

export async function exportTasks(filter: FilterParams = {}): Promise<Task[]> {
  try {
    const filterArgs = buildFilterArgs(filter);
    const output = await runCommand('task', [...filterArgs, 'export']);
    return JSON.parse(output) as Task[];
  } catch (err) {
    throw new Error(`Failed to export tasks: ${(err as Error).message}`);
  }
}

export async function listProjects(): Promise<string[]> {
  try {
    const output = await runCommand('task', ['projects']);
    return output
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  } catch (err) {
    throw new Error(`Failed to list projects: ${(err as Error).message}`);
  }
}

export async function createTask(fields: TaskFields & { description: string }): Promise<void> {
  try {
    const args = buildModifyArgs(fields);
    await runCommand('task', ['add', ...args]);
  } catch (err) {
    throw new Error(`Failed to create task: ${(err as Error).message}`);
  }
}

export async function modifyTask(id: string, fields: TaskFields, agentId: string): Promise<void> {
  await ensureClaim(id, agentId);
  try {
    const args = buildModifyArgs(fields);
    await runCommand('task', [id, 'modify', ...args]);
  } catch (err) {
    throw new Error(`Failed to modify task ${id}: ${(err as Error).message}`);
  }
}

export async function completeTask(id: string, agentId: string): Promise<void> {
  await ensureClaim(id, agentId);
  try {
    await runCommand('task', ['rc.confirmation=no', id, 'done']);
  } catch (err) {
    throw new Error(`Failed to complete task ${id}: ${(err as Error).message}`);
  }
  await releaseClaim(id);
}

export async function deleteTask(id: string, agentId: string): Promise<void> {
  await ensureClaim(id, agentId);
  try {
    await runCommand('task', ['rc.confirmation=no', id, 'delete']);
  } catch (err) {
    throw new Error(`Failed to delete task ${id}: ${(err as Error).message}`);
  }
  await releaseClaim(id);
}

export async function startTask(id: string, agentId: string): Promise<void> {
  await ensureClaim(id, agentId);
  try {
    await runCommand('task', [id, 'start']);
  } catch (err) {
    throw new Error(`Failed to start task ${id}: ${(err as Error).message}`);
  }
}

export async function stopTask(id: string, agentId: string): Promise<void> {
  await ensureClaim(id, agentId);
  try {
    await runCommand('task', [id, 'stop']);
  } catch (err) {
    throw new Error(`Failed to stop task ${id}: ${(err as Error).message}`);
  }
}

export async function annotateTask(id: string, annotation: string, agentId: string): Promise<void> {
  await ensureClaim(id, agentId);
  try {
    await runCommand('task', [id, 'annotate', annotation]);
  } catch (err) {
    throw new Error(`Failed to annotate task ${id}: ${(err as Error).message}`);
  }
}

interface TaskClaim {
  owner_agent: string;
  claimed_at: string;
  lease_until: string;
  last_renewed_at?: string;
}

/**
 * Format a Date as Taskwarrior compact UTC: YYYYMMDDTHHMMSSz.
 * Taskwarrior's UDA date parser misinterprets ISO-8601 Z-suffixed dates
 * as local time, so we must use the compact format for correct UTC storage.
 */
export function toTaskwarriorDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Parse dates in both ISO extended (2026-03-24T10:30:45Z) and
 * Taskwarrior compact (20260324T103045Z) formats.
 */
export function parseTaskwarriorDate(dateStr: string): Date {
  const compact = dateStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    const [, y, mo, d, h, mi, s] = compact;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  }
  return new Date(dateStr);
}

export function isLeaseExpired(leaseUntil: string | undefined): boolean {
  if (!leaseUntil) return true;
  const parsed = parseTaskwarriorDate(leaseUntil);
  if (isNaN(parsed.getTime())) return true;
  return parsed < new Date();
}

export function getTaskClaim(task: Task): TaskClaim | null {
  if (!task.owner_agent) return null;
  if (isLeaseExpired(task.lease_until)) return null;
  return {
    owner_agent: task.owner_agent,
    claimed_at: task.claimed_at || '',
    lease_until: task.lease_until || '',
    last_renewed_at: task.last_renewed_at,
  };
}

async function resolveTaskRef(taskRef: string): Promise<string> {
  const tasks = await exportTasks({ status: 'all' });
  const task = tasks.find((t) => String(t.id) === taskRef || t.uuid === taskRef);
  if (!task) {
    throw new Error(`Task not found: ${taskRef}`);
  }
  return task.uuid;
}

/**
 * Ensure the calling agent holds an active claim on the task.
 * - Unclaimed / expired lease → acquires claim
 * - Same agent → renews lease
 * - Different agent → throws
 */
async function ensureClaim(
  taskRef: string,
  agentId: string,
  durationMs: number = 30 * 60 * 1000,
): Promise<void> {
  const uuid = await resolveTaskRef(taskRef);
  const tasks = await exportTasks({ status: 'all' });
  const task = tasks.find((t) => t.uuid === uuid);

  if (!task) {
    throw new Error(`Task not found: ${taskRef}`);
  }

  const now = new Date();
  const nowCompact = toTaskwarriorDate(now);
  const leaseUntil = toTaskwarriorDate(new Date(now.getTime() + durationMs));

  const existingClaim = getTaskClaim(task);

  if (existingClaim && existingClaim.owner_agent !== agentId) {
    throw new Error(`Task is already claimed by ${existingClaim.owner_agent}`);
  }

  const isRenewal = !!existingClaim;

  const args = [
    uuid,
    'modify',
    `owner_agent:${agentId}`,
    `lease_until:${leaseUntil}`,
  ];

  if (isRenewal) {
    args.push(`last_renewed_at:${nowCompact}`);
  } else {
    args.push(`claimed_at:${nowCompact}`);
  }

  try {
    await runCommand('task', args);
  } catch (err) {
    throw new Error(`Failed to claim task ${taskRef}: ${(err as Error).message}`);
  }

  // Verify UDA fields were actually persisted
  try {
    const verifyOutput = await runCommand('task', [uuid, 'export']);
    const verified = JSON.parse(verifyOutput) as Task[];
    const verifiedTask = verified[0];
    if (!verifiedTask?.owner_agent) {
      throw new Error(
        'UDA fields not persisted after claim. Ensure owner_agent, lease_until, ' +
          'claimed_at, and last_renewed_at UDAs are configured in .taskrc. See README for setup.',
      );
    }
  } catch (err) {
    if ((err as Error).message.includes('UDA fields not persisted')) throw err;
    // Non-fatal: verification export failed but claim modify succeeded
  }
}

async function releaseClaim(taskRef: string): Promise<void> {
  const uuid = await resolveTaskRef(taskRef);

  try {
    await runCommand('task', [
      uuid,
      'modify',
      'owner_agent:',
      'claimed_at:',
      'lease_until:',
      'last_renewed_at:',
    ]);
  } catch (err) {
    throw new Error(`Failed to release claim on task ${taskRef}: ${(err as Error).message}`);
  }
}
