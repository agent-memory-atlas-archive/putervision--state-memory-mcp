import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { getDb, getProjectSlug, resolveProjectRoot } from './db.js';
import {
  BaseNode,
  Edge,
  NodeType,
  NodeRow,
  EdgeRow,
  NodeField,
  TaskSlice,
} from '../schema/types.js';
import { parseNodeRow, parseEdgeRow } from './row-mappers.js';
import { getCurrentBranch } from '../utils/git.js';
import { canonicalJsonStringify } from '../utils/canonical-json.js';
import { searchTfidf } from './tfidf.js';
import { logger } from '../utils/logger.js';
import { findSubdirectoryMemoryDbs, SubdirectoryMemoryDb } from './subdirectory-scanner.js';

export function projectNodeFields(node: BaseNode, fields?: NodeField[]): BaseNode {
  if (!fields || fields.length === 0) return node;
  const projected: any = {};
  for (const field of fields) {
    if (field in node) {
      projected[field] = (node as any)[field];
    }
  }
  return projected as BaseNode;
}

/**
 * Engine for querying nodes and subgraphs from the database.
 */
export class QueryEngine {
  /**
   * List nodes with advanced filtering and pagination.
   *
   * @param params - The list filtering and pagination parameters.
   * @param params.project - Optional project identifier.
   * @param params.type - Optional node type to filter by.
   * @param params.status - Optional status to filter by.
   * @param params.tags - Optional array of tags (AND matches).
   * @param params.limit - Optional maximum number of nodes to return.
   * @param params.offset - Optional offset for pagination.
   * @param params.compact - Optional. If true, metadata is excluded.
   * @param params.git_branch - Optional git branch filter.
   * @param params.fields - Optional list of node fields to project.
   * @returns An object containing the list of matching nodes and the total count of matched nodes.
   */
  static async listNodes(params: {
    project?: string;
    subproject?: string;
    type?: NodeType;
    status?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
    compact?: boolean;
    git_branch?: string;
    fields?: NodeField[];
    include_subdirectories?: boolean;
  }): Promise<{ nodes: BaseNode[]; total_count: number }> {
    const projectSlug = getProjectSlug(params.project);
    const db = getDb(projectSlug);

    const columns = params.compact
      ? 'id, type, title, status, project, git_branch, tags, created_at, updated_at'
      : '*';

    const skipRoot =
      params.subproject && params.subproject !== 'root' && params.subproject !== projectSlug;

    const limit = params.limit !== undefined ? params.limit : 50;
    const offset = params.offset !== undefined ? params.offset : 0;
    const perDbLimit = limit + offset;

    let allNodes: BaseNode[] = [];
    let total_count = 0;

    if (!skipRoot) {
      let whereClause = ' WHERE project = ?';
      const queryParams: any[] = [projectSlug];

      const branch = params.git_branch !== undefined ? params.git_branch : getCurrentBranch();
      if (branch && branch !== '*') {
        whereClause += ' AND git_branch = ?';
        queryParams.push(branch);
      }

      if (params.type) {
        whereClause += ' AND type = ?';
        queryParams.push(params.type);
      }

      if (params.status) {
        whereClause += ' AND status = ?';
        queryParams.push(params.status);
      }

      if (params.tags && params.tags.length > 0) {
        for (const tag of params.tags) {
          whereClause += ` AND EXISTS (
            SELECT 1 FROM json_each(nodes.tags) WHERE value = ?
          )`;
          queryParams.push(tag);
        }
      }

      const countSql = `SELECT COUNT(*) as total FROM nodes${whereClause}`;
      const countRow = db.prepare(countSql).get(...queryParams) as any;
      total_count += countRow ? countRow.total : 0;

      const paginatedSql = `SELECT ${columns} FROM nodes${whereClause} ORDER BY created_at DESC LIMIT ?`;
      const rows = db.prepare(paginatedSql).all(...queryParams, perDbLimit) as NodeRow[];
      allNodes.push(...rows.map(parseNodeRow).map((n) => projectNodeFields(n, params.fields)));
    }

    if (params.include_subdirectories && params.subproject !== 'root') {
      try {
        const rootDir = resolveProjectRoot(params.project);
        let subDbs = await findSubdirectoryMemoryDbs(rootDir);
        if (params.subproject) {
          const target = params.subproject.toLowerCase();
          subDbs = subDbs.filter(
            (d) => d.projectSlug.toLowerCase() === target || d.relPath.toLowerCase() === target
          );
        }

        for (const subDb of subDbs) {
          try {
            const subConn = new Database(subDb.dbPath, { readonly: true });
            let subSql = `SELECT ${columns} FROM nodes WHERE 1=1`;
            const subParams: any[] = [];
            if (params.type) {
              subSql += ' AND type = ?';
              subParams.push(params.type);
            }
            if (params.status) {
              subSql += ' AND status = ?';
              subParams.push(params.status);
            }

            const subCountRow = subConn
              .prepare(`SELECT COUNT(*) as total FROM (${subSql})`)
              .get(...subParams) as any;
            total_count += subCountRow ? subCountRow.total : 0;

            subSql += ' ORDER BY created_at DESC LIMIT ?';
            const subRows = subConn.prepare(subSql).all(...subParams, perDbLimit) as NodeRow[];
            for (const r of subRows) {
              const subNode = parseNodeRow(r);
              subNode.metadata = {
                ...subNode.metadata,
                subproject: subDb.projectSlug,
                subproject_path: subDb.relPath,
              };
              if (!subNode.tags.includes(`subproject:${subDb.projectSlug}`)) {
                subNode.tags.push(`subproject:${subDb.projectSlug}`);
              }
              allNodes.push(projectNodeFields(subNode, params.fields));
            }
            subConn.close();
          } catch {}
        }
      } catch {}
    }

    // Global sort by created_at DESC across all databases
    allNodes.sort((a, b) =>
      b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : 0
    );

    // Apply final offset and limit globally
    const paginatedNodes = allNodes.slice(offset, offset + limit);

    return { nodes: paginatedNodes, total_count };
  }

