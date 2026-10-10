<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.1.0
Bump rationale: MINOR. Adds two permitted exceptions to "Technology & Platform Standards"
(read-only external data sources, delegated authentication). No principle is removed or
redefined, so this is materially expanded guidance rather than a MAJOR change. Adopted in
the first pull request of the chinaparts-node-backend repository (research R21).

Modified principles: None. Principle II (BaseRepository) and Principle V (JWT guard) are
read together with the new exceptions; their text is unchanged.

Added sections:
  - Technology & Platform Standards → "Permitted exceptions" (two exceptions)

Removed sections: None

Templates requiring updates:
  - .specify/templates/plan-template.md ......... ✅ compatible (Constitution Check gate
        references the constitution generically)
  - .specify/templates/spec-template.md ......... ✅ compatible
  - .specify/templates/tasks-template.md ........ ✅ compatible
  - .specify/templates/checklist-template.md .... ✅ compatible

Runtime guidance docs:
  - CLAUDE.md ................................... ✅ points to the active feature plan
  - README.md ................................... ✅ states the fork source

Deferred TODOs: None.

History:
  - 1.0.0 (2026-06-10): first ratified in chat-app-backend. Copied here unchanged, then
    amended to 1.1.0 on 2026-10-10.
-->

# Backend Constitution (China Parts Reels Service)

The non-negotiable engineering principles for NestJS + TypeScript backends built on
MongoDB/Mongoose and Redis. These principles govern how code is structured, typed,
validated, secured, and reviewed.

This repository (`chinaparts-node-backend`, the China Parts reels service) adopted the
constitution from `chat-app-backend` v1.0.0 and amended it to v1.1.0. Principles that
mention WebSockets or Socket.IO apply only to features that have real-time channels; this
service has none.

## Core Principles

### I. Modular Feature Architecture

Every domain capability MUST live in a self-contained feature module under
`src/modules/<feature>/`, wired through a NestJS `@Module` that declares its own
controllers, providers, and `MongooseModule.forFeature` schemas. Cross-cutting,
domain-agnostic concerns (filters, guards, interceptors, adapters, base repositories,
storage backends) MUST live under `src/common/` and never under a feature module.

Rules:
- A module MUST explicitly `exports` only the providers other modules legitimately depend
  on; inter-module access goes through these exports, never through deep relative imports
  into another module's internals.
- A module MUST NOT reach into another module's private files (services, repositories) by
  path; it MUST `import` the owning module and inject the exported provider.
- Shared infrastructure clients (Redis, JWT, queues) MUST be provided by dedicated modules
  and injected, not re-instantiated per feature.

Rationale: Feature isolation keeps the dependency graph acyclic and reviewable, lets
modules be tested and reasoned about independently, and prevents the "big ball of mud"
coupling that makes real-time backends fragile as they grow.

### II. Layered Separation of Concerns

Each request MUST flow through clearly separated layers, each with a single
responsibility:

- **Boundary** (Controllers / Gateways): translate HTTP/WebSocket I/O, apply guards and
  validation, and delegate. They MUST stay thin — no business rules, no direct database
  access.
- **Service**: owns business logic, orchestration, and domain decisions. Services MUST NOT
  build raw Mongoose queries inline; they call repositories.
- **Repository**: owns all data access. Feature repositories MUST extend the generic
  `BaseRepository<T>` (`src/common/repositories/base.repository.ts`) and are the only layer
  permitted to touch a Mongoose `Model`.
- **Schema / DTO**: define persistence shape (Mongoose `@Schema`) and transport shape
  (class-validator DTOs) respectively, and MUST remain distinct types.

Rationale: This is the dominant pattern already in the codebase (e.g. `AuthController` →
`AuthService` → `UsersRepository`). Enforcing it keeps controllers swappable, business
logic unit-testable without HTTP, and data-access changes localized to repositories.

### III. Strict Type Safety (NON-NEGOTIABLE)

