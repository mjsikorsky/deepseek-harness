# Agent Note: Search executable follows the subprocess provider

Status: implemented

English | [中文](2026-09-13-subprocess-search-executable.zh.md)

## Problem

The search consumer launches ripgrep through the native subprocess provider but resolves the packaged binary on the host. A remote or container provider cannot execute that host path even when it supports the complete native subprocess interface and owns the intended workspace.

## Decision

The search package accepts an optional `executable` name or path. Both glob and grep resolve it through their selected subprocess provider, pass the current cancellation signal, and launch through that same provider. Resolution failure fails the call; there is no fallback to the host binary. Omission retains the packaged binary and single-file sidecar behavior.

## Alternatives considered

**Rewrite or copy the host binary into the guest.** That would make a transport responsible for this consumer's platform-specific dependency and could select a binary incompatible with the execution environment.

**Replace native glob and grep with product tools.** That would duplicate schemas, parsing, retention and cancellation behavior which the existing consumer already owns.

## Consequences

Deployments using a configured executable own its version and supported ripgrep flags. The native tools retain their existing arguments, `--no-config`, error classes, output limits and result semantics. Executable selection neither authorizes workspace access nor establishes cross-provider filesystem alignment. The focused native consumer tests cover both tools, resolution failure without fallback and cancellation before launch; container integration additionally proves the actual provider path.
