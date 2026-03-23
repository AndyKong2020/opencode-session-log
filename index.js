import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const LOG_DIRNAME = ".agents-log";
const STATE_VERSION = 1;
const TEXT_INLINE_LIMIT = 6000;
const JSON_INLINE_LIMIT = 3000;
const TOOL_RESULT_INLINE_LIMIT = 4000;
const SUMMARY_TEXT_INLINE_LIMIT = 4000;
const SUMMARY_VALUE_INLINE_LIMIT = 1200;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_RETRY_MS = 80;
const execFile = promisify(execFileCallback);

const RELEVANT_EVENT_TYPES = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.status",
  "session.idle",
  "session.compacted",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
]);

const DEBOUNCED_EVENT_TYPES = new Set([
  "session.updated",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
]);

async function OpencodeSessionLogPlugin(input) {
  const pending = new Map();

  const queueSync = (sessionID, triggerEvent, immediate = false) => {
    if (!sessionID) return;
    const existing = pending.get(sessionID);
    if (existing) {
      clearTimeout(existing.timer);
      existing.triggerEvent = triggerEvent;
      if (immediate) existing.immediate = true;
    }

    const state = existing ?? { triggerEvent, immediate };
    state.triggerEvent = triggerEvent;
    state.immediate = state.immediate || immediate;
    state.timer = setTimeout(async () => {
      pending.delete(sessionID);
      try {
        const snapshot = await buildSnapshotFromClient({
          client: input.client,
          sessionID,
          directory: input.directory,
        });
        if (!snapshot) return;
        await syncOpencodeSessionLogSnapshot({
          projectDir: input.directory,
          snapshot,
          triggerEvent: state.triggerEvent,
        });
      } catch (error) {
        await writePluginError(path.resolve(input.directory, LOG_DIRNAME), error);
      }
    }, state.immediate ? 0 : 150);
    pending.set(sessionID, state);
  };

  return {
    event: async ({ event }) => {
      if (!event || !RELEVANT_EVENT_TYPES.has(event.type)) return;
      const sessionID = extractSessionID(event);
      if (!sessionID) return;
      queueSync(sessionID, event.type, !DEBOUNCED_EVENT_TYPES.has(event.type));
    },
    "tool.execute.after": async (hookInput) => {
      queueSync(hookInput.sessionID, "tool.execute.after", true);
    },
    "experimental.session.compacting": async (hookInput) => {
      queueSync(hookInput.sessionID, "experimental.session.compacting", true);
    },
  };
}

async function buildSnapshotFromClient({ client, sessionID, directory }) {
  const canUseClient =
    typeof client?.session?.get === "function" &&
    typeof client?.session?.messages === "function";
  const snapshot = canUseClient
    ? await collectSessionTree({ client, sessionID, directory, seen: new Set() })
    : null;
  if (snapshot?.session?.id) return snapshot;
  return buildSnapshotFromDatabase({ sessionID, directory });
}

async function collectSessionTree({ client, sessionID, directory, seen }) {
  if (!sessionID || seen.has(sessionID)) return null;
  seen.add(sessionID);

  const session = await fetchData(
    client.session.get(
      { sessionID, directory },
      { responseStyle: "data" },
    ),
  );
  if (!session?.id) return null;

  const messages = await fetchSessionMessages({ client, sessionID, directory });
  const sessionTodoMethod =
    typeof client?.session?.todo === "function"
      ? client.session.todo.bind(client.session)
      : typeof client?.session?.todos === "function"
        ? client.session.todos.bind(client.session)
        : null;
  const todos = sessionTodoMethod
    ? await fetchData(
        sessionTodoMethod(
          { sessionID, directory },
          { responseStyle: "data" },
        ),
      )
    : [];
  const diff = await fetchData(
    client.session.diff(
      { sessionID, directory },
      { responseStyle: "data" },
    ),
  );
  const children = await fetchData(
    client.session.children(
      { sessionID, directory },
      { responseStyle: "data" },
    ),
  );

  const childSnapshots = [];
  for (const child of safeArray(children)) {
    const childID = child?.id;
    if (!childID) continue;
    const childSnapshot = await collectSessionTree({
      client,
      sessionID: childID,
      directory,
      seen,
    });
    if (childSnapshot) childSnapshots.push(childSnapshot);
  }

  return {
    platform: "opencode",
    capturedAt: Date.now(),
    session,
    messages,
    todos: safeArray(todos),
    diff: safeArray(diff),
    children: childSnapshots,
  };
}

async function buildSnapshotFromDatabase({ sessionID, directory }) {
  const rootSessionID = await resolveRootSessionIDFromDb(sessionID);
  if (!rootSessionID) return null;
  const seen = new Set();
  const snapshot = await collectSessionTreeFromDb(rootSessionID, seen);
  if (!snapshot?.session?.id) return null;
  if (directory && !snapshot.session.directory) snapshot.session.directory = directory;
  snapshot.platform = "opencode";
  snapshot.capturedAt = Date.now();
  return snapshot;
}

async function collectSessionTreeFromDb(sessionID, seen) {
  if (!sessionID || seen.has(sessionID)) return null;
  seen.add(sessionID);

  const session = await loadSessionFromDb(sessionID);
  if (!session?.id) return null;

  const [messages, todos, childSessions] = await Promise.all([
    loadMessagesFromDb(sessionID),
    loadTodosFromDb(sessionID),
    loadChildSessionsFromDb(sessionID),
  ]);

  const children = [];
  for (const child of childSessions) {
    const childSnapshot = await collectSessionTreeFromDb(child.id, seen);
    if (childSnapshot) children.push(childSnapshot);
  }

  return {
    platform: "opencode",
    capturedAt: Date.now(),
    session,
    messages,
    todos,
    diff: safeArray(session.summary?.diffs),
    children,
  };
}

async function resolveRootSessionIDFromDb(sessionID) {
  let currentID = sessionID;
  const visited = new Set();
  while (currentID && !visited.has(currentID)) {
    visited.add(currentID);
    const rows = await querySqliteJson(
      `select id, parent_id as parentID from session where id = ${sqlString(currentID)} limit 1;`,
    );
    const row = rows[0];
    if (!row?.id) return null;
    if (!row.parentID) return row.id;
    currentID = row.parentID;
  }
  return currentID || null;
}

async function loadSessionFromDb(sessionID) {
  const rows = await querySqliteJson(
    `select
      id,
      slug,
      project_id as projectID,
      workspace_id as workspaceID,
      directory,
      parent_id as parentID,
      title,
      version,
      share_url as shareURL,
      summary_additions as summaryAdditions,
      summary_deletions as summaryDeletions,
      summary_files as summaryFiles,
      summary_diffs as summaryDiffs,
      time_created as timeCreated,
      time_updated as timeUpdated,
      time_compacting as timeCompacting,
      time_archived as timeArchived,
      permission,
      revert
    from session
    where id = ${sqlString(sessionID)}
    limit 1;`,
  );
  const row = rows[0];
  if (!row?.id) return null;
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.projectID,
    workspaceID: row.workspaceID || undefined,
    directory: row.directory,
    parentID: row.parentID || undefined,
    title: row.title,
    version: row.version,
    summary:
      row.summaryAdditions != null ||
      row.summaryDeletions != null ||
      row.summaryFiles != null ||
      row.summaryDiffs != null
        ? {
            additions: Number(row.summaryAdditions || 0),
            deletions: Number(row.summaryDeletions || 0),
            files: Number(row.summaryFiles || 0),
            diffs: parseJsonValue(row.summaryDiffs, []),
          }
        : undefined,
    share: row.shareURL ? { url: row.shareURL } : undefined,
    time: {
      created: Number(row.timeCreated || 0),
      updated: Number(row.timeUpdated || 0),
      compacting: row.timeCompacting == null ? undefined : Number(row.timeCompacting),
      archived: row.timeArchived == null ? undefined : Number(row.timeArchived),
    },
    permission: parseJsonValue(row.permission, undefined),
    revert: parseJsonValue(row.revert, undefined),
  };
}

async function loadChildSessionsFromDb(sessionID) {
  const rows = await querySqliteJson(
    `select id from session where parent_id = ${sqlString(sessionID)} order by time_created, id;`,
  );
  return rows;
}

