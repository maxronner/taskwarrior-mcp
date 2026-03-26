import { describe, it, expect, mock, beforeEach, type Mock } from 'bun:test';
import type { Task } from '../src/taskwarrior.js';

// Mock at the I/O boundary — the exec wrapper, not internal logic
mock.module('../src/exec.js', () => ({
  runCommand: mock(),
}));

import { runCommand } from '../src/exec.js';
import {
  exportTasks,
  createTask,
  modifyTask,
  completeTask,
  deleteTask,
  startTask,
  stopTask,
  annotateTask,
  buildModifyArgs,
  getTaskClaim,
  isLeaseExpired,
  parseTaskwarriorDate,
  toTaskwarriorDate,
} from '../src/taskwarrior.js';

const mockRun = runCommand as Mock<typeof runCommand>;

const sampleTask: Task = {
  id: 1,
  uuid: 'abc-123',
  description: 'Write tests',
  status: 'pending',
  entry: '20240101T000000Z',
  modified: '20240101T000000Z',
  urgency: 2.0,
};

const claimedTask: Task = {
  ...sampleTask,
  owner_agent: 'agent1',
  claimed_at: '20240101T000000Z',
  lease_until: '2099-01-01T00:00:00.000Z',
};

/**
 * Set up mocks for ensureClaim's internal calls (resolveTask + modify + verify).
 */
function mockEnsureClaim(task: Task, verifiedTask?: Task): void {
  // resolveTask → exportTasks({status:'all'})
  mockRun.mockResolvedValueOnce(JSON.stringify([task]));
  // ensureClaim → task modify (claim UDAs)
  mockRun.mockResolvedValueOnce('Modified 1 task.');
  // ensureClaim → verification export
  mockRun.mockResolvedValueOnce(
    JSON.stringify([verifiedTask ?? { ...task, owner_agent: 'agent1' }]),
  );
}

beforeEach(() => {
  mockRun.mockReset();
});

describe('exportTasks', () => {
  it('returns parsed tasks from task export output', async () => {
    mockRun.mockResolvedValue(JSON.stringify([sampleTask]));

    const tasks = await exportTasks();

    expect(mockRun).toHaveBeenCalledWith('task', ['export']);
    expect(tasks).toEqual([sampleTask]);
  });

  it('applies status filter when provided', async () => {
    mockRun.mockResolvedValue(JSON.stringify([sampleTask]));

    await exportTasks({ status: 'completed' });

    expect(mockRun).toHaveBeenCalledWith('task', ['status:completed', 'export']);
  });

  it('applies project filter when provided', async () => {
    mockRun.mockResolvedValue(JSON.stringify([sampleTask]));

    await exportTasks({ project: 'work' });

    expect(mockRun).toHaveBeenCalledWith('task', ['project:work', 'export']);
  });

  it('applies tag filter when provided', async () => {
    mockRun.mockResolvedValue(JSON.stringify([sampleTask]));

    await exportTasks({ tags: ['urgent'] });

    expect(mockRun).toHaveBeenCalledWith('task', ['+urgent', 'export']);
  });

  it('applies multiple filters together', async () => {
    mockRun.mockResolvedValue(JSON.stringify([sampleTask]));

    await exportTasks({ project: 'work', tags: ['urgent'], priority: 'H' });

    const call = mockRun.mock.calls[0][1];
    expect(call).toContain('project:work');
    expect(call).toContain('+urgent');
    expect(call).toContain('priority:H');
    expect(call).toContain('export');
    expect(call[call.length - 1]).toBe('export');
  });

  it('returns empty array when task outputs empty JSON array', async () => {
    mockRun.mockResolvedValue('[]');

    const tasks = await exportTasks();

    expect(tasks).toEqual([]);
  });

  it('throws a descriptive error when task CLI fails', async () => {
    mockRun.mockRejectedValue(new Error('No matches'));

    await expect(exportTasks()).rejects.toThrow('Failed to export tasks');
  });
});