  static async searchNodes(params: {
    project?: string;
    subproject?: string;
    query: string;
    type?: NodeType;
    status?: string;
    limit?: number;
    offset?: number;
    git_branch?: string;
    algorithm?: 'fts' | 'tfidf';
    fields?: NodeField[];
    include_subdirectories?: boolean;
  }): Promise<{ nodes: BaseNode[]; total_count: number }> {
    const projectSlug = getProjectSlug(params.project);
    const db = getDb(projectSlug);

    const skipRoot =
      params.subproject && params.subproject !== 'root' && params.subproject !== projectSlug;
    const limit = params.limit !== undefined ? params.limit : 20;
    const offset = params.offset !== undefined ? params.offset : 0;
    const perDbLimit = limit + offset;

    let subDbs: SubdirectoryMemoryDb[] = [];
    if (params.include_subdirectories && params.subproject !== 'root') {
      try {
        const rootDir = resolveProjectRoot(params.project);
        subDbs = await findSubdirectoryMemoryDbs(rootDir);
        if (params.subproject) {
          const target = params.subproject.toLowerCase();
          subDbs = subDbs.filter(
            (d) => d.projectSlug.toLowerCase() === target || d.relPath.toLowerCase() === target
          );
        }
      } catch {}
    }

    if (params.algorithm === 'tfidf') {
      const MAX_TFIDF_CANDIDATES = 1000;
      let allCandidates: BaseNode[] = [];

      if (!skipRoot) {
        let sql = 'SELECT * FROM nodes WHERE project = ?';
        const queryParams: any[] = [projectSlug];

        const branch = params.git_branch !== undefined ? params.git_branch : getCurrentBranch();
        if (branch && branch !== '*') {
          sql += ' AND git_branch = ?';
          queryParams.push(branch);
        }
        if (params.type) {
          sql += ' AND type = ?';
          queryParams.push(params.type);
        }
        if (params.status) {
          sql += ' AND status = ?';
          queryParams.push(params.status);
        }

        sql += ` LIMIT ${MAX_TFIDF_CANDIDATES + 1}`;
        const rows = db.prepare(sql).all(...queryParams) as NodeRow[];
        if (rows.length > MAX_TFIDF_CANDIDATES) rows.pop();
        allCandidates.push(...rows.map(parseNodeRow));
      }

      for (const subDb of subDbs) {
        try {
          const subConn = new Database(subDb.dbPath, { readonly: true });
          let sql = 'SELECT * FROM nodes WHERE 1=1';
          const queryParams: any[] = [];
          if (params.type) {
            sql += ' AND type = ?';
            queryParams.push(params.type);
          }
          if (params.status) {
            sql += ' AND status = ?';
            queryParams.push(params.status);
          }
          sql += ` LIMIT ${MAX_TFIDF_CANDIDATES + 1}`;
          const subRows = subConn.prepare(sql).all(...queryParams) as NodeRow[];
          if (subRows.length > MAX_TFIDF_CANDIDATES) subRows.pop();

          for (const r of subRows) {
            const subNode = parseNodeRow(r);
            subNode.metadata = {
              ...subNode.metadata,
              subproject: subDb.projectSlug,
              subproject_path: subDb.relPath,
            };
            if (!subNode.tags.includes(`subproject:${subDb.projectSlug}`)) {
              subNode.tags.push(`subproject:${subDb.projectSlug}`);
            }
            allCandidates.push(subNode);
          }
          subConn.close();
        } catch {}
      }

      const matched = searchTfidf(allCandidates, params.query, allCandidates.length);
      const paginated = matched
        .slice(offset, offset + limit)
        .map((n) => projectNodeFields(n, params.fields));

      return { nodes: paginated, total_count: matched.length };
    }

    // FTS algorithm
    const sanitizeFtsQuery = (q: string): string => {
      const truncated = q.slice(0, 500).trim();
      if (!truncated) return '""';
      const tokens = truncated.split(/\s+/).filter(Boolean).slice(0, 50);
      if (tokens.length === 0) return '""';
      return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
    };

    let ftsQuery = params.query;
    let allFtsNodes: (BaseNode & { _rank: number })[] = [];
    let total_count = 0;

    const executeFtsOnDb = (
      conn: Database.Database,
      isRoot: boolean,
      subDb?: SubdirectoryMemoryDb
    ) => {
      let sql = `
        SELECT n.*, nodes_fts.rank as _rank
        FROM nodes n
        JOIN nodes_fts ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?
      `;
      let queryParams: any[] = [ftsQuery];

      if (isRoot) {
        sql += ' AND n.project = ?';
        queryParams.push(projectSlug);

        const branch = params.git_branch !== undefined ? params.git_branch : getCurrentBranch();
        if (branch && branch !== '*') {
          sql += ' AND n.git_branch = ?';
          queryParams.push(branch);
        }
      }

      if (params.type) {
        sql += ' AND n.type = ?';
        queryParams.push(params.type);
      }
      if (params.status) {
        sql += ' AND n.status = ?';
        queryParams.push(params.status);
      }

      const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
      const countRow = conn.prepare(countSql).get(...queryParams) as any;
      total_count += countRow ? countRow.total : 0;

      const paginatedSql = sql + ' ORDER BY _rank ASC LIMIT ?';
      const rows = conn.prepare(paginatedSql).all(...queryParams, perDbLimit) as any[];

      for (const r of rows) {
        const node = parseNodeRow(r);
        if (!isRoot && subDb) {
          node.metadata = {
            ...node.metadata,
            subproject: subDb.projectSlug,
            subproject_path: subDb.relPath,
          };
          if (!node.tags.includes(`subproject:${subDb.projectSlug}`)) {
            node.tags.push(`subproject:${subDb.projectSlug}`);
          }
        }
        allFtsNodes.push({ ...node, _rank: r._rank });
      }
    };

    try {
      if (!skipRoot) {
        executeFtsOnDb(db, true);
      }
      for (const subDb of subDbs) {
        try {
          const subConn = new Database(subDb.dbPath, { readonly: true });
          executeFtsOnDb(subConn, false, subDb);
          subConn.close();
        } catch {}
      }
    } catch (err: any) {
      logger.debug(`FTS search failed, retrying with sanitized FTS terms: ${err.message}`);
      ftsQuery = sanitizeFtsQuery(params.query);
      allFtsNodes = [];
      total_count = 0;
      try {
        if (!skipRoot) executeFtsOnDb(db, true);
        for (const subDb of subDbs) {
          try {
            const subConn = new Database(subDb.dbPath, { readonly: true });
            executeFtsOnDb(subConn, false, subDb);
            subConn.close();
          } catch {}
        }
      } catch (retryErr: any) {
        logger.warn(
          `Sanitized FTS search failed, falling back to TF-IDF search: ${retryErr.message}`
        );
        return QueryEngine.searchNodes({ ...params, algorithm: 'tfidf' });
      }
    }

    allFtsNodes.sort((a, b) => a._rank - b._rank);

    const paginatedNodes = allFtsNodes.slice(offset, offset + limit).map((n) => {
      const { _rank, ...cleanNode } = n;
      return projectNodeFields(cleanNode, params.fields);
    });

    return { nodes: paginatedNodes, total_count };
  }

