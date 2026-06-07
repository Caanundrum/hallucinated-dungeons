# Hallucinated Dungeons QA Handoff

Date: 2026-06-07
QA thread role: read-only QA, no development changes.

## Summary

Latest production regression pass confirms the remaining ration-count and rope-use issues are fixed in production. Client lint passed. Server tests pass.

## Latest QA Pass - 2026-06-07 After DEV Fix `d82268c`

Scope:

- Verified local `main` equals `origin/main` at `9752b67 Update QA_HANDOFF.md`; latest app-code fix is `d82268c Fix DM2 inventory counts and rope false positives`.
- Rechecked production at `https://hallucinated-dungeons.vercel.app/` using existing `QA Smoke` session.
- Rechecked local automation after the push.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `427/427`.

Verified fixed / passed in production:

- DM2 ration count after consumption: PASS. The previously blank response now shows:

```text
You had Rations x9 in your Dungeoneer's Pack, and the context says you just ate that ration.
So you now have Rations x8 left.
```

- Natural rope use: PASS. `i tie rope from my pack to the bridge rail before leaning over` now resolves with player-facing narration, says the hempen rope is tied securely to the bridge rail, and makes the line available for climbing/hauling/steadying.
- Production console: PASS. No warn/error logs observed during this pass.

QA note:

- A fresh DM2 question attempt hit the known browser automation typing issue where the Rules textarea duplicated automated keystrokes and kept `ASK` disabled. QA did not count that as an app defect because the visible production transcript already contained the corrected ration answer after reload.

Current blocker recommendation:

- No remaining P2 blocker from this targeted inventory/hazard pass. From QA's current evidence, DEV can proceed toward 4D leveling, with normal caution around resource/inventory state because that is the area most likely to regress.

## Latest QA Pass - 2026-06-07 After DEV Fix `2500df3`

Scope:

- Verified local `main` equals `origin/main` at `c302bd7 Update QA_HANDOFF.md`; latest app-code fix is `2500df3 Apply concrete hazard and inventory consequences`.
- Played production at `https://hallucinated-dungeons.vercel.app/` using existing `QA Smoke` session.
- Rechecked local automation after the push.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `423/423`.

Verified fixed / passed in production:

- Hazard failed consequence: PASS. `i jump into the water` requested DC 30 Athletics; failed result now says the character hits the water badly, armor/shield/pack pull them under, and they come up struggling below Lantern Bridge. It no longer shows the meta/template consequence text.
- Hazard roll gating: PASS. Pending roll locked input and cleared/unlocked after rolling.
- Ration consumption narration: PASS. `i eat one ration from my pack again` produced normal narration and said one more ration is gone.
- Production console: PASS. No warn/error logs observed during this pass.

Still failing / needs follow-up:

### P2: DM2 ration-count query returns blank after consumption

Production sequence:

```text
i eat one ration from my pack again
how many rations do i have left after eating that ration
```

Observed:

DM1 correctly narrated that one more ration was consumed. DM2 then produced an empty Rules response:

```text
RULES

ASK A RULES QUESTION
```

Expected:

DM2 should answer with the current ration count, or at minimum explain that exact consumable tracking is unavailable. A blank answer is worse than the previous stale `10 rations left` response.

Suggested fix:

Check the DM2/rules-summary path for consumed carried inventory quantities. Ensure the answer renderer handles updated consumable counts and does not emit an empty response when asked for post-consumption quantity.

### P2/P3: Natural rope use still denied in production

Production action:

```text
i tie rope from my pack to the bridge rail before leaning over
```

Observed:

```text
The Game Master lowers the screen and stares at you over it. That idea has been denied entry to the campaign, the tavern, and polite society. Try something else.
```

Expected:

The action should resolve using the known Hempen Rope from the carried Dungeoneer's Pack contents. Local tests now include `using rope from a pack resolves to carried Hempen Rope`, but production still rejects this natural phrasing in the current saved session.

Suggested fix:

Verify deployed code path and saved-session inventory normalization. This may be a legacy session/state mismatch, but the live player experience still rejects the clear action.