describe('createTask', () => {
  it('adds a task with description only', async () => {
    mockRun.mockResolvedValue('Created task 1.');

    await createTask({ description: 'Buy milk' });

    expect(mockRun).toHaveBeenCalledWith('task', ['add', 'Buy milk']);
  });

  it('includes project when provided', async () => {
    mockRun.mockResolvedValue('Created task 2.');

    await createTask({ description: 'Deploy app', project: 'ops' });

    const args = mockRun.mock.calls[0][1];
    expect(args).toContain('project:ops');
    expect(args).toContain('Deploy app');
  });

  it('includes priority when provided', async () => {
    mockRun.mockResolvedValue('Created task 3.');

    await createTask({ description: 'Fix bug', priority: 'H' });

    const args = mockRun.mock.calls[0][1];
    expect(args).toContain('priority:H');
  });

  it('includes tags when provided', async () => {
    mockRun.mockResolvedValue('Created task 4.');

    await createTask({ description: 'Review PR', tags: ['work', 'review'] });

    const args = mockRun.mock.calls[0][1];
    expect(args).toContain('+work');
    expect(args).toContain('+review');
  });

  it('includes due date when provided', async () => {
    mockRun.mockResolvedValue('Created task 5.');

    await createTask({ description: 'Submit report', due: '2024-12-25' });

    const args = mockRun.mock.calls[0][1];
    expect(args).toContain('due:2024-12-25');
  });

  it('throws a descriptive error when task add fails', async () => {
    mockRun.mockRejectedValue(new Error('Permission denied'));

    await expect(createTask({ description: 'Test' })).rejects.toThrow('Failed to create task');
  });
});

describe('modifyTask', () => {
  it('claims then modifies task using resolved UUID', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockResolvedValueOnce('Modified 1 task.');

    await modifyTask('1', { description: 'Updated description' }, 'agent1');

    // The 5th call (index 4) is the actual modify, using UUID not ID
    expect(mockRun.mock.calls[3]).toEqual(['task', ['abc-123', 'modify', 'Updated description']]);
  });

  it('throws when modify command fails', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockRejectedValueOnce(new Error('No matches'));

    await expect(modifyTask('1', { description: 'x' }, 'agent1')).rejects.toThrow(
      'Failed to modify task',
    );
  });
});

describe('completeTask', () => {
  it('claims, completes, then releases', async () => {
    mockEnsureClaim(sampleTask);
    // complete
    mockRun.mockResolvedValueOnce('Completed task 1.');
    // releaseClaim modify
    mockRun.mockResolvedValueOnce('Modified 1 task.');

    await completeTask('1', 'agent1');

    expect(mockRun.mock.calls[3]).toEqual([
      'task',
      ['rc.confirmation=no', 'abc-123', 'done'],
    ]);
    // Release clears UDAs
    expect(mockRun.mock.calls[4][1]).toContain('owner_agent:');
  });

  it('releases claim using UUID even after task status changes', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockResolvedValueOnce('Completed task 1.');
    mockRun.mockResolvedValueOnce('Modified 1 task.');

    await completeTask('1', 'agent1');

    // releaseClaim uses UUID directly, not the original numeric ID
    const releaseArgs = mockRun.mock.calls[4][1] as string[];
    expect(releaseArgs[0]).toBe('abc-123');
    expect(releaseArgs).toContain('owner_agent:');
    expect(releaseArgs).toContain('claimed_at:');
    expect(releaseArgs).toContain('lease_until:');
    expect(releaseArgs).toContain('last_renewed_at:');
  });

  it('throws when done command fails', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockRejectedValueOnce(new Error('No matches'));

    await expect(completeTask('1', 'agent1')).rejects.toThrow('Failed to complete task');
  });
});

describe('deleteTask', () => {
  it('claims, deletes, then releases', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockResolvedValueOnce('Deleted task 1.');
    mockRun.mockResolvedValueOnce('Modified 1 task.');

    await deleteTask('1', 'agent1');

    expect(mockRun.mock.calls[3]).toEqual([
      'task',
      ['rc.confirmation=no', 'abc-123', 'delete'],
    ]);
  });
});

