# DevTools CDP Paths for Browser, Node.js, and Workers

This note explains why some Chrome DevTools memory features behave differently
for browser pages, Node.js processes, and Cloudflare Workers running on
`workerd`. It also separates the runtime work that could unlock missing
features from the frontend/product work that currently requires a patched
DevTools frontend.

The immediate questions this answers are:

- Why does the Performance panel memory checkbox show no useful memory graph
  for Workers?
- Is that behavior specific to Workers, or inherited from the Node.js DevTools
  path?
- What would "implement tracing support" mean in `workerd`?
- Could better runtime/CDP support remove the custom Cloudflare DevTools fork?

## Executive Summary

Chrome DevTools has two different memory-related paths that are easy to confuse:

| DevTools surface | Protocol path | Data shape | Worker status |
| --- | --- | --- | --- |
| Memory panel heap snapshots and allocation tools | `HeapProfiler.*` | Heap snapshots, sampling heap profiles, heap tracking events | `takeHeapSnapshot` is implemented manually; other `HeapProfiler.*` methods likely fall through to V8 and need live validation |
| Performance panel memory overview checkbox | `Tracing.*` trace events, especially `UpdateCounters` | Timeline trace events with `jsHeapSizeUsed` counters | Workers currently use Node-style CPU profiling, so the fake trace has no memory counters |

The Performance panel behavior is mostly inherited from the Node.js DevTools
mode. When DevTools records a Node-like target, it records a CPU profile via
`Profiler.start` / `Profiler.stop`, then converts that CPU profile into a fake
trace for display. That fake trace has CPU samples, but not browser timeline
counter events such as `UpdateCounters`, so the memory checkbox has no data to
render.

By contrast, the Memory panel uses `HeapProfiler.*` directly. Adding or fixing
`HeapProfiler.*` support would help allocation sampling and allocation
instrumentation, but it would not fix the Performance panel memory graph.

Better `workerd` CDP support can reduce patches in the Workers DevTools fork,
especially the patch that hides heap allocation modes. It is unlikely to remove
the fork completely because several patches are product or embedding behavior,
not runtime capability gaps.

## Mental Model: What CDP Is

The Chrome DevTools Protocol is a JSON-RPC protocol, usually over a WebSocket.
The frontend sends commands such as:

```json
{ "id": 1, "method": "Runtime.evaluate", "params": { "expression": "1 + 1" } }
```

The inspected runtime sends responses and events such as:

```json
{ "id": 1, "result": { "result": { "type": "number", "value": 2 } } }
```

CDP is organized into domains. Important domains for this investigation are:

| Domain | Purpose |
| --- | --- |
| `Runtime` | Evaluate JavaScript, inspect objects, report console calls and exceptions |
| `Debugger` | Breakpoints, stepping, source scripts |
| `Profiler` | CPU profiling |
| `HeapProfiler` | Heap snapshots, allocation sampling, heap object tracking |
| `Tracing` | Browser-style timeline trace recording |
| `Network` | Network request timeline, response metadata, response bodies |
| `Memory` | Miscellaneous browser memory APIs; not the primary path for the Performance memory checkbox |

The same DevTools frontend can connect to different kinds of targets, but it
does not use the same recording path for all of them. Browser pages and Node.js
processes are the important comparison points.

## Three CDP Worlds

| Topic | Browser page target | Node.js target | Workers / `workerd` today |
| --- | --- | --- | --- |
| Backend | Chromium browser, renderer, network service, tracing service | Node.js inspector built on V8 inspector | `workerd` inspector built around V8 inspector plus Worker-specific interception |
| Target shape | Page/tab target with browser, page, network, tracing, runtime, debugger, profiler domains | V8 isolate/process target with runtime, debugger, profiler, heap profiler, limited browser domains | Node-like V8 isolate target with Worker-specific network and profiling handling |
| Performance recording path | `Tracing.start` / `Tracing.end` on a trace-capable root target | `Profiler.start` / `Profiler.stop`, then DevTools builds a fake trace from the CPU profile | Same Node-style CPU profile path in the patched Workers DevTools frontend |
| CPU data in Performance panel | Trace events include CPU profile chunks and timeline events | CPU profile is converted into synthetic trace events | `workerd` manually implements CPU profiler responses and DevTools converts them into a fake trace |
| Performance memory checkbox | Renders `UpdateCounters` trace events from the trace model | Usually empty because CPU profiles do not contain `UpdateCounters` events | Empty for the same reason as Node mode |
| Memory panel heap snapshot | Uses `HeapProfiler.takeHeapSnapshot` | Uses V8 inspector `HeapProfiler.takeHeapSnapshot` | `workerd` intercepts `HeapProfiler.takeHeapSnapshot` and writes snapshot chunks itself |
| Memory panel allocation sampling | Uses `HeapProfiler.startSampling`, `getSamplingProfile`, `stopSampling` | Uses V8 inspector heap profiler methods | Likely falls through to V8 inspector because `workerd` does not intercept these methods; needs live validation |
| Memory panel allocation instrumentation | Uses `HeapProfiler.startTrackingHeapObjects`, tracking events, `stopTrackingHeapObjects` | Uses V8 inspector heap tracking if available | Likely falls through to V8 inspector; needs live validation, especially events and final snapshot behavior |
| Network panel | Browser emits standard `Network.*` events and supports response body retrieval | Limited or different from browser network timeline | Workers DevTools has custom frontend patches for Worker network data and response bodies |
| Frontend mode | Main browser DevTools app | Node/JavaScript DevTools app path | Patched hosted DevTools app based on upstream DevTools, with Workers-specific patches |

