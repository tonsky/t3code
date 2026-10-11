import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { resolveThreadAwarenessPhaseV2 } from "@t3tools/shared/agentAwareness";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import { shouldPublishAgentAwarenessEvent } from "./relay/AgentAwarenessRelay.ts";
import { forkParked } from "./serverActivation.ts";

// An agent that is working, or a finished run whose subagent or monitor will
// wake it. A thread blocked on the user does not count: nothing moves until
// they are back.
function threadKeepsAwake(thread: OrchestrationV2ThreadShell): boolean {
  const phase = resolveThreadAwarenessPhaseV2(thread);
  return phase === "starting" || phase === "running";
}

/**
 * Stops the Mac from idle-sleeping while any thread is running or monitoring.
 * The display may still sleep, and closing the lid still sleeps the machine.
 */
const start = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  if (platform !== "darwin") return;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // `-w` releases the assertion when this server exits, so a crash cannot
  // leave the machine awake.
  const caffeinate = spawner
    .spawn(
      ChildProcess.make("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.andThen((child) => child.exitCode),
      Effect.scoped,
      Effect.ignore,
    );

  const awakeThreads = new Set<ThreadId>();
  let holding: Fiber.Fiber<void> | null = null;

  const track = (threadId: ThreadId, shell: OrchestrationV2ThreadShell | null) => {
    if (shell !== null && threadKeepsAwake(shell)) {
      awakeThreads.add(threadId);
    } else {
      awakeThreads.delete(threadId);
    }
  };

  const reconcile = Effect.gen(function* () {
    if (awakeThreads.size > 0 && holding === null) {
      holding = yield* Effect.forkScoped(caffeinate);
    } else if (awakeThreads.size === 0 && holding !== null) {
      yield* Fiber.interrupt(holding);
      holding = null;
    }
  });

  yield* forkParked(
    Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      for (const shell of snapshot.threads) {
        track(shell.id, shell);
      }
      yield* reconcile;
      yield* threads.streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence }).pipe(
        Stream.filter((stored) => shouldPublishAgentAwarenessEvent(stored.event)),
        Stream.runForEach((stored) =>
          threads.getThreadShell(stored.event.threadId).pipe(
            Effect.andThen((shell) => {
              track(stored.event.threadId, shell);
              return reconcile;
            }),
          ),
        ),
      );
    }).pipe(
      // Scoped so the hold ends with the watcher instead of outliving it.
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.logWarning("keep-awake watcher stopped", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(start);
