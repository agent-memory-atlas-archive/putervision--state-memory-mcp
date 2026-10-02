import { getDb, getProjectSlug } from './db.js';
import { SessionEngine } from './sessions.js';
import { AnalyticsEngine } from './analytics/index.js';
import { getNextTasks } from './work-queue.js';
import { QueryEngine } from './queries.js';
import { BootstrapSessionParams } from '../schema/types.js';

export function bootstrapSession(params: BootstrapSessionParams) {
  const projectSlug = getProjectSlug(params.project);
  const db = getDb(projectSlug);

  const { session_id, session_reused } = SessionEngine.startSession(db, {
    project: projectSlug,
    agent_id: params.agent_id,
    metadata: params.metadata,
    reuse_existing: true,
  });

  const context_snapshot = AnalyticsEngine.getContextSnapshot({ project: projectSlug });

  const next_tasks_res = getNextTasks(db, {
    project: projectSlug,
    limit: params.task_limit !== undefined ? params.task_limit : 5,
  });

  const topTask = next_tasks_res.tasks[0]?.node;
  const task_slice = topTask ? QueryEngine.getTaskSlice(db, projectSlug, topTask.id) : null;

  return {
    session_id,
    session_reused: !!session_reused,
    task_slice,
    spatial_slice_handle: task_slice?.spatial_entity_id
      ? `spatial:${task_slice.spatial_entity_id}`
      : undefined,
    visual_slice_handle: task_slice?.visual_state_id
      ? `visual:${task_slice.visual_state_id}`
      : undefined,
    active_intention: task_slice?.active_intention_id
      ? { id: task_slice.active_intention_id }
      : undefined,
    context_snapshot,
    next_tasks: next_tasks_res.tasks,
    summary: next_tasks_res.summary,
  };
}