## Latest QA Pass - 2026-06-07 After DEV Fix `362a3b4`

Scope:

- Verified local `main` equals `origin/main` at `7cc4946 Inventory QA`; latest app-code fix is `362a3b4 Fix inventory state and hazard checks`.
- Played production at `https://hallucinated-dungeons.vercel.app/` using existing `QA Smoke` session.
- Rechecked local automation after the push.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `419/419`.

Verified fixed / passed in production:

- DM2 pack awareness: PASS. `what items are currently available from my pack now` listed Dungeoneer's Pack contents: bedroll, mess kit, tinderbox, Torch x10, Rations x10, waterskin, hempen rope, crowbar, hammer, pitons, etc.
- DM2 Second Wind awareness: PASS. `how many second wind uses do i have left now` returned `Second Wind: 1/2 remaining`.
- Second Wind at full HP: PASS. `i use second wind again` did not spend a use and clearly said full HP means no healing/use spent.
- Hazard gating: PARTIAL PASS. `i jump into the dark water again` now requested a DC 30 Strength (Athletics), locked input, and unlocked after the roll.
- Direct pack item use: PASS for rations. `i eat one ration from my pack` produced normal narration and said one ration was consumed.
- Production console: PASS. No warn/error logs observed during this pass.

Still failing / needs follow-up:

### P2: Failed hazard check returns meta consequence text instead of applying/narrating the consequence

Production action:

```text
i jump into the dark water again
```

Observed:

The game correctly prompted:

```text
Make a DC 30 Strength (Athletics).
```

After rolling failure:

```text
Roll 9 (natural 4; 4+5=9) vs DC 30: failure.

The physical challenge goes badly enough to create a real complication: lost position, danger, damage, fatigue, or another consequence that fits the scene.
```

Expected:

The referee should apply and narrate an actual consequence, such as being swept under the bridge, losing grip/position, taking damage, gaining a fatigue/exhaustion marker, losing/dropping an item, or being forced into another immediate danger state. The player should not see an instruction/template about what kind of consequence should happen.

Suggested fix:

Route failed hazard outcomes through player-facing narration/state mutation after the deterministic check resolves. The message should contain the chosen consequence, not the abstract consequence menu.

### P2: DM2 sees available pack contents but not consumed item counts

Production sequence:

```text
i eat one ration from my pack
how many rations do i have left in my pack now
```

Observed:

DM1 narrated:

```text
one ration is available and one is consumed.
```

DM2 answered:

```text
You currently have Rations x10 in your Dungeoneer’s Pack...
So the answer is: 10 rations left.
```

Expected:

After consuming one ration from an established pack count of 10, DM2 should answer 9 remaining, or state that consumption tracking is not authoritative yet. It should not ignore the just-established consumption.

Suggested fix:

Persist consumable item count changes into carried inventory state and include those current counts in DM2's rules-state summary.

### P3: Rope use still asks for a rephrase instead of executing a clear natural action

Production action:

```text
i tie rope from my pack to the bridge rail before leaning over
```

Observed:

```text
You can absolutely tie off the rope, but a small reality check first: your pack has been opened, and the rope is part of that pack’s contents, not a separate magical rope hidden in your sleeves.

If you want to proceed, you can say “I take out the hempen rope and tie it to the bridge rail before leaning over.”
```

Impact:

This is much better than the previous generic denial, but the original player action is already clear enough to execute. Asking for the exact rephrase still feels like a magic-phrase requirement.

Suggested fix:

Treat `tie rope from my pack` as equivalent to taking out the known hempen rope and tying it off. Only ask for clarification if multiple ropes/items exist or the target is unclear.

## Player Realism QA Pass - 2026-06-07

Scope:

- Played production as a realistic player using `QA Smoke` on Lantern Bridge.
- Focused on natural actions, item use, risky choices, rules questions, reload persistence, and limit behavior.
- No app code changes made by QA.

Verified passed:

