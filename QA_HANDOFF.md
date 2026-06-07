# Hallucinated Dungeons QA Handoff

Date: 2026-06-07
QA thread role: read-only QA, no development changes.

## Summary

Latest production playtest passed core flow checks, with one new rules-answer bug and one discovery follow-up bug for DEV to fix. Client lint passed. Server tests pass.

## Latest QA Pass - 2026-06-07 After DEV Fix `52260cb`

Scope:

- Inspected latest commits: `caf4ea2 Target QA Fix`, `52260cb Keep equipment out of active effects display`.
- Played production at `https://hallucinated-dungeons.vercel.app/` using existing `QA Smoke` character.
- Rechecked local automation after production play.

Verified fixed / passed:

- Equipment display after additional state sync: PASS. Character Sheet now shows `Active Effects -> No active effects.` and lists `Shield` / `Chain Mail` only under `Equipped Defenses`.
- Lantern Bridge movement continuity: PASS. `Go to lantern bridge.` produced coherent location narration with no roll.
- Pending roll gating: PASS. `Pause and look around first.` requested exactly one `Roll 1d20 +2`; story input locked during the pending Perception roll and unlocked after resolution.
- Production console: PASS. No warn/error logs observed during this latest pass.
- Automated checks: PASS. Client `npm.cmd run lint` passed. Server `npm.cmd test` passed `408/408`.

New / still failing:

### P2: DM2 exact AC-source answer omits Defense and prints raw formula token

Production prompt after Character Sheet showed no active effects:

```text
List my AC sources exactly.
```

Observed DM2 answer:

```text
Your AC sources on this sheet are:
- Chain Mail: armor_formula
- Shield (equipped): +2
Total AC shown on your sheet: 19 (i.e., Chain Mail + Shield; no other temporary spell effects are listed).
```

Expected:

```text
Chain Mail: 16
Shield (equipped): +2
Fighting Style: Defense: +1 while wearing armor
Total: 19
```

Impact:

The UI sheet is now clean, but the rules assistant still cannot produce the exact AC source list from the sheet. It exposes an internal token (`armor_formula`) and makes the math incomplete by saying Chain Mail + Shield explains AC 19.

Suggested fix:

Provide DM2 a structured AC breakdown that includes passive class/style modifiers such as Defense, and render armor formulas to player-facing numbers before answering.

### P2/P3: Discovery follow-up asks for another check instead of revealing known notice details

Production sequence:

```text
Study notice board.
```

Result:

```text
Discovery: notice board pinned with requests and warnings now has a successful study result on record.
```

Follow-up:

```text
Read notice details.
```

Observed:

The game requested another DC 10 Intelligence (Investigation), then recorded a second synthetic target:

```text
Discovery: notice details now has a successful study result on record.
```

Expected:

After a successful study of the notice board, a follow-up read/details action should use the established `notice board` discovery and reveal fair details, not require another identical Investigation check and create `notice details` as a separate target.

Suggested fix:

When the player asks to read/reveal details after a successful discovery, resolve against the existing discovered target/subject before prompting a new check. Treat phrases like `notice details` as a follow-up intent for `notice board`, not a new searchable object.

Minor QA tooling note:

- Browser `fill` / `type` helpers still hit a local virtual-clipboard issue, so production entry was performed with direct key presses. This is a QA environment nuisance, not an app defect.

## Regression Pass - 2026-06-07 After QA Fixes

User reported the prior findings were fixed. QA reran targeted checks against latest local repo and production.

Verified fixed / passed:

- P1 active-combat invalid spell target retargeting: PASS locally. `Fire Bolt at the dragon` with only Skeleton present now blocks before outcome/damage.
- P2 Defense Fighting Style AC preview/review: PASS by code inspection and automated coverage. `client/src/CharacterWizard.jsx` now includes `Defense Fighting Style` in `calculateAcPreview`; server character validation test covers Defense AC 19.
- P3 redundant Switch narration for current character: PASS in production. Reselecting current `QA Smoke` through Switch did not add another join narration; before/after join narration count remained 2.
- P3 notice-board Investigation discovery target: PASS in automated coverage. `server/test/discoveryStateEngine.test.js` now covers `notice board` target and `missing road-workers` subject.
- Automated checks: PASS. Server `npm.cmd test` passed 407/407. Client `npm.cmd run lint` passed.

