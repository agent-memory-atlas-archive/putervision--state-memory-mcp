import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { GraphEngine } from '../../src/engine/graph.js';
import { QueryEngine } from '../../src/engine/queries.js';
import { SynergyEngine } from '../../src/engine/synergy.js';
import { nodeHandlers } from '../../src/handlers/node.js';
import { graphHandlers } from '../../src/handlers/graph.js';
import { getDb, closeAllDbs } from '../../src/engine/db.js';

describe('System One TaskSlice and Decision Logging', () => {
  const project = 'test-system-one-slice';

  beforeEach(() => {
    const db = getDb(project);
    db.prepare('DELETE FROM edges WHERE project = ?').run(project);
    db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
    db.prepare('DELETE FROM events WHERE project = ?').run(project);
  });

  afterAll(() => {
    closeAllDbs();
  });

  it('generates a compact TaskSlice (<1KB) with active task, milestone, blockers, and hash', () => {
    // 1. Create a milestone
    const ms = GraphEngine.addNode({
      project,
      type: 'milestone',
      title: 'Milestone Alpha',
      status: 'in_progress',
    });

    // 2. Create active task
    const activeTask = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Active Fast Task',
      status: 'in_progress',
      metadata: { milestone_id: ms.id },
    });

    // 3. Create pending tasks
    GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Pending Task 1',
      status: 'pending',
    });
    GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Pending Task 2',
      status: 'pending',
    });

    // 4. Create active blocker
    GraphEngine.addNode({
      project,
      type: 'blocker',
      title: 'Blocker X',
      status: 'active',
      metadata: { description: 'Missing network bridge' },
    });

    // 5. Query compact slice via handler
    const slice: any = graphHandlers.query_graph({
      action: 'compact_slice',
      project,
    });

    expect(slice.active_task_id).toBe(activeTask.id);
    expect(slice.active_task_title).toBe('Active Fast Task');
    expect(slice.milestone_title).toBe('Milestone Alpha');
    expect(slice.pending_tasks_count).toBe(2);
    expect(slice.blockers.length).toBe(1);
    expect(slice.blockers[0].description).toBe('Missing network bridge');
    expect(slice.task_graph_hash).toMatch(/^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(slice);
    expect(serialized.length).toBeLessThan(1024);
  });

  it('filters low-significance cache-hit decisions to SQLite event log only', () => {
    // Active task
    const activeTask = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Active Task',
      status: 'in_progress',
    });

    // Sub-0.70 significance decision with cache_hit = true
    const lowSigResult: any = nodeHandlers.manage_nodes({
      action: 'create',
      project,
      type: 'decision',
      title: 'Routine cached turn',
      status: 'accepted',
      metadata: {
        significance: 0.45,
        reasoning_tier: 'L1',
        cache_hit: true,
        state_pack_hash: 'hash-abc',
      },
    });

    expect(lowSigResult.status).toBe('logged_only');
    expect(lowSigResult.id).toMatch(/^fast_decision_/);

    const db = getDb(project);
    const dbNode = db.prepare('SELECT * FROM nodes WHERE project = ? AND title = ?').get(project, 'Routine cached turn');
    expect(dbNode).toBeUndefined(); // Did NOT pollute graph nodes table

    const dbEvent = db.prepare("SELECT * FROM events WHERE project = ? AND event_type = 'fast_decision'").get(project);
    expect(dbEvent).toBeDefined(); // Logged to Merkle events table

    // High-significance decision (>= 0.70)
    const highSigResult: any = nodeHandlers.manage_nodes({
      action: 'create',
      project,
      type: 'decision',
      title: 'Critical path turn',
      status: 'accepted',
      metadata: {
        significance: 0.85,
        reasoning_tier: 'L2',
        state_pack_hash: 'hash-xyz',
      },
    });

    expect(highSigResult.id).toBeDefined();
    expect(highSigResult.status).toBe('accepted');

    const createdNode = db.prepare('SELECT * FROM nodes WHERE project = ? AND id = ?').get(project, highSigResult.id);
    expect(createdNode).toBeDefined();

    // Check decided_in edge auto-link to active task
    const edge = db.prepare("SELECT * FROM edges WHERE project = ? AND source_id = ? AND type = 'decided_in'").get(project, highSigResult.id) as any;
    expect(edge).toBeDefined();
    expect(edge.target_id).toBe(activeTask.id);
  });

  it('always creates graph node for gated decisions regardless of significance', () => {
    const gatedResult: any = nodeHandlers.manage_nodes({
      action: 'create',
      project,
      type: 'decision',
      title: 'Gated Action Turn',
      status: 'accepted',
      metadata: {
        significance: 0.35,
        reasoning_tier: 'L1',
        token_id: 'tok-12345',
      },
    });

    expect(gatedResult.status).toBe('accepted');
    const db = getDb(project);
    const createdNode = db.prepare('SELECT * FROM nodes WHERE project = ? AND id = ?').get(project, gatedResult.id);
    expect(createdNode).toBeDefined();
  });

  it('interleaves decision events into exportJointTrajectories with step index', async () => {
    // Log a fast decision event
    const res: any = nodeHandlers.manage_nodes({
      action: 'create',
      project,
      type: 'decision',
      title: 'Action Jump',
      status: 'accepted',
      metadata: {
        significance: 0.5,
        reasoning_tier: 'L1',
        cache_hit: true,
        state_pack_hash: 'pack-hash-123',
      },
    });

    const joint = await SynergyEngine.exportJointTrajectories({ project });
    expect(joint.steps.length).toBeGreaterThan(0);
    const decisionStep = joint.steps.find((s: any) => s.decision);
    expect(decisionStep).toBeDefined();
    expect(decisionStep.step).toBe(1);
    expect(decisionStep.decision.action).toBe('Action Jump');
    expect(decisionStep.decision.tier).toBe('L1');
    expect(decisionStep.decision.pack_hash).toBe('pack-hash-123');
  });
});
