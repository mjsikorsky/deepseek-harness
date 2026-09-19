# Agent Note: Independent Session views

Status: implemented

English | [中文](2026-09-19-independent-session-views.zh.md)

## Problem

An embedding application can display several Sessions at once. Calling the selected-session operation for each panel changes another panel's selection and cannot describe independently owned views.

## Decision

Session Controller exposes `acquireView(id)`, returning its existing native binding and an idempotent release operation. Only eligible listed Sessions can acquire a new view. Leases retain removed scopes until the last view releases; client disposal drains all scopes. An optional client `persistSelection: false` configuration leaves selection storage to the embedding application. The default remains unchanged.

## Alternatives considered

**Switch the selected Session for every panel.** This changes shared navigation state and does not represent independent view lifetimes.

**Implement a second Session reducer.** Native event folding, reconnect and prompt submission already belong to Session Controller. The lease reuses them.

## Consequences

Closing a view releases client resources without cancelling or deleting Host work. A held view is not authority to acquire another view of an unavailable Session. The owning client tests cover independent acquisition, release, selection and disposal. This change does not implement an embedding application's admission or resource authorization.