describe('startTask', () => {
  it('claims then starts using resolved UUID', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockResolvedValueOnce('Started task 1.');

    await startTask('1', 'agent1');

    expect(mockRun.mock.calls[3]).toEqual(['task', ['abc-123', 'start']]);
  });
});

describe('stopTask', () => {
  it('claims then stops using resolved UUID', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockResolvedValueOnce('Stopped task 1.');

    await stopTask('1', 'agent1');

    expect(mockRun.mock.calls[3]).toEqual(['task', ['abc-123', 'stop']]);
  });
});

describe('annotateTask', () => {
  it('claims then annotates using resolved UUID', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockResolvedValueOnce('Annotated task 1.');

    await annotateTask('1', 'See issue #42', 'agent1');

    expect(mockRun.mock.calls[3]).toEqual(['task', ['abc-123', 'annotate', 'See issue #42']]);
  });
});

describe('buildModifyArgs', () => {
  it('converts description to positional arg', () => {
    expect(buildModifyArgs({ description: 'New title' })).toContain('New title');
  });

  it('converts project to project: arg', () => {
    expect(buildModifyArgs({ project: 'home' })).toContain('project:home');
  });

  it('converts priority to priority: arg', () => {
    expect(buildModifyArgs({ priority: 'M' })).toContain('priority:M');
  });

  it('converts tags to +tag args', () => {
    const args = buildModifyArgs({ tags: ['a', 'b'] });
    expect(args).toContain('+a');
    expect(args).toContain('+b');
  });

  it('converts removeTags to -tag args', () => {
    const args = buildModifyArgs({ removeTags: ['old'] });
    expect(args).toContain('-old');
  });

  it('converts due to due: arg', () => {
    expect(buildModifyArgs({ due: '2024-12-25' })).toContain('due:2024-12-25');
  });

  it('converts scheduled to scheduled: arg', () => {
    expect(buildModifyArgs({ scheduled: '2024-12-20' })).toContain('scheduled:2024-12-20');
  });

  it('converts wait to wait: arg', () => {
    expect(buildModifyArgs({ wait: '2024-12-19' })).toContain('wait:2024-12-19');
  });

  it('clears a field when set to empty string', () => {
    expect(buildModifyArgs({ due: '' })).toContain('due:');
  });
});

describe('parseTaskwarriorDate', () => {
  it('parses ISO extended format', () => {
    const d = parseTaskwarriorDate('2024-06-15T10:30:45Z');
    expect(d.getTime()).toBe(new Date('2024-06-15T10:30:45Z').getTime());
  });

  it('parses Taskwarrior compact format', () => {
    const d = parseTaskwarriorDate('20240615T103045Z');
    expect(d.getTime()).toBe(new Date('2024-06-15T10:30:45Z').getTime());
  });

  it('both formats produce equivalent dates', () => {
    const iso = parseTaskwarriorDate('2024-01-01T00:00:00Z');
    const compact = parseTaskwarriorDate('20240101T000000Z');
    expect(iso.getTime()).toBe(compact.getTime());
  });
});

describe('toTaskwarriorDate', () => {
  it('produces compact UTC format', () => {
    const d = new Date('2026-03-26T04:15:52.180Z');
    expect(toTaskwarriorDate(d)).toBe('20260326T041552Z');
  });

  it('round-trips through parseTaskwarriorDate', () => {
    const d = new Date('2024-06-15T10:30:45.999Z');
    const compact = toTaskwarriorDate(d);
    const parsed = parseTaskwarriorDate(compact);
    expect(parsed.getUTCFullYear()).toBe(2024);
    expect(parsed.getUTCMonth()).toBe(5);
    expect(parsed.getUTCDate()).toBe(15);
    expect(parsed.getUTCHours()).toBe(10);
    expect(parsed.getUTCMinutes()).toBe(30);
    expect(parsed.getUTCSeconds()).toBe(45);
  });

  it('pads single-digit components', () => {
    const d = new Date('2024-01-02T03:04:05Z');
    expect(toTaskwarriorDate(d)).toBe('20240102T030405Z');
  });
});

