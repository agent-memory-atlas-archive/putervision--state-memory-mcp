import { McpError, ErrorCode } from '../utils/errors.js';
import {
  AddNodeSchema,
  UpdateNodeSchema,
  GetNodeSchema,
  RemoveNodeSchema,
  ListNodesSchema,
  SearchNodesSchema,
  BatchCreateNodesSchema,
  BatchUpdateSchema,
  AddNoteSchema,
} from '../schema/schemas.js';
import { GraphEngine } from '../engine/graph.js';
import { QueryEngine } from '../engine/queries.js';
import { EdgeEngine } from '../engine/edges.js';
import { batchCreateNodes, batchUpdate } from '../engine/batch.js';
import { getDb, getProjectSlug } from '../engine/db.js';
import { EventEngine } from '../engine/events.js';
import { parseArgs, suggestLinks, findFuzzyNodeSuggestions } from './helper.js';

export const nodeHandlers = {
  manage_nodes: (args: unknown) => {
    const action = (args as any)?.action;
    if (!action) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Parameter "action" is required for manage_nodes.'
      );
    }

    switch (action) {
      case 'create': {
        const data = parseArgs(AddNodeSchema, args);
        if (data.type === 'decision' && data.metadata) {
          const meta = data.metadata as Record<string, any>;
          const significance = typeof meta.significance === 'number' ? meta.significance : 0.8;
          const tier = meta.reasoning_tier || meta.tier;
          const isCacheHit = Boolean(meta.cache_hit || meta.from_cache);
          const hasToken = Boolean(meta.token_id || meta.dispatch_token);

          // If significance < 0.70 AND was an L1/L2 cache hit AND no dispatch token:
          if (significance < 0.7 && (tier === 'L1' || tier === 'L2' || isCacheHit) && !hasToken) {
            const projectSlug = getProjectSlug(data.project);
            const db = getDb(projectSlug);
            EventEngine.logEvent(db, {
              project: projectSlug,
              event_type: 'fast_decision',
              entity_type: 'decision',
              entity_id: `fast_${Date.now()}`,
              after_state: {
                title: data.title,
                metadata: data.metadata,
                status: data.status || 'accepted',
              },
              metadata: {
                significance,
                reasoning_tier: tier || 'L1',
                cache_hit: true,
                state_pack_hash: meta.state_pack_hash,
              },
            });
            return {
              id: `fast_decision_${Date.now()}`,
              type: 'decision',
              title: data.title,
              status: 'logged_only',
              project: projectSlug,
              metadata: data.metadata,
              tags: data.tags || [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
          }
        }

        const node = GraphEngine.addNode(data);
        suggestLinks(node.project, node);

        // If it's a decision node and metadata has task_id (or active in_progress task), link decided_in edge
        if (node.type === 'decision') {
          try {
            const meta = (node.metadata || {}) as Record<string, any>;
            let targetTaskId = meta.task_id;
            if (!targetTaskId) {
              const db = getDb(node.project);
              const activeTask = db
                .prepare(
                  "SELECT id FROM nodes WHERE project = ? AND type = 'task' AND status = 'in_progress' ORDER BY updated_at DESC LIMIT 1"
                )
                .get(node.project) as { id: string } | undefined;
              if (activeTask) targetTaskId = activeTask.id;
            }
            if (targetTaskId) {
              EdgeEngine.addEdge({
                project: node.project,
                source_id: node.id,
                target_id: targetTaskId,
                type: 'decided_in',
              });
            }
          } catch {
            // Ignore edge collision or missing target
          }
        }

        return node;
      }
      case 'update': {
        const data = parseArgs(UpdateNodeSchema, args);
        const node = GraphEngine.updateNode(data);
        if (!node) {
          const projectSlug = getProjectSlug(data.project);
          const msg = findFuzzyNodeSuggestions(projectSlug, data.id);
          throw new McpError(ErrorCode.InvalidRequest, msg);
        }
        suggestLinks(node.project, node);
        return node;
      }
      case 'get': {
        const data = parseArgs(GetNodeSchema, args);
        const result = GraphEngine.getNode(data);
        if (!result) {
          const projectSlug = getProjectSlug(data.project);
          const msg = findFuzzyNodeSuggestions(projectSlug, data.id);
          throw new McpError(ErrorCode.InvalidRequest, msg);
        }
        return result;
      }
      case 'remove': {
        const data = parseArgs(RemoveNodeSchema, args);
        const result = GraphEngine.removeNode(data);
        if (!result) {
          const projectSlug = getProjectSlug(data.project);
          const msg = findFuzzyNodeSuggestions(projectSlug, data.id);
          throw new McpError(ErrorCode.InvalidRequest, msg);
        }
        return result;
      }
      case 'list': {
        const data = parseArgs(ListNodesSchema, args);
        return QueryEngine.listNodes(data);
      }
      case 'search': {
        const data = parseArgs(SearchNodesSchema, args);
        return QueryEngine.searchNodes(data);
      }
      case 'batch_create': {
        const data = parseArgs(BatchCreateNodesSchema, args);
        const projectSlug = getProjectSlug(data.project);
        const db = getDb(projectSlug);
        return batchCreateNodes(db, {
          project: projectSlug,
          nodes: data.nodes,
        });
      }
      case 'batch_update': {
        const data = parseArgs(BatchUpdateSchema, args);
        const projectSlug = getProjectSlug(data.project);
        const db = getDb(projectSlug);
        return batchUpdate(db, {
          project: projectSlug,
          ids: data.ids,
          status: data.status,
          metadata: data.metadata,
          tags: data.tags,
        });
      }
      case 'add_note': {
        const data = parseArgs(AddNoteSchema, args);
        const projectSlug = getProjectSlug(data.project);
        const db = getDb(projectSlug);
        return db.transaction(() => {
          const node = GraphEngine.addNode({
            project: projectSlug,
            type: 'observation',
            title: data.text.slice(0, 200),
            metadata: { full_text: data.text },
            tags: data.tags,
          });
          if (data.attach_to) {
            EdgeEngine.addEdge({
              project: projectSlug,
              source_id: node.id,
              target_id: data.attach_to,
              type: 'references',
            });
          }
          return node;
        })();
      }
      default:
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid action "${action}" for manage_nodes. Supported actions: create, update, get, remove, list, search, batch_create, batch_update, add_note.`
        );
    }
  },
};
