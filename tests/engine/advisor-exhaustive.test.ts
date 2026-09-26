import { describe, it, expect } from 'vitest';
import {
  TOOL_ACTION_REGISTRY,
  resolveAction,
  generateToolActionGuidance,
} from '../../src/engine/advisor.js';

describe('Exhaustive Advisor & Self-Healing Action Resolver Suite', () => {
  it('covers all tools, actions, and aliases in TOOL_ACTION_REGISTRY', () => {
    for (const [toolName, toolMeta] of Object.entries(TOOL_ACTION_REGISTRY)) {
      expect(toolMeta.tool).toBe(toolName);
      expect(typeof toolMeta.description).toBe('string');
      expect(Object.keys(toolMeta.actions).length).toBeGreaterThan(0);

      for (const [actionName, actionMeta] of Object.entries(toolMeta.actions)) {
        // 1. Direct match
        const direct = resolveAction(toolName, actionName);
        expect(direct.action).toBe(actionName);
        expect(direct.inferred).toBe(false);

        // Case insensitivity & trimming
        const mixed = resolveAction(toolName, `  ${actionName.toUpperCase()}  `);
        expect(mixed.action).toBe(actionName);
        expect(mixed.inferred).toBe(false);

        // 2. Aliases
        if (actionMeta.aliases) {
          for (const alias of actionMeta.aliases) {
            const aliasRes = resolveAction(toolName, alias);
            expect(aliasRes.action).toBe(actionName);
            expect(aliasRes.inferred).toBe(true);

            const aliasMixed = resolveAction(toolName, `  ${alias.toUpperCase()}  `);
            expect(aliasMixed.action).toBe(actionName);
            expect(aliasMixed.inferred).toBe(true);
          }
        }

        // Validate metadata structure
        expect(typeof actionMeta.description).toBe('string');
        expect(actionMeta.example).toBeDefined();
        expect(actionMeta.example.action).toBeDefined();
      }
    }
  });

  it('covers inferAction logic across all tools with inferAction', () => {
    // manage_nodes
    expect(resolveAction('manage_nodes', undefined, { type: 'task', title: 'Test' }).action).toBe('create');
    expect(resolveAction('manage_nodes', undefined, { id: '01...', status: 'done' }).action).toBe('update');
    expect(resolveAction('manage_nodes', undefined, { id: '01...' }).action).toBe('get');
    expect(resolveAction('manage_nodes', undefined, { query: 'search terms' }).action).toBe('search');
    expect(resolveAction('manage_nodes', undefined, { text: 'Quick note' }).action).toBe('add_note');
    expect(resolveAction('manage_nodes', undefined, { nodes: [{ title: 'A' }] }).action).toBe('batch_create');
    expect(resolveAction('manage_nodes', undefined, { ids: ['01...'], status: 'done' }).action).toBe('batch_update');
    expect(resolveAction('manage_nodes', undefined, { type: 'task' }).action).toBe('list');

    // manage_edges
    expect(resolveAction('manage_edges', undefined, { edges: [{ source_id: 'a', target_id: 'b' }] }).action).toBe('batch_add');
    expect(resolveAction('manage_edges', undefined, { visual_state_id: 'v_1' }).action).toBe('link_visual');
    expect(resolveAction('manage_edges', undefined, { source_id: 'a', target_id: 'b', type: 'blocks' }).action).toBe('add');
    expect(resolveAction('manage_edges', undefined, {}).action).toBeNull();

    // manage_sessions
    expect(resolveAction('manage_sessions', undefined, { agent_id: 'agent_1' }).action).toBe('start');
    expect(resolveAction('manage_sessions', undefined, { session_id: 's_1', finish: true }).action).toBe('end');
    expect(resolveAction('manage_sessions', undefined, { task_limit: 5 }).action).toBe('bootstrap');
    expect(resolveAction('manage_sessions', undefined, {}).action).toBeNull();

    // manage_tasks
    expect(resolveAction('manage_tasks', undefined, { task_id: 't_1' }).action).toBe('complete');
    expect(resolveAction('manage_tasks', undefined, { decision_id: 'd_1' }).action).toBe('find_blocked');
    expect(resolveAction('manage_tasks', undefined, { node_id: 'n_1' }).action).toBe('find_blockers');
    expect(resolveAction('manage_tasks', undefined, { query: 'q' }).action).toBe('find_similar_blockers');
    expect(resolveAction('manage_tasks', undefined, { older_than: '10d', target_status: 'archived' }).action).toBe('auto_prune');
    expect(resolveAction('manage_tasks', undefined, { older_than: '10d' }).action).toBe('find_stale');
    expect(resolveAction('manage_tasks', undefined, {}).action).toBe('next');

    // manage_snapshots
    expect(resolveAction('manage_snapshots', undefined, { snapshot_id_a: 'a', snapshot_id_b: 'b' }).action).toBe('diff');
    expect(resolveAction('manage_snapshots', undefined, { snapshot_a: 'a', snapshot_b: 'b' }).action).toBe('diff');
    expect(resolveAction('manage_snapshots', undefined, { timestamp: 1234, revert: true }).action).toBe('revert');
    expect(resolveAction('manage_snapshots', undefined, { timestamp: 1234 }).action).toBe('get_state');
    expect(resolveAction('manage_snapshots', undefined, { node_id: 'n_1', history: true }).action).toBe('get_history');
    expect(resolveAction('manage_snapshots', undefined, { node_id: 'n_1' }).action).toBe('undo');
    expect(resolveAction('manage_snapshots', undefined, {}).action).toBeNull();

    // manage_specs
    expect(resolveAction('manage_specs', undefined, { criterion_id: 'c_1' }).action).toBe('verify');
    expect(resolveAction('manage_specs', undefined, { spec_id: 's_1' }).action).toBe('export');
    expect(resolveAction('manage_specs', undefined, { file_path: 'spec.md' }).action).toBe('ingest');
    expect(resolveAction('manage_specs', undefined, { subtasks: ['s1'] }).action).toBe('decompose_feature');
    expect(resolveAction('manage_specs', undefined, { template: 'fdd', name: 'Billing' }).action).toBe('template');
    expect(resolveAction('manage_specs', undefined, { title: 'Spec Title' }).action).toBe('scaffold');
    expect(resolveAction('manage_specs', undefined, {}).action).toBe('compliance');

    // manage_database
    expect(resolveAction('manage_database', undefined, { outputPath: '/tmp/db.bak' }).action).toBe('backup');
    expect(resolveAction('manage_database', undefined, { backupPath: '/tmp/db.bak' }).action).toBe('restore');
    expect(resolveAction('manage_database', undefined, { sourcePath: '/tmp/other.db' }).action).toBe('merge');
    expect(resolveAction('manage_database', undefined, { source_branch: 'feat', target_branch: 'main' }).action).toBe('branch_merge');
    expect(resolveAction('manage_database', undefined, { target_branch: 'main' }).action).toBe('branch_diff');
    expect(resolveAction('manage_database', undefined, {}).action).toBe('audit');

    // manage_data
    expect(resolveAction('manage_data', undefined, { issues: [] }).action).toBe('import_issues');
    expect(resolveAction('manage_data', undefined, { nodes: [], edges: [] }).action).toBe('import_graph');
    expect(resolveAction('manage_data', undefined, { file_path: 'spec.md' }).action).toBe('import_spec');
    expect(resolveAction('manage_data', undefined, { format: 'github' }).action).toBe('export_issues');
    expect(resolveAction('manage_data', undefined, { format: 'joint' }).action).toBe('export_joint_trajectories');
    expect(resolveAction('manage_data', undefined, { format: 'jsonl' }).action).toBe('export_trajectories');
    expect(resolveAction('manage_data', undefined, { synergy: true }).action).toBe('export_synergy_metrics');
    expect(resolveAction('manage_data', undefined, {}).action).toBe('export_graph');

    // query_graph
    expect(resolveAction('query_graph', undefined, { sql: 'SELECT 1' }).action).toBe('raw');
    expect(resolveAction('query_graph', undefined, { root_id: 'n_1' }).action).toBe('subgraph');
    expect(resolveAction('query_graph', undefined, { node_id: 'n_1' }).action).toBe('trace');
    expect(resolveAction('query_graph', undefined, { direction: 'downstream' }).action).toBe('trace');
    expect(resolveAction('query_graph', undefined, { query: 'who blocks?' }).action).toBe('natural_language');
    expect(resolveAction('query_graph', undefined, {}).action).toBeNull();

    // get_analytics
    expect(resolveAction('get_analytics', undefined, { days: 7 }).action).toBe('burndown');
    expect(resolveAction('get_analytics', undefined, { window_days: 14 }).action).toBe('velocity');
    expect(resolveAction('get_analytics', undefined, { milestone_id: 'm_1' }).action).toBe('critical_path');
    expect(resolveAction('get_analytics', undefined, { node_id: 'n_1' }).action).toBe('decision_trail');
    expect(resolveAction('get_analytics', undefined, { artifact_id: 'a_1' }).action).toBe('find_related_decisions');
    expect(resolveAction('get_analytics', undefined, { contradictions: true }).action).toBe('contradictions');
    expect(resolveAction('get_analytics', undefined, { context: true }).action).toBe('context_snapshot');
    expect(resolveAction('get_analytics', undefined, {}).action).toBe('summary');

    // get_events
    expect(resolveAction('get_events', undefined, { since: '1h' }).action).toBe('changelog');
    expect(resolveAction('get_events', undefined, { since_session: 's_1' }).action).toBe('changelog');
    expect(resolveAction('get_events', undefined, { post_mortem: true }).action).toBe('post_mortem');
    expect(resolveAction('get_events', undefined, { report: true }).action).toBe('post_mortem');
    expect(resolveAction('get_events', undefined, {}).action).toBe('log');

    // run_diagnostics
    expect(resolveAction('run_diagnostics', undefined, { auto_heal: true }).action).toBe('check_refs');
    expect(resolveAction('run_diagnostics', undefined, { checks: ['cycles'] }).action).toBe('validate');
    expect(resolveAction('run_diagnostics', undefined, { older_than_days: 30 }).action).toBe('archive');
    expect(resolveAction('run_diagnostics', undefined, { older_than: '90d' }).action).toBe('prune_events');
    expect(resolveAction('run_diagnostics', undefined, {}).action).toBe('validate');

    // use_blackboard
    expect(resolveAction('use_blackboard', undefined, { content: 'hello' }).action).toBe('post');
    expect(resolveAction('use_blackboard', undefined, {}).action).toBe('read');
  });

  it('covers error handling and guidance generation', () => {
    // Unknown tool
    const unknownToolRes = resolveAction('nonexistent_tool', 'create');
    expect(unknownToolRes.action).toBe('create');
    expect(unknownToolRes.inferred).toBe(false);

    const unknownGuidance = generateToolActionGuidance('nonexistent_tool');
    expect(unknownGuidance.error).toContain('Unknown tool');
    expect(unknownGuidance.supported_tools.length).toBeGreaterThan(0);

    // Invalid action on existing tool
    const invalidRes = resolveAction('manage_nodes', 'completely_bogus_action');
    expect(invalidRes.action).toBeNull();
    expect(invalidRes.inferred).toBe(false);
    expect(invalidRes.errorGuidance).toBeDefined();
    expect(invalidRes.errorGuidance?.error).toContain('Invalid action "completely_bogus_action"');
    expect(invalidRes.errorGuidance?.supported_actions.create).toBeDefined();

    // Missing action with empty args that fails inference
    const customTool = {
      tool: 'test_empty_tool',
      description: 'empty',
      actions: {},
    };
    (TOOL_ACTION_REGISTRY as any)['test_empty_tool'] = customTool;
    const missingRes = resolveAction('test_empty_tool', undefined, {});
    expect(missingRes.action).toBeNull();
    expect(missingRes.errorGuidance?.error).toContain('Missing required parameter "action"');
    delete (TOOL_ACTION_REGISTRY as any)['test_empty_tool'];
  });

  it('covers canonicalJsonStringify edge cases', async () => {
    const { canonicalJsonStringify } = await import('../../src/utils/canonical-json.js');
    expect(canonicalJsonStringify(undefined)).toBe('');
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(-0)).toBe('0');
    expect(canonicalJsonStringify([undefined, 1])).toBe('[null,1]');
    expect(canonicalJsonStringify({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(() => canonicalJsonStringify(Infinity)).toThrow('Invalid non-finite number');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify('str')).toBe('"str"');
    expect(canonicalJsonStringify(Symbol('test'))).toBeUndefined();

    // version
    const { VERSION } = await import('../../src/utils/version.js');
    expect(VERSION).toBe('1.3.0');

    // logger
    const { logger } = await import('../../src/utils/logger.js');
    logger.debug('test debug');
    logger.info('test info');
    logger.warn('test warn');
    logger.error('test error');

    // bootstrapSession
    const { bootstrapSession } = await import('../../src/engine/bootstrap.js');
    const bootRes = bootstrapSession({ project: 'test_coverage_p', task_limit: 3 });
    expect(bootRes.session_id).toBeDefined();

    // completeTask error
    const { completeTask } = await import('../../src/engine/complete-task.js');
    expect(() => completeTask({ project: 'test_coverage_p', task_id: 'nonexistent_task_id' })).toThrow('Task not found');

    // legacy tool resolve
    const { translateLegacyCall } = await import('../../src/tools/compat-shim.js');
    const resolvedLegacy = translateLegacyCall('impact_analysis', { root_id: '01...' });
    expect(resolvedLegacy.tool).toBe('query_graph');
    expect(resolvedLegacy.action).toBe('trace');
    expect(resolvedLegacy.transformedArgs.direction).toBe('downstream');

    // staleness & trajectories
    const { parseDuration, getStaleNodes } = await import('../../src/engine/staleness.js');
    expect(parseDuration('1y')).toBe(365 * 24 * 3600 * 1000);
    expect(parseDuration('2d')).toBe(2 * 24 * 3600 * 1000);

    const { getDb } = await import('../../src/engine/db.js');
    const testDb = getDb('test_coverage_p');
    getStaleNodes(testDb, { project: 'test_coverage_p', type: 'task' });

    const { TrajectoryEngine } = await import('../../src/engine/trajectories.js');
    const trajOut = TrajectoryEngine.exportTrajectories(testDb, { project: 'test_coverage_p' });
    expect(typeof trajOut).toBe('string');

    // completeTask with visual state and artifact
    const { GraphEngine } = await import('../../src/engine/graph.js');
    const newTask = GraphEngine.addNode({
      project: 'test_coverage_p',
      type: 'task',
      title: 'Task To Complete',
      status: 'in_progress',
    });
    const completedRes = completeTask({
      project: 'test_coverage_p',
      task_id: newTask.id,
      visual_state_id: 'vs_visual_complete',
      artifact_title: 'Completed Artifact',
    });
    expect(completedRes.task.status).toBe('done');
    expect(completedRes.artifact).toBeDefined();
    expect(completedRes.visual_edge).toBeDefined();

    // compaction
    const { compactGraph } = await import('../../src/engine/compaction.js');
    const compRes = compactGraph({ project: 'test_coverage_p', prune_orphaned_edges: true });
    expect(compRes.database_bytes_after).toBeGreaterThanOrEqual(0);

    // batchUpdate error and limits
    const { batchUpdate, batchCreateNodes, batchAddEdges } = await import('../../src/engine/batch.js');
    const over100Ids = Array.from({ length: 101 }, (_, i) => `id_${i}`);
    expect(() => batchUpdate(testDb, { project: 'test_coverage_p', ids: over100Ids })).toThrow('Cannot update more than 100 nodes');
    expect(() => batchCreateNodes(testDb, { project: 'test_coverage_p', nodes: new Array(101).fill({ type: 'task', title: 't' }) })).toThrow('Cannot create more than 100 nodes');
    expect(() => batchAddEdges(testDb, { project: 'test_coverage_p', edges: new Array(101).fill({ source_id: 'a', target_id: 'b', type: 'depends_on' }) })).toThrow('Cannot add more than 100 edges');

    // schema record and proto tests
    const { z } = await import('../../src/schema/schemas.js');
    const recDef = z.record(z.string()).default({ d: 'val' });
    expect(recDef.parse(undefined)).toEqual({ d: 'val' });
    const recOpt = z.record(z.string()).optional();
    expect(recOpt.parse(undefined)).toBeUndefined();
    expect(() => z.record(z.string()).parse(null)).toThrow('is required');
    const parsedRec = recDef.parse(JSON.parse('{"__proto__": "bad", "ok": "yes"}'));
    expect(parsedRec.ok).toBe('yes');

    const arrMax = z.array(z.string()).max(2, 'too long').default(['def']);
    expect(arrMax.parse(undefined)).toEqual(['def']);
    expect(arrMax.parse(['a'])).toEqual(['a']);
    expect(() => arrMax.parse(['a', 'b', 'c'])).toThrow('too long');
    expect(z.array(z.string()).optional().parse(undefined)).toBeUndefined();
    expect(() => z.array(z.string()).parse(null)).toThrow('is required');

    const objProto = z.object({ normal: z.string() });
    const parsedObj = objProto.parse(JSON.parse('{"__proto__": "bad", "normal": "yes"}'));
    expect(parsedObj.normal).toBe('yes');

    // NativeClient coverage
    const { NativeMcpServer, NativeClient, NativeInMemoryTransport } = await import('../../src/transport/native-mcp.js');
    const server = new NativeMcpServer({ name: 'test-server', version: '1.0.0' });
    server.registerPrompt('p1', { title: 'p1' }, () => ({ messages: [] }));
    server.registerResource('r1', 'res://test', { title: 'r1' }, () => ({ contents: [] }));
    const [cTrans, sTrans] = NativeInMemoryTransport.createLinkedPair();
    await server.connect(sTrans);
    const client = new NativeClient({ name: 'test-client', version: '1.0.0' }, { capabilities: { prompts: {}, resources: {} } });
    await client.connect(cTrans);
    const resList = await client.listResources();
    expect(resList.resources.length).toBeGreaterThan(0);
    await client.readResource({ uri: 'res://test' });
    const promptList = await client.listPrompts();
    expect(promptList.prompts.length).toBeGreaterThan(0);
    await client.getPrompt({ name: 'p1' });
    await client.close();
    await server.close();
  });
});