- Movement continuity: PASS. `I step onto Lantern Bridge and keep my shield ready.` moved the character onto the bridge, listed visible objects, requested no unnecessary roll, and kept input enabled.
- Discovery/inspection gating: PASS. `I look over the side and search the dark water below.` requested a DC 15 Investigation roll, locked input, then unlocked after the roll resolved.
- Pack opening branch: PASS after explicit unpacking. `i open the dungeoneers pack and sort through the contents` revealed bedroll, mess kit, tinderbox, torches, rations, waterskin, and 50 feet of hempen rope.
- Torch use after unpacking: PASS. `i light a torch and hold it over the dark water` produced player-facing scene details after generation completed.
- Invalid combat target: PASS. `i attack the shadow in the water with my longsword` blocked cleanly instead of inventing a target or combat.
- Reload persistence: PASS. Reload preserved recent bridge/pack history and no console warnings/errors appeared.
- Character Sheet baseline: PASS. AC 19, Active Effects empty, Shield/Chain Mail under Equipped Defenses.

New findings:

### P2: Starter pack contents are not immediately usable from listed equipment

Production action before opening the pack:

```text
i tie rope from my pack to the bridge rail before leaning over
```

Observed:

```text
The Game Master lowers the screen and stares at you over it. That idea has been denied entry to the campaign, the tavern, and polite society. Try something else.
```

Related action:

```text
i light a torch from my pack and hold it near the bridge rail
```

Observed:

```text
You can hold a torch near the bridge rail, but no torch is currently established in your inventory. Your visible carried objects are empty, while your pack contents haven’t been separately itemized in the current state.
```

Impact:

A player sees `Dungeoneer's Pack` on the sheet and reasonably expects standard pack contents to be available. The game can reveal those contents if the player explicitly opens/sorts the pack, but normal use like `take rope from my pack` fails or is rejected before that step. This makes starting equipment feel unavailable until the player discovers the magic phrase.

Suggested fix:

Seed standard contents for starting equipment packs into available inventory/carryable state at character creation or session sync, or automatically expand known pack contents when a player names a standard item from a carried pack.

### P2: Physical hazard actions in armor resolve without checks or consequences

Production sequence:

```text
i jump into the dark water
i try to swim back to the surface and grab the bridge support
i climb back up onto the bridge
```

Observed:

All resolved as free narration with no Athletics check, Strength check, exhaustion/damage risk, drowning pressure, equipment complication, or other cost. This happened while the character was wearing Chain Mail and carrying Shield/gear.

Impact:

The game is under-gating obvious physical hazards. This weakens the referee layer and lets high-risk environmental actions bypass the same roll/difficulty system used for lower-risk inspections.

Suggested fix:

Classify swimming/climbing in dangerous water, especially while armored, as a referee-gated physical challenge. Use Athletics/Strength or an appropriate save/check, and consider armor/equipment context when setting DC or consequences.

### P2: DM2 cannot see established story inventory/resource state

After DM1 established pack contents and after Second Wind was used, DM2 answered from the static sheet only.

Production prompt:

```text
what items are currently available from my pack
```

Observed:

DM2 said it could only see `Dungeoneer's Pack` and could not list contents because the sheet does not break them out, despite DM1 having just established the pack contents in story state.

Production prompt:

```text
how many second wind uses do i have left
```

Observed:

DM2 answered that level 1 Fighter has `Second Wind = 1 use per rest` and `you have 1 Second Wind use left right now unless it was already spent...`, even though DM1 had just spent one use and earlier feature text says level 1 has two uses.

Impact:

DM2 is not reliably aware of current world/resource state beyond the static character sheet. This matters for Phase 4D leveling because resources, granted features, inventory, and progression choices will increasingly need a single consistent state story.

Suggested fix:

Feed DM2 a current rules-state summary that includes tracked resources/spent uses, carried object state, unpacked pack contents, active scene inventory, and recent item state changes.

### P3: Second Wind can be wasted at full HP with weak feedback

Production action at 14/14 HP:

```text
i use second wind
```

Observed:

```text
You use Second Wind as a Bonus Action and regain 0 HP (1 + 1). HP: 14 -> 14. Uses left: 1.
```