async function loadTodosFromDb(sessionID) {
  const rows = await querySqliteJson(
    `select content, status, priority, position, time_created as timeCreated, time_updated as timeUpdated
     from todo
     where session_id = ${sqlString(sessionID)}
     order by position;`,
  );
  return rows.map((row) => ({
    content: row.content,
    status: row.status,
    priority: row.priority,
    position: Number(row.position || 0),
    time: {
      created: Number(row.timeCreated || 0),
      updated: Number(row.timeUpdated || 0),
    },
  }));
}

async function loadMessagesFromDb(sessionID) {
  const [messageRows, partRows] = await Promise.all([
    querySqliteJson(
      `select id, time_created as timeCreated, time_updated as timeUpdated, data
       from message
       where session_id = ${sqlString(sessionID)}
       order by time_created, id;`,
    ),
    querySqliteJson(
      `select id, message_id as messageID, time_created as timeCreated, time_updated as timeUpdated, data
       from part
       where session_id = ${sqlString(sessionID)}
       order by time_created, id;`,
    ),
  ]);

  const partsByMessage = new Map();
  for (const row of partRows) {
    const parsed = parseJsonValue(row.data, {});
    const part = {
      ...parsed,
      id: row.id,
      messageID: row.messageID,
      sessionID,
      time:
        parsed?.time && typeof parsed.time === "object"
          ? parsed.time
          : {
              created: Number(row.timeCreated || 0),
              updated: Number(row.timeUpdated || 0),
            },
    };
    const list = partsByMessage.get(row.messageID) || [];
    list.push(part);
    partsByMessage.set(row.messageID, list);
  }

  return messageRows.map((row) => {
    const parsed = parseJsonValue(row.data, {});
    return {
      info: {
        ...parsed,
        id: row.id,
        sessionID,
        time:
          parsed?.time && typeof parsed.time === "object"
            ? parsed.time
            : {
                created: Number(row.timeCreated || 0),
                updated: Number(row.timeUpdated || 0),
              },
      },
      parts: partsByMessage.get(row.id) || [],
    };
  });
}

async function querySqliteJson(sql) {
  const dbPath = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  const { stdout } = await execFile("sqlite3", ["-json", dbPath, ".timeout 3000", sql]);
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return [];
  return parseJsonValue(trimmed, []);
}

function sqlString(value) {
  return `'${String(value || "").replaceAll("'", "''")}'`;
}

function parseJsonValue(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function fetchSessionMessages({ client, sessionID, directory }) {
  const collected = [];
  let before = undefined;

  while (true) {
    const page = await fetchData(
      client.session.messages(
        { sessionID, directory, limit: 200, before },
        { responseStyle: "data" },
      ),
    );
    const rows = safeArray(page);
    if (!rows.length) break;
    collected.push(...rows);
    if (rows.length < 200) break;
    before = rows.at(-1)?.info?.id;
    if (!before) break;
  }

  const deduped = new Map();
  for (const row of collected) {
    const id = row?.info?.id;
    if (!id) continue;
    deduped.set(id, row);
  }

  return Array.from(deduped.values()).sort((left, right) => {
    return messageCreatedAt(left) - messageCreatedAt(right);
  });
}

async function syncOpencodeSessionLogSnapshot({
  projectDir,
  snapshot,
  triggerEvent = "manual",
}) {
  const rootSession = snapshot?.session;
  if (!rootSession?.id) {
    throw new Error("OpenCode snapshot is missing root session information.");
  }

  const projectRoot = path.resolve(projectDir || rootSession.directory || process.cwd());
  const logRoot = path.join(projectRoot, LOG_DIRNAME);
  const metaRoot = path.join(logRoot, "meta");
  const stateDir = path.join(metaRoot, "state");
  await fs.mkdir(stateDir, { recursive: true });

  return withSessionLock(logRoot, rootSession.id, async () => {
    const statePath = path.join(stateDir, `${rootSession.id}.json`);
    const state = await loadJsonFile(statePath, {});

    const firstTimestampMs = firstKnownTimestampMs(snapshot) ?? Date.now();
    const metaPaths = resolveMetaSessionRelpaths(rootSession.id, firstTimestampMs, state);
    const summaryPaths = await resolveSummaryRelpaths(
      rootSession.id,
      firstTimestampMs,
      state,
      logRoot,
    );

    const metaSessionDir = path.join(logRoot, metaPaths.sessionDirRelpath);
    const summaryRoot = path.join(logRoot, summaryPaths.summaryDirRelpath);
    await fs.mkdir(metaSessionDir, { recursive: true });
    await fs.mkdir(summaryRoot, { recursive: true });

    const buckets = buildAgentBuckets(snapshot);
    const agentSummaryRelpaths = buildSummaryAgentRelpaths(summaryPaths.summaryDirRelpath, buckets);
    const agentMetaRelpaths = buildMetaAgentRelpaths(metaPaths.sessionDirRelpath, buckets);
    const agentOutputPaths = buildAgentOutputPaths(
      logRoot,
      buckets,
      agentSummaryRelpaths,
      agentMetaRelpaths,
    );

    const sessionMetaIndexPath = path.join(logRoot, metaPaths.indexRelpath);
    const mergedMetaPath = path.join(logRoot, metaPaths.mergedRelpath);
    const rootSummaryPath = path.join(logRoot, summaryPaths.summaryRelpath);
    const rootUsagePath = path.join(logRoot, summaryPaths.usageRelpath);
    await fs.mkdir(path.dirname(sessionMetaIndexPath), { recursive: true });
    await fs.mkdir(path.dirname(mergedMetaPath), { recursive: true });
    await fs.mkdir(path.dirname(rootSummaryPath), { recursive: true });

    const sharedArtifactDir = path.join(metaSessionDir, "artifacts", "shared");
    const sharedRenderedDir = path.join(sharedArtifactDir, "rendered");
    await resetDir(sharedRenderedDir);
    const sharedStore = new ArtifactStore(sharedRenderedDir);
    const sharedSnapshotPath = path.join(sharedArtifactDir, "snapshot.json");
    await writeJson(sharedSnapshotPath, snapshot);

    const rootSummaryCtx = createRenderContext(rootSummaryPath, sharedStore);
    const mergedMetaCtx = createRenderContext(mergedMetaPath, sharedStore);
    const metaIndexCtx = createRenderContext(sessionMetaIndexPath, sharedStore);

    const mergedEntries = buildMergedEntries(buckets);
    const rootUsage = buildUsagePayload({
      rootSession,
      bucket: null,
      buckets,
      mergedEntries,
      snapshot,
      triggerEvent,
      summaryPath: rootSummaryPath,
      sessionPath: mergedMetaPath,
      metaIndexPath: sessionMetaIndexPath,
      snapshotPath: sharedSnapshotPath,
    });

    const mergedMarkdown = await buildMetaSessionMarkdown({
      title: decoratePageTitle(rootSession.title || rootSession.id, "merged"),
      rootSession,
      entries: mergedEntries,
      buckets,
      snapshot,
      usagePayload: rootUsage,
      renderCtx: mergedMetaCtx,
      includeSessionSummary: true,
    });
    await writeText(mergedMetaPath, mergedMarkdown);

    const rootSummaryMarkdown = await buildRootSummaryMarkdown({
      rootSession,
      buckets,
      rootUsage,
      renderCtx: rootSummaryCtx,
      mergedMetaPath,
      metaIndexPath: sessionMetaIndexPath,
      rootUsagePath,
      agentOutputPaths,
    });
    await writeText(rootSummaryPath, rootSummaryMarkdown);
    await writeJson(rootUsagePath, rootUsage);

    const sessionMetaIndexMarkdown = await buildSessionMetaIndexMarkdown({
      rootSession,
      buckets,
      rootUsage,
      renderCtx: metaIndexCtx,
      rootSummaryPath,
      rootUsagePath,
      mergedMetaPath,
      globalMetaIndexPath: path.join(metaRoot, "index.md"),
      snapshotPath: sharedSnapshotPath,
      agentOutputPaths,
    });
    await writeText(sessionMetaIndexPath, sessionMetaIndexMarkdown);

    for (const bucket of buckets) {
      const outputPaths = agentOutputPaths[bucket.key];
      await fs.mkdir(path.dirname(outputPaths.summaryPath), { recursive: true });
      await fs.mkdir(path.dirname(outputPaths.metaPath), { recursive: true });

      const agentArtifactDir = path.join(metaSessionDir, "artifacts", bucket.key, "rendered");
      await resetDir(agentArtifactDir);
      const agentStore = new ArtifactStore(agentArtifactDir);
      const agentSummaryCtx = createRenderContext(outputPaths.summaryPath, agentStore);
      const agentMetaCtx = createRenderContext(outputPaths.metaPath, agentStore);

      const agentUsage = buildUsagePayload({
        rootSession,
        bucket,
        buckets,
        mergedEntries,
        snapshot,
        triggerEvent,
        summaryPath: outputPaths.summaryPath,
        sessionPath: outputPaths.metaPath,
        metaIndexPath: sessionMetaIndexPath,
        snapshotPath: sharedSnapshotPath,
      });

      const agentMetaMarkdown = await buildMetaSessionMarkdown({
        title: decoratePageTitle(rootSession.title || rootSession.id, bucket.label),
        rootSession: bucket.session,
        entries: bucket.entries,
        buckets: [bucket],
        snapshot,
        usagePayload: agentUsage,
        renderCtx: agentMetaCtx,
        includeSessionSummary: false,
      });
      await writeText(outputPaths.metaPath, agentMetaMarkdown);

      const agentSummaryMarkdown = await buildAgentSummaryMarkdown({
        title: decoratePageTitle(rootSession.title || rootSession.id, bucket.label),
        rootSession: bucket.session,
        bucket,
        usagePayload: agentUsage,
        renderCtx: agentSummaryCtx,
        metaPath: outputPaths.metaPath,
        metaIndexPath: sessionMetaIndexPath,
        usagePath: outputPaths.usagePath,
      });
      await writeText(outputPaths.summaryPath, agentSummaryMarkdown);
      await writeJson(outputPaths.usagePath, agentUsage);
    }

    const statePayload = buildStatePayload({
      oldState: state,
      rootSession,
      snapshot,
      triggerEvent,
      summaryPaths,
      metaPaths,
      agentSummaryRelpaths,
      agentMetaRelpaths,
      projectRoot,
    });
    await writeJson(statePath, statePayload);

    const globalIndexPath = await writeGlobalIndex(logRoot);
    return {
      sessionID: rootSession.id,
      logRoot,
      summaryPath: rootSummaryPath,
      usagePath: rootUsagePath,
      statePath,
      indexPath: globalIndexPath,
      metaIndexPath: sessionMetaIndexPath,
      mergedMetaPath,
      snapshotPath: sharedSnapshotPath,
    };
  });
}

function buildAgentBuckets(snapshot) {
  const usedKeys = new Set();
  const buckets = [];
  const nodes = flattenSessionNodes(snapshot);

  if (nodes.length) {
    const mainNode = nodes[0];
    buckets.push(
      buildBucket({
        kind: "main",
        label: "main",
        rawID: "main",
        keySeed: "main",
        session: mainNode.session,
        messages: mainNode.messages,
        usedKeys,
      }),
    );
  }

  for (const node of nodes.slice(1)) {
    const label = node.session.title || node.session.slug || node.session.id;
    buckets.push(
      buildBucket({
        kind: "subagent",
        label,
        rawID: node.session.id,
        keySeed: node.session.slug || label || node.session.id,
        session: node.session,
        messages: node.messages,
        usedKeys,
      }),
    );
  }

  return buckets;
}

function buildBucket({ kind, label, rawID, keySeed, session, messages, usedKeys }) {
  const key = createAgentKey(keySeed, kind, usedKeys);
  usedKeys.add(key);
  const entries = messages
    .map((message) => ({
      bucketKey: key,
      bucketLabel: label,
      rawID,
      kind,
      session,
      message,
      timestamp: messageTimestamp(message),
    }))
    .sort((left, right) => left.timestamp - right.timestamp);

  return {
    key,
    label,
    rawID,
    kind,
    session,
    messages,
    entries,
  };
}

function flattenSessionNodes(snapshot) {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of safeArray(node.children)) visit(child);
  };
  visit(snapshot);
  return nodes;
}