## Browser DevTools Path

When DevTools attaches to Chrome inspecting a page, the Performance panel records
a browser trace:

```text
DevTools frontend
  -> Tracing.start
  <- Tracing.dataCollected events
  -> Tracing.end
  <- Tracing.tracingComplete
```

The trace is a stream of trace events. These events include JavaScript execution,
CPU samples, network activity, rendering work, screenshots, navigation metadata,
and memory counters.

The Performance panel memory checkbox does not request a heap snapshot and does
not call `Memory.getDOMCounters`. In the inspected DevTools revision, the
checkbox toggles whether the minimap renders memory data that is already present
in the parsed trace.

The relevant memory event is `UpdateCounters`:

```json
{
  "cat": "devtools.timeline",
  "name": "UpdateCounters",
  "ph": "I",
  "s": "t",
  "pid": 123,
  "tid": 456,
  "ts": 1000000,
  "args": {
    "data": {
      "documents": 1,
      "nodes": 100,
      "jsEventListeners": 5,
      "jsHeapSizeUsed": 10485760
    }
  }
}
```

In upstream DevTools at the Workers fork base revision:

- `front_end/models/trace/handlers/MemoryHandler.ts` stores events where
  `event.name === "UpdateCounters"`.
- `front_end/panels/timeline/TimelineEventOverview.ts` renders the heap graph
  from `event.args.data.jsHeapSizeUsed`.
- The graph filters counters to `parsedTrace.Meta.topLevelRendererIds`, so a
  non-browser trace also needs compatible metadata or a frontend adaptation.

That last point matters. A trace containing `UpdateCounters` is not always
enough. DevTools also needs enough metadata to decide which process is the main
renderer-like process. Browser traces provide this through events such as
`TracingStartedInBrowser` and `FrameCommittedInBrowser`.

## Node.js DevTools Path

Node.js exposes the V8 inspector protocol. That gives DevTools excellent access
to the JavaScript runtime, debugger, CPU profiler, and heap profiler, but it is
not the same as a full browser page target.

For Node-like targets, DevTools uses its Node/JavaScript timeline path. In the
DevTools revision inspected here, `front_end/panels/js_timeline/js_timeline-meta.ts`
loads the main Timeline panel with `isNode: true`:

```ts
return Timeline.TimelinePanel.TimelinePanel.instance({forceNew: null, isNode: true});
```

When `isNode` is true, `front_end/panels/timeline/TimelinePanel.ts` records via
the CPU profiler path:

```text
DevTools frontend
  -> Profiler.enable
  -> Profiler.start
  -> Profiler.stop
  -> Profiler.disable
  -> convert CPU profile into fake trace
```

The conversion happens in `front_end/panels/timeline/TimelineLoader.ts` via:

```ts
SamplesIntegrator.createFakeTraceFromCpuProfile(profile, ThreadID(1))
```

That fake trace is useful for rendering CPU flame charts. It does not contain
browser timeline memory counter events. As a result, the Performance panel's
memory checkbox can be visible but still produce no heap graph.

This is not a Workers-specific failure mode. Workers inherit it because their
Performance panel currently follows the same Node-style recording path.

The Memory panel is different. In Node, DevTools can still use V8 inspector
`HeapProfiler.*` commands for heap snapshots and allocation profiling. These do
not require browser `Tracing.*` support.

So the Node comparison should be read narrowly: Node-like Performance recordings
usually do not have browser memory counter trace events. This does not mean Node
lacks heap profiler support, and it does not mean Workers need to invent a heap
profiler API that Node does not have.

## Workers / `workerd` Path Today

