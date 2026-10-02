import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeAllDbs } from '../../src/engine/db.js';
import { GraphEngine } from '../../src/engine/graph.js';
import { EdgeEngine } from '../../src/engine/edges.js';
import { QueryEngine } from '../../src/engine/queries.js';

describe('Typed Blockers and Fast TaskSlice', () => {
  const project = 'typed-blockers-test';

  beforeEach(() => {
    const db = getDb(project);
    db.prepare('DELETE FROM nodes').run();
    db.prepare('DELETE FROM edges').run();
    db.prepare('DELETE FROM blackboard').run();
  });

  afterAll(() => {
    closeAllDbs();
  });

  it('should categorize typed blockers and populate TaskSlice blockers array', () => {
    const db = getDb(project);

    // Create main task
    const task = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Navigate to target waypoint',
      status: 'in_progress',
    });

    // Create blocker 1: spatial_stale
    const b1 = GraphEngine.addNode({
      project,
      type: 'blocker',
      title: 'Spatial data is older than 5s',
      status: 'active',
      metadata: {
        blocker_class: 'spatial_stale',
      },
    });

    // Create blocker 2: clearance_violation
    const b2 = GraphEngine.addNode({
      project,
      type: 'blocker',
      title: 'Obstacle distance below min_clearance',
      status: 'active',
      metadata: {
        blocker_class: 'clearance_violation',
      },
    });

    // Link blockers to task
    EdgeEngine.addEdge({
      project,
      source_id: b1.id,
      target_id: task.id,
      type: 'blocks',
    });

    EdgeEngine.addEdge({
      project,
      source_id: b2.id,
      target_id: task.id,
      type: 'blocks',
    });

    const slice = QueryEngine.getTaskSlice(db, project, task.id);

    expect(slice.task_id).toBe(task.id);
    expect(slice.status).toBe('in_progress');
    expect(slice.blockers).toHaveLength(2);

    const blockerClasses = slice.blockers.map((b) => b.blocker_class);
    expect(blockerClasses).toContain('spatial_stale');
    expect(blockerClasses).toContain('clearance_violation');
    expect(slice.blocker_class).toBeDefined();
  });

  it('should calculate feature density correctly based on fresh vs decayed observations', () => {
    const db = getDb(project);

    const task = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Perception task',
      status: 'in_progress',
    });

    // Create 3 fresh observations
    for (let i = 0; i < 3; i++) {
      const obs = GraphEngine.addNode({
        project,
        type: 'observation',
        title: `Fresh observation ${i}`,
        status: 'active',
      });
      EdgeEngine.addEdge({
        project,
        source_id: task.id,
        target_id: obs.id,
        type: 'references',
      });
    }

    const slice = QueryEngine.getTaskSlice(db, project, task.id);
    expect(slice.feature_density).toBe(1.0);
  });
});