function buildMergedEntries(buckets) {
  return buckets
    .flatMap((bucket) => bucket.entries)
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return messageCreatedAt(left.message) - messageCreatedAt(right.message);
    });
}

async function buildRootSummaryMarkdown({
  rootSession,
  buckets,
  rootUsage,
  renderCtx,
  mergedMetaPath,
  metaIndexPath,
  rootUsagePath,
  agentOutputPaths,
}) {
  const lines = [
    `# OpenCode Session: ${rootSession.title || rootSession.id}`,
    "",
    ...bulletLines([
      ["Platform", "opencode"],
      ["Session ID", rootSession.id],
      ["Started at", formatTimestamp(rootSession.time?.created)],
      ["Last event at", rootUsage.session.last_event_at],
      ["Last synced at", rootUsage.session.last_synced_at],
      ["Directory", rootSession.directory],
      ["Version", rootSession.version],
      ["Meta index", markdownLink("Open session meta index", relativeLink(renderCtx.markdownPath, metaIndexPath))],
      ["Merged detail", markdownLink("Open merged detail", relativeLink(renderCtx.markdownPath, mergedMetaPath))],
      ["Usage JSON", markdownLink("Open usage JSON", relativeLink(renderCtx.markdownPath, rootUsagePath))],
    ]),
    "",
    "## Aggregate Usage",
    ...bulletLines([
      ["Input tokens", formatInt(rootUsage.transcript_usage.input_tokens)],
      ["Output tokens", formatInt(rootUsage.transcript_usage.output_tokens)],
      ["Reasoning tokens", formatInt(rootUsage.transcript_usage.reasoning_tokens)],
      ["Cache read tokens", formatInt(rootUsage.transcript_usage.cache_read_input_tokens)],
      ["Cache write tokens", formatInt(rootUsage.transcript_usage.cache_creation_input_tokens)],
      ["Cost USD", formatNumber(rootUsage.session_metrics.cost_usd, 6)],
      ["Duration ms", formatInt(rootUsage.session_metrics.duration_ms_total)],
      ["Models", rootUsage.models.join(", ") || "-"],
      ["Diff files", formatInt(rootUsage.diff_summary.files)],
      ["Diff additions", formatInt(rootUsage.diff_summary.additions)],
      ["Diff deletions", formatInt(rootUsage.diff_summary.deletions)],
    ]),
    "",
    "## Agents",
    "",
  ];

  for (const bucket of buckets) {
    const output = agentOutputPaths[bucket.key];
    const usage = summarizeBucketUsage(bucket);
    lines.push(`### \`${bucket.key}\``);
    lines.push("");
    lines.push(
      ...bulletLines([
        ["Kind", bucket.kind],
        ["Label", bucket.label],
        ["Source session ID", bucket.session.id],
        ["Message count", String(bucket.messages.length)],
        ["Started at", formatTimestamp(bucket.session.time?.created)],
        ["Last event at", formatTimestamp(lastBucketTimestamp(bucket))],
        ["Models", usage.models.join(", ") || "-"],
        ["Summary", markdownLink("Open agent summary", relativeLink(renderCtx.markdownPath, output.summaryPath))],
        ["Usage JSON", markdownLink("Open agent usage", relativeLink(renderCtx.markdownPath, output.usagePath))],
        ["Detailed log", markdownLink("Open agent detail", relativeLink(renderCtx.markdownPath, output.metaPath))],
      ]),
    );
    lines.push("");
  }

  return finalizeMarkdown(lines);
}