The Workers SDK serves a patched Chrome DevTools frontend. Wrangler opens this
hosted frontend from:

```text
/Users/brendan/src/workers-sdk/packages/wrangler/src/dev/inspect.ts
```

The patched frontend is maintained in:

```text
/Users/brendan/src/workers-sdk/packages/chrome-devtools-patches
```

The patch base is recorded in the package Makefile:

```text
HEAD = b66ecf5bef3ae6c769dbc6d904ce1c54d3771227
```

On the runtime side, `workerd` handles inspector messages in:

```text
/Users/brendan/src/workerd/src/workerd/io/worker.c++
/Users/brendan/src/workerd/src/workerd/io/cdp.capnp
```

`workerd` decodes incoming CDP JSON into the small set of methods modeled in
`cdp.capnp`. It manually handles some commands, then forwards unknown commands
to the underlying V8 inspector session.

The relevant behavior is in `InspectorChannelImpl::dispatchProtocolMessage()`:

```text
if the command is one of the modeled commands:
  handle it in workerd
else:
  session.dispatchProtocolMessage(...)
```

The manually handled subset includes:

| Domain method | `workerd` behavior |
| --- | --- |
| `Network.enable` | Enables Worker network event emission |
| `Network.disable` | Disables Worker network event emission |
| `Network.getResponseBody` | Returns an unsupported error in this fork |
| `Profiler.enable` | Creates a CPU profiler |
| `Profiler.setSamplingInterval` | Sets CPU profiler sampling interval |
| `Profiler.start` | Starts CPU profiling, with Worker startup-profile behavior |
| `Profiler.stop` | Stops CPU profiling and writes a CDP CPU profile |
| `HeapProfiler.takeHeapSnapshot` | Takes and serializes a heap snapshot manually |

Unknown commands are forwarded to V8. This means these standard V8 inspector
methods are likely already reaching V8:

| Method | Why it matters |
| --- | --- |
| `HeapProfiler.startSampling` | Starts allocation sampling for the Memory panel |
| `HeapProfiler.getSamplingProfile` | Gets intermediate allocation sampling data |
| `HeapProfiler.stopSampling` | Stops allocation sampling and returns the profile |
| `HeapProfiler.startTrackingHeapObjects` | Starts allocation instrumentation / heap object tracking |
| `HeapProfiler.stopTrackingHeapObjects` | Stops tracking and produces final heap snapshot data |
| `Runtime.getIsolateId` | Standard experimental CDP method currently used by a Workers frontend keepalive patch |

This fallback behavior was found by code inspection. It still needs a live
inspector smoke test before removing UI restrictions.

## Why Workers Hide Memory Panel Allocation Modes

The Workers DevTools patch stack includes:

```text
/Users/brendan/src/workers-sdk/packages/chrome-devtools-patches/patches/0007-Limit-heap-profiling-modes-available.patch
```

That patch changes the Memory panel profile types from:

```ts
[
  registry.heapSnapshotProfileType,
  registry.trackingHeapSnapshotProfileType,
  registry.samplingHeapProfileType,
  registry.detachedElementProfileType,
]
```

to:

```ts
[registry.heapSnapshotProfileType]
```

So the frontend explicitly hides:

- Allocation instrumentation on timeline
- Allocation sampling
- Detached elements

For the two allocation tools, upstream DevTools uses standard `HeapProfiler.*`
commands:

| UI mode | CDP methods/events |
| --- | --- |
| Allocation sampling | `HeapProfiler.startSampling`, `HeapProfiler.getSamplingProfile`, `HeapProfiler.stopSampling` |
| Allocation instrumentation | `HeapProfiler.startTrackingHeapObjects`, `HeapProfiler.heapStatsUpdate`, `HeapProfiler.lastSeenObjectId`, `HeapProfiler.stopTrackingHeapObjects` |

Because `workerd` does not currently intercept these methods, they should fall
through to V8. If they work, the runtime change needed for allocation sampling
may be no runtime change at all. The work would be to add tests and remove or
relax the frontend patch.

Allocation instrumentation has a larger validation surface because DevTools
expects live tracking events and a final snapshot. The important events are:

- `HeapProfiler.heapStatsUpdate`
- `HeapProfiler.lastSeenObjectId`
- `HeapProfiler.addHeapSnapshotChunk`
- `HeapProfiler.reportHeapSnapshotProgress`

One thing to validate is whether `HeapProfiler.stopTrackingHeapObjects(true)`,
when forwarded to V8, produces the final snapshot and progress events in the
shape DevTools expects. `workerd` has a custom implementation for
`HeapProfiler.takeHeapSnapshot`, but not for `stopTrackingHeapObjects`.

