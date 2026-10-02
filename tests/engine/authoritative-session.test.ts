import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeAllDbs } from '../../src/engine/db.js';
import { SessionEngine } from '../../src/engine/sessions.js';
import { bootstrapSession } from '../../src/engine/bootstrap.js';
import { leaseBlackboard } from '../../src/engine/blackboard.js';
import { EventEngine } from '../../src/engine/events.js';
import { calculateSpecCompliance } from '../../src/engine/spec-compliance.js';
import { GraphEngine } from '../../src/engine/graph.js';
import { EdgeEngine } from '../../src/engine/edges.js';

describe('Authoritative Session Minting, Intention Leases, and Multimodal Verification', () => {
  const project = 'authoritative-session-test';

  beforeEach(() => {
    const db = getDb(project);
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM nodes').run();
    db.prepare('DELETE FROM edges').run();
    db.prepare('DELETE FROM blackboard').run();
  });

  afterAll(() => {
    closeAllDbs();
  });

  it('should reuse existing active session for same agent_id and return session_reused: true', () => {
    const db = getDb(project);

    const s1 = SessionEngine.startSession(db, {
      project,
      agent_id: 'pentad-agent-alpha',
    });
    expect(s1.session_id).toBeDefined();
    expect(s1.session_reused).toBe(false);

    // Call startSession again with same agent_id
    const s2 = SessionEngine.startSession(db, {
      project,
      agent_id: 'pentad-agent-alpha',
    });
    expect(s2.session_id).toBe(s1.session_id);
    expect(s2.session_reused).toBe(true);
  });

  it('should bootstrapSession and return authoritative session with task slice and handles', () => {
    const db = getDb(project);

    // Create a task with spatial and visual edges
    const task = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Inspect target zone',
      status: 'pending',
    });

    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: 'entity_waypoint_09',
      type: 'link_spatial' as any,
    });

    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: 'vs_viewport_3',
      type: 'renders_state',
    });

    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: 'int_survey_area',
      type: 'link_intention' as any,
    });

    const bootRes = bootstrapSession({
      project,
      agent_id: 'coordinator-agent',
    });

    expect(bootRes.session_id).toBeDefined();
    expect(bootRes.session_reused).toBe(false);
    expect(bootRes.task_slice).toBeDefined();
    expect(bootRes.spatial_slice_handle).toBe('spatial:entity_waypoint_09');
    expect(bootRes.visual_slice_handle).toBe('visual:vs_viewport_3');
    expect(bootRes.active_intention?.id).toBe('int_survey_area');

    // Second bootstrap call should reuse session
    const bootRes2 = bootstrapSession({
      project,
      agent_id: 'coordinator-agent',
    });
    expect(bootRes2.session_id).toBe(bootRes.session_id);
    expect(bootRes2.session_reused).toBe(true);
  });

  it('should manage intention-keyed leases and handle lease_denied gracefully', () => {
    // Agent 1 acquires lease on resource with intention_id
    const lease1 = leaseBlackboard({
      project,
      resource_id: 'entity:door_control_panel',
      agent_id: 'agent_worker_1',
      intention_id: 'int_unlock_panel',
      duration_seconds: 60,
    });

    expect(lease1.success).toBe(true);

    // Agent 2 attempts to acquire lease on same resource -> lease_denied
    const lease2 = leaseBlackboard({
      project,
      resource_id: 'entity:door_control_panel',
      agent_id: 'agent_worker_2',
      intention_id: 'int_bypass_panel',
      duration_seconds: 60,
    });

    expect(lease2.success).toBe(false);
    expect(lease2.lease_denied).toBe(true);
    expect(lease2.holder).toBe('agent_worker_1');

    // Agent 1 releases lease using intention_id
    const releaseRes = leaseBlackboard({
      project,
      resource_id: 'entity:door_control_panel',
      agent_id: 'agent_worker_1',
      intention_id: 'int_unlock_panel',
      mode: 'release',
    });

    expect(releaseRes.success).toBe(true);

    // Agent 2 can now acquire lease
    const lease3 = leaseBlackboard({
      project,
      resource_id: 'entity:door_control_panel',
      agent_id: 'agent_worker_2',
      duration_seconds: 30,
    });

    expect(lease3.success).toBe(true);
  });

  it('should ingest off-tick outcome batches via EventEngine.ingestFromTick and index by pack_hash', () => {
    const db = getDb(project);

    const outcomes = [
      {
        task_id: 'task_001',
        leaf: 'leaf_move_to_point',
        status: 'success',
        result: { arrived: true },
        pack_hash: 'sha256:pack_abcdef012345',
        token_id: 'tok_998877',
      },
      {
        task_id: 'task_002',
        leaf: 'leaf_scan_horizon',
        status: 'failure',
        error: 'target_obscured',
        pack_hash: 'sha256:pack_abcdef012345',
      },
    ];

    const result = EventEngine.ingestFromTick(db, {
      project,
      session_id: 'sess_tick_01',
      batch: outcomes,
    });

    expect(result.success).toBe(true);
    expect(result.ingested_count).toBe(2);
    expect(result.pack_hashes).toContain('sha256:pack_abcdef012345');

    // Verify events were stored and indexed
    const rows = db
      .prepare(
        "SELECT entity_id, metadata FROM events WHERE project = ? AND json_extract(metadata, '$.pack_hash') = ?"
      )
      .all(project, 'sha256:pack_abcdef012345') as any[];

    expect(rows).toHaveLength(2);
  });

  it('should evaluate calculateSpecCompliance with visual_spec_hash and spatial_proof_hash', () => {
    const db = getDb(project);

    // Create a spec and requirement
    const spec = GraphEngine.addNode({
      project,
      type: 'spec',
      title: 'Navigation SDD',
    });

    const req = GraphEngine.addNode({
      project,
      type: 'requirement',
      title: 'Arrive safely at waypoint',
      metadata: { spec_id: spec.id },
    });

    const crit = GraphEngine.addNode({
      project,
      type: 'acceptance_criterion',
      title: 'Obstacle clearance > 0.5m verified',
      status: 'verified',
      metadata: { requirement_id: req.id },
    });

    // Add an artifact holding the proof hashes
    GraphEngine.addNode({
      project,
      type: 'artifact',
      title: 'Navigation Evidence Pack',
      metadata: {
        visual_spec_hash: 'sha256:vis_spec_hash_123',
        spatial_proof_hash: 'sha256:spat_proof_hash_456',
      },
    });

    // Link requirement as satisfied
    const task = GraphEngine.addNode({
      project,
      type: 'task',
      title: 'Execute navigation',
      status: 'done',
    });

    EdgeEngine.addEdge({
      project,
      source_id: task.id,
      target_id: req.id,
      type: 'satisfies',
    });

    const report = calculateSpecCompliance(db, project, {
      visual_spec_hash: 'sha256:vis_spec_hash_123',
      spatial_proof_hash: 'sha256:spat_proof_hash_456',
    });

    expect(report.is_compliant).toBe(true);
    expect(report.visual_spec_verified).toBe(true);
    expect(report.spatial_proof_verified).toBe(true);

    // If an unknown proof hash is passed, compliance fails
    const reportFail = calculateSpecCompliance(db, project, {
      spatial_proof_hash: 'sha256:non_existent_proof',
    });

    expect(reportFail.is_compliant).toBe(false);
    expect(reportFail.spatial_proof_verified).toBe(false);
  });
});