async function buildAgentSummaryMarkdown({
  title,
  rootSession,
  bucket,
  usagePayload,
  renderCtx,
  metaPath,
  metaIndexPath,
  usagePath,
}) {
  const lines = [
    `# OpenCode Session: ${title}`,
    "",
    ...bulletLines([
      ["Platform", "opencode"],
      ["Session ID", rootSession.id],
      ["Bucket", bucket.key],
      ["Bucket label", bucket.label],
      ["Started at", formatTimestamp(rootSession.time?.created)],
      ["Last event at", usagePayload.session.last_event_at],
      ["Last synced at", usagePayload.session.last_synced_at],
      ["Directory", rootSession.directory],
      ["Detailed log", markdownLink("Open session detail", relativeLink(renderCtx.markdownPath, metaPath))],
      ["Detailed index", markdownLink("Open meta index", relativeLink(renderCtx.markdownPath, metaIndexPath))],
      ["Usage JSON", markdownLink("Open usage JSON", relativeLink(renderCtx.markdownPath, usagePath))],
    ]),
    "",
    "## Usage",
    ...bulletLines([
      ["Input tokens", formatInt(usagePayload.transcript_usage.input_tokens)],
      ["Output tokens", formatInt(usagePayload.transcript_usage.output_tokens)],
      ["Reasoning tokens", formatInt(usagePayload.transcript_usage.reasoning_tokens)],
      ["Cache read tokens", formatInt(usagePayload.transcript_usage.cache_read_input_tokens)],
      ["Cache write tokens", formatInt(usagePayload.transcript_usage.cache_creation_input_tokens)],
      ["Cost USD", formatNumber(usagePayload.session_metrics.cost_usd, 6)],
      ["Duration ms", formatInt(usagePayload.session_metrics.duration_ms_total)],
      ["Models", usagePayload.models.join(", ") || "-"],
    ]),
    "",
    "## Conversation",
    "",
  ];

  const conversationLines = [];
  let visibleIndex = 0;
  for (const entry of bucket.entries) {
    const rendered = await renderSummaryMessage(entry, renderCtx);
    if (!rendered.length) continue;
    visibleIndex += 1;
    conversationLines.push(
      `### ${String(visibleIndex).padStart(3, "0")}. ${formatTimestamp(entry.timestamp)} ${summaryActorLabel(entry)}`,
      "",
      ...rendered,
      "",
    );
  }

  if (!conversationLines.length) {
    lines.push("_No user or assistant content was captured for this session yet._", "");
  } else {
    lines.push(...conversationLines);
  }

  return finalizeMarkdown(lines);
}

async function buildMetaSessionMarkdown({
  title,
  rootSession,
  entries,
  buckets,
  snapshot,
  usagePayload,
  renderCtx,
  includeSessionSummary,
}) {
  const lines = [
    `# OpenCode Session: ${title}`,
    "",
    "## Session Metadata",
    ...bulletLines([
      ["Platform", "opencode"],
      ["Session ID", rootSession.id],
      ["Directory", rootSession.directory],
      ["Parent session", rootSession.parentID],
      ["Version", rootSession.version],
      ["Started at", formatTimestamp(rootSession.time?.created)],
      ["Last event at", usagePayload.session.last_event_at],
      ["Last synced at", usagePayload.session.last_synced_at],
      ["Models", usagePayload.models.join(", ") || "-"],
    ]),
    "",
    "## Counts",
    ...bulletLines([
      ["Messages", String(usagePayload.counts.messages)],
      ["Assistant messages", String(usagePayload.counts.assistant_messages)],
      ["User messages", String(usagePayload.counts.user_messages)],
      ["Parts", String(usagePayload.counts.parts)],
      ["Agents", String(usagePayload.counts.agents)],
    ]),
    "",
    "## Usage",
    ...bulletLines([
      ["Input tokens", formatInt(usagePayload.transcript_usage.input_tokens)],
      ["Output tokens", formatInt(usagePayload.transcript_usage.output_tokens)],
      ["Reasoning tokens", formatInt(usagePayload.transcript_usage.reasoning_tokens)],
      ["Cache read tokens", formatInt(usagePayload.transcript_usage.cache_read_input_tokens)],
      ["Cache write tokens", formatInt(usagePayload.transcript_usage.cache_creation_input_tokens)],
      ["Cost USD", formatNumber(usagePayload.session_metrics.cost_usd, 6)],
      ["Duration ms", formatInt(usagePayload.session_metrics.duration_ms_total)],
    ]),
    "",
  ];

  if (includeSessionSummary && snapshot?.session?.summary) {
    lines.push(
      "## Session Diff Summary",
      ...bulletLines([
        ["Files", formatInt(snapshot.session.summary.files)],
        ["Additions", formatInt(snapshot.session.summary.additions)],
        ["Deletions", formatInt(snapshot.session.summary.deletions)],
      ]),
      "",
    );
  }

  lines.push("## Timeline", "");
  if (!entries.length) {
    lines.push("_No timeline entries were captured for this session yet._", "");
  } else {
    let index = 0;
    for (const entry of entries) {
      index += 1;
      lines.push(
        `### ${String(index).padStart(3, "0")}. ${formatTimestamp(entry.timestamp)} ${detailedActorLabel(entry)}`,
        "",
      );
      lines.push(...renderDetailedMessageMetadata(entry), "");
      const partLines = await renderDetailedParts(entry, renderCtx);
      if (partLines.length) {
        lines.push(...partLines, "");
      }
    }
  }

  if (buckets.length > 1) {
    lines.push("## Agent Buckets", "");
    for (const bucket of buckets) {
      lines.push(
        `### \`${bucket.key}\``,
        "",
        ...bulletLines([
          ["Kind", bucket.kind],
          ["Label", bucket.label],
          ["Source session ID", bucket.session.id],
          ["Message count", String(bucket.messages.length)],
        ]),
        "",
      );
    }
  }

  return finalizeMarkdown(lines);
}

async function buildSessionMetaIndexMarkdown({
  rootSession,
  buckets,
  rootUsage,
  renderCtx,
  rootSummaryPath,
  rootUsagePath,
  mergedMetaPath,
  globalMetaIndexPath,
  snapshotPath,
  agentOutputPaths,
}) {
  const lines = [
    `# OpenCode Session: ${rootSession.title || rootSession.id} Meta Index`,
    "",
    ...bulletLines([
      ["Platform", "opencode"],
      ["Session ID", rootSession.id],
      ["Started at", formatTimestamp(rootSession.time?.created)],
      ["Last event at", rootUsage.session.last_event_at],
      ["Last synced at", rootUsage.session.last_synced_at],
      ["Directory", rootSession.directory],
      ["Version", rootSession.version],
      ["Root summary", markdownLink("Open root summary", relativeLink(renderCtx.markdownPath, rootSummaryPath))],
      ["Root usage", markdownLink("Open root usage JSON", relativeLink(renderCtx.markdownPath, rootUsagePath))],
      ["Merged detail", markdownLink("Open merged detail", relativeLink(renderCtx.markdownPath, mergedMetaPath))],
      ["Global meta index", markdownLink("Open global meta index", relativeLink(renderCtx.markdownPath, globalMetaIndexPath))],
      ["Raw snapshot", markdownLink("Open raw snapshot JSON", relativeLink(renderCtx.markdownPath, snapshotPath))],
      ["Shared rendered artifacts", relativeLink(renderCtx.markdownPath, path.join(path.dirname(snapshotPath), "rendered"))],
    ]),
    "",
    "## Agent Views",
    "",
  ];

  for (const bucket of buckets) {
    const output = agentOutputPaths[bucket.key];
    lines.push(`### \`${bucket.key}\``, "");
    lines.push(
      ...bulletLines([
        ["Kind", bucket.kind],
        ["Label", bucket.label],
        ["Source session ID", bucket.session.id],
        ["Message count", String(bucket.messages.length)],
        ["Summary", markdownLink("Open summary", relativeLink(renderCtx.markdownPath, output.summaryPath))],
        ["Usage JSON", markdownLink("Open usage JSON", relativeLink(renderCtx.markdownPath, output.usagePath))],
        ["Detailed log", markdownLink("Open detail", relativeLink(renderCtx.markdownPath, output.metaPath))],
        ["Rendered artifacts", relativeLink(renderCtx.markdownPath, path.join(path.dirname(path.dirname(output.metaPath)), "..", "artifacts", bucket.key, "rendered"))],
      ]),
      "",
    );
  }

  return finalizeMarkdown(lines);
}