## What "Implement Tracing Support" Means

Implementing tracing support does not mean implementing `Memory.*` CDP methods.
It means making `workerd` look like a trace-capable CDP backend to DevTools.

At the protocol level, the minimum shape is:

| CDP item | Required role |
| --- | --- |
| `Tracing.start` | Begin collecting trace events for a session |
| `Tracing.end` | Stop the session and flush collected events |
| `Tracing.dataCollected` | Send batches of trace events to DevTools |
| `Tracing.tracingComplete` | Tell DevTools all trace data has been delivered |
| `Tracing.bufferUsage` | Optional progress signal while recording |

For the Performance memory graph specifically, `workerd` would need to emit
`UpdateCounters` trace events with `jsHeapSizeUsed` while tracing is active.

The minimal useful memory event would look like this:

```json
{
  "cat": "devtools.timeline",
  "name": "UpdateCounters",
  "ph": "I",
  "s": "t",
  "pid": 1,
  "tid": 1,
  "ts": 1000000,
  "args": {
    "data": {
      "documents": 0,
      "nodes": 0,
      "jsEventListeners": 0,
      "jsHeapSizeUsed": 10485760
    }
  }
}
```

The `jsHeapSizeUsed` value could come from V8 heap statistics for the isolate.
The trace timestamp must use a stable trace clock, in microseconds, consistent
with the other events in the same trace.

However, that event alone may still not draw in upstream DevTools. The trace
model currently filters the memory graph to top-level renderer process ids. A
Worker trace therefore needs one of these:

| Approach | Meaning |
| --- | --- |
| Emit browser-compatible metadata | Produce enough events such as `TracingStartedInBrowser` or `FrameCommittedInBrowser` for DevTools to classify the Worker process id as a top-level renderer-like process |
| Teach DevTools about Worker traces | Add or upstream frontend logic so Worker traces can render memory counters without pretending to be a page renderer |
| Keep using Node CPU profile path | No trace metadata needed, but the Performance memory graph remains empty unless the fake trace is extended |

For a complete Workers Performance trace, memory counters are only one piece.
Other useful trace events would include:

| Event family | Why it matters |
| --- | --- |
| CPU profile trace events such as `Profile` and `ProfileChunk` | Preserve current CPU flame chart behavior in the tracing path |
| Worker request lifecycle events | Represent fetch/request execution as timeline work |
| Network events or synthetic network trace events | Support network tracks without Worker-specific frontend hacks |
| Metadata events such as `process_name` and `thread_name` | Give DevTools readable process/thread labels |
| Worker identity metadata | Let DevTools show a Worker name without query-param patches |

There is also a frontend selection issue. Even if `workerd` implements
`Tracing.*`, the current Workers frontend path still loads the Timeline panel in
Node mode. In Node mode, DevTools chooses `Profiler.start` / `Profiler.stop`,
not `Tracing.start` / `Tracing.end`.

So making Performance memory work through tracing requires two coordinated
changes:

| Layer | Required change |
| --- | --- |
| Runtime | Implement `Tracing.*` and emit useful trace events, including `UpdateCounters` |
| Frontend or target metadata | Make DevTools choose the trace recording path for Workers, or add a Worker-specific path that calls `Tracing.*` |

There is a less standard alternative: keep the current Node-style CPU profiler
path and teach the frontend to poll memory separately, then inject synthetic
`UpdateCounters` into the fake trace created from the CPU profile. That would be
more of a Workers/Node-mode frontend customization than a standard CDP tracing
implementation. It could be smaller, but it would not move Workers closer to
upstream browser Performance recording.

## What Runtime Work Could Help

### 1. Validate and unhide allocation sampling

Test these methods against a live `workerd` inspector session:

```text
HeapProfiler.startSampling
HeapProfiler.getSamplingProfile
HeapProfiler.stopSampling
```

Expected result:

- If V8 fallback works, no runtime implementation is needed.
- The Workers frontend can stop hiding `registry.samplingHeapProfileType`.
- Add a regression test under `src/workerd/server/tests/inspector`.

### 2. Validate and unhide allocation instrumentation

Test these methods and events:

```text
HeapProfiler.startTrackingHeapObjects
HeapProfiler.heapStatsUpdate
HeapProfiler.lastSeenObjectId
HeapProfiler.stopTrackingHeapObjects
HeapProfiler.addHeapSnapshotChunk
HeapProfiler.reportHeapSnapshotProgress
```

Expected result:

- If V8 fallback works, the frontend can stop hiding
  `registry.trackingHeapSnapshotProfileType`.
