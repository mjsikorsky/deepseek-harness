# Agent Note: Deployment access and Agent publication

Status: implemented

English | [中文](2026-09-13-deployment-access-and-agent-publication.zh.md)

## Problem

A shared Host needs request-bound authorization across native unary calls, mux streams and approval replies. Filtering search results after pagination can hide readable results. Assigning authority only after Agent creation exposes an unpublished ownership gap, and an awaited durable append can outlive a previously checked grant.

## Decision

Gateway admits a deployment-owned lease from the original carrier request, checks dispatch and delivery, and closes revoked carriers. Native mux and RPC codecs remain unchanged. The required-policy configuration fails closed when no provider admits the request. Hidden waterfall deliveries leave pending accounting and delegate when no actual recipient remains.

SessionController consults its visibility provider before native list collection and search pagination. AgentLoop composes deployment preparation with caller setup for every creation path, awaits durable seed persistence, runs synchronous commits, and publishes without another await. Deployment plugins own identity verification, immutable workspace mappings, durable ACLs and execution capabilities.

The native Client socket factory preserves Remote mux framing while letting a shell acquire fresh per-attempt admission. Cancellation closes late asynchronous factory results. [DeepTail](https://github.com/d4551/DeepTail) at `69696916832b02c0ecdd9ce625aeae93c7787cfc` (MIT) documented this missing physical-carrier extension; the implementation adds the native hook rather than copying its application transport.

Open-in-app authorizes host resource observations at its own native route owner. A deployment lease grants one canonical launch target; every primary, fallback and refreshed attempt rechecks that target and current authority. Keeping the policy beside the launcher prevents a native fallback from escaping a route-only check. Browser authentication alone does not authorize a workspace directory or host-machine action. Admission ownership covers both late fulfillment and cancellation during promise handoff.

The third `prepare(agentCtx, agent, capabilities)` argument is frozen: `parent` is the explicit factory parent Agent, independent of ambient initiator attribution, and `terminate` is an exact-Agent authority termination capability. Calling `terminate()` synchronously stops current work, retains queued Inbox input, and begins the native persistence drain, scope cleanup and registry removal. It returns `void`, so a pre-step listener cannot await its own teardown; the factory observes asynchronous failures. Repeated calls share the first teardown and its Inbox policy. An old capability cannot terminate a fresh Agent resumed from the same Session. Ordinary `AgentHandle.dispose()` keeps its existing clear-Inbox behavior when it initiates teardown.

Session export captures a finite reader from the same visibility owner before returning a streaming response. Capturing an invocation stack would preserve an inactive ambient slot rather than current authority. The reader instead retains the immutable principal and request lifetime and rereads each resource policy. Descendant discovery grants no inherited read access; attachment streaming rechecks a currently readable referring Session around each chunk read. Revocation fails the archive rather than producing a success-shaped partial export.

## Alternatives considered

Replacing the RPC parser or mirroring Sessions creates competing native behavior. Post-result filtering cannot protect pre-publication events or restore search results already excluded by pagination. Caller-only setup misses direct configured Agents. These approaches were rejected.

## Consequences

Standalone configurations retain their existing behavior. Required deployment providers can deny native Remote traffic and Agent publication without replacing presets, model selection or tools. Connection also admits every HTTP RPC channel and exact Fetch route through a required deployment request policy, retaining its lease through native request and response streams. Gateway keeps operation-level checks. A cancelled lease releases promptly even if a handler or source ignores cancellation; late response bodies are cancelled. Separate WebServer registrations and WebSocket upgrades still belong to their route owners. Durable preparation is not atomic across services; its owner must reconcile interrupted writes. Browser authentication and Remote event decisions remain active with explicit partial supersession links.

## Verification

Focused native and composed policy tests cover direct reads, stream delivery, approval replies, missing authority, revocation, pre-pagination visibility and publication after real durable appends. Source-owned Loader and build qualification are recorded separately with their exact results.

The recorded SDK deployment-termination scenario and Python SDK projection exercise the same native lifecycle plugin: terminate an idle Agent, persist queued Inbox input, resume a distinct Agent on the same Session, and reject stale termination authority. Native pre-step tests cover active cancellation without self-await. Local Python qualification can use the built native Node CLI; packaged single-executable qualification remains a separate CI tier.