async function renderSummaryMessage(entry, renderCtx) {
  const role = entry.message?.info?.role;
  const parts = safeArray(entry.message?.parts);
  const lines = [];

  for (const [index, part] of parts.entries()) {
    if (!part?.type) continue;
    if (part.type === "reasoning") {
      lines.push(
        ...(await renderTextItem({
          title: "Thinking",
          text: part.text || "",
          renderCtx,
          prefix: `${entry.bucketKey}-summary-reasoning-${entry.message.info.id}-${index + 1}`,
          inlineLimit: SUMMARY_TEXT_INLINE_LIMIT,
        })),
      );
      continue;
    }

    if (part.type === "text") {
      lines.push(
        ...(await renderTextItem({
          title: role === "assistant" ? "Output" : "Message",
          text: part.text || "",
          renderCtx,
          prefix: `${entry.bucketKey}-summary-text-${entry.message.info.id}-${index + 1}`,
          inlineLimit: SUMMARY_TEXT_INLINE_LIMIT,
        })),
      );
      continue;
    }

    if (part.type === "tool") {
      lines.push(...(await renderSummaryToolPart(entry, part, index, renderCtx)));
      continue;
    }

    if (part.type === "file") {
      lines.push(...(await renderSummaryFilePart(entry, part, index, renderCtx)));
      continue;
    }

    if (part.type === "subtask") {
      lines.push(
        `#### Subtask \`${excerpt(part.agent || "agent", 80)}\``,
        ...bulletLines([
          ["Description", excerpt(part.description || "", SUMMARY_VALUE_INLINE_LIMIT)],
          ["Prompt", excerpt(part.prompt || "", SUMMARY_VALUE_INLINE_LIMIT)],
          ["Command", part.command],
          ["Model", formatModelIdentifier(part.model)],
        ]),
        "",
      );
      continue;
    }

    if (part.type === "agent") {
      lines.push(
        `#### Agent`,
        ...bulletLines([
          ["Name", part.name],
          ["Source", part.source?.value ? excerpt(part.source.value, SUMMARY_VALUE_INLINE_LIMIT) : undefined],
        ]),
        "",
      );
    }
  }

  return lines;
}

function renderDetailedMessageMetadata(entry) {
  const info = entry.message?.info || {};
  return bulletLines([
    ["Role", info.role],
    ["Message ID", info.id],
    ["Session ID", info.sessionID || entry.session?.id],
    ["Source bucket", entry.bucketKey],
    ["Source label", entry.bucketLabel],
    ["Parent ID", info.parentID],
    ["Agent", info.agent],
    ["Model", formatModelIdentifier(info)],
    ["Mode", info.mode],
    ["Directory", info.path?.cwd || entry.session?.directory],
    ["Root", info.path?.root],
    ["Cost USD", info.cost != null ? formatNumber(info.cost, 6) : undefined],
    ["Input tokens", formatInt(info.tokens?.input || 0)],
    ["Output tokens", formatInt(info.tokens?.output || 0)],
    ["Reasoning tokens", formatInt(info.tokens?.reasoning || 0)],
    ["Cache read tokens", formatInt(info.tokens?.cache?.read || 0)],
    ["Cache write tokens", formatInt(info.tokens?.cache?.write || 0)],
    ["Finish reason", info.finish],
    ["Completed at", formatTimestamp(info.time?.completed)],
  ]);
}

async function renderDetailedParts(entry, renderCtx) {
  const lines = [];
  const parts = safeArray(entry.message?.parts);
  for (const [index, part] of parts.entries()) {
    if (!part?.type) continue;
    lines.push(`#### Part ${index + 1} \`${part.type}\``);
    lines.push(...(await renderDetailedPart(entry, part, index, renderCtx)));
    lines.push("");
  }
  return lines;
}

async function renderDetailedPart(entry, part, index, renderCtx) {
  if (part.type === "text") {
    return renderTextItem({
      title: "Text",
      text: part.text || "",
      renderCtx,
      prefix: `${entry.bucketKey}-detail-text-${entry.message.info.id}-${index + 1}`,
      inlineLimit: TEXT_INLINE_LIMIT,
    });
  }

  if (part.type === "reasoning") {
    return renderTextItem({
      title: "Reasoning",
      text: part.text || "",
      renderCtx,
      prefix: `${entry.bucketKey}-detail-reasoning-${entry.message.info.id}-${index + 1}`,
      inlineLimit: TEXT_INLINE_LIMIT,
    });
  }

  if (part.type === "tool") {
    return renderDetailedToolPart(entry, part, index, renderCtx);
  }

  if (part.type === "file") {
    return renderDetailedFilePart(entry, part, index, renderCtx);
  }

  if (part.type === "subtask") {
    return [
      ...bulletLines([
        ["Agent", part.agent],
        ["Description", part.description],
        ["Prompt", part.prompt],
        ["Command", part.command],
        ["Model", formatModelIdentifier(part.model)],
      ]),
    ];
  }

  if (part.type === "agent") {
    return [
      ...bulletLines([
        ["Name", part.name],
        ["Source", part.source?.value],
      ]),
    ];
  }

  if (part.type === "step-start") {
    return [...bulletLines([["Snapshot", part.snapshot]])];
  }

  if (part.type === "step-finish") {
    return [
      ...bulletLines([
        ["Reason", part.reason],
        ["Snapshot", part.snapshot],
        ["Cost USD", part.cost != null ? formatNumber(part.cost, 6) : undefined],
        ["Input tokens", formatInt(part.tokens?.input || 0)],
        ["Output tokens", formatInt(part.tokens?.output || 0)],
        ["Reasoning tokens", formatInt(part.tokens?.reasoning || 0)],
        ["Cache read tokens", formatInt(part.tokens?.cache?.read || 0)],
        ["Cache write tokens", formatInt(part.tokens?.cache?.write || 0)],
      ]),
    ];
  }

  if (part.type === "patch") {
    return [
      ...bulletLines([
        ["Hash", part.hash],
        ["Files", safeArray(part.files).join(", ") || "-"],
      ]),
    ];
  }

  if (part.type === "retry") {
    return [
      ...bulletLines([
        ["Attempt", String(part.attempt)],
        ["Created at", formatTimestamp(part.time?.created)],
      ]),
      ...codeBlock(jsonStringify(part.error || {}), "json"),
    ];
  }

  if (part.type === "compaction") {
    return [
      ...bulletLines([
        ["Auto", part.auto != null ? String(part.auto) : undefined],
        ["Overflow", part.overflow != null ? String(part.overflow) : undefined],
      ]),
    ];
  }

  return codeBlock(jsonStringify(part), "json");
}

async function renderSummaryToolPart(entry, part, index, renderCtx) {
  const lines = [
    `#### Tool Call \`${part.tool || "tool"}\``,
    ...bulletLines([
      ["Call ID", part.callID],
      ["Status", part.state?.status],
      ["Title", part.state?.title],
      ["Time started", formatTimestamp(part.state?.time?.start)],
      ["Time ended", formatTimestamp(part.state?.time?.end)],
    ]),
  ];

  if (part.state?.input) {
    const rendered = await renderValueItem({
      title: "Tool Input",
      value: part.state.input,
      renderCtx,
      prefix: `${entry.bucketKey}-summary-tool-input-${entry.message.info.id}-${index + 1}`,
      inlineLimit: SUMMARY_VALUE_INLINE_LIMIT,
    });
    lines.push(...rendered);
  }

  if (typeof part.state?.output === "string") {
    const rendered = await renderTextItem({
      title: `Tool Result \`${part.callID || part.tool || "tool"}\``,
      text: part.state.output,
      renderCtx,
      prefix: `${entry.bucketKey}-summary-tool-output-${entry.message.info.id}-${index + 1}`,
      inlineLimit: TOOL_RESULT_INLINE_LIMIT,
    });
    lines.push(...rendered);
  }

  if (safeArray(part.state?.attachments).length) {
    lines.push(`#### Attachments`, ...renderAttachmentLines(part.state.attachments), "");
  }

  lines.push("");
  return lines;
}