  /**
   * Get recursive N-hop neighborhood of a root node.
   *
   * @param params - The subgraph query parameters.
   * @param params.project - Optional project identifier.
   * @param params.root_id - The root node ID to traverse from.
   * @param params.depth - The traversal depth limit.
   * @param params.edge_types - Optional array of edge types to follow.
   * @param params.node_types - Optional array of node types to include in results.
   * @param params.fields - Optional list of node fields to project.
   * @returns An object containing nodes and edges within the subgraph.
   */
  static getSubgraph(params: {
    project?: string;
    root_id: string;
    depth?: number;
    edge_types?: string[];
    node_types?: string[];
    fields?: NodeField[];
  }): { nodes: BaseNode[]; edges: Edge[] } {
    const projectSlug = getProjectSlug(params.project);
    const db = getDb(projectSlug);

    const depth = params.depth !== undefined ? params.depth : 2;

    // Verify root node exists
    const rootExists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(params.root_id);
    if (!rootExists) {
      throw new Error(`Root node not found: ${params.root_id}`);
    }

    let edgeTypeFilter = '';
    const recursiveParams: any[] = [params.root_id, params.root_id, depth];

    if (params.edge_types && params.edge_types.length > 0) {
      const placeholders = params.edge_types.map(() => '?').join(',');
      edgeTypeFilter = `AND e.type IN (${placeholders})`;
      recursiveParams.push(...params.edge_types);
    }

    // Recursive CTE to gather node IDs in N hops, avoiding cycles via path tracking
    const idQuery = `
      WITH RECURSIVE neighborhood(node_id, depth, path) AS (
        SELECT ?, 0, ',' || ? || ','
        UNION
        SELECT 
          CASE 
            WHEN e.source_id = n.node_id THEN e.target_id
            ELSE e.source_id
          END,
          n.depth + 1,
          n.path || CASE WHEN e.source_id = n.node_id THEN e.target_id ELSE e.source_id END || ','
        FROM neighborhood n
        JOIN edges e ON (e.source_id = n.node_id OR e.target_id = n.node_id)
        WHERE n.depth < ? ${edgeTypeFilter}
          AND instr(n.path, ',' || CASE WHEN e.source_id = n.node_id THEN e.target_id ELSE e.source_id END || ',') = 0
      )
      SELECT DISTINCT node_id FROM neighborhood
    `;

    const idRows = db.prepare(idQuery).all(...recursiveParams) as any[];
    const nodeIds = idRows.map((r) => r.node_id);

    if (nodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Retrieve the nodes
    let nodeSql = 'SELECT * FROM nodes WHERE id IN (' + nodeIds.map(() => '?').join(',') + ')';
    const nodeQueryParams: any[] = [...nodeIds];

    if (params.node_types && params.node_types.length > 0) {
      nodeSql += ' AND type IN (' + params.node_types.map(() => '?').join(',') + ')';
      nodeQueryParams.push(...params.node_types);
    }

    const nodeRows = db.prepare(nodeSql).all(...nodeQueryParams) as NodeRow[];
    const nodes = nodeRows.map(parseNodeRow).map((n) => projectNodeFields(n, params.fields));

    // Filter nodeIds to those that were actually returned (matching node_types)
    const returnedNodeIds = nodeRows.map(parseNodeRow).map((n) => n.id);

    if (returnedNodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Retrieve all edges connecting these nodes
    const placeholders = returnedNodeIds.map(() => '?').join(',');
    const edgeSql = `
      SELECT * FROM edges 
      WHERE project = ? 
        AND source_id IN (${placeholders}) 
        AND target_id IN (${placeholders})
    `;
    const edgeRows = db
      .prepare(edgeSql)
      .all(projectSlug, ...returnedNodeIds, ...returnedNodeIds) as EdgeRow[];

    const edges = edgeRows.map(parseEdgeRow);

    return { nodes, edges };
  }

  /**
   * Fast compact TaskSlice query for System One fast decision layer.
   */
  static getTaskSlice(params: { project?: string }): TaskSlice {
    const projectSlug = getProjectSlug(params.project);
    const db = getDb(projectSlug);

    // 1. Active task (in_progress)
    const activeTaskRow = db
      .prepare(
        "SELECT * FROM nodes WHERE project = ? AND type = 'task' AND status = 'in_progress' ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectSlug) as NodeRow | undefined;
    const activeTask = activeTaskRow ? parseNodeRow(activeTaskRow) : undefined;

    let active_task_id = activeTask?.id;
    let active_task_title = activeTask?.title;
    let milestone_title: string | undefined = undefined;

    // Parent milestone
    if (activeTask) {
      if (activeTask.metadata && (activeTask.metadata as any).milestone_id) {
        const msRow = db
          .prepare('SELECT title FROM nodes WHERE project = ? AND id = ?')
          .get(projectSlug, (activeTask.metadata as any).milestone_id) as
          { title: string } | undefined;
        if (msRow) milestone_title = msRow.title;
      }
      if (!milestone_title) {
        const edgeMs = db
          .prepare(
            `
            SELECT n.title FROM edges e
            JOIN nodes n ON (n.id = e.target_id OR n.id = e.source_id)
            WHERE e.project = ? AND n.type = 'milestone'
              AND (e.source_id = ? OR e.target_id = ?)
            LIMIT 1
          `
          )
          .get(projectSlug, activeTask.id, activeTask.id) as { title: string } | undefined;
        if (edgeMs) milestone_title = edgeMs.title;
      }
    }

    if (!milestone_title) {
      const activeMs = db
        .prepare(
          "SELECT title FROM nodes WHERE project = ? AND type = 'milestone' AND status IN ('in_progress', 'upcoming') ORDER BY created_at ASC LIMIT 1"
        )
        .get(projectSlug) as { title: string } | undefined;
      if (activeMs) milestone_title = activeMs.title;
    }

    // 2. Pending task count
    const pendingRow = db
      .prepare(
        "SELECT COUNT(*) as count FROM nodes WHERE project = ? AND type = 'task' AND status = 'pending'"
      )
      .get(projectSlug) as { count: number } | undefined;
    const pending_tasks_count = pendingRow ? pendingRow.count : 0;

    // 3. Active blockers
    const blockerRows = db
      .prepare(
        "SELECT id, title, metadata FROM nodes WHERE project = ? AND type = 'blocker' AND status = 'active' LIMIT 10"
      )
      .all(projectSlug) as NodeRow[];
    const blockers = blockerRows.map((r) => {
      let desc = r.title;
      if (r.metadata) {
        try {
          const parsed = JSON.parse(r.metadata);
          if (parsed.description) desc = parsed.description;
        } catch {}
      }
      return { id: r.id, description: desc };
    });

    // 4. Recent decision IDs (last 5)
    const decisionRows = db
      .prepare(
        "SELECT id FROM nodes WHERE project = ? AND type = 'decision' ORDER BY created_at DESC LIMIT 5"
      )
      .all(projectSlug) as Array<{ id: string }>;
    const recent_decision_ids = decisionRows.map((r) => r.id);

    // 5. task_graph_hash = Merkle root or SHA-256 of active tasks/edges
    const activeNodes = db
      .prepare(
        "SELECT id, status, version FROM nodes WHERE project = ? AND status NOT IN ('cancelled', 'archived') ORDER BY id ASC"
      )
      .all(projectSlug) as Array<{ id: string; status: string; version?: number }>;
    const summary = activeNodes.map((n) => ({
      id: n.id,
      s: n.status,
      v: n.version ?? 1,
    }));
    const task_graph_hash = crypto
      .createHash('sha256')
      .update(canonicalJsonStringify(summary))
      .digest('hex');

    return {
      active_task_id,
      active_task_title,
      milestone_title,
      pending_tasks_count,
      blockers,
      recent_decision_ids,
      task_graph_hash,
    };
  }
}
