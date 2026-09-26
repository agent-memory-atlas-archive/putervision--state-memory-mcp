import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { GraphEngine } from '../../src/engine/graph.js';
import { nodeHandlers } from '../../src/handlers/node.js';
import { getDb, closeAllDbs } from '../../src/engine/db.js';

describe('State-Memory Decision Nodes & Significance Thresholding', () => {
  const project = 'test-decision-nodes-suite';

  beforeEach(() => {
    const db = getDb(project);
    db.prepare('DELETE FROM edges WHERE project = ?').run(project);
    db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
    db.prepare('DELETE FROM events WHERE project = ?').run(project);
  });

  afterAll(() => {
    closeAllDbs();
  });

  it('filters sub-0.70 significance routine decisions to SQLite event log only', () => {
    const activeTask = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Current Active Task',
      status: 'in_progress',
    });

    const lowSigResult: any = nodeHandlers.manage_nodes({
      action: 'create',
      project,
      type: 'decision',
      title: 'Sub-threshold Routine Turn',
      status: 'accepted',
      metadata: {
        significance: 0.55,
        reasoning_tier: 'L1',
        cache_hit: true,
        state_pack_hash: 'hash-abc-123',
      },
    });

    expect(lowSigResult.status).toBe('logged_only');
    expect(lowSigResult.id).toMatch(/^fast_decision_/);

    const db = getDb(project);
    const dbNode = db
      .prepare('SELECT * FROM nodes WHERE project = ? AND title = ?')
      .get(project, 'Sub-threshold Routine Turn');
    expect(dbNode).toBeUndefined(); // Graph node not created

    const dbEvent = db
      .prepare("SELECT * FROM events WHERE project = ? AND event_type = 'fast_decision'")
      .get(project) as any;
    expect(dbEvent).toBeDefined();
    expect(dbEvent.metadata).toContain('hash-abc-123');
  });

  it('creates full graph node and decided_in edge for >= 0.70 high-significance decisions', () => {
    const activeTask = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Current Active Task',
      status: 'in_progress',
    });

    const highSigResult: any = nodeHandlers.manage_nodes({
      action: 'create',
      project,
      type: 'decision',
      title: 'High Significance Escalation',
      status: 'accepted',
      metadata: {
        significance: 0.75,
        reasoning_tier: 'L2',
        state_pack_hash: 'hash-l2-789',
      },
    });

    expect(highSigResult.id).toBeDefined();
    expect(highSigResult.status).toBe('accepted');

    const db = getDb(project);
    const createdNode = db
      .prepare('SELECT * FROM nodes WHERE project = ? AND id = ?')
      .get(project, highSigResult.id);
    expect(createdNode).toBeDefined();

    const edge = db
      .prepare("SELECT * FROM edges WHERE project = ? AND source_id = ? AND type = 'decided_in'")
      .get(project, highSigResult.id) as any;
    expect(edge).toBeDefined();
    expect(edge.target_id).toBe(activeTask.id);
  });

  it('always creates graph node for gated decisions regardless of significance', () => {
    const gatedResult: any = nodeHandlers.manage_nodes({
      action: 'create',
      project,
      type: 'decision',
      title: 'Gated Action with Token',
      status: 'accepted',
      metadata: {
        significance: 0.2,
        reasoning_tier: 'L1',
        token_id: 'token-verified-456',
      },
    });

    expect(gatedResult.status).toBe('accepted');
    const db = getDb(project);
    const createdNode = db
      .prepare('SELECT * FROM nodes WHERE project = ? AND id = ?')
      .get(project, gatedResult.id);
    expect(createdNode).toBeDefined();
  });
});