async function renderDetailedToolPart(entry, part, index, renderCtx) {
  const lines = [
    ...bulletLines([
      ["Tool", part.tool],
      ["Call ID", part.callID],
      ["Status", part.state?.status],
      ["Title", part.state?.title],
      ["Time started", formatTimestamp(part.state?.time?.start)],
      ["Time ended", formatTimestamp(part.state?.time?.end)],
    ]),
  ];

  if (part.state?.input) {
    lines.push("##### Tool input", ...codeBlock(jsonStringify(part.state.input), "json"));
  }

  if (typeof part.state?.output === "string") {
    lines.push(
      ...(await renderTextItem({
        title: "Tool output",
        text: part.state.output,
        renderCtx,
        prefix: `${entry.bucketKey}-detail-tool-output-${entry.message.info.id}-${index + 1}`,
        inlineLimit: TOOL_RESULT_INLINE_LIMIT,
      })),
    );
  }

  if (part.state?.metadata) {
    lines.push("##### Tool metadata", ...codeBlock(jsonStringify(part.state.metadata), "json"));
  }

  if (safeArray(part.state?.attachments).length) {
    lines.push("##### Attachments", ...renderAttachmentLines(part.state.attachments));
  }

  return lines;
}

async function renderSummaryFilePart(entry, part, index, renderCtx) {
  const lines = [`#### File`, ...bulletLines(renderFileBulletItems(part))];
  if (isInlineDataUrl(part.url)) {
    const artifactLine = await maybeRenderDataUrlArtifact({
      part,
      renderCtx,
      prefix: `${entry.bucketKey}-summary-file-${entry.message.info.id}-${index + 1}`,
    });
    if (artifactLine) lines.push(artifactLine);
  }
  lines.push("");
  return lines;
}

async function renderDetailedFilePart(entry, part, index, renderCtx) {
  const lines = [...bulletLines(renderFileBulletItems(part))];
  if (isInlineDataUrl(part.url)) {
    const artifactLine = await maybeRenderDataUrlArtifact({
      part,
      renderCtx,
      prefix: `${entry.bucketKey}-detail-file-${entry.message.info.id}-${index + 1}`,
    });
    if (artifactLine) lines.push(artifactLine);
  }
  return lines;
}

function renderFileBulletItems(part) {
  return [
    ["Mime", part.mime],
    ["Filename", part.filename],
    ["URL", part.url && !isInlineDataUrl(part.url) ? part.url : undefined],
    ["Source type", part.source?.type],
    ["Source path", part.source?.path],
    ["Source name", part.source?.name],
    ["Source URI", part.source?.uri],
  ];
}

function renderAttachmentLines(attachments) {
  return safeArray(attachments).flatMap((item) =>
    bulletLines([
      ["Attachment", item.filename || item.url || item.path],
      ["Mime", item.mime],
      ["URL", item.url && !isInlineDataUrl(item.url) ? item.url : undefined],
      ["Source path", item.source?.path],
    ]),
  );
}

async function renderTextItem({ title, text, renderCtx, prefix, inlineLimit }) {
  if (!text) return [];
  if (text.length <= inlineLimit) {
    return [`#### ${title}`, ...blockquote(text), ""];
  }

  const artifactPath = await renderCtx.artifactStore.writeText(prefix, text, "txt");
  return [
    `#### ${title}`,
    `${excerpt(text, inlineLimit)}...`,
    "",
    markdownLink(
      "Open full artifact",
      relativeLink(renderCtx.markdownPath, artifactPath),
    ),
    "",
  ];
}

async function renderValueItem({ title, value, renderCtx, prefix, inlineLimit }) {
  const serialized = jsonStringify(value);
  if (serialized.length <= inlineLimit) {
    return [`#### ${title}`, ...codeBlock(serialized, "json")];
  }

  const artifactPath = await renderCtx.artifactStore.writeText(prefix, serialized, "json");
  return [
    `#### ${title}`,
    markdownLink(
      "Open full artifact",
      relativeLink(renderCtx.markdownPath, artifactPath),
    ),
    "",
  ];
}

async function maybeRenderDataUrlArtifact({ part, renderCtx, prefix }) {
  const decoded = decodeDataUrl(part.url);
  if (!decoded) return null;
  const extension = inferExtensionFromMime(part.mime);
  const artifactPath = await renderCtx.artifactStore.writeBytes(prefix, decoded.data, extension);
  return `- Artifact: ${markdownLink(path.basename(artifactPath), relativeLink(renderCtx.markdownPath, artifactPath))}`;
}

function buildUsagePayload({
  rootSession,
  bucket,
  buckets,
  mergedEntries,
  snapshot,
  triggerEvent,
  summaryPath,
  sessionPath,
  metaIndexPath,
  snapshotPath,
}) {
  const entries = bucket ? bucket.entries : mergedEntries;
  const usage = summarizeEntries(entries);
  const lastEventAt = lastEntryTimestamp(entries) ?? rootSession.time?.updated ?? rootSession.time?.created;
  const diffSummary = bucket
    ? summarizeSessionDiff(bucket.session)
    : summarizeSessionDiff(rootSession);

  const payload = {
    version: 1,
    platform: "opencode",
    session: {
      id: bucket ? bucket.session.id : rootSession.id,
      root_session_id: rootSession.id,
      title: bucket ? bucket.session.title : rootSession.title,
      started_at: formatTimestamp(bucket ? bucket.session.time?.created : rootSession.time?.created),
      last_event_at: formatTimestamp(lastEventAt),
      last_synced_at: formatTimestamp(Date.now()),
      directory: bucket ? bucket.session.directory : rootSession.directory,
      version: bucket ? bucket.session.version : rootSession.version,
      parent_id: bucket ? bucket.session.parentID : rootSession.parentID,
      trigger_event: triggerEvent,
    },
    paths: {
      summary_md: summaryPath,
      session_md: sessionPath,
      meta_index_md: metaIndexPath,
      snapshot_json: snapshotPath,
    },
    models: usage.models,
    counts: {
      messages: entries.length,
      assistant_messages: usage.assistantMessages,
      user_messages: usage.userMessages,
      parts: usage.parts,
      agents: bucket ? 1 : buckets.length,
      child_sessions: bucket ? 0 : flattenSessionNodes(snapshot).length - 1,
    },
    transcript_usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      reasoning_tokens: usage.reasoningTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
      total_tokens: usage.totalTokens,
    },
    session_metrics: {
      cost_usd: usage.costUsd,
      duration_ms_total: usage.durationMs,
      models: usage.models,
      source: "assistant_messages",
    },
    diff_summary: diffSummary,
  };

  if (bucket) {
    payload.agent = {
      id: bucket.rawID,
      key: bucket.key,
      kind: bucket.kind,
      label: bucket.label,
    };
  } else {
    payload.agents = buckets.map((item) => ({
      id: item.rawID,
      key: item.key,
      kind: item.kind,
      label: item.label,
      session_id: item.session.id,
    }));
  }

  return payload;
}

function buildStatePayload({
  oldState,
  rootSession,
  snapshot,
  triggerEvent,
  summaryPaths,
  metaPaths,
  agentSummaryRelpaths,
  agentMetaRelpaths,
  projectRoot,
}) {
  return {
    version: STATE_VERSION,
    platform: "opencode",
    session_id: rootSession.id,
    title: rootSession.title,
    markdown_relpath: metaPaths.indexRelpath,
    merged_markdown_relpath: metaPaths.mergedRelpath,
    summary_dir_relpath: summaryPaths.summaryDirRelpath,
    summary_markdown_relpath: summaryPaths.summaryRelpath,
    usage_relpath: summaryPaths.usageRelpath,
    summary_agents_relpaths: agentSummaryRelpaths,
    meta_agents_relpaths: agentMetaRelpaths,
    directory: rootSession.directory,
    project_root: projectRoot,
    session_started_at: formatTimestamp(rootSession.time?.created),
    last_event_at: formatTimestamp(lastKnownTimestampMs(snapshot)),
    last_synced_at: formatTimestamp(Date.now()),
    trigger_event: triggerEvent,
    child_session_count: flattenSessionNodes(snapshot).length - 1,
    previous_version: oldState?.version,
  };
}

