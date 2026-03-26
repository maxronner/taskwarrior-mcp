#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  exportTasks,
  listProjects,
  createTask,
  modifyTask,
  completeTask,
  deleteTask,
  startTask,
  stopTask,
  annotateTask,
  type Priority,
  type TaskStatus,
} from './taskwarrior.js';

const server = new McpServer({
  name: 'task-mcp',
  version: '1.0.0',
});

// ─── Shared schema fragments ──────────────────────────────────────────────────

const idParam = z.string().describe('Task ID or UUID');
const agentIdParam = z.string().describe('Globally unique agent identifier (e.g. "claude-opus-<uuid>"). Each agent instance MUST use a distinct ID to prevent collisions between parallel agents.');
const priorityParam = z.enum(['H', 'M', 'L']).optional().describe('Priority: H, M, or L');
/** Coerce JSON-stringified arrays (e.g. '["a","b"]') that LLM clients sometimes send. */
function coerceStringArray(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* let Zod validate */ }
  }
  return val;
}

const tagsParam = z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to add');
const dateParam = z
  .string()
  .optional()
  .describe('Date in any format Taskwarrior accepts (e.g. 2024-12-25, tomorrow, eow)');

// ─── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  'list_tasks',
  'List tasks, optionally filtered by status, project, tags, or priority. Returns claim metadata (owner_agent, lease_until, claimed_at, last_renewed_at) for each task.',
  {
    status: z
      .enum(['pending', 'completed', 'deleted', 'waiting', 'recurring', 'all'])
      .optional()
      .describe('Filter by status (default: pending)'),
    project: z.string().optional().describe('Filter by project name'),
    tags: tagsParam,
    priority: priorityParam,
    due_before: dateParam,
    due_after: dateParam,
  },
  async (params) => {
    const tasks = await exportTasks({
      status: params.status as TaskStatus | 'all' | undefined,
      project: params.project,
      tags: params.tags,
      priority: params.priority as Priority | undefined,
      dueBefore: params.due_before,
      dueAfter: params.due_after,
    });
    return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
  },
);

server.tool('project_list', 'List all projects in Taskwarrior', {}, async () => {
  const projects = await listProjects();
  return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
});

server.tool('get_task', 'Get a single task by ID or UUID', { id: idParam }, async ({ id }) => {
  const tasks = await exportTasks({ status: 'all' });
  const task = tasks.find((t) => String(t.id) === id || t.uuid === id);
  if (!task) {
    return {
      content: [{ type: 'text', text: `No task found with id or uuid: ${id}` }],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
});

server.tool(
  'create_task',
  'Create a new task',
  {
    description: z.string().describe('Task description (required)'),
    project: z.string().optional().describe('Project name'),
    priority: priorityParam,
    tags: tagsParam,
    due: dateParam,
    scheduled: dateParam,
    wait: dateParam,
    until: dateParam,
    depends: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('UUIDs this task depends on'),
  },
  async (params) => {
    await createTask({
      description: params.description,
      project: params.project,
      priority: params.priority as Priority | undefined,
      tags: params.tags,
      due: params.due,
      scheduled: params.scheduled,
      wait: params.wait,
      until: params.until,
      depends: params.depends,
    });
    return { content: [{ type: 'text', text: `Task created: ${params.description}` }] };
  },
);

server.tool(
  'update_task',
  'Update fields on an existing task. Auto-claims the task for the calling agent.',
  {
    id: idParam,
    agent_id: agentIdParam,
    description: z.string().optional().describe('New description'),
    project: z.string().optional().describe('New project'),
    priority: priorityParam,
    tags: tagsParam,
    remove_tags: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('Tags to remove'),
    due: dateParam,
    scheduled: dateParam,
    wait: dateParam,
    until: dateParam,
    depends: z.preprocess(coerceStringArray, z.array(z.string()).optional()).describe('UUIDs this task depends on'),
  },
  async ({ id, agent_id, remove_tags, ...fields }) => {
    await modifyTask(id, {
      description: fields.description,
      project: fields.project,
      priority: fields.priority as Priority | undefined,
      tags: fields.tags,
      removeTags: remove_tags,
      due: fields.due,
      scheduled: fields.scheduled,
      wait: fields.wait,
      until: fields.until,
      depends: fields.depends,
    }, agent_id);
    return { content: [{ type: 'text', text: `Task ${id} updated.` }] };
  },
);

server.tool(
  'complete_task',
  'Mark a task as done. Auto-claims then releases after completion.',
  {
    id: idParam,
    agent_id: agentIdParam,
  },
  async ({ id, agent_id }) => {
    await completeTask(id, agent_id);
    return { content: [{ type: 'text', text: `Task ${id} completed.` }] };
  },
);

server.tool(
  'delete_task',
  'Delete a task. Auto-claims then releases after deletion.',
  { id: idParam, agent_id: agentIdParam },
  async ({ id, agent_id }) => {
    await deleteTask(id, agent_id);
    return { content: [{ type: 'text', text: `Task ${id} deleted.` }] };
  },
);

server.tool(
  'start_task',
  'Start working on a task (auto-claims and sets active timer)',
  { id: idParam, agent_id: agentIdParam },
  async ({ id, agent_id }) => {
    await startTask(id, agent_id);
    return { content: [{ type: 'text', text: `Task ${id} started.` }] };
  },
);

server.tool(
  'stop_task',
  'Stop working on a task (pauses active timer, keeps claim)',
  { id: idParam, agent_id: agentIdParam },
  async ({ id, agent_id }) => {
    await stopTask(id, agent_id);
    return { content: [{ type: 'text', text: `Task ${id} stopped.` }] };
  },
);

server.tool(
  'annotate_task',
  'Add an annotation (note) to a task (auto-claims, renews lease)',
  {
    id: idParam,
    agent_id: agentIdParam,
    annotation: z.string().describe('The annotation text to add'),
  },
  async ({ id, agent_id, annotation }) => {
    await annotateTask(id, annotation, agent_id);
    return { content: [{ type: 'text', text: `Annotation added to task ${id}.` }] };
  },
);

// ─── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
