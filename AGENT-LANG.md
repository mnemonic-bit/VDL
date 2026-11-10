# Agent language

Use these rules for natural-language text that an agent authors: session messages, task assignments, specifications, plans, reports, review findings, state files, documentation, code comments, and tool descriptions. Apply the rules to prose inside structured fields as well as prose in Markdown. Preserve the syntax of code, commands, quoted source material, and formats required by a user or tool. Higher-priority instructions and a document's required schema take precedence over this guide.

The aim is to let the next reader identify the intended action, its conditions, and the evidence for its result. Use ordinary technical prose. A short answer does not need a template.

## Rules for every output

1. **Use one term for one concept.** Reuse a defined term. Define a domain term or abbreviation when its meaning is not clear from context. Use declared workflow values exactly; do not replace `completed` with `done` if `completed` is the defined state.
2. **Name the referent.** Use exact names for files, symbols, commands, branches, tasks, criteria, and artifacts. Replace `it`, `this`, or `that` when more than one referent is possible. Use stable identifiers when a reader must find the item later.
3. **State one action per instruction.** Start an instruction with an action verb. Name the responsible actor when the reader is not the actor. Put a condition before the action: “If the import fails, record the error.” State what happens when the other branch matters.
4. **Separate outcome from method.** A goal says what result is wanted. An instruction says what to do. A constraint limits what an actor may do. An acceptance criterion says what observable result establishes completion.
5. **Use obligation words consistently.** `Must` means required; `must not` means prohibited; `may` means permitted; `should` means recommended. Use these words only when the distinction matters. State hard constraints directly.
6. **Make conditions and criteria observable.** Name the trigger, scope, limit, and expected result when they affect the decision. Replace terms such as “as needed,” “properly,” “robust,” and “works” with the behavior or check meant by the term. An acceptance criterion must have a way to verify it.
7. **Keep claims tied to evidence.** Distinguish observed facts, source claims, assumptions, and inferences. For consequential claims, identify the source, artifact, command result, or revision that supports them. Do not describe a check as passed unless its result is known.
8. **Report uncertainty where it changes a decision.** If a missing or conflicting fact can change the action or acceptance result, identify the fact and ask for clarification. If work can proceed safely, label the assumption and continue. Name the affected work when only part of a task is blocked.
9. **Keep the reading path clear.** Put the decision or result first, then the details needed to act on it. Keep one topic per paragraph and use lists for separate actions or findings. Include necessary context; omit repeated background and unexplained “etc.”

These rules apply to all authored prose. Do not force a fixed form onto a brief answer or exploratory discussion. Use the stronger record rules below when another agent or a later session will rely on the text.

## Handoffs, specifications, reports, and state files

Include the following information when it is needed to perform or verify the work. Use the format required by the surrounding system; these are content requirements, not a mandatory YAML schema.

- **Task or decision:** State the requested outcome, the actor or owner, and the relevant baseline or version.
- **Scope and inputs:** Name the files, artifacts, requirements, and constraints that control the work. Point to durable material instead of copying a long history.
- **Actions:** Give separate, ordered instructions. Put preconditions before dependent actions.
- **Acceptance:** Give each mandatory criterion an observable result and a verification method. Assign stable IDs when criteria will be tracked across messages or revisions.
- **Result:** For each reported check, use `passed`, `failed`, `not_run`, or `inconclusive`, unless a declared schema defines other values. Include the command, artifact, or observation that supports the result. State why a check was not run or was inconclusive when that affects acceptance.
- **Status:** Use the declared state names and transition rules when a workflow defines them. Report `completed` only when every mandatory criterion has passed. Report a blocker with its cause, the affected work, and the next action or decision owner. An agent's prose does not authorize a state transition owned by another system or person.
- **Open items:** Label assumptions, unresolved risks, and questions separately from completed work. Identify the exact conflict and bounded choices in a clarification request when possible.

Keep machine-owned values, such as IDs, state, owner, revision, and check results, in their structured fields when such fields exist. Keep prose fields focused on meaning that the fields cannot express. Preserve the schema's field names and enum values.

## Examples

| Unclear | Controlled |
| --- | --- |
| “Fix it and check that it works.” | “Update `ImportService`. Run `ImportServiceTests`. Report the command and exit code.” |
| “Use the fallback if needed.” | “If the primary endpoint returns HTTP 503, call the fallback endpoint.” |
| “The tests passed.” | “`pytest tests/test_import.py` exited with code 0 on commit `abc123`.” |
| “The change is basically complete.” | “Status: `blocked`. Check `AC-2`: `failed`. The imported file remains after cancellation. Next action: correct cleanup in `ImportService`.” |

Before sending or saving, check that each instruction has an actor and action, each completion claim has evidence, each condition has a clear effect, and each unresolved decision is visible to the next reader.