function summarizeEntries(entries) {
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let durationMs = 0;
  let assistantMessages = 0;
  let userMessages = 0;
  let parts = 0;
  const models = new Set();

  for (const entry of entries) {
    const info = entry.message?.info || {};
    const tokens = info.tokens || {};
    parts += safeArray(entry.message?.parts).length;
    if (info.role === "assistant") {
      assistantMessages += 1;
      inputTokens += tokens.input || 0;
      outputTokens += tokens.output || 0;
      reasoningTokens += tokens.reasoning || 0;
      cacheReadTokens += tokens.cache?.read || 0;
      cacheWriteTokens += tokens.cache?.write || 0;
      totalTokens += tokens.total || (tokens.input || 0) + (tokens.output || 0) + (tokens.reasoning || 0) + (tokens.cache?.read || 0) + (tokens.cache?.write || 0);
      costUsd += info.cost || 0;
      if (info.time?.created && info.time?.completed) {
        durationMs += Math.max(0, info.time.completed - info.time.created);
      }
      const model = formatModelIdentifier(info);
      if (model) models.add(model);
    } else if (info.role === "user") {
      userMessages += 1;
      const model = formatModelIdentifier(info.model);
      if (model) models.add(model);
    }
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
    durationMs,
    assistantMessages,
    userMessages,
    parts,
    models: Array.from(models).sort(),
  };
}

function summarizeBucketUsage(bucket) {
  return summarizeEntries(bucket.entries);
}

function summarizeSessionDiff(session) {
  return {
    files: session?.summary?.files || 0,
    additions: session?.summary?.additions || 0,
    deletions: session?.summary?.deletions || 0,
    diffs: safeArray(session?.summary?.diffs),
  };
}

function resolveMetaSessionRelpaths(sessionID, firstTimestampMs, state) {
  const indexRelpath = state?.markdown_relpath;
  const mergedRelpath = state?.merged_markdown_relpath;
  if (
    typeof indexRelpath === "string" &&
    indexRelpath.endsWith("/index.md") &&
    typeof mergedRelpath === "string" &&
    mergedRelpath.endsWith("/session.md")
  ) {
    return {
      sessionDirRelpath: normalizeRelpath(path.dirname(indexRelpath)),
      indexRelpath,
      mergedRelpath,
    };
  }

  const date = new Date(firstTimestampMs);
  const sessionDirRelpath = normalizeRelpath(
    path.join(
      "meta",
      "sessions",
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      sessionID,
    ),
  );
  return {
    sessionDirRelpath,
    indexRelpath: normalizeRelpath(path.join(sessionDirRelpath, "index.md")),
    mergedRelpath: normalizeRelpath(path.join(sessionDirRelpath, "merged", "session.md")),
  };
}

async function resolveSummaryRelpaths(sessionID, firstTimestampMs, state, logRoot) {
  const legacy = discoverExistingSummaryRelpaths;
  if (
    typeof state?.summary_dir_relpath === "string" &&
    typeof state?.summary_markdown_relpath === "string" &&
    typeof state?.usage_relpath === "string"
  ) {
    return {
      summaryDirRelpath: state.summary_dir_relpath,
      summaryRelpath: state.summary_markdown_relpath,
      usageRelpath: state.usage_relpath,
    };
  }

  const existing = await legacy(logRoot, sessionID);
  if (existing) return existing;

  const baseName = formatSummaryDirName(firstTimestampMs);
  const baseRelpath = normalizeRelpath(path.join("summary", baseName));
  const summaryDirRelpath = await ensureUniqueSummaryDirRelpath(logRoot, baseRelpath);
  return {
    summaryDirRelpath,
    summaryRelpath: normalizeRelpath(path.join(summaryDirRelpath, "summary.md")),
    usageRelpath: normalizeRelpath(path.join(summaryDirRelpath, "usage.json")),
  };
}