Still failing / needs follow-up:

- P3 equipment under Active Effects: PARTIAL/FAIL in production. Character Sheet now has an `Equipped Defenses` section, but the same Shield and Chain Mail entries still also appear under `Active Effects` as `Effect active`. This remains confusing and keeps equipment mixed with temporary active effects.

Production note:

- Browser text-entry helpers hit a local virtual-clipboard failure while attempting to create a fresh visible AC-retest character. QA did not claim a fresh production creation pass for AC preview after that point; AC preview fix was verified from current code/tests instead.

## Confirmed Bug

### P1: Explicit invalid spell targets in active combat silently retarget to the first enemy

File: `server/src/spellEffectEngine.js`

Relevant area:

- `validateRequiredSpellTarget()` lines around 509-522 validates that a target exists.
- `getSpellTargetContext()` lines around 525-538 handles active-combat target lookup.
- The active-combat lookup falls back to `firstEnemy(combat)` when an explicit requested target does not match.

Observed behavior:

```text
Input: I cast Fire Bolt at the dragon.
Combatants: Mira, Skeleton
Actual: Fire Bolt resolves against Skeleton.
Expected: Block with spell_no_target / no established target.
```

Read-only reproduction output:

```text
blocked: false
outcomeLogType: spell_combat
outcomeReply: You cast **Fire Bolt** at Skeleton. Spell attack: 12+5 = 17 vs AC 12.
```

Impact:

The latest target-validation work blocks absent scene targets outside combat, but active combat still allows a named invalid target to hit the first living enemy. This can cause the engine to resolve against a target the player did not choose.

Suggested fix:

If `requestedId` or `requestedName` is present and no active combatant matches, return no target/null instead of falling back to `firstEnemy(combat)`. Only use `firstEnemy(combat)` when the player did not explicitly name a target.

Suggested regression test:

Add a combat spell test where the only enemy is Skeleton and the player casts `Fire Bolt at the dragon`; assert the cast/outcome is blocked with `spell_no_target` and Skeleton HP remains unchanged.

### P2: Character creation AC preview/review underreports Defense fighting style

Production extended test created a Human Fighter with:

- Chain Mail
- Shield
- Defense Fighting Style
- DEX 14

Creation Review and Live Impact showed:

```text
AC: 18 (Chain Mail +16, DEX cap 0 +0, Shield +2)
```

After confirming the character, the saved Character Sheet and character picker showed:

```text
AC 19
```

The saved value is likely correct because Defense adds +1 AC while wearing armor. The bug is that the creation preview/review AC breakdown appears to omit Defense, which can mislead players before they confirm.

Suggested fix:

Include passive AC bonuses from fighting styles/features in the character creation preview and review breakdown. Expected preview:

```text
AC: 19 (Chain Mail +16, DEX cap 0 +0, Shield +2, Defense +1)
```

### P3: Equipment shield is presented as an "Active Effect"

After confirming the same Fighter, the Character Sheet displayed:

```text
Active Effects
Shield
+2 AC
Chain Mail
AC 16 + Dex cap 0 (chain mail)
```

This is confusing because Shield here is equipment, not the Shield spell or a temporary active effect. DM2 also echoed the confusion by describing "Shield (active effect): adds +2 AC."

Suggested fix:

Move equipped armor/shield modifiers out of `Active Effects` and into an equipment/passive defense section, or relabel the section so equipment is not mistaken for temporary spell/effect state.

### P3: Reselecting the current character from Switch triggers redundant join narration

Production test:

1. Created and confirmed `QA Smoke`.
2. Campaign started normally.
3. Clicked `Switch`.
4. Clicked the already-current `QA Smoke` card.

Observed:

The app returned to the campaign, but GM added a new narration saying QA Smoke is now with the party.

Expected:

Reselecting the currently active character should return to the campaign without generating a party join/change narration.

Suggested fix:

If the selected character is already active/current for this browser session, treat selection as navigation only and skip party-change narration.

### P3: Investigation success on an explicit notice-board search does not create a discovery target

Production test action:

```text
I inspect the notice board and look for details about the missing road-workers.
```

GM requested:

```text
DC 10 Intelligence (Investigation)
```

Roll succeeded:

```text
Roll 11 (natural 10; 10+1=11) vs DC 10: success.
```

But the deterministic result said:

```text
Discovery: no clear searchable or studyable target was identified, so no lasting discovery state changes.
```

The user named a clear target (`notice board`) and a clear subject (`missing road-workers`). This may be a target-extraction gap in the discovery/state update path.

Suggested fix:

Teach the discovery resolver to recognize common inspection targets like "notice board" and preserve the subject being investigated.

## Minor Accessibility Note

### P3: Human Size select is operable but not label-bound

File: `client/src/CharacterWizard.jsx`

The deployed page exposes the Human size choice as a visible "Size" label plus a native select. The select works and Step 1 unlocks after choosing Medium, but browser accessibility lookup could not resolve it by label. DOM inspection showed the `<select>` had no `id`, `name`, or `aria-label`.

Impact is low because the control is visually usable, but it is worth binding the label or adding an accessible name.

## Production Smoke Test

URL: `https://hallucinated-dungeons.vercel.app/`

Result: Pass with notes.

- Page loaded.
- Title was `Hallucinated Dungeons`.
- Socket status showed `Connected`.
- Console had no warnings/errors during smoke.
- Initial state showed `Preparing character creation...` for about 10 seconds, then resolved into Phase 4A Character Creation.
- Filled a name, selected Human, selected two languages, selected Medium size.
- `Next` became enabled.
- Stopped before creating/submitting a character.

## Extended Production Test

After user approval for production testing, QA continued visibly in the in-app browser.

Created production test character:

```text
QA Smoke
Human Fighter level 1
Background: Soldier
Fighting Style: Defense
Weapon Mastery: Dagger, Longsword, Longbow
Origin feats: Savage Attacker, Tough
Human Skillful: Perception
Class skills: Acrobatics, Survival
Ability array: STR 17, DEX 14, CON 14, INT 12, WIS 10, CHA 8
Equipment: Longsword, Chain Mail, Shield, Dungeoneer's Pack, Soldier package
```

Verified:

- Confirm Character saved successfully.
- Main campaign UI loaded after confirmation.
- Opening scene generated.
- Character Sheet opened and displayed saved character.
- DM2 answered a sheet-aware AC question.
- DM1 accepted a story action.
- Pending Investigation roll was requested.
- Dice roller resolved the pending roll.
- Story input locked during pending roll and unlocked afterward.
- Page reload resumed the same session and preserved history.
- Switch opened the character picker.
- Reselecting QA Smoke returned to the campaign, with the redundant narration noted above.
- No browser console warnings/errors were observed during the extended production pass.

## Verification

Client:

```text
npm.cmd run lint
pass
```

Server:

```text
npm.cmd test
405 tests
405 pass
0 fail
```

Note:

The first sandboxed server test run failed with `spawn EPERM`. Rerunning with approved normal test permissions passed, so this looks like a local Codex sandbox permission issue, not an application defect.

## Security / Loophole Sweep Notes

No immediate red flags found for:

- `dangerouslySetInnerHTML`
- `innerHTML`
- `eval`
- `new Function`
- raw markdown HTML injection

The client uses `react-markdown`, which should escape raw HTML by default. Session tokens are stored in `localStorage`; acceptable for this app shape, but worth keeping in mind for future XSS hardening.
