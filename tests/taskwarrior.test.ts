import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../src/taskwarrior.js';

// Mock at the I/O boundary — the exec wrapper, not internal logic
vi.mock('../src/exec.js', () => ({
  runCommand: vi.fn(),
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
  claimTask,
  releaseTask,
  getTaskClaim,
  isLeaseExpired,
  parseTaskwarriorDate,
} from '../src/taskwarrior.js';

const mockRun = vi.mocked(runCommand);

const sampleTask: Task = {
  id: 1,
  uuid: 'abc-123',
  description: 'Write tests',
  status: 'pending',
  entry: '20240101T000000Z',
  modified: '20240101T000000Z',
  urgency: 2.0,
};

beforeEach(() => {
  vi.resetAllMocks();
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
  it('modifies task description', async () => {
    mockRun.mockResolvedValue('Modified 1 task.');

    await modifyTask('1', { description: 'Updated description' });

    expect(mockRun).toHaveBeenCalledWith('task', ['1', 'modify', 'Updated description']);
  });

  it('modifies project', async () => {
    mockRun.mockResolvedValue('Modified 1 task.');

    await modifyTask('1', { project: 'personal' });

    const args = mockRun.mock.calls[0][1];
    expect(args).toContain('project:personal');
  });

  it('removes a tag with minus prefix', async () => {
    mockRun.mockResolvedValue('Modified 1 task.');

    await modifyTask('1', { removeTags: ['old'] });

    const args = mockRun.mock.calls[0][1];
    expect(args).toContain('-old');
  });

  it('throws a descriptive error when modify fails', async () => {
    mockRun.mockRejectedValue(new Error('No matches'));

    await expect(modifyTask('999', { description: 'x' })).rejects.toThrow('Failed to modify task');
  });
});

describe('completeTask', () => {
  it('marks a task done by id', async () => {
    mockRun.mockResolvedValue('Completed task 1.');

    await completeTask('1');

    expect(mockRun).toHaveBeenCalledWith('task', ['rc.confirmation=no', '1', 'done']);
  });

  it('throws a descriptive error when done fails', async () => {
    mockRun.mockRejectedValue(new Error('No matches'));

    await expect(completeTask('999')).rejects.toThrow('Failed to complete task');
  });
});

describe('deleteTask', () => {
  it('deletes a task by id', async () => {
    mockRun.mockResolvedValue('Deleted task 1.');

    await deleteTask('1');

    expect(mockRun).toHaveBeenCalledWith('task', ['rc.confirmation=no', '1', 'delete']);
  });
});

describe('startTask', () => {
  it('starts a task by id', async () => {
    mockRun.mockResolvedValue('Started task 1.');

    await startTask('1');

    expect(mockRun).toHaveBeenCalledWith('task', ['1', 'start']);
  });
});

describe('stopTask', () => {
  it('stops a task by id', async () => {
    mockRun.mockResolvedValue('Stopped task 1.');

    await stopTask('1');

    expect(mockRun).toHaveBeenCalledWith('task', ['1', 'stop']);
  });
});

describe('annotateTask', () => {
  it('adds an annotation to a task', async () => {
    mockRun.mockResolvedValue('Annotated task 1.');

    await annotateTask('1', 'See issue #42');

    expect(mockRun).toHaveBeenCalledWith('task', ['1', 'annotate', 'See issue #42']);
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
    const task: Task = {
      id: 1,
      uuid: 'abc',
      description: 'test',
      status: 'pending',
      entry: '',
      modified: '',
      urgency: 0,
    };
    expect(getTaskClaim(task)).toBeNull();
  });

  it('returns null when lease is expired', () => {
    const task: Task = {
      id: 1,
      uuid: 'abc',
      description: 'test',
      status: 'pending',
      entry: '',
      modified: '',
      urgency: 0,
      owner_agent: 'agent1',
      lease_until: '2020-01-01T00:00:00.000Z',
    };
    expect(getTaskClaim(task)).toBeNull();
  });

  it('returns claim when task has valid claim', () => {
    const task: Task = {
      id: 1,
      uuid: 'abc',
      description: 'test',
      status: 'pending',
      entry: '',
      modified: '',
      urgency: 0,
      owner_agent: 'agent1',
      claimed_at: '2024-01-01T00:00:00.000Z',
      lease_until: '2099-01-01T00:00:00.000Z',
    };
    const claim = getTaskClaim(task);
    expect(claim).not.toBeNull();
    expect(claim?.owner_agent).toBe('agent1');
  });
});

describe('claimTask', () => {
  const unclaimedTask: Task = {
    id: 1,
    uuid: 'abc-123',
    description: 'Test task',
    status: 'pending',
    entry: '20240101T000000Z',
    modified: '20240101T000000Z',
    urgency: 2.0,
  };

  const claimedTask: Task = {
    id: 1,
    uuid: 'abc-123',
    description: 'Test task',
    status: 'pending',
    entry: '20240101T000000Z',
    modified: '20240101T000000Z',
    urgency: 2.0,
    owner_agent: 'agent1',
    claimed_at: '20240101T000000Z',
    lease_until: '2099-01-01T00:00:00.000Z',
  };

  it('acquires unclaimed task', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));
    mockRun.mockResolvedValueOnce('Modified 1 task.');
    // Verification export after modify
    mockRun.mockResolvedValueOnce(JSON.stringify([{ ...unclaimedTask, owner_agent: 'agent1' }]));

    const result = await claimTask('abc-123', 'agent1', 1800000);

    expect(result.claim_mode).toBe('acquired');
    expect(result.owner_agent).toBe('agent1');
    expect(result.claimed_at).toBeDefined();
    expect(result.lease_until).toBeDefined();
  });

  it('renews same-agent lease', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));
    mockRun.mockResolvedValueOnce('Modified 1 task.');
    // Verification export after modify
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));

    const result = await claimTask('abc-123', 'agent1', 1800000);

    expect(result.claim_mode).toBe('renewed');
    expect(result.last_renewed_at).toBeDefined();
  });

  it('rejects different-agent active lease', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));

    await expect(claimTask('abc-123', 'agent2', 1800000)).rejects.toThrow(
      'Task is already claimed by agent1',
    );
  });

  it('succeeds on expired lease (treat as unclaimed)', async () => {
    const expiredTask: Task = {
      ...claimedTask,
      lease_until: '2020-01-01T00:00:00.000Z',
    };
    mockRun.mockResolvedValueOnce(JSON.stringify([expiredTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([expiredTask]));
    mockRun.mockResolvedValueOnce('Modified 1 task.');
    // Verification export after modify
    mockRun.mockResolvedValueOnce(JSON.stringify([{ ...expiredTask, owner_agent: 'agent2' }]));

    const result = await claimTask('abc-123', 'agent2', 1800000);

    expect(result.claim_mode).toBe('acquired');
  });

  it('throws descriptive error when UDAs are not persisted', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));
    mockRun.mockResolvedValueOnce('Modified 1 task.');
    // Verification export returns task WITHOUT owner_agent (UDA not configured)
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));

    await expect(claimTask('abc-123', 'agent1', 1800000)).rejects.toThrow(
      'UDA fields not persisted',
    );
  });

  it('throws when task not found', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([]));

    await expect(claimTask('nonexistent', 'agent1', 1800000)).rejects.toThrow(
      'Task not found: nonexistent',
    );
  });
});

