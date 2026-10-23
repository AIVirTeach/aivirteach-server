# Learning domain boundaries and PR delivery

Status: agreed design; implementation incomplete. Existing server #34 and client #22 are draft source PRs. No merge or deployment is authorized by this plan.

## Ownership and principles

Course content owns drafts, immutable published versions and stable lesson IDs. Learning owns enrollment, generation, reading position, completion and historical achievements. Assessment owns attempts and PASS evidence. Chat owns questions, replies and their explicit context. Labs owns execution and environment lifecycle.

1. Every chat request supplies courseVersionId, lessonId and generation. Never infer context from reading position, completion percentage or previous messages.
2. Client identifiers express intent. The server checks ownership and version membership and loads trusted lesson instructions.
3. Reading, completion and assessment are independent commands. Chat does not mutate their business state.
4. An accepted question retains its version and lesson throughout execution. Publication must not silently replace its context.
5. Check generation before accepting work and before saving results. Old responses must not enter a restarted learning session.
6. Agent calls run outside database transactions. Use short transactions around acceptance and finalization.
7. Invalid or stale context produces an explicit error. Never fall back to the first lesson or latest version.
8. Streaming and ordinary chat share validation, context construction and persistence rules.
9. Migrate all callers and delete obsolete endpoints. There are no users requiring a legacy compatibility layer.
10. Tests accompany each behavior change. Passing builds does not establish browser or production acceptance.

## Contracts

Completion: lessonId, courseVersionId, generation, revision, completed. Reading: lessonId, courseVersionId, generation. Chat: requestId, text, context containing courseVersionId, lessonId and generation. Enrollment comes from the route and identity from authentication.

requestId correlates a question and reply. Repeated requests need a defined uniqueness scope and duplicate-in-flight result before implementation; correlation alone does not establish idempotence.

Both clients send context from successfully loaded content. Disable send while changing lessons. Keep already submitted questions bound to their original context. Reading persistence is a resume aid, not the authority for current chat context. A reading save failure should allow reading and explicitly scoped chat while exposing a retry.

For a new request, reject an outdated published version with a stable conflict code. After acceptance, finish using the captured version. Recheck generation when persisting results. Verify published versions are immutable and retained before relying on references instead of content snapshots.

## Chat persistence and flow

Store requestId, generation, courseVersionId and lessonContentId as explicit context, separate from Agent diagnostic JSON. Current Conversation.contextRef receives Agent responses and is not yet this contract. Select uniqueness constraints and migration details in the chat PR.

Validate context and save the user question in a short transaction. Call Agent outside the transaction. Recheck the generation and save the reply in a second short transaction. Apply the same rules to ordinary and streaming paths, including suppression of late UI results after restart.

## PR sequence

| Slice | Contents | Dependency |
| --- | --- | --- |
| Design | This decision, principles and acceptance matrix | main |
| Progress model | Schema, migration, pure completed-ID projection and its tests | main |
| Progress API | Commands, dashboard/enrollment integration, HTTP tests and verification script | Progress model |
| Client controller | API additions, progress controller/hook and controller tests | client main |
| Client pages | V1/V2 integration, loader tests, remove old client completion caller | Client controller; Progress API contract |
| Chat API | Explicit context, persistence, shared streaming rules, remove legacy completion endpoint and implicit context path | Progress API |
| Chat client | Explicit loaded-lesson context in both layouts and late-response protection | Client pages; Chat API contract |

The first four implementation slices reorganize existing code; they do not complete the new chat architecture. Retain legacy client method only in the controller base so existing callers compile; remove it in the page slice. The existing legacy server adapter remains a known blocker in the extracted API draft until the chat/API cleanup removes it. Do not restore automatic reading advancement.

## Acceptance matrix

- Completion changes neither reading nor assessment PASS; reading never completes a lesson.
- Retry, unmark, concurrent revision, restart and publication preserve the tested learning rules.
- Two tabs viewing different lessons send different correct tutor contexts.
- A forged lesson/version pair is rejected before Agent invocation.
- A stale new request is rejected; publication during an accepted question does not switch content.
- Restart during Agent work cannot inject the old response into the new generation.
- Reading persistence failure does not force chat to guess context.
- V1 streaming and V2 ordinary chat enforce identical business rules.
- Operator edit, preview, save, publish and learner reading require real end-to-end acceptance.

## Release boundary

Draft PRs are review slices, not independent deployment units. Breaking client/server contract changes require a coordinated release. No legacy fallback is planned. Check provider Git integrations before merging; absence of .github/workflows is not proof that auto-deployment is disabled. Neither repository has a checked-in GitHub Actions workflow at the inspected baselines (server 6b5f00d, client 5392a6e). Provider auto-deployment state remains unverified.

Existing full-suite counts in source PRs are historical evidence for the original combined implementation, not fresh validation of each split. Record actual split checks in each PR. Browser, real Labs/VM and production acceptance remain pending.