The codebase MUST move toward and maintain end-to-end type soundness. TypeScript's full
`strict` family MUST be enabled in `tsconfig.json` (`strict: true`, which includes
`strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, `strictBindCallApply`, and
`alwaysStrict`).

Rules:
- New and modified code MUST NOT introduce `any`. Use precise types, `unknown` with
  narrowing, generics, or declared interfaces (e.g. `JwtPayload`, `AuthenticatedSocket`).
  Existing `any` is treated as technical debt to be removed when a file is touched.
- Public method signatures (controllers, services, repositories) MUST declare explicit
  parameter and return types; do not rely on inference across module boundaries.
- `@typescript-eslint/no-floating-promises` and `no-unsafe-argument` MUST be resolved, not
  suppressed; every Promise is awaited or explicitly handled.
- Type assertions (`as X`) and non-null assertions (`!`) require a justifying comment when
  they cannot be replaced by a proper guard.

Rationale: Strong typing is the cheapest defect-prevention available. The project already
opts into `strictNullChecks` and `noImplicitAny`; completing the strict surface and
eliminating `any` removes whole classes of runtime errors in async, real-time code paths.

### IV. Validated Boundaries & Standardized Contracts

Every value crossing a trust boundary MUST be validated, and every response MUST follow
the standard envelope.

Rules:
- All request payloads (REST bodies/queries and WebSocket messages) MUST be typed
  class-validator DTOs. The global `ValidationPipe` configuration
  (`whitelist`, `forbidNonWhitelisted`, `transform`) MUST remain enabled; unknown fields
  are rejected, not silently accepted.
- Success responses MUST conform to the `GlobalResponseInterceptor` envelope
  (`{ success, data, message }`) and errors to `GlobalExceptionFilter`
  (`{ success, error, message, statusCode }`). Controllers MUST NOT hand-roll alternative
  shapes.
- Internal error details (stack traces, driver messages) MUST NEVER be returned to
  clients; they are logged server-side and surfaced as generic messages.
- Environment configuration MUST be read through `ConfigService` and validated by the Joi
  schema in `AppModule`. New environment variables MUST be added to that schema. Direct
  `process.env` reads in feature code are prohibited (bootstrap in `main.ts` excepted).
- Client-facing contract strings/shapes that an external client depends on (e.g. the
  Flutter auth error sentinels in `auth.service.ts`) MUST be treated as load-bearing: they
  are documented at the definition site and changed only with a coordinated client update.

Rationale: Centralized validation and a uniform contract make the API predictable for the
Flutter client, shrink the attack surface, and keep error handling consistent and safe.

### V. Security by Default

Security controls are mandatory infrastructure, not per-endpoint afterthoughts.

Rules:
- HTTP hardening (`helmet`), strict CORS, and input sanitization (`express-mongo-sanitize`,
  XSS cleaning) MUST remain enabled at the application edge.
- Authenticated routes and gateway connections MUST enforce identity via the JWT guard /
  strategy; WebSocket connections MUST authenticate the socket before joining rooms or
  emitting.
- Secrets and credentials MUST come from validated config, never be hard-coded. Passwords
  MUST be hashed with `bcrypt`; raw passwords are never logged or returned.
- Queries returning user data MUST project only the fields the caller is entitled to.
  Sensitive fields (`password`, `refreshToken`, tokens, payment identifiers) MUST be
  excluded from any client-facing payload (via `.select(...)` projections or stripping
  before serialization).
- Rate limiting (`ThrottlerModule` backed by Redis) MUST protect public and abuse-prone
  endpoints.

Rationale: A messaging backend handles identities, contacts, location, and payment data.
Defense-in-depth defaults ensure a missed annotation degrades safely rather than leaking
data.

### VI. Performance & Scalability by Design

Code MUST be written for a horizontally scaled, multi-instance deployment.

Rules:
- Read queries that do not need Mongoose documents MUST use `.lean()` and field
  projections; never fetch whole documents to read one field.
- Query paths MUST be backed by appropriate indexes (e.g. unique/secondary indexes,
  `2dsphere` for geo). New high-cardinality query filters require a corresponding index.
- Independent async operations MUST be parallelized (`Promise.all`) rather than awaited
  serially.
- Real-time fan-out MUST go through the Redis Socket.IO adapter so events broadcast across
  instances; gateways MUST NOT assume single-process in-memory state is authoritative for
  cross-instance delivery.
- Expensive, deferrable, or retry-prone work MUST be offloaded to BullMQ queues rather than
  blocking the request/socket path. Hot ephemeral state belongs in Redis, not in-process
  maps that won't survive scale-out.

Rationale: The service already adopts Redis adapters, queues, lean reads, and geo indexes;
codifying these prevents regressions that only surface under multi-instance production
load.

### VII. Clean Code & Test Discipline

Code MUST be readable, consistent, and accompanied by meaningful tests.

Rules:
- Formatting and linting are enforced: code MUST pass `npm run lint` and Prettier
  (`singleQuote`, `trailingComma: all`) with no errors before merge. CI-equivalent checks
  MUST be green.
- Naming MUST follow existing conventions: `*.controller.ts`, `*.service.ts`,
  `*.repository.ts`, `*.gateway.ts`, `*.module.ts`, `*.schema.ts`, DTOs under `dto/`,
  schemas under `schemas/`.
- Functions MUST be small and single-purpose; deeply nested logic and duplicated query
  code MUST be refactored into services/repositories. Non-obvious decisions (workarounds,
  contract couplings, security choices) MUST carry a short explanatory comment.
- Every service and gateway with business logic MUST have colocated `*.spec.ts` unit tests
  covering its core paths and failure modes. Bug fixes MUST add a regression test.
- `TODO` markers that gate production readiness (e.g. temporary OTP/auth shortcuts) MUST be
  tracked and resolved before release, not silently shipped.

Rationale: Consistency and tests are what let a small team change real-time code
confidently; they keep review focused on behavior rather than style and catch regressions
in concurrency-sensitive paths.

## Technology & Platform Standards

The following stack is the sanctioned baseline; deviations require justification under
Governance.

- **Runtime/Framework**: Node.js with NestJS 11 (`@nestjs/*`), TypeScript 5.7+.
- **Persistence**: MongoDB via Mongoose 9 (`@nestjs/mongoose`). All access through
  repositories extending `BaseRepository`, except for the read-only external data source
  exception below.
- **Cache / Real-time / Queues**: Redis (`ioredis`), Socket.IO with the Redis adapter for
  WebSockets, BullMQ for background jobs.
- **Auth**: Passport JWT (`@nestjs/passport`, `passport-jwt`), `bcrypt` for hashing, except
  for the delegated authentication exception below.
- **Validation/Config**: `class-validator` + `class-transformer` for DTOs, `Joi` for
  environment schema, `@nestjs/config` for access.
- **Integrations**: LiveKit (calls), Firebase Admin (push), as isolated modules.
- **Build/Test/Tooling**: `nest build`, Jest + `ts-jest`, ESLint (typescript-eslint
  type-checked config) + Prettier. Containerized via the provided Dockerfile /
  docker-compose.

New runtime dependencies MUST be justified (capability not already covered), kept current
on security patches, and integrated behind a module boundary rather than imported ad hoc
throughout features.

### Permitted exceptions

Both exceptions MUST be named in the feature plan's Complexity Tracking table with the
reason they are needed. Anything not met below is an undocumented deviation.

1. **Read-only external data sources.** A service MAY read a database it does not own (for
   example a platform's MySQL) when the feature requires that platform to stay the single
   source of truth. Conditions:
   - All access goes through one dedicated integration module (for example
     `src/modules/china-parts/`); no other module opens a connection to it.
   - The database user has column-level `SELECT` grants only, on exactly the columns the
     feature needs. Write access and private fields must be physically impossible, and the
     columns are listed in the feature's contracts.
   - Queries are parameterized and name their columns. `SELECT *` is not used. Identifiers
     that cannot be parameters come from validated configuration and are quoted.
   - A failure to reach the source is surfaced as a distinct, documented error. It is never
     treated as "no data" and never grants access.
   - The repositories that read it are exempt from `BaseRepository` (Principle II), because
     that class is Mongoose-only. They still never contain business logic.
2. **Delegated authentication.** When a feature requires single sign-on with an existing
   host platform's sessions, a service MAY validate that platform's tokens (for example
   Laravel Sanctum personal access tokens) instead of issuing its own Passport JWTs.
   Conditions:
   - Token validation lives in one Passport strategy and one guard chain. Secrets are
     compared in constant time and raw tokens are never logged or cached; caches are keyed
     by a hash.
   - Revocation latency is bounded and documented in the plan.
   - A token that fails validation is refused. It is never downgraded to anonymous access.
   - The service does not write to the host platform's session store.

## Development Workflow & Quality Gates

These gates apply to every change before it is considered complete.

- **Pre-merge gates** (all MUST pass): `npm run build` (no type errors), `npm run lint`
  (no errors), and `npm test` (relevant suites green). Formatting MUST be applied.
- **Layer review**: reviewers MUST confirm controllers stay thin, data access stays in
  repositories, DTO validation is present on new inputs, and responses use the standard
  envelope.
- **Security review**: reviewers MUST confirm new endpoints/gateways are guarded as
  intended, no secrets are committed, and no sensitive fields leak in responses or logs.
- **Type-safety review**: new `any`, suppressed lint rules, unhandled promises, or
  unjustified type assertions are blocking review comments.
- **Spec Kit flow**: feature work proceeds through the Spec Kit lifecycle (specify → plan →
  tasks → implement). The plan's "Constitution Check" MUST be completed and any violation
  recorded with justification before implementation.
- **Contract changes**: any change to a client-facing contract (response shapes, auth
  sentinels, socket event names/payloads) MUST be called out in the PR and coordinated with
  the consuming client.

## Governance

This constitution supersedes ad hoc conventions and prior informal practice. Where another
document conflicts with it, this constitution wins until formally amended.

- **Authority**: All PRs and reviews MUST verify compliance with these principles.
  Reviewers are empowered (and expected) to block merges that violate a MUST rule.
- **Amendments**: Changes to this constitution MUST be proposed via PR that edits this
  file, states the rationale, and updates the version and Sync Impact Report. Approval
  follows the normal code-review process; merging the PR ratifies the amendment.
- **Versioning policy** (semantic):
  - **MAJOR**: removal or backward-incompatible redefinition of a principle or governance
    rule.
  - **MINOR**: a new principle/section, or materially expanded mandatory guidance.
  - **PATCH**: clarifications, wording, or non-semantic refinements.
- **Compliance review**: when a MUST rule cannot be met, the deviation MUST be documented
  in the relevant plan's Complexity/Constitution-Check section with the reason and a
  remediation path; undocumented deviations are defects.
- **Living debt**: pre-existing violations (e.g. residual `any`, partial `strict` config,
  temporary auth shortcuts) are recognized debt and MUST be corrected opportunistically
  when the surrounding code is modified, and before production release where flagged.
- **Runtime guidance**: agent and contributor runtime guidance lives in `CLAUDE.md` and the
  active feature plan; those documents MUST stay consistent with this constitution.

**Version**: 1.1.0 | **Ratified**: 2026-06-10 | **Last Amended**: 2026-10-10
