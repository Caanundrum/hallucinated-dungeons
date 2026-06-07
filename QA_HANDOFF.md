# Hallucinated Dungeons QA Handoff

Date: 2026-06-07
QA thread role: read-only QA, no development changes.

## Summary

Production smoke test passed with one confirmed rules-engine bug and one minor accessibility note. Client lint passed. Server tests pass outside the restricted Codex sandbox.

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
