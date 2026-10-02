import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeAllDbs } from '../../src/engine/db.js';
import { GraphEngine } from '../../src/engine/graph.js';
import { EdgeEngine } from '../../src/engine/edges.js';
import { QueryEngine } from '../../src/engine/queries.js';
import { validateGraph } from '../../src/engine/validate.js';

describe('Cross-Server Edges and External References', () => {
  const project = 'cross-server-edges-test';

  beforeEach(() => {
    const db = getDb(project);
    db.prepare('DELETE FROM nodes').run();
    db.prepare('DELETE FROM edges').run();
  });

  afterAll(() => {
    closeAllDbs();
  });

  it('should allow link_spatial, link_intention, and link_behavior edges without flagging dangling errors', () => {
    const db = getDb(project);

    // Create a local task
    const task = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Drive to target object',
      status: 'in_progress',
    });

    // Add cross-server edges referencing external IDs
    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: 'entity_cube_01',
      type: 'link_spatial' as any,
    });

    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: 'int_nav_goal_42',
      type: 'link_intention' as any,
    });

    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: 'runtime:leaf_approach_01',
      type: 'link_behavior' as any,
    });

    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: 'vs_dialog_screen_3',
      type: 'renders_state',
    });

    // Run graph validation on dangling_edges
    const validation = validateGraph(db, {
      project,
      checks: ['dangling_edges'],
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toHaveLength(0);

    // Verify QueryEngine.getTaskSlice resolves spatial, intention, and visual handles
    const slice = QueryEngine.getTaskSlice(db, project, task.id);
    expect(slice.spatial_entity_id).toBe('entity_cube_01');
    expect(slice.active_intention_id).toBe('int_nav_goal_42');
    expect(slice.visual_state_id).toBe('vs_dialog_screen_3');
  });

  it('should still flag truly dangling edges to non-external missing nodes', () => {
    const db = getDb(project);

    const task = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Standard task',
      status: 'pending',
    });

    // AddEdge should reject non-existent internal node
    expect(() => {
      EdgeEngine.addEdge({
        project,
        source_id: task.id,
        target_id: '01M3NONEXISTENTNODEID999999',
        type: 'depends_on',
      });
    }).toThrow(/Target node not found/);

    // Insert directly into edges table to test validateGraph detecting dangling edges
    db.pragma('foreign_keys = OFF');
    db.prepare(
      `INSERT INTO edges (id, source_id, target_id, type, properties, project, git_branch, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'dangling_edge_test',
      task.id,
      '01M3NONEXISTENTNODEID999999',
      'depends_on',
      '{}',
      project,
      'main',
      new Date().toISOString()
    );
    db.pragma('foreign_keys = ON');

    const validation = validateGraph(db, {
      project,
      checks: ['dangling_edges'],
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues.length).toBeGreaterThan(0);
    expect(validation.issues[0].check).toBe('dangling_edges');
  });
});