- If final snapshots or events do not work, `workerd` could explicitly bridge
  this subset of `HeapProfiler.*` the same way it currently bridges
  `takeHeapSnapshot`.

### 3. Implement standard `Network.getResponseBody`

The current `workerd` manual handler returns:

```text
Network.getResponseBody is not supported in this fork
```

The Workers frontend has a network patch that uses Cloudflare-specific response
body plumbing. A standard `Network.getResponseBody` implementation would make
this behavior closer to upstream DevTools and could reduce custom frontend code.

### 4. Implement trace-capable Performance recording

This is the larger project described above. It would add `Tracing.*` support and
Worker trace events.

Expected result:

- DevTools can record Workers through a browser-style trace path instead of the
  Node CPU-profile path.
- The Performance memory graph can draw `UpdateCounters` data.
- More Workers-specific timeline information can move into standard trace data
  instead of frontend patches.

This is not required to make Memory panel allocation sampling work.

## Can We Drop The Custom DevTools Frontend?

Runtime work can reduce the fork, but it probably cannot remove it completely by
itself.

The current patch stack includes several kinds of changes:

| Patch | What it does | Can runtime work remove it? |
| --- | --- | --- |
| `0001-Expand-Browser-support-make-it-work-in-Firefox-Safar.patch` | Allows hosted DevTools to run in non-Chrome browsers | No. This is frontend/hosting compatibility. |
| `0002-Setup-Cloudflare-devtools-target-type.patch` | Adds Cloudflare target type behavior | Maybe only if Workers uses an upstream target type or upstream accepts a Workers target concept. |
| `0003-Add-ping-to-improve-connection-stability.-Without-th.patch` | Sends periodic `Runtime.getIsolateId` as a keepalive | Maybe. Better WebSocket/proxy keepalive behavior could remove this frontend patch. |
| `0004-Support-viewing-source-files-over-the-network.-This-.patch` | Changes source loading behavior | Maybe. Depends whether standard source URLs/source maps can represent all Worker sources. |
| `0005-Support-forcing-the-devtools-theme-via-a-query-param.patch` | Adds theme query-param behavior | No. This is hosted frontend product behavior. |
| `0006-All-about-the-network-tab.patch` | Worker-specific network tab behavior and response body plumbing | Partly. Standard `Network.*` support could reduce it, but Worker-specific UX may remain. |
| `0007-Limit-heap-profiling-modes-available.patch` | Hides allocation sampling and instrumentation | Likely yes if `HeapProfiler.*` is validated or fixed. |
| `0008-Use-the-worker-name-as-the-title-for-the-Javascript-.patch` | Uses query-param Worker name in Performance isolate selector | Maybe. Better target naming metadata could reduce it, but this is presentation logic. |

The likely end state is not "runtime support removes every patch." A more
realistic goal is:

```text
Use standard CDP wherever possible.
Move Worker-specific data into standard protocol fields/events where possible.
Keep only small product/hosting patches, or upstream them.
```

## Recommended Next Steps

| Priority | Step | Outcome |
| --- | --- | --- |
| 1 | Add inspector tests for heap allocation sampling | Know whether `registry.samplingHeapProfileType` can be restored |
| 2 | Add inspector tests for heap object tracking and final snapshots | Know whether `registry.trackingHeapSnapshotProfileType` can be restored |
| 3 | Decide whether Performance memory should be hidden or supported | Avoid a checkbox that appears broken |
| 4 | If supporting Performance memory, design a Worker tracing MVP | Define exact `Tracing.*` methods, event metadata, and frontend path |
| 5 | Audit network tab patch against standard `Network.*` support | Identify which parts can move into runtime protocol behavior |

## Current Confidence

High confidence:

- Browser Performance memory uses trace `UpdateCounters`, not heap snapshots.
- Node-mode Performance recording uses CPU profiler output and fake traces.
- Workers currently follow the Node-mode Performance path.
- `workerd` forwards unknown CDP methods to V8 inspector.
- `0007` explicitly hides heap allocation Memory panel modes.

Medium confidence:

- `HeapProfiler.startSampling` works through V8 fallback in `workerd`.
- `HeapProfiler.startTrackingHeapObjects` works through V8 fallback in
  `workerd`.

Needs live validation:

- Whether allocation sampling returns useful call frames and sizes in Workers.
- Whether allocation instrumentation emits `heapStatsUpdate` and
  `lastSeenObjectId` events in Workers.
- Whether `stopTrackingHeapObjects(true)` emits a final snapshot compatible
  with the upstream DevTools UI.
- Whether a minimal Worker trace can satisfy DevTools' `Meta` handler without a
  frontend adaptation.
