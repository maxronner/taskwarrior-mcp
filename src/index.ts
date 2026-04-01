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
  type Task,
  type TaskStatus,
} from './taskwarrior.js';

const server = new McpServer({
  name: 'task-mcp',
  version: '1.0.0',
});

// ─── Shared schema fragments ──────────────────────────────────────────────────

const uuidParam = z
  .string()
  .uuid('Must be a UUID, not a numeric task index')
  .describe('Task UUID (from the uuid field in list_tasks). NEVER pass a numeric task index.');
const agentIdParam = z
  .string()
  .describe(
    'Globally unique agent identifier (e.g. "claude-opus-<uuid>"). Each agent instance MUST use a distinct ID to prevent collisions between parallel agents.',
  );
const priorityParam = z.enum(['H', 'M', 'L']).optional().describe('Priority: H, M, or L');
/** Coerce JSON-stringified arrays (e.g. '["a","b"]') that LLM clients sometimes send. */
function coerceStringArray(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* let Zod validate */
    }
  }
  return val;
}

const tagsParam = z
  .preprocess(coerceStringArray, z.array(z.string()).optional())
  .describe('Tags to add');
const dateParam = z
  .string()
  .optional()
  .describe('Date in any format Taskwarrior accepts (e.g. 2024-12-25, tomorrow, eow)');

// ─── Output formatting ───────────────────────────────────────────────────────

/** Rename `id` → `index` and omit when 0 (non-pending tasks have no index). */
function formatTaskOutput(task: Task): Record<string, unknown> {
  const { id, ...rest } = task;
  if (id && id !== 0) return { index: id, ...rest };
  return rest;
}

// ─── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  'list_tasks',
  'List tasks, optionally filtered by status, project, tags, or priority. Returns claim metadata (owner_agent, lease_until, claimed_at, last_renewed_at) for each task.',
  {
    status: z
      .enum(['pending', 'completed', 'deleted', 'waiting', 'recurring', 'all'])
      .optional()
      .describe('Filter by status (default: pending)'),
    project: z
      .string()
      .optional()
      .describe(
        'Filter by project name (supports hierarchy prefix matching, e.g. "jobfilter" matches "jobfilter.infra", "jobfilter.db"). Use project_list to discover available projects.',
      ),
    tags: z
      .preprocess(coerceStringArray, z.array(z.string()).optional())
      .describe('Filter by tags (these are explicit +tag labels, NOT project names)'),
    priority: priorityParam,
    due_before: dateParam,
    due_after: dateParam,
  },
  async (params) => {
    try {
      const tasks = await exportTasks({
        status: params.status as TaskStatus | 'all' | undefined,
        project: params.project,
        tags: params.tags,
        priority: params.priority as Priority | undefined,
        dueBefore: params.due_before,
        dueAfter: params.due_after,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(tasks.map(formatTaskOutput), null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool('project_list', 'List all projects in Taskwarrior', {}, async () => {
  try {
    const projects = await listProjects();
    return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
  }
});

server.tool(
  'get_task',
  'Get a single task by index (numeric) or UUID',
  { id: z.string().describe('Task index (numeric, from list_tasks) or UUID') },
  async ({ id }) => {
    try {
      const tasks = await exportTasks({ status: 'all' });
      const task = tasks.find((t) => String(t.id) === id || t.uuid === id);
      if (!task) {
        return {
          content: [{ type: 'text', text: `No task found matching: ${id}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(formatTaskOutput(task), null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  'create_task',
  'Create a new task and return the created task payload, including uuid',
  {
    description: z.string().describe('Task description (required)'),
    project: z.string().optional().describe('Project name'),
    priority: priorityParam,
    tags: tagsParam,
    due: dateParam,
    scheduled: dateParam,
    wait: dateParam,
    until: dateParam,
    depends: z
      .preprocess(coerceStringArray, z.array(z.string()).optional())
      .describe('UUIDs this task depends on'),
  },
  async (params) => {
    try {
      const task = await createTask({
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
      return { content: [{ type: 'text', text: JSON.stringify(formatTaskOutput(task), null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  'update_task',
  'Update fields on an existing task. Auto-claims the task for the calling agent.',
  {
    uuid: uuidParam,
    agent_id: agentIdParam,
    description: z.string().optional().describe('New description'),
    project: z.string().optional().describe('New project'),
    priority: priorityParam,
    tags: tagsParam,
    remove_tags: z
      .preprocess(coerceStringArray, z.array(z.string()).optional())
      .describe('Tags to remove'),
    due: dateParam,
    scheduled: dateParam,
    wait: dateParam,
    until: dateParam,
    depends: z
      .preprocess(coerceStringArray, z.array(z.string()).optional())
      .describe('UUIDs this task depends on'),
  },
  async ({ uuid, agent_id, remove_tags, ...fields }) => {
    try {
      const desc = await modifyTask(
        uuid,
        {
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
        },
        agent_id,
      );
      return { content: [{ type: 'text', text: `Task updated: "${desc}" (${uuid})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  'complete_task',
  'Mark a task as done. Auto-claims then releases after completion.',
  {
    uuid: uuidParam,
    agent_id: agentIdParam,
  },
  async ({ uuid, agent_id }) => {
    try {
      const desc = await completeTask(uuid, agent_id);
      return { content: [{ type: 'text', text: `Task completed: "${desc}" (${uuid})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  'delete_task',
  'Delete a task. Auto-claims then releases after deletion.',
  { uuid: uuidParam, agent_id: agentIdParam },
  async ({ uuid, agent_id }) => {
    try {
      const desc = await deleteTask(uuid, agent_id);
      return { content: [{ type: 'text', text: `Task deleted: "${desc}" (${uuid})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  'start_task',
  'Start working on a task (auto-claims and sets active timer)',
  { uuid: uuidParam, agent_id: agentIdParam },
  async ({ uuid, agent_id }) => {
    try {
      const desc = await startTask(uuid, agent_id);
      return { content: [{ type: 'text', text: `Task started: "${desc}" (${uuid})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  'stop_task',
  'Stop working on a task (pauses active timer, keeps claim)',
  { uuid: uuidParam, agent_id: agentIdParam },
  async ({ uuid, agent_id }) => {
    try {
      const desc = await stopTask(uuid, agent_id);
      return { content: [{ type: 'text', text: `Task stopped: "${desc}" (${uuid})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.tool(
  'annotate_task',
  'Add an annotation (note) to a task (auto-claims, renews lease)',
  {
    uuid: uuidParam,
    agent_id: agentIdParam,
    annotation: z.string().describe('The annotation text to add'),
  },
  async ({ uuid, agent_id, annotation }) => {
    try {
      const desc = await annotateTask(uuid, annotation, agent_id);
      return { content: [{ type: 'text', text: `Annotation added to task: "${desc}" (${uuid})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

// ─── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