Impact:

This may be rules-legal, but it is poor player UX. Most players would expect a warning or no-spend confirmation when a limited healing resource has no benefit. The roll text also reads like `1 + 1` rather than clearly showing `1d10 + Fighter level`.

Suggested fix:

Consider blocking or confirming zero-benefit limited-resource use outside combat, or clearly state that the player is spending it despite being at full HP. Improve roll display to show the die/source.

## Latest QA Pass - 2026-06-07 After DEV Fix `bbf71d4`

Scope:

- Verified local `main` equals `origin/main` at `272c93d DiscoveryFix`; latest app-code fix is `bbf71d4 Route discovery followups through narration`.
- Played production at `https://hallucinated-dungeons.vercel.app/` using the existing `QA Smoke` character.
- Rechecked local automation after the push.

Verified fixed / passed:

- Discovery follow-up narration: PASS in production. Prompt `Use the established notice board discovery to read what it says about the missing road-workers.` produced player-facing narrative/details instead of referee/meta text.
- Natural player phrasing follow-up: PASS in production after QA corrected an over-directed test. Prompt `Read the notice board again.` produced player-facing notice-board content without mentioning internal discovery state.
- Discovery follow-up roll gating: PASS. No new roll was requested; story input remained enabled after the response.
- Stale target pollution mitigation: PASS for this repro. Even though the session still had old `notice details` state in history, the fresh explicit `notice board` prompt revealed the missing road-workers notice content.
- Production console: PASS. No warn/error logs observed during this pass.
- Automated checks: PASS. Client `npm.cmd run lint` passed. Server `npm.cmd test` passed `412/412`.

No open regressions from the latest targeted pass.

Follow-up correction:

- QA initially used an overly leading prompt (`Use the established notice board discovery...`). User correctly pointed out that real players will not phrase actions that way. QA reran with natural wording (`Read the notice board again.`), and production still passed: it revealed the notice content, requested no roll, kept input enabled, and logged no console warnings/errors.

## Latest QA Pass - 2026-06-07 After DEV Fixes `3a3127f` / `9420094`

Scope:

- Verified local `main` equals `origin/main` at `9420094 Discovery state`.
- Inspected fix commits `3a3127f Fix DM2 AC sources and discovery followups` and `9420094 Discovery state`.
- Played production at `https://hallucinated-dungeons.vercel.app/` using the existing `QA Smoke` character.

Verified fixed / passed:

- DM2 AC exact-source answer: PASS in production on a fresh prompt. `Current exact AC sources after latest fix?` returned Chain Mail 16, Shield +2, Fighting Style: Defense +1, and total 19. No raw `armor_formula` token appeared.
- Discovery follow-up roll gating: PARTIAL PASS in production. `Read the notice board details again.` and `Use the established notice board discovery...` did not request another roll, and story input stayed enabled after each response.
- Production console: PASS. No warn/error logs observed during this pass.
- Automated checks: PASS. Client `npm.cmd run lint` passed. Server `npm.cmd test` passed `411/411`.

Still failing / needs follow-up:

### P2: Known discovery follow-up returns referee/meta text instead of revealing content

Production actions:

```text
Read the notice board details again.
Use the established notice board discovery to read what it says about the missing road-workers.
```

Observed response both times:

```text
Discovery: notice details already has a successful study result on record. No new roll is needed; use the established result and reveal what that target can fairly provide.
```

Expected:

No extra roll is correct, but the player should receive actual in-world notice-board content or a narrative reveal. The response should not tell the player/GM to reveal the content; it should reveal it.

Additional note:

This existing production session still contains legacy polluted discovery state from the previous bug (`notice details`). That may explain the target label, but not the player-facing problem. Even with an explicit prompt naming `notice board` and `missing road-workers`, the output remained meta/referee text instead of actual notice contents.

Suggested fix:

Route known-discovery follow-up responses back through DM1/player-facing narration after the referee confirms no roll is needed. The final chat message should contain the fair revealed detail, not the internal instruction.

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
