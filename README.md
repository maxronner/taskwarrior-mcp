# task-mcp

MCP server for Taskwarrior with agent claim/lease semantics.

## Setup

### Required Taskwarrior Configuration

Add the following to your `~/.taskrc` to enable claim metadata:

```ini
uda.owner_agent.type=string
uda.lease_until.type=date
uda.claimed_at.type=date
uda.last_renewed_at.type=date
```

## Usage

```bash
bun run dist/index.js
```

## MCP Tools

| Tool            | Description                                        |
| --------------- | -------------------------------------------------- |
| `project_list`  | List all projects                                  |
| `list_tasks`    | List tasks (returns claim metadata)                |
| `claim_task`    | Claim a task for an agent                          |
| `release_task`  | Release a claim                                    |
| `create_task`   | Create a new task (returns task payload with uuid) |
| `update_task`   | Update task (requires claim)                       |
| `complete_task` | Complete task (requires claim)                     |

## Claim Rules

- Agents must claim a task before mutating it
- Same agent can renew their claim
- Different agent cannot steal an active lease
- Expired leases are treated as unclaimed

## Development

```bash
bun install
bun run dev
bun run test
```
