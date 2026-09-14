# Agent Note: Dynamic Host code admission

Status: implemented

English | [中文](2026-09-13-dynamic-host-code-admission.zh.md)

## Problem

Dynamic Host packages execute inside the shared DSH process. Their VM and Cordis façade support API correctness, not isolation from private sessions, credentials or other Host resources. Session collaboration permission therefore cannot authorize arbitrary Host source, and a Client's approval of future versions cannot silently authorize new Host code.

## Decision

The native runner retains its immutable package registry, exact-version card and Host/Client lifecycle. Shared deployments require `cordisHostActivationPolicy` through explicit configuration. The provider receives native session, plugin, package and run identities with the exact stored Host source. It derives elevated code-trust authority from verified deployment context; browser claims and ordinary session write access are insufficient.

The common Host activation path enforces the policy before evaluation, including direct panel calls. Host-only packages use the existing card and settle without loading Client source. Client authorization for future versions remains independent from exact Host authorization. Unconfigured personal compositions retain native direct Host-only activation.

A captured finite lease controls pending activation and native run lifetime. Native stop, undefine, provider revocation, expiry and runner disposal prevent late approvals or pending startup from publishing a run. The native owner captures cleanup ownership before publishing an asynchronous admission result. Ordinary fiber disposal remains the owner of mounted effects.

## Alternatives considered

**Only use the generic one-shot approval service.** Its requests require an open turn, whereas direct Cordis panel actions can occur outside a turn. It also cannot infer a deployment code-trust role. The existing exact-package card covers both lifecycle paths without adding another interaction system.

**Only install a reviewer plugin.** Independent review can inform a human decision, but review reminders and reviewer verdicts do not establish authenticated privilege or enforce every native activation path.

**Restrict the model's plugin catalog.** A fixed catalog would remove dynamic Cordis capabilities without making arbitrary accepted Host code isolated. Explicit trusted-code admission preserves native composition and leaves untrusted execution to its execution provider.

## Consequences

Deployments can preserve dynamic Host plugins while separating code trust from collaboration rights. The provider must implement real identity, current role checks and exact-source authorization. Revocation retracts native fibers and handlers; it does not undo earlier arbitrary Node side effects or revoke references trusted code deliberately retained. The VM remains outside the security boundary.

Focused native runner and card tests exercise fake policy fixtures, missing and denied authority, exact versions, future Client approvals, expiry, revocation, pending injections and late stop/undefine results. They do not prove a deployment's role verifier or signed proof issuer. Those owners require independent joined qualification.

The owner-local browser expectation drives the actual built Web Client and native Host runner through the user’s panel action, then revokes its finite fixture lease. It checks that no Host effect exists before the gesture, the policy receives the exact immutable source identity, revocation removes the native effect, and no model call is issued. The package is created before the Client’s initial inventory read; direct registry definition alone does not publish a tool card or refresh a previously loaded inventory.
