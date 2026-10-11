import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as KeepAwake from "./keepAwake.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";

const FIRST = ThreadId.make("keep-awake-thread");
const SECOND = ThreadId.make("keep-awake-thread-2");
const NOW = DateTime.makeUnsafe("2026-10-11T12:00:00.000Z");
const PROVIDER = ProviderInstanceId.make("codex");

function shell(
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell>,
): OrchestrationV2ThreadShell {
  return {
    id,
    projectId: ProjectId.make("keep-awake-project"),
    title: "Thread",
    providerInstanceId: PROVIDER,
    modelSelection: { instanceId: PROVIDER, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    ...overrides,
  };
}

function runUpdated(threadId: ThreadId, sequence: number): OrchestrationV2StoredEvent {
  const runId = RunId.make(`run:${threadId}`);
  return {
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`event:${sequence}`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: NOW,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: PROVIDER,
        modelSelection: { instanceId: PROVIDER, model: "test-model" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${threadId}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
  };
}

/** Starts the watcher over `initial` shells; `change` applies a shell and waits for it to be handled. */
const makeHarness = Effect.fnUntraced(function* (
  initial: ReadonlyArray<OrchestrationV2ThreadShell>,
) {
  const shells = new Map(initial.map((thread) => [thread.id, thread]));
  const caffeinate = { running: 0, commands: [] as Array<ReadonlyArray<string>> };
  const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  // The watcher pulls the next event only after it has handled the previous one.
  const pulls = yield* Queue.unbounded<void>();
  let sequence = 1;

  const spawner = ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.acquireRelease(
      Effect.sync(() => {
        caffeinate.running += 1;
        caffeinate.commands.push([executable, ...args]);
      }),
      () => Effect.sync(() => void (caffeinate.running -= 1)),
    ).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
  });

  yield* Layer.build(
    KeepAwake.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: sequence,
              threads: [...shells.values()],
              archivedThreads: [],
            }),
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          streamStoredEventsFrom: () =>
            Stream.fromEffectRepeat(
              Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
            ),
        }),
      ),
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
    ),
  );
  yield* Queue.take(pulls);

  const change = Effect.fnUntraced(function* (
    threadId: ThreadId,
    overrides: Partial<OrchestrationV2ThreadShell>,
  ) {
    shells.set(threadId, shell(threadId, overrides));
    yield* Queue.offer(events, runUpdated(threadId, ++sequence));
    yield* Queue.take(pulls);
  });

  return { caffeinate, change };
});

it.effect(
  "holds one caffeinate across running threads and releases it when the last one ends",
  () =>
    Effect.gen(function* () {
      const { caffeinate, change } = yield* makeHarness([shell(FIRST, { status: "running" })]);
      assert.deepEqual(caffeinate.commands, [
        ["/usr/bin/caffeinate", "-i", "-w", String(process.pid)],
      ]);

      yield* change(SECOND, { status: "starting" });
      yield* change(FIRST, { status: "completed" });
      assert.equal(caffeinate.running, 1);

      yield* change(SECOND, { status: "interrupted" });
      assert.equal(caffeinate.running, 0);
      assert.lengthOf(caffeinate.commands, 1);
    }),
);

it.effect("holds for a finished run that is still monitoring, not for one that left a server", () =>
  Effect.gen(function* () {
    const { caffeinate, change } = yield* makeHarness([]);
    assert.equal(caffeinate.running, 0);

    yield* change(FIRST, {
      status: "completed",
      pendingBackgroundTasks: [{ taskId: "watch-ci", kind: "monitor" }],
    });
    assert.equal(caffeinate.running, 1);

    yield* change(FIRST, {
      status: "completed",
      pendingBackgroundTasks: [{ taskId: "dev-server", kind: "command" }],
    });
    assert.equal(caffeinate.running, 0);
  }),
);

it.effect("lets the machine sleep while a running thread waits on the user", () =>
  Effect.gen(function* () {
    const { caffeinate, change } = yield* makeHarness([shell(FIRST, { status: "running" })]);
    assert.equal(caffeinate.running, 1);

    yield* change(FIRST, {
      status: "running",
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request:approval"),
        kind: "user_input",
        createdAt: NOW,
      },
    });
    assert.equal(caffeinate.running, 0);
  }),
);
