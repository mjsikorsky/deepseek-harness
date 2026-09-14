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

## Alternatives considered

Replacing the RPC parser or mirroring Sessions creates competing native behavior. Post-result filtering cannot protect pre-publication events or restore search results already excluded by pagination. Caller-only setup misses direct configured Agents. These approaches were rejected.

## Consequences

Standalone configurations retain their existing behavior. Required deployment providers can deny native Remote traffic and Agent publication without replacing presets, model selection or tools. Connection also admits every HTTP RPC channel and exact Fetch route through a required deployment request policy, retaining its lease through native request and response streams. Gateway keeps operation-level checks. A cancelled lease releases promptly even if a handler or source ignores cancellation; late response bodies are cancelled. Separate WebServer registrations and WebSocket upgrades still belong to their route owners. Durable preparation is not atomic across services; its owner must reconcile interrupted writes. Browser authentication and Remote event decisions remain active with explicit partial supersession links.

## Verification

Focused native and composed policy tests cover direct reads, stream delivery, approval replies, missing authority, revocation, pre-pagination visibility and publication after real durable appends. Source-owned Loader and build qualification are recorded separately with their exact results.