async function discoverExistingSummaryRelpaths(logRoot, sessionID) {
  const summaryRoot = path.join(logRoot, "summary");
  try {
    const entries = await fs.readdir(summaryRoot, { withFileTypes: true });
    let best = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const usagePath = path.join(summaryRoot, entry.name, "usage.json");
      const payload = await loadJsonFile(usagePath, null);
      if (!payload?.session) continue;
      const candidateSessionID = payload.session.root_session_id || payload.session.id;
      if (candidateSessionID !== sessionID) continue;
      const lastSyncedAt = payload.session.last_synced_at || "";
      const rel = normalizeRelpath(path.join("summary", entry.name));
      const candidate = {
        lastSyncedAt,
        summaryDirRelpath: rel,
        summaryRelpath: normalizeRelpath(path.join(rel, "summary.md")),
        usageRelpath: normalizeRelpath(path.join(rel, "usage.json")),
      };
      if (!best || candidate.lastSyncedAt > best.lastSyncedAt) {
        best = candidate;
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function ensureUniqueSummaryDirRelpath(logRoot, baseRelpath) {
  let candidate = baseRelpath;
  let attempt = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(path.join(logRoot, candidate));
      attempt += 1;
      candidate = `${baseRelpath}-${String(attempt).padStart(2, "0")}`;
    } catch {
      return candidate;
    }
  }
}

function buildSummaryAgentRelpaths(summaryDirRelpath, buckets) {
  const mapping = {};
  for (const bucket of buckets) {
    const dirRelpath = normalizeRelpath(path.join(summaryDirRelpath, "agents", bucket.key));
    mapping[bucket.key] = {
      agent_id: bucket.rawID,
      agent_kind: bucket.kind,
      label: bucket.label,
      summary_markdown_relpath: normalizeRelpath(path.join(dirRelpath, "summary.md")),
      usage_relpath: normalizeRelpath(path.join(dirRelpath, "usage.json")),
    };
  }
  return mapping;
}

function buildMetaAgentRelpaths(metaSessionDirRelpath, buckets) {
  const mapping = {};
  for (const bucket of buckets) {
    const dirRelpath = normalizeRelpath(path.join(metaSessionDirRelpath, "agents", bucket.key));
    mapping[bucket.key] = {
      agent_id: bucket.rawID,
      agent_kind: bucket.kind,
      label: bucket.label,
      markdown_relpath: normalizeRelpath(path.join(dirRelpath, "session.md")),
    };
  }
  return mapping;
}

function buildAgentOutputPaths(logRoot, buckets, summaryRelpaths, metaRelpaths) {
  const output = {};
  for (const bucket of buckets) {
    const summaryInfo = summaryRelpaths[bucket.key];
    const metaInfo = metaRelpaths[bucket.key];
    output[bucket.key] = {
      summaryPath: path.join(logRoot, summaryInfo.summary_markdown_relpath),
      usagePath: path.join(logRoot, summaryInfo.usage_relpath),
      metaPath: path.join(logRoot, metaInfo.markdown_relpath),
    };
  }
  return output;
}

async function writeGlobalIndex(logRoot) {
  const stateDir = path.join(logRoot, "meta", "state");
  const indexPath = path.join(logRoot, "meta", "index.md");
  const states = [];

  try {
    const entries = await fs.readdir(stateDir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const payload = await loadJsonFile(path.join(stateDir, name), null);
      if (payload) states.push(payload);
    }
  } catch {
    // ignore missing state directory
  }

  states.sort((left, right) => {
    const l = left?.last_synced_at || "";
    const r = right?.last_synced_at || "";
    return r.localeCompare(l);
  });

  const lines = [
    "# OpenCode Session Meta Index",
    "",
    "_Detailed and machine-oriented session artifacts._",
    "",
    ...bulletLines([
      ["Updated at", formatTimestamp(Date.now())],
      ["Sessions", String(states.length)],
    ]),
    "",
  ];

  for (const state of states) {
    if (!state?.markdown_relpath) continue;
    const detailPath = path.join(logRoot, state.markdown_relpath);
    lines.push(
      `## ${markdownLink(
        state.title || state.session_id || "Untitled Session",
        relativeLink(indexPath, detailPath),
      )}`,
      "",
      ...bulletLines([
        ["Session ID", state.session_id],
        ["Last synced", state.last_synced_at],
        ["Started at", state.session_started_at],
        ["Directory", state.directory],
        ["Platform", state.platform],
      ]),
      "",
    );
  }

  await writeText(indexPath, finalizeMarkdown(lines));
  return indexPath;
}

async function withSessionLock(logRoot, sessionID, fn) {
  const lockDir = path.join(logRoot, "meta", "locks");
  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${sessionID}.lock`);
  const startedAt = Date.now();

  while (true) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ sessionID, time: startedAt }));
      try {
        return await fn();
      } finally {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
            await fs.rm(lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        throw new Error(`Timed out waiting for session lock: ${sessionID}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function fetchData(promise) {
  const result = await promise;
  if (!result) return undefined;
  if ("data" in result) return result.data;
  return result;
}

function extractSessionID(event) {
  if (!event?.type) return undefined;
  const properties = event.properties || {};
  if (properties.sessionID) return properties.sessionID;
  if (properties.info?.sessionID) return properties.info.sessionID;
  if (properties.info?.id && event.type.startsWith("session.")) return properties.info.id;
  if (properties.part?.sessionID) return properties.part.sessionID;
  return undefined;
}

async function writePluginError(logRoot, error) {
  try {
    await fs.mkdir(logRoot, { recursive: true });
    const target = path.join(logRoot, "plugin-errors.log");
    const lines = [
      `[${new Date().toISOString()}] ${error?.stack || error?.message || String(error)}`,
      "",
    ];
    await fs.appendFile(target, lines.join("\n"), "utf8");
  } catch {
    // ignore
  }
}

async function resetDir(target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
}

async function writeText(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function writeJson(target, value) {
  await writeText(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadJsonFile(target, fallback) {
  try {
    const raw = await fs.readFile(target, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createRenderContext(markdownPath, artifactStore) {
  return { markdownPath, artifactStore };
}

class ArtifactStore {
  constructor(renderArtifactsDir) {
    this.renderArtifactsDir = renderArtifactsDir;
    this.counter = 0;
    this.cache = new Map();
  }

  async writeText(prefix, content, extension = "txt") {
    const cacheKey = `text:${extension}:${hashString(content)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const artifactPath = await this.createArtifactPath(prefix, extension);
    await fs.writeFile(artifactPath, content, "utf8");
    this.cache.set(cacheKey, artifactPath);
    return artifactPath;
  }

  async writeBytes(prefix, content, extension = "bin") {
    const cacheKey = `bytes:${extension}:${hashBuffer(content)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const artifactPath = await this.createArtifactPath(prefix, extension);
    await fs.writeFile(artifactPath, content);
    this.cache.set(cacheKey, artifactPath);
    return artifactPath;
  }

  async createArtifactPath(prefix, extension) {
    this.counter += 1;
    await fs.mkdir(this.renderArtifactsDir, { recursive: true });
    const safePrefix = slugify(prefix).slice(0, 48) || "artifact";
    const safeExtension = (extension || "txt").replace(/^\./, "");
    return path.join(
      this.renderArtifactsDir,
      `${String(this.counter).padStart(3, "0")}-${safePrefix}.${safeExtension}`,
    );
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function messageCreatedAt(message) {
  return Number(message?.info?.time?.created || 0);
}

function messageCompletedAt(message) {
  return Number(message?.info?.time?.completed || message?.info?.time?.created || 0);
}

function messageTimestamp(message) {
  return messageCompletedAt(message) || messageCreatedAt(message) || 0;
}

function firstKnownTimestampMs(snapshot) {
  const nodes = flattenSessionNodes(snapshot);
  let earliest = Number(snapshot?.session?.time?.created || 0) || null;
  for (const node of nodes) {
    const created = Number(node?.session?.time?.created || 0);
    if (created && (earliest == null || created < earliest)) earliest = created;
    for (const message of safeArray(node?.messages)) {
      const timestamp = messageCreatedAt(message);
      if (timestamp && (earliest == null || timestamp < earliest)) earliest = timestamp;
    }
  }
  return earliest;
}

function lastKnownTimestampMs(snapshot) {
  const nodes = flattenSessionNodes(snapshot);
  let latest = Number(snapshot?.session?.time?.updated || snapshot?.session?.time?.created || 0) || null;
  for (const node of nodes) {
    const updated = Number(node?.session?.time?.updated || node?.session?.time?.created || 0);
    if (updated && (latest == null || updated > latest)) latest = updated;
    for (const message of safeArray(node?.messages)) {
      const timestamp = messageTimestamp(message);
      if (timestamp && (latest == null || timestamp > latest)) latest = timestamp;
    }
  }
  return latest;
}

function lastBucketTimestamp(bucket) {
  return lastEntryTimestamp(bucket.entries) || bucket.session?.time?.updated || bucket.session?.time?.created;
}

function lastEntryTimestamp(entries) {
  let latest = 0;
  for (const entry of entries) {
    if (entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest || null;
}

function formatTimestamp(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(Number(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function formatSummaryDirName(timestampMs) {
  const shifted = new Date(Number(timestampMs) + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
}

function formatInt(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function summaryActorLabel(entry) {
  const role = titleCase(entry.message?.info?.role || "unknown");
  if (entry.kind === "subagent") return `${role} [${entry.bucketLabel}]`;
  return role;
}

function detailedActorLabel(entry) {
  const role = titleCase(entry.message?.info?.role || "unknown");
  return `${role}${entry.kind === "subagent" ? ` [${entry.bucketLabel}]` : ""}`;
}

function formatModelIdentifier(value) {
  if (!value) return undefined;
  const providerID = value.providerID || value.provider?.providerID;
  const modelID = value.modelID || value.model?.modelID;
  if (providerID && modelID) return `${providerID}/${modelID}`;
  if (modelID) return modelID;
  return undefined;
}

function excerpt(value, limit) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 3))}...`;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

function createAgentKey(seed, kind, usedKeys) {
  if (kind === "main") return "main";
  let candidate = slugify(seed) || "agent";
  if (candidate === "main") candidate = "agent";
  if (!usedKeys.has(candidate)) return candidate;
  let attempt = 2;
  while (true) {
    const next = `${candidate}-${String(attempt).padStart(2, "0")}`;
    if (!usedKeys.has(next)) return next;
    attempt += 1;
  }
}

function bulletLines(items) {
  return items
    .filter(([, value]) => value != null && value !== "")
    .map(([label, value]) => `- ${label}: ${value}`);
}

function codeBlock(text, language = "") {
  return [`\`\`\`${language}`.trimEnd(), text, "```", ""];
}

function blockquote(text) {
  return String(text || "")
    .split("\n")
    .map((line) => `> ${line}`);
}

function markdownLink(label, href) {
  return `[${label}](${href})`;
}

function relativeLink(fromPath, targetPath) {
  return normalizeRelpath(path.relative(path.dirname(fromPath), targetPath));
}

function normalizeRelpath(value) {
  return String(value).replaceAll(path.sep, "/");
}

function jsonStringify(value) {
  return JSON.stringify(value, null, 2);
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function finalizeMarkdown(lines) {
  return `${lines.map((line) => String(line).replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function decoratePageTitle(title, label) {
  return `${title} [${label}]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashString(value) {
  let hash = 0;
  const input = String(value);
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

function hashBuffer(buffer) {
  let hash = 0;
  for (const byte of buffer) {
    hash = (hash * 31 + byte) >>> 0;
  }
  return hash.toString(16);
}

function isInlineDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:");
}

function decodeDataUrl(value) {
  if (!isInlineDataUrl(value)) return null;
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  const [, mime = "application/octet-stream", base64Marker, payload] = match;
  try {
    const data = base64Marker ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mime, data };
  } catch {
    return null;
  }
}

function inferExtensionFromMime(mime) {
  const normalized = String(mime || "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("svg")) return "svg";
  if (normalized.includes("json")) return "json";
  if (normalized.includes("plain")) return "txt";
  return "bin";
}

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
OpencodeSessionLogPlugin.buildSnapshotFromClient = buildSnapshotFromClient;
OpencodeSessionLogPlugin.syncOpencodeSessionLogSnapshot = syncOpencodeSessionLogSnapshot;
OpencodeSessionLogPlugin.OPENCODE_SESSION_LOG_PLUGIN_DIR = pluginDir;
export default OpencodeSessionLogPlugin;
