import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import OpencodeSessionLogPlugin from "../index.js";

const { syncOpencodeSessionLogSnapshot } = OpencodeSessionLogPlugin;
const { parseSqliteTabularJson, shouldFallbackSqliteFormat, parseOpencodeExport, normalizeExportedSnapshot } =
  OpencodeSessionLogPlugin.__testOnly();

function makeSnapshot(workspace, overrides = {}) {
  const longToolOutput = overrides.longToolOutput ?? null;
  const rootSession = {
    id: "ses_root",
    slug: "audit-root",
    projectID: "proj_1",
    directory: workspace,
    title: "Audit root session",
    version: "1.2.27",
    time: {
      created: 1773890591755,
      updated: 1773890636393,
    },
    summary: {
      additions: 20,
      deletions: 0,
      files: 2,
    },
  };

  const childSession = {
    id: "ses_child",
    slug: "agent-helper",
    projectID: "proj_1",
    directory: workspace,
    parentID: "ses_root",
    title: "agent-helper",
    version: "1.2.27",
    time: {
      created: 1773890600000,
      updated: 1773890615000,
    },
    summary: {
      additions: 0,
      deletions: 0,
      files: 0,
    },
  };

  return {
    platform: "opencode",
    capturedAt: 1773890637000,
    session: rootSession,
    todos: [],
    diff: [],
    messages: [
      {
        info: {
          id: "msg_user_1",
          sessionID: "ses_root",
          role: "user",
          time: { created: 1773890591755 },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
        parts: [
          {
            id: "prt_user_text_1",
            sessionID: "ses_root",
            messageID: "msg_user_1",
            type: "text",
            text: "Please audit the project and keep a detailed running log.",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_1",
          sessionID: "ses_root",
          role: "assistant",
          parentID: "msg_user_1",
          time: {
            created: 1773890591763,
            completed: 1773890597442,
          },
          modelID: "big-pickle",
          providerID: "opencode",
          mode: "build",
          agent: "build",
          path: {
            cwd: workspace,
            root: workspace,
          },
          cost: 0.012345,
          tokens: {
            total: 13573,
            input: 78,
            output: 187,
            reasoning: 12,
            cache: {
              read: 510,
              write: 12798,
            },
          },
          finish: "tool-calls",
        },
        parts: [
          {
            id: "prt_reasoning_1",
            sessionID: "ses_root",
            messageID: "msg_assistant_1",
            type: "reasoning",
            text: "I should inspect the repository and use tools carefully.",
            time: {
              start: 1773890591800,
              end: 1773890591900,
            },
          },
          {
            id: "prt_text_1",
            sessionID: "ses_root",
            messageID: "msg_assistant_1",
            type: "text",
            text: "I will inspect the repository and keep track of the findings.",
          },
          {
            id: "prt_tool_1",
            sessionID: "ses_root",
            messageID: "msg_assistant_1",
            type: "tool",
            callID: "call_read_1",
            tool: "bash",
            state: {
              status: "completed",
              input: {
                command: "rg --files .",
                description: "List repository files",
              },
              title: "List repository files",
              output: longToolOutput ?? "app.py\ntests/test_app.py\n",
              metadata: {
                exit: 0,
              },
              time: {
                start: 1773890592000,
                end: 1773890592100,
              },
            },
          },
          {
            id: "prt_finish_1",
            sessionID: "ses_root",
            messageID: "msg_assistant_1",
            type: "step-finish",
            reason: "tool-calls",
            snapshot: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            cost: 0.012345,
            tokens: {
              total: 13573,
              input: 78,
              output: 187,
              reasoning: 12,
              cache: {
                read: 510,
                write: 12798,
              },
            },
          },
        ],
      },
    ],
    children: [
      {
        platform: "opencode",
        capturedAt: 1773890615000,
        session: childSession,
        todos: [],
        diff: [],
        messages: [
          {
            info: {
              id: "msg_child_user_1",
              sessionID: "ses_child",
              role: "user",
              time: { created: 1773890600000 },
              agent: "build",
            },
            parts: [
              {
                id: "prt_child_user_text_1",
                sessionID: "ses_child",
                messageID: "msg_child_user_1",
                type: "text",
                text: "Inspect only the logging layer.",
              },
            ],
          },
          {
            info: {
              id: "msg_child_assistant_1",
              sessionID: "ses_child",
              role: "assistant",
              parentID: "msg_child_user_1",
              time: {
                created: 1773890600500,
                completed: 1773890602000,
              },
              modelID: "big-pickle",
              providerID: "opencode",
              mode: "build",
              agent: "build",
              path: {
                cwd: workspace,
                root: workspace,
              },
              cost: 0.001234,
              tokens: {
                total: 420,
                input: 15,
                output: 9,
                reasoning: 3,
                cache: {
                  read: 12,
                  write: 381,
                },
              },
              finish: "stop",
            },
            parts: [
              {
                id: "prt_child_reasoning_1",
                sessionID: "ses_child",
                messageID: "msg_child_assistant_1",
                type: "reasoning",
                text: "Subagent is narrowing the audit to the logging layer.",
                time: {
                  start: 1773890600600,
                  end: 1773890600700,
                },
              },
              {
                id: "prt_child_text_1",
                sessionID: "ses_child",
                messageID: "msg_child_assistant_1",
                type: "text",
                text: "Subagent inspected the logging layer and found no crash path.",
              },
            ],
          },
        ],
        children: [],
      },
    ],
  };
}

function getOutputPaths(result) {
  const summaryRoot = path.dirname(result.summaryPath);
  const metaSessionDir = path.dirname(path.dirname(result.mergedMetaPath));
  return {
    summaryRoot,
    metaSessionDir,
    mainSummary: path.join(summaryRoot, "agents", "main", "summary.md"),
    mainUsage: path.join(summaryRoot, "agents", "main", "usage.json"),
    subagentSummary: path.join(summaryRoot, "agents", "agent-helper", "summary.md"),
    subagentUsage: path.join(summaryRoot, "agents", "agent-helper", "usage.json"),
    metaIndex: path.join(metaSessionDir, "index.md"),
    mainMeta: path.join(metaSessionDir, "agents", "main", "session.md"),
    subagentMeta: path.join(metaSessionDir, "agents", "agent-helper", "session.md"),
    sharedRendered: path.join(metaSessionDir, "artifacts", "shared", "rendered"),
    mainRendered: path.join(metaSessionDir, "artifacts", "main", "rendered"),
  };
}

async function readText(target) {
  return readFile(target, "utf8");
}

async function listDir(target) {
  try {
    return (await readdir(target)).sort();
  } catch {
    return [];
  }
}

test("creates root, agent, and merged outputs under .agents-log", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "opencode-session-log-"));
  try {
    const snapshot = makeSnapshot(workspace);
    const result = await syncOpencodeSessionLogSnapshot({
      projectDir: workspace,
      snapshot,
      triggerEvent: "message.updated",
    });

    const paths = getOutputPaths(result);
    const rootSummary = await readText(result.summaryPath);
    const mainSummary = await readText(paths.mainSummary);
    const subagentSummary = await readText(paths.subagentSummary);
    const mergedMeta = await readText(result.mergedMetaPath);
    const mainMeta = await readText(paths.mainMeta);
    const subagentMeta = await readText(paths.subagentMeta);
    const usage = JSON.parse(await readText(result.usagePath));
    const mainUsage = JSON.parse(await readText(paths.mainUsage));
    const state = JSON.parse(await readText(result.statePath));
    const indexText = await readText(result.indexPath);

    assert.equal(result.logRoot.endsWith(path.join(workspace, ".agents-log")), true);
    assert.match(result.summaryPath, /\/\.agents-log\/summary\/2026-03-19_11-23-11\/summary\.md$/);
    assert.match(result.mergedMetaPath, /\/\.agents-log\/meta\/sessions\/2026\/03\/ses_root\/merged\/session\.md$/);

    assert.equal(rootSummary.includes("## Agents"), true);
    assert.equal(rootSummary.includes("Open merged detail"), true);
    assert.equal(rootSummary.includes("Subagent inspected the logging layer"), false);
    assert.equal(rootSummary.includes("I should inspect the repository"), false);

    assert.equal(mainSummary.includes("## Conversation"), true);
    assert.equal(mainSummary.includes("I should inspect the repository and use tools carefully."), true);
    assert.equal(mainSummary.includes("Subagent inspected the logging layer"), false);

    assert.equal(subagentSummary.includes("Subagent inspected the logging layer and found no crash path."), true);
    assert.equal(subagentSummary.includes("I should inspect the repository and use tools carefully."), false);

    assert.equal(mergedMeta.includes("[agent-helper]"), true);
    assert.equal(mainMeta.includes("I should inspect the repository and use tools carefully."), true);
    assert.equal(mainMeta.includes("Subagent inspected the logging layer"), false);
    assert.equal(subagentMeta.includes("Subagent inspected the logging layer and found no crash path."), true);

    assert.equal(usage.platform, "opencode");
    assert.equal(usage.session.id, "ses_root");
    assert.equal(usage.transcript_usage.input_tokens, 93);
    assert.equal(usage.transcript_usage.output_tokens, 196);
    assert.equal(usage.transcript_usage.reasoning_tokens, 15);
    assert.equal(usage.transcript_usage.cache_read_input_tokens, 522);
    assert.equal(usage.transcript_usage.cache_creation_input_tokens, 13179);
    assert.equal(usage.session_metrics.cost_usd, 0.013579);
    assert.equal(mainUsage.agent.key, "main");

    assert.equal(state.summary_dir_relpath, "summary/2026-03-19_11-23-11");
    assert.equal(state.summary_agents_relpaths.main.summary_markdown_relpath, "summary/2026-03-19_11-23-11/agents/main/summary.md");
    assert.equal(state.summary_agents_relpaths["agent-helper"].summary_markdown_relpath, "summary/2026-03-19_11-23-11/agents/agent-helper/summary.md");
    assert.equal(state.meta_agents_relpaths.main.markdown_relpath, "meta/sessions/2026/03/ses_root/agents/main/session.md");
    assert.equal(state.meta_agents_relpaths["agent-helper"].markdown_relpath, "meta/sessions/2026/03/ses_root/agents/agent-helper/session.md");

    assert.equal(indexText.includes("OpenCode Session Meta Index"), true);
    assert.equal(indexText.includes("ses_root"), true);

    assert.equal((await listDir(paths.sharedRendered)).includes("snapshot.json"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("moves long tool output into main rendered artifacts", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "opencode-session-log-"));
  try {
    const snapshot = makeSnapshot(workspace, { longToolOutput: "A".repeat(5000) });
    const result = await syncOpencodeSessionLogSnapshot({
      projectDir: workspace,
      snapshot,
      triggerEvent: "message.part.updated",
    });

    const paths = getOutputPaths(result);
    const rootSummary = await readText(result.summaryPath);
    const mainSummary = await readText(paths.mainSummary);
    const rendered = await listDir(paths.mainRendered);

    assert.equal(rootSummary.includes("Open full artifact"), false);
    assert.equal(mainSummary.includes("Open full artifact"), true);
    assert.equal(rendered.some((name) => name.endsWith(".txt")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reuses existing summary directory when state is missing", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "opencode-session-log-"));
  try {
    const snapshot = makeSnapshot(workspace);
    const first = await syncOpencodeSessionLogSnapshot({
      projectDir: workspace,
      snapshot,
      triggerEvent: "message.updated",
    });

    await unlink(first.statePath);

    const second = await syncOpencodeSessionLogSnapshot({
      projectDir: workspace,
      snapshot,
      triggerEvent: "session.idle",
    });

    const summaryDirs = await listDir(path.join(workspace, ".agents-log", "summary"));
    assert.equal(first.summaryPath, second.summaryPath);
    assert.deepEqual(summaryDirs, ["2026-03-19_11-23-11"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("concurrent sync keeps a single summary directory", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "opencode-session-log-"));
  try {
    const snapshot = makeSnapshot(workspace);
    const [first, second] = await Promise.all([
      syncOpencodeSessionLogSnapshot({
        projectDir: workspace,
        snapshot,
        triggerEvent: "message.updated",
      }),
      syncOpencodeSessionLogSnapshot({
        projectDir: workspace,
        snapshot,
        triggerEvent: "tool.execute.after",
      }),
    ]);

    const summaryDirs = await listDir(path.join(workspace, ".agents-log", "summary"));
    assert.equal(first.summaryPath, second.summaryPath);
    assert.deepEqual(summaryDirs, ["2026-03-19_11-23-11"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parses legacy sqlite tabular output and detects -json fallback", () => {
  const rows = parseSqliteTabularJson(
    [
      "id\tparentID\ttimeCreated\tdata",
      'ses_root\tnull\t1773890591755\t{"role":"assistant","count":2}',
      "ses_child\tses_root\t1773890600000\tplain-text",
    ].join("\n"),
  );

  assert.deepEqual(rows, [
    {
      id: "ses_root",
      parentID: null,
      timeCreated: 1773890591755,
      data: { role: "assistant", count: 2 },
    },
    {
      id: "ses_child",
      parentID: "ses_root",
      timeCreated: 1773890600000,
      data: "plain-text",
    },
  ]);

  assert.equal(
    shouldFallbackSqliteFormat({
      stderr: "sqlite3: Error: unknown option: -json\nUse -help for a list of options.\n",
    }),
    true,
  );
  assert.equal(shouldFallbackSqliteFormat({ stderr: "another error" }), false);
});

test("parses opencode export output with human prefix", () => {
  const exported = parseOpencodeExport(
    'Exporting session: ses_123{"info":{"id":"ses_123","directory":"/tmp/demo"},"messages":[]}',
  );

  assert.deepEqual(exported, {
    info: { id: "ses_123", directory: "/tmp/demo" },
    messages: [],
  });
});

test("normalizes exported snapshot into plugin snapshot shape", () => {
  const snapshot = normalizeExportedSnapshot(
    {
      info: {
        id: "ses_root",
        directory: "/tmp/demo",
        summary: { diffs: [{ path: "a.txt" }] },
      },
      messages: [{ info: { id: "msg_1" }, parts: [] }],
      children: [
        {
          info: { id: "ses_child" },
          messages: [],
        },
      ],
    },
    "/tmp/demo",
  );

  assert.equal(snapshot.platform, "opencode");
  assert.equal(snapshot.session.id, "ses_root");
  assert.deepEqual(snapshot.diff, [{ path: "a.txt" }]);
  assert.equal(snapshot.children[0].session.id, "ses_child");
});