describe('isLeaseExpired', () => {
  it('returns true for undefined', () => {
    expect(isLeaseExpired(undefined)).toBe(true);
  });

  it('returns true for null', () => {
    expect(isLeaseExpired(null as unknown as undefined)).toBe(true);
  });

  it('returns true for past date', () => {
    expect(isLeaseExpired('2020-01-01T00:00:00.000Z')).toBe(true);
  });

  it('returns false for future date', () => {
    expect(isLeaseExpired('2099-01-01T00:00:00.000Z')).toBe(false);
  });

  it('returns true for past compact date', () => {
    expect(isLeaseExpired('20200101T000000Z')).toBe(true);
  });

  it('returns false for future compact date', () => {
    expect(isLeaseExpired('20990101T000000Z')).toBe(false);
  });

  it('returns true for invalid date string', () => {
    expect(isLeaseExpired('not-a-date')).toBe(true);
  });
});

describe('getTaskClaim', () => {
  it('returns null when task has no owner_agent', () => {
    expect(getTaskClaim(sampleTask)).toBeNull();
  });

  it('returns null when lease is expired', () => {
    const task: Task = {
      ...sampleTask,
      owner_agent: 'agent1',
      lease_until: '2020-01-01T00:00:00.000Z',
    };
    expect(getTaskClaim(task)).toBeNull();
  });

  it('returns claim when task has valid claim', () => {
    const claim = getTaskClaim(claimedTask);
    expect(claim).not.toBeNull();
    expect(claim?.owner_agent).toBe('agent1');
  });
});

describe('auto-claim behavior', () => {
  it('acquires claim on unclaimed task', async () => {
    mockEnsureClaim(sampleTask);
    mockRun.mockResolvedValueOnce('Started task 1.');

    await startTask('1', 'agent1');

    // The modify call (index 2) should set owner_agent
    const modifyArgs = mockRun.mock.calls[1][1] as string[];
    expect(modifyArgs).toContain('owner_agent:agent1');
    expect(modifyArgs.some((a: string) => a.startsWith('claimed_at:'))).toBe(true);
  });

  it('renews lease for same agent', async () => {
    mockEnsureClaim(claimedTask);
    mockRun.mockResolvedValueOnce('Started task 1.');

    await startTask('1', 'agent1');

    const modifyArgs = mockRun.mock.calls[1][1] as string[];
    expect(modifyArgs.some((a: string) => a.startsWith('last_renewed_at:'))).toBe(true);
  });

  it('rejects mutation by different agent on claimed task', async () => {
    // resolveTask → exportTasks({status:'all'})
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));

    await expect(startTask('1', 'agent2')).rejects.toThrow(
      'Task is already claimed by agent1',
    );
  });

  it('allows claim on expired lease', async () => {
    const expiredTask: Task = {
      ...claimedTask,
      lease_until: '2020-01-01T00:00:00.000Z',
    };
    mockEnsureClaim(expiredTask, { ...expiredTask, owner_agent: 'agent2' });
    mockRun.mockResolvedValueOnce('Started task 1.');

    await startTask('1', 'agent2');

    const modifyArgs = mockRun.mock.calls[1][1] as string[];
    expect(modifyArgs).toContain('owner_agent:agent2');
  });

  it('throws when UDAs are not persisted', async () => {
    // resolveTask → exportTasks({status:'all'})
    mockRun.mockResolvedValueOnce(JSON.stringify([sampleTask]));
    // modify
    mockRun.mockResolvedValueOnce('Modified 1 task.');
    // verification returns task WITHOUT owner_agent
    mockRun.mockResolvedValueOnce(JSON.stringify([sampleTask]));

    await expect(startTask('1', 'agent1')).rejects.toThrow('UDA fields not persisted');
  });

  it('throws when task not found', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([]));

    await expect(startTask('nonexistent', 'agent1')).rejects.toThrow(
      'Task not found: nonexistent',
    );
  });
});