describe('releaseTask', () => {
  const claimedTask: Task = {
    id: 1,
    uuid: 'abc-123',
    description: 'Test task',
    status: 'pending',
    entry: '20240101T000000Z',
    modified: '20240101T000000Z',
    urgency: 2.0,
    owner_agent: 'agent1',
    claimed_at: '20240101T000000Z',
    lease_until: '2099-01-01T00:00:00.000Z',
  };

  it('releases same-agent active lease', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));
    mockRun.mockResolvedValueOnce('Modified 1 task.');

    const result = await releaseTask('abc-123', 'agent1');

    expect(result.released).toBe(true);
    expect(result.previous_owner).toBe('agent1');
  });

  it('rejects different-agent active lease', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));

    await expect(releaseTask('abc-123', 'agent2')).rejects.toThrow(
      'Cannot release: task is claimed by agent1',
    );
  });

  it('idempotent for unclaimed task', async () => {
    const unclaimedTask: Task = {
      id: 1,
      uuid: 'abc-123',
      description: 'Test task',
      status: 'pending',
      entry: '20240101T000000Z',
      modified: '20240101T000000Z',
      urgency: 2.0,
    };
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));

    const result = await releaseTask('abc-123', 'agent1');

    expect(result.released).toBe(false);
  });

  it('idempotent for same-agent expired lease', async () => {
    const expiredTask: Task = {
      ...claimedTask,
      lease_until: '2020-01-01T00:00:00.000Z',
    };
    mockRun.mockResolvedValueOnce(JSON.stringify([expiredTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([expiredTask]));
    mockRun.mockResolvedValueOnce('Modified 1 task.');

    const result = await releaseTask('abc-123', 'agent1');

    expect(result.released).toBe(true);
  });

  it('throws when task not found', async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([]));

    await expect(releaseTask('nonexistent', 'agent1')).rejects.toThrow(
      'Task not found: nonexistent',
    );
  });
});

describe('concurrent claim conflicts', () => {
  it('unique agent_id prevents collisions between parallel agents', async () => {
    const unclaimedTask: Task = {
      id: 1,
      uuid: 'abc-123',
      description: 'Test task',
      status: 'pending',
      entry: '20240101T000000Z',
      modified: '20240101T000000Z',
      urgency: 2.0,
    };

    // First agent claims with unique ID
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([unclaimedTask]));
    mockRun.mockResolvedValueOnce('Modified 1 task.');
    mockRun.mockResolvedValueOnce(JSON.stringify([{ ...unclaimedTask, owner_agent: 'claude-opus-aaa' }]));

    const result = await claimTask('abc-123', 'claude-opus-aaa', 1800000);

    expect(result.claim_mode).toBe('acquired');
    expect(result.owner_agent).toBe('claude-opus-aaa');
  });

  it('second agent with different unique id cannot claim already-claimed task', async () => {
    const claimedTask: Task = {
      id: 1,
      uuid: 'abc-123',
      description: 'Test task',
      status: 'pending',
      entry: '20240101T000000Z',
      modified: '20240101T000000Z',
      urgency: 2.0,
      owner_agent: 'claude-opus-aaa',
      claimed_at: '20240101T000000Z',
      lease_until: '2099-01-01T00:00:00.000Z',
    };

    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));
    mockRun.mockResolvedValueOnce(JSON.stringify([claimedTask]));

    await expect(claimTask('abc-123', 'claude-opus-bbb', 1800000)).rejects.toThrow(
      'Task is already claimed by claude-opus-aaa',
    );
  });
});
