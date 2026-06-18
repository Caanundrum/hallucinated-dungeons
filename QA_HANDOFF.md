# Hallucinated Dungeons QA Handoff

## Latest QA Pass - 2026-06-18 Cleric/Druid Level 2 Production QA `a675d3e`

Scope:

- Verified production frontend at `https://hallucinated-dungeons.vercel.app/`.
- Latest repo HEAD seen by QA: `43c404e Update QA_HANDOFF.md` (handoff-only).
- App-code commit under test: `a675d3e Add Cleric and Druid level 2 mechanics`.
- Relevant prior fix under test: `094d442 Scope combat turn resources to active character`.
- QA remained read-only for app code. Only this handoff was updated.

Automated checks:

- Server `npm.cmd test`: PASS, `496/496`.
- Client `npm.cmd run lint`: PASS.
- `git diff --check HEAD^ HEAD`: PASS for the handoff-only HEAD.

Verified passed in production - Cleric:

- Created fresh `QA Cleric` through the visible character-creation UI as Orc Cleric / Protector / Wayfarer.
- Level 1 sheet passed: `Orc Cleric - Level 1`, HP `10/10`, AC `16`, speed `30 ft`, Wisdom spellcasting attack `+5`, save DC `13`.
- Used QA level-up hook to make `QA Cleric` level-up-ready, then applied level 2 through the visible sheet UI.
- Level 2 sheet passed: `Orc Cleric - Level 2`, HP `17/17`, AC `16`, XP `300/900`, feature `Channel Divinity`, resource `Channel Divinity 2/2 until short rest`.
- Prior action-economy carryover fix appears to pass for this path: after switching to Cleric, a full-HP Divine Spark heal attempt reported fresh turn resources (`Action`, `Bonus Action`, `Reaction`, `30 ft movement`) instead of inheriting another character's spent state.
- `I use Divine Spark to heal myself.` at full HP correctly did not spend Channel Divinity.
- `I use Divine Spark to damage First Hostile Shape That Comes Close.` worked: target failed CON save `12 vs DC 13`, took `9 radiant damage`, dropped from `3 -> 0 HP`, awarded `25 XP`, and spent Channel Divinity to `1/2`.
- Direct Rules query confirmed Level 1 Cleric spell slots `3/3`.
- Browser console/warn/error logs were empty during the Cleric checks.

Blocked in production - Druid:

- Attempted Druid creation through the visible UI multiple times as a normal player path.
- Reproduced a hard creation-flow failure: while creating `QA Druid` as Orc Druid / Warden / Wayfarer, the app abruptly exited character creation and returned to the existing game screen before review/confirm.
- Most recent reproduction happened at Step 7 of 10 on the `Skills` page while selecting the first Druid class skill (`Animal Handling`). Earlier attempts dropped around the later equipment/spell area.
- After the jump, the character switcher did not contain `QA Druid`; the draft was not saved.
- Browser console/warn/error logs were empty, so this looks like an app state/navigation/socket-flow issue rather than an obvious client exception.
- Because the Druid cannot be created through the visible production UI, QA could not fairly verify level 2 `Wild Shape` or `Wild Companion` in live player flow.

Findings for DEV:

- P1: Druid creation flow can exit to the game screen before review/confirm and lose the draft. Repro path: `Create New Character` -> name `QA Druid` -> Orc with two languages -> Druid with Primal Order `Warden` -> Wayfarer with DEX `+1`, WIS `+2` -> Lucky -> ability scores -> Skills -> select `Animal Handling`; production returned to the game screen and no `QA Druid` was saved. This blocks production QA of Druid level 2 mechanics. The wizard did not merely stumble; it left the dungeon and pretended it had an appointment.
- P3: Cleric sheet display regression after Divine Spark action: `Equipped Defenses` changed from clear AC formulas (`Shield AC +2`, `Scale Mail Base AC 14 + DEX modifier cap 2`) to `Shield / Effect active` and `Scale Mail / Effect active`, even though AC stayed correct at `16` and `Active Effects` said none.
- P3: Combined Rules resource query can omit spell slots when asked alongside class resources. Querying `Channel Divinity, Lucky, level 1 Cleric spell slots` returned Channel Divinity and Lucky but omitted spell slots; a direct spell-slot query returned `3/3`.
- P3 / review note: During Druid creation, Warden selection says it grants Medium armor training, but build guidance/default equipment still references Leather Armor and AC `13`. This may be valid default equipment, but DEV should confirm whether Warden should offer or default to medium armor.

Current recommendation:

- Treat Cleric level 2 as production-passed for the tested path.
- Fix Druid creation before adding more Druid mechanics. Once a Druid can be created through the UI, QA should retest level-up, `Wild Companion`, `Wild Shape`, resource spending from `2/2`, active effects, and sheet/resource display.

Date: 2026-06-14
QA thread role: read-only QA, no development changes.

## Summary

Latest production QA of `6347b65 Add Bard and Monk level 2 mechanics` mostly passes for the new Bard and Monk paths. Automated checks pass, Monk level 2 mechanics pass in production, Bard level 2 creation/choices/apply/resources/spellcasting mostly pass in production. Active DEV attention needed: switching active characters during an open combat turn can carry the previous character's spent action economy into the new active character. Smaller notes: visible sheet resource counters are still not surfaced for new class resources, and old transcript/RULES history can make current character state look stale or contradictory.

## Latest QA Pass - 2026-06-15 Bard/Monk Level 2 Production QA `6347b65`

Scope:

- Verified latest app-code commit under test: `6347b65 Add Bard and Monk level 2 mechanics`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/`.
- Created and tested fresh production characters `QA Monk` and `QA Bard`.
- Used the QA-only backend test hook to make each new character level-up-ready; no app code changes were made by QA.

Automated checks:

- Server `npm.cmd test`: PASS, `485/485`.
- Client `npm.cmd run lint`: PASS.
- `git diff --check 6347b65^ 6347b65`: PASS.

Verified passed in production - Monk:

- `QA Monk` creation passed with Orc Monk / Guide, Magic Initiate Druid choices, expected level 1 sheet values: HP `9/9`, AC `15`, speed `30 ft`, Unarmored Defense from DEX/WIS.
- Level-up gate showed expected level 2 readiness after XP bump and applied through the visible sheet UI.
- Level 2 sheet passed: `Orc Monk - Level 2`, HP `15/15`, AC `15`, speed `40 ft`, XP `300/900`, features `Monk's Focus`, `Unarmored Movement`, and `Uncanny Metabolism`.
- Rules query confirmed `Focus Points 2/2` and `Uncanny Metabolism 1/1`.
- `I use Patient Defense.` spent 1 Focus Point, applied Dodge as Bonus Action, and left Focus at `1/2`.
- Enemy attack after end turn used live AC `15` and included Dodge disadvantage: `rolls 11/9 with disadvantage, using 9+3 = 12 vs AC 15`.
- `I use Uncanny Metabolism.` refilled Focus to `2/2`, spent Uncanny Metabolism to `0/1`, and did not over-heal at full HP.
- `I use Step of the Wind.` spent Focus, applied Dash + Disengage, doubled jump, and updated movement to `80 ft`.
- `I use Flurry of Blows...` spent the last Focus, made two Unarmed Strike attacks, handled advantage/Hidden ending, and left Focus at `0/2`.
- Browser console/warn/error logs were empty during these checks.

Verified passed in production - Bard:

- `QA Bard` creation passed with Orc Bard / Wayfarer, Lucky origin feat, expected level 1 sheet values: HP `9/9`, AC `13`, Bard spellcasting CHA attack `+5`, DC `13`, Bardic Inspiration feature present.
- Level-up gate correctly blocked application until Bard selected exactly 2 Expertise skills and 1 prepared spell.
- Level-up UI showed expected Expertise options from proficient skills and prepared spell options. Selected `Persuasion`, `Performance`, and `Bane`.
- `Apply Level Up` stayed disabled until required choices were complete, then enabled and applied.
- Level 2 sheet passed: `Orc Bard - Level 2`, HP `15/15`, AC `13`, XP `300/900`, Expertise choices recorded, `Bane` added to prepared Level 1 spells, `Expertise` and `Jack of All Trades` features present.
- Skill math passed after level-up: `Persuasion +7 Expertise`, `Performance +7 Expertise`, and non-proficient skills received Jack of All Trades half-proficiency bump, for example `Arcana +1`, `Athletics +0`, `Acrobatics +3`.
- Rules query confirmed `Bardic Inspiration 3/3`, `Luck Points 2/2`, and Level 1 Bard spell slots `3/3` before casting.
- After ending the inherited combat turn, `I give Bardic Inspiration to QA Monk.` worked as a Bonus Action and reduced Bardic Inspiration to `2/3`.
- `I cast Bane on First Hostile Shape That Comes Close.` worked as an Action, created an active Bane concentration effect, and reduced Level 1 spell slots from `3/3` to `2/2`.
- Browser console/warn/error logs were empty during Bard checks.

Findings for DEV:

- P2: Active character switch can inherit prior character combat action economy. After switching from `QA Monk` to `QA Bard` while Monk's turn still had Bonus Action spent from Flurry of Blows, the Bard's first `I give Bardic Inspiration to QA Monk.` was rejected with `Your Bonus Action is already spent this turn` and showed Monk movement state `40 ft movement`. Ending the turn reset correctly and Bardic Inspiration then worked. Expected: changing active character in combat should not let the new active character inherit another character's spent Bonus Action/movement state, or the UI should clearly prevent/scope combat actions to the actual current turn actor.
- P3: Character Sheet does not visibly show new resource counters for class resources like Monk Focus Points, Uncanny Metabolism, Bardic Inspiration, Lucky, or spell slots in the main sheet summary. Rules queries and mechanics can read/use them, but players do not get an obvious current counter on the sheet. This is a UX gap, not a mechanics blocker.
- P3: Old transcript/RULES history remains easy to misread after character switching. The page still shows stale older Fighter/Rogue AC and resource answers in the long transcript, even while fresh sheet/query state is correct. This is not currently breaking fresh mechanics, but it is confusing enough that QA has to keep saying "fresh query only" like a haunted parrot.
- P3: After Bane is active, the sheet's `Equipped Defenses` section shows `Leather Armor` followed by `Effect active`. AC stayed correct at `13`, but the label placement makes it look like leather armor itself is an active effect. Likely display-only.

Current recommendation:

- Treat Bard and Monk level 2 mechanics as broadly production-passed, with the action-economy carryover as the main fix candidate before piling on more combat/class complexity. The new classes are playing music and doing flips; the turn-state ledger just needs to stop sharing sticky notes between characters.

## Latest QA Pass - 2026-06-14 Equipment AC Tick Retest `9ce63c5`

Scope:

- Verified latest app-code commit under test: `9ce63c5 Fix equipment AC during effect ticks`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/` after reload.
- Continued with visible `QA Rogue`, Level 2 Human Rogue, in the existing combat scene.
- No app code changes were made by QA.

Automated checks:

- Server `npm.cmd test`: PASS, `478/478`.
- Client `npm.cmd run lint`: PASS.
- `git diff --check 9ce63c5^ 9ce63c5`: PASS.

Verified fixed / passed in production:

- P1 Rules-panel AC math remains fixed. Fresh query `What is my exact current AC right now? Show the formula and equipped armor.` returned `Your exact current AC right now: 14`, with `AC = Leather Armor base AC (11) + Dex modifier (+3)` and `AC = 11 + 3 = 14`.
- P1 end-turn continuation is fixed. Fresh player-style typed action `I end my turn.` produced a normal GM response instead of `The Game Master encountered an error. Please try again.`
- P1 live combat AC now uses Rogue AC 14. Creature attack after the fresh end-turn command: `First Hostile Shape That Comes Close uses weapon attack: rolls 5/6 with disadvantage, using 5+3 = 8 vs AC 14 (disadvantage: Hidden target). Miss.`
- Hidden disadvantage is still visible/applied in the live roll.
- Visible sheet still shows `QA Rogue`, `Human Rogue - Level 2`, no active effects, and `Equipped Defenses: Leather Armor`.
- Browser console/warn/error log check returned no entries.

Notes for DEV:

- The old transcript still contains earlier stale Fighter AC / AC 19 answers, but fresh current Rules and live combat checks now use Rogue AC 14. That history may look confusing in the scrollback, but the current behavior passed.
- Automation note only: Playwright-style direct `fill()` did not enable the ACT button, but player-like typing did. This looks like a QA automation quirk rather than a player-facing issue; the visible UI enabled ACT normally when typed into.

Current recommendation:

- Treat the Rogue AC/end-turn regression path as production-passed. Good moment to continue broader gameplay QA or move DEV to the next feature slice. The math is no longer doing stage magic.

## Latest QA Pass - 2026-06-14 Runtime AC Repair Retest `eb5efde`

Scope:

- Verified latest app-code commit under test: `eb5efde Repair runtime armor class from equipment`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/` after reload.
- Continued with visible `QA Rogue`, Level 2 Human Rogue, in the existing combat scene.
- No app code changes were made by QA.

Automated checks:

- Server `npm.cmd test`: PASS, `477/477`.
- Client `npm.cmd run lint`: PASS.
- `git diff --check eb5efde^ eb5efde`: PASS.

Verified fixed / passed in production:

- P1 Rules-panel AC math: PASS/FIXED for fresh exact query. `What is my exact current AC and what are the exact AC sources? Do not infer from prior text.` returned:
  - `Your exact current AC is 14.`
  - `Leather Armor: AC 11`
  - `Dexterity modifier: +3 (from DEX 16)`
  - `Total: 11 + 3 = 14`
- Active sheet still correctly shows `QA Rogue`, `Human Rogue - Level 2`, no active effects, and Leather Armor.
- Automated regression suite now includes local AC repair coverage and passes.

Still failing / new findings for DEV:

- P1 existing Rogue combat cannot advance after the AC repair. Fresh production command `I end my turn.` returned `The Game Master encountered an error. Please try again.` Browser console/error logs were empty. This blocks QA from verifying whether creature attacks now use AC 14 in live combat.
- Not yet production-verified after this fix: creature attack AC value. The Rules panel is fixed, but the combat loop did not reach the creature attack because end-turn continuation errored.
- Old transcript lines still contain previous AC 19 answers and Fighter gear explanations, but fresh exact Rules query is now correct. The active blocker is the end-turn GM error, not the Rules AC answer.

Current recommendation:

- Treat Rules-panel AC math as production-passed. DEV should investigate the end-turn GM error in the current Rogue combat continuation next, then QA should re-run the enemy attack to confirm live combat uses AC 14. The calculator learned arithmetic; now the turn engine dropped its pencil.

## Latest QA Pass - 2026-06-14 Stale Defense Fix Retest `acfc493`

Scope:

- Verified latest app-code commit under test: `acfc493 Fix stale active character defenses`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/` after reload.
- Continued with visible `QA Rogue`, Level 2 Human Rogue, in the existing combat scene.
- No app code changes were made by QA.

Automated checks:

- Server `npm.cmd test`: PASS, `475/475`.
- Client `npm.cmd run lint`: PASS.
- `git diff --check acfc493^ acfc493`: PASS.

Verified fixed / passed in production:

- P2 Hidden disadvantage display/application: PASS/FIXED. After successful Cunning Action Hide, the enemy attack now displayed `rolls 20/20 with disadvantage, using 20+3 = 23 vs AC 19 (disadvantage: Hidden target)`.
- P2 post-Disengage action summary: PASS/FIXED. After Cunning Action Dash spent Bonus Action, then `I use Cunning Action to Disengage too.` resolved as normal Action Disengage, the summary now says `60 feet of movement remain. You can move or end your turn.` It no longer advertises Bonus Action.
- Natural Cunning Action Dash regression stayed fixed: PASS. `I use my bonus action to dash away from the hostile shape.` still routes to Cunning Action Dash and says `use your Action`.

Still failing / new findings for DEV:

- P1 Rogue AC/equipment context is still wrong in production. Active sheet shows `QA Rogue`, `Human Rogue - Level 2`, no active effects, and `Equipped Defenses: Leather Armor` (`Base AC 11 + full DEX modifier`). But exact Rules query answered `Your exact current AC is 19` with sources `Leather Armor: base AC 11`, `DEX modifier: +3`, `Total AC: 11 + 3 = 19`. This is now using Rogue source labels, but the arithmetic/result are still impossible.
- P1 creature attacks still resolve against AC 19. Fresh enemy attack after reload: `First Hostile Shape That Comes Close uses weapon attack: rolls 20/20 with disadvantage, using 20+3 = 23 vs AC 19 (disadvantage: Hidden target). Critical hit. Hit for 4 damage. QA Rogue: (9 -> 5 HP).`
- P2 old Rules-panel history still shows stale Fighter AC explanations in the transcript, but the fresh exact query is more important: current answer uses Rogue source labels with wrong total. The old transcript pollution may remain confusing for players, but the active bug is the current AC value/math.

Current recommendation:

- Treat Hidden disadvantage and Disengage summary as production-passed. Keep `QA Rogue` AC as the active blocker. The fix appears to have changed source selection from Fighter gear to Rogue gear, but the derived AC value is still stuck at 19. The math is wearing a fake mustache: `11 + 3` should not equal `19`.

## Latest QA Pass - 2026-06-13 Rogue Cunning Action Fix Retest `c0b801b`

Scope:

- Verified latest app-code commit under test: `c0b801b Fix rogue Cunning Action routing`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/` after reload.
- Continued with visible `QA Rogue`, Level 2 Human Rogue, in the existing combat scene.
- No app code changes were made by QA.

Automated checks:

- Server `npm.cmd test`: PASS, `472/472`.
- Client `npm.cmd run lint`: PASS.
- `git diff --check c0b801b^ c0b801b`: PASS.

Verified fixed / passed in production:

- P1 natural Cunning Action Hide: PASS/FIXED. `I use my bonus action to hide behind the bridge support.` now prompts `Make a DC 15 Dexterity (Stealth). This uses your Bonus Action through Cunning Action.` It rolls at `1d20+7`.
- Natural Hide post-roll action economy: PASS. After a successful 26 vs DC 15 Stealth check, the turn summary listed `Action, Reaction, 30 ft movement`; Bonus Action was correctly spent.
- P2 natural Cunning Action Dash summary: PASS/FIXED. `I use my bonus action to dash away from the hostile shape.` now says Cunning Action Dash uses Bonus Action and follows with `60 feet of movement remain. You can move, use your Action, or end your turn.` It no longer says Bonus Action remains available immediately after Dash.
- P2 exhausted Cunning Action blocker: PASS/FIXED. After Cunning Action Dash plus normal Action Disengage, `I use Cunning Action to Hide again.` now blocks with `Your Bonus Action is already spent this turn, so Cunning Action: Hide has to wait.`

Still failing / new findings for DEV:

- P1 QA Rogue combat is using stale Fighter AC/equipment state. The visible character sheet shows `QA Rogue`, `Human Rogue - Level 2`, no active effects, and `Equipped Defenses: Leather Armor` (`Base AC 11 + full DEX modifier`). However creature attacks against QA Rogue are resolving against AC 19: `First Hostile Shape That Comes Close uses weapon attack: rolls 20+3 = 23 vs AC 19... QA Rogue: (17 -> 9 HP)`. Rules-panel text also explains AC 19 using Fighter gear: Chain Mail + Shield + Defense. HP and name are Rogue, but AC/equipment context appears stale from `QA Smoke`.
- P2 Hidden disadvantage still not shown/applied in production. After natural Cunning Action Hide succeeded and the GM said attacks against QA Rogue have Disadvantage, ending the turn produced `First Hostile Shape That Comes Close uses weapon attack: rolls 2+3 = 5 vs AC 19. Miss.` There was no disadvantage wording or paired roll shown.
- P2 follow-up after Action Disengage still advertises Bonus Action availability. After Cunning Action Dash spent Bonus Action, `I use Cunning Action to Disengage too.` resolved as normal `Disengage action`, then summarized `60 feet of movement remain. You can move, use a Bonus Action, or end your turn.` A later Cunning Action attempt correctly says Bonus Action is already spent, so this is likely stale summary text after normal Action Disengage.

Current recommendation:

- Treat the targeted Cunning Action routing fixes as partially production-passed. DEV should prioritize the stale active-character AC/equipment context next because it affects core combat math and Rules answers for switched characters. The Cunning Action fixes are mostly in; the character-state blender is the louder smoke alarm.

## Latest QA Pass - 2026-06-13 Rogue Level 2 Production Gameplay `ab63e08`

Scope:

- Verified latest app-code commit under test: `ab63e08 Enable barbarian and rogue level 2`; current `HEAD` is `1b608d7 Update QA_HANDOFF.md`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/` using a newly created visible `QA Rogue`.
- No app code changes were made by QA.

Automated checks:

- Server `npm.cmd test`: PASS, `467/467`.
- Client `npm.cmd run lint`: PASS.
- `git diff --check ab63e08^ ab63e08`: PASS.

Production verified / passed:

- Character creation, Human Rogue: PASS. Created `QA Rogue` through the full 9-step UI with Human size/languages, Rogue class choices, Criminal background, Human Skillful/Versatile choices, skills, Expertise, equipment, and review.
- Creation math: PASS. Review showed Human Rogue, HP `10`, AC `14`, languages `Common, Draconic, Dwarvish, Thieves' Cant, Elvish`, skills/tool choices, and Rogue class choices as selected.
- QA level-up readiness helper by active character name: PASS. `QA Rogue` was prepared at `currentXp: 300`, `threshold: 300`, `currentLevel: 1`, `nextLevel: 2`, `canApply: true`, `blockers: []`.
- Visible level-up UI: PASS. Character sheet showed `QA Rogue`, `Human Rogue - Level 1`, `Level Up Available`, XP `300/300`, and a `Level Up` button.
- Rogue level-up preview: PASS. Preview showed `Rogue Level 2`, XP `300/300 - Level 1 to 2`, HP gain, and new feature `Cunning Action`.
- Apply level-up: PASS. After apply, sheet showed `Human Rogue - Level 2`, XP `300/900`, and `Cunning Action`.
- Out-of-combat Stealth: PASS. `I duck behind the bridge support and try to hide.` requested DC 15 Dexterity (Stealth), used `+7`, rolled 16 vs DC 15, and resolved hidden.
- Combat setup and initiative: PASS. Pressing the dark water encounter began combat, requested initiative `1d20+5`, and produced order `QA Rogue (22), First Hostile Shape That Comes Close (6)`.
- Explicit Cunning Action Hide: PASS. `I use Cunning Action to Hide.` requested DC 15 Dexterity (Stealth), used `+7`, explicitly said it used Bonus Action through Cunning Action, and after success listed only `Reaction, 30 ft movement`.
- Explicit Cunning Action Dash: PASS. `I use Cunning Action to Dash away from the hostile shape.` said it used Cunning Action to Dash as a Bonus Action and increased movement to 60 ft.

New findings for DEV:

- P1 player-natural Cunning Action Hide does not route to Cunning Action. In combat, `I use my bonus action to hide behind the bridge support.` resolved as `You take the Utilize action to use bridge support`, consumed the main Action, and left `Bonus Action` available. Explicit `I use Cunning Action to Hide.` works, but a normal player should not need to know the exact engine phrase.
- P2 Cunning Action Dash follow-up text incorrectly says Bonus Action remains available. After explicit Cunning Action Dash, the response said `You use Cunning Action to Dash as a Bonus Action` and then `60 feet of movement remain. You can move, use a Bonus Action, or end your turn.` A follow-up second Cunning Action did not grant a second bonus action, so this may be display/state-summary wording rather than a spend loophole.
- P2 repeated Cunning Action after Dash gives the wrong blocker reason. After using Cunning Action Dash, then normal Action Disengage, `I use Cunning Action to Hide again.` was blocked with `Your Action is already spent this turn`, even though the command explicitly asked for Cunning Action and the relevant exhausted resource was Bonus Action.
- P2 Hidden disadvantage may not be applied or shown on enemy attack. After explicit Cunning Action Hide succeeded, GM said attacks against QA Rogue have Disadvantage until reveal. On enemy turn, the attack displayed a single roll `8+3 = 11 vs AC 19` with no disadvantage wording. It missed, so the outcome was not wrong, but the displayed roll does not prove disadvantage was applied.
- P2 hidden/readied-action phrasing can throw a GM error. `I stay hidden, watch the dark water, and ready my shortsword for the next hostile shape that comes within reach.` returned `The Game Master encountered an error. Please try again.` A simpler follow-up movement/search command did not error.
- P3 Cunning Action plus ready wording is overmatched by Ready parsing. `I use my bonus action to hide behind the bridge support, then keep my shortsword ready.` answered only about Ready support and did not resolve the hide/bonus-action part.
- P3 Rogue Standard Array default is legal but odd. Default Standard Array put STR 15 and DEX 14 before background bonuses, producing final STR 15 / DEX 16. Not a blocker, but class-aware default assignment would feel better for players.

Current recommendation:

- Treat Rogue level-up preview/apply and explicit Cunning Action mechanics as production-passed. Before building more on Rogue combat, DEV should fix natural-language Cunning Action routing and the post-spend action-economy summaries; otherwise players will think the feature is broken unless they know the exact spell words. Tiny parser trapdoor, full-size player bruise.

## Latest QA Pass - 2026-06-13 Tactical Mind Success/Spend Production Proof

Scope:

- Continued production testing at `https://hallucinated-dungeons.vercel.app/` using visible `QA Smoke`, Level 2 Fighter.
- No app code changes were made by QA.
- Goal was to force the last unproven live branch: Tactical Mind turns a failed ability check into success and spends Second Wind.

Production verified / passed:

- Tactical Mind still-fails/no-spend rechecked: PASS. Climbing the slick bridge support produced DC 29 Strength (Athletics), rolled 18, Tactical Mind rolled `1d10 = 8`, revised total 26 still failed, and GM said no Second Wind use was spent.
- Tactical Mind success/spend branch: PASS. A later climb using the safer boot placement produced DC 29 Strength (Athletics), rolled 23, Tactical Mind rolled `1d10 = 6`, revised total 29 met DC 29 and succeeded. GM explicitly said `Second Wind uses left: 1`.
- Success consequence: PASS. GM resolved the hazard positively: secure grip, pulled through the hazard without losing position or gear, and no longer caught in the immediate hazard.
- Exact resource verification after success: PASS. DM2 exact-state query returned `Second Wind 1/2` and `Action Surge 0/1`, confirming the successful Tactical Mind spent exactly one Second Wind use.

Current recommendation:

- Tactical Mind production coverage is now complete for prompt, decline, still-fails/no-spend, and success/spend. No blocker found in this pass. The dice made us work for it, but the branch finally confessed.

## Latest QA Pass - 2026-06-13 Combined Resource Fix Retest `32ac1aa`

Scope:

- Verified latest app-code commit under test: `32ac1aa Answer combined resource queries`; current `HEAD` is `738cadb Update QA_HANDOFF.md`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/` after reload.
- Used visible `QA Smoke`, Level 2 Fighter, in the existing combat state after Action Surge had been spent.
- No app code changes were made by QA.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `460/460`.
- `git diff --check 32ac1aa^ 32ac1aa`: PASS.

Verified fixed / passed in production:

- Combined exact resource query: PASS/FIXED. The exact question `What are my exact current Action Surge and Second Wind resource entries, remaining and max? Do not infer from prior text.` now answers both resources in one response:
  - `Action Surge 0/1 uses left. It resets on short rest.`
  - `Second Wind 2/2 uses left. It resets on long rest.`
- Regression context stayed intact: PASS. The production session still shows the prior Action Surge wording fix resolved correctly: `I attack the hostile shape again with my longsword using my Action Surge action.` resolved as a longsword attack and did not false-block as a second Action Surge activation.

Current recommendation:

- Treat the latest resource-answer fix as production-passed. No new blocker found in this retest. The main remaining Fighter-ability coverage gap is still Tactical Mind success/spend in production, because natural live rolls have not yet landed in the narrow "d10 turns failure into success" window. The dice continue to behave like tiny auditors with opinions.

## Latest QA Pass - 2026-06-13 Fighter Ability Fix Retest `a65109f`

Scope:

- Verified latest app-code commit under test: `a65109f Fix Action Surge wording and resource answers`; current `HEAD` is `163b7fb Update QA_HANDOFF.md`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/` after reload.
- Used visible `QA Smoke`, Level 2 Fighter, and continued natural production play from the previous ability-test session.
- No app code changes were made by QA.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `459/459`.
- `git diff --check a65109f^ a65109f`: PASS.

Verified fixed / passed in production:

- Short rest restored Action Surge to `1/1`: PASS. GM response said Action Surge reset, and DM2 exact Action Surge query returned `Action Surge 1/1`.
- Fresh combat setup: PASS. After moving toward/pressing around the dark water threat, combat began, enemy won initiative, hit QA Smoke for 3 damage, and the player turn opened normally.
- Action Surge spend path: PASS. After a normal longsword attack used the regular action, `I use Action Surge.` spent Action Surge, returned `Uses left: 0`, and exposed `Action Surge action`.
- Previously failing Action Surge wording: PASS/FIXED. `I attack the hostile shape again with my longsword using my Action Surge action.` now resolved as an attack instead of being rejected as a second Action Surge use. It rolled 19 vs AC 12, hit for 5 damage, applied Savage Attacker and Sap, and left only Bonus Action/Reaction/movement available.
- DM2 Tactical Mind resource follow-up: PASS/FIXED. The formerly misleading question `How many Second Wind uses do I have left after that Tactical Mind attempt?` now answered from current sheet state: `Second Wind 2/2 uses left`, with the note that Tactical Mind only spends Second Wind if the d10 turns failure into success.

New findings for DEV:

- P3 combined exact resource query omits Action Surge. The exact combined question `What are my exact current Action Surge and Second Wind resource entries, remaining and max? Do not infer from prior text.` repeatedly answered only Second Wind (`Second Wind 1/2` before rest, `Second Wind 2/2` after rest / after Action Surge use) and omitted Action Surge. Asking Action Surge alone returned the correct value (`0/1` before rest, `1/1` after rest). This looks like the resource-answer shortcut handles Tactical Mind/Second Wind first and returns before also answering Action Surge.

Other QA notes:

- Scene discovery consistency is improved but still a little awkward: a successful search recorded a hostile-shape discovery in the dark water, but an immediate attack on "the hostile shape I just spotted" said the target was not here. Following the app prompt to move toward the sighting and press around the support did eventually establish combat. I would not block on this yet, but it is worth watching as discovery-to-target handoff gets more important.
- Short rest narration said `Second Wind recovers 1 use` while DM2 says Second Wind resets on long rest. The resulting resource state became `2/2`. This may be correct for the intended 2024 Fighter resource model, but the Rules-panel reset wording should stay consistent with the actual resource engine.

Current recommendation:

- Treat the two targeted fixes as production-passed. DEV should clean up the new combined-resource omission before it becomes a recurring Rules-panel papercut. Core Fighter ability testing can continue; Tactical Mind success/spend remains the one branch not yet naturally proven in production.

## Latest QA Pass - 2026-06-13 Fighter Ability Production Gameplay `7ee9848`

Scope:

- Continued production testing at `https://hallucinated-dungeons.vercel.app/` using visible `QA Smoke`, now a Level 2 Fighter.
- Focused on player-realistic ability use before DEV adds more 4D mechanics.
- Tested live GM and Rules panels through the in-app browser; no app code changes were made.

Production verified / passed:

- Tactical Mind failed-check prompt: PASS. A hazardous armored swim produced DC 30 Strength (Athletics), rolled 15 vs 30, and prompted Tactical Mind with the correct spend-on-success/no-spend-on-failure explanation.
- Tactical Mind no-spend failure branch: PASS. Choosing `use Tactical Mind` rolled `1d10 = 7`, revised total 22 vs DC 30, still failed, and GM explicitly said no Second Wind use was spent.
- Tactical Mind decline branch: PASS. A later failed DC 20 Wisdom (Perception) check prompted Tactical Mind; choosing `decline Tactical Mind` resolved the original failed check without spending the resource.
- Exact Second Wind resource after failed Tactical Mind: PASS. DM2 exact-state query returned `Second Wind 1/2`, remaining 1, max 2.
- Action Surge out-of-combat guard from previous pass still stands: PASS. Out-of-combat use was refused and did not spend the resource.
- Action Surge combat spend: PASS. In combat, after a normal longsword attack, `I use Action Surge.` spent the resource, returned `Uses left: 0`, and opened `Action Surge action, Bonus Action, Reaction, 30 ft movement`.
- Action Surge granted action usable with natural wording: PASS. `I attack again with my longsword.` consumed the granted action, rolled a critical hit, killed the target, ended combat, and awarded combat XP.
- Post-combat resource state: PASS. DM2 exact-state query returned `Action Surge 0/1` and `Second Wind 1/2`.
- Second Wind full-HP guard: PASS. At `24/24 HP`, `I use Second Wind to catch my breath.` refused to waste the heal and said no use was spent.
- Second Wind resource after full-HP guard: PASS. DM2 exact-state query still returned `Second Wind 1/2`.

New findings for DEV:

- P2 Action Surge granted-action wording false-block. After Action Surge was already spent and the UI listed `Action Surge action` as available, the realistic command `I attack the dark shape again with my longsword using my Action Surge action.` was rejected with `Action Surge has no uses left until a Short or Long Rest restores it.` The extra action remained available and a follow-up `I attack again with my longsword.` worked. The parser/action economy appears to treat the phrase "Action Surge" in the follow-up as a second feature-use attempt instead of recognizing it as the already-granted action slot.
- P3 DM2 Tactical Mind resource inference can contradict exact state. The question `How many Second Wind uses do I have left after that Tactical Mind attempt?` incorrectly answered `0 Second Wind uses left`, even though the GM had said no use was spent and an exact-state query immediately after returned `Second Wind 1/2`. This looks like Rules-panel context inference overriding authoritative sheet/resource state.

Not yet production-proven:

- Tactical Mind success/spend branch. Production random rolls covered still-fails/no-spend and decline. Need a controlled or lucky failed ability check where the Tactical Mind d10 turns failure into success, then verify Second Wind spends from `1/2` to `0/2`.

Current recommendation:

- Do not block the next 4D work on core ability functionality; the main mechanics are live and playable. DEV should fix the Action Surge follow-up wording trap before broad player testing, and tighten DM2 resource answers to prefer authoritative current resources over inferred transcript math. The fighter is swinging; it just trips over the label on its own extra action.

## Latest QA Pass - 2026-06-13 Active QA Character Level-Up Visual E2E `7ee9848`

Scope:

- Verified latest app-code commit under test: `7ee9848 Allow QA level-up readiness by active test character`.
- Inspected changed surface: `README.md`, `server/src/db.js`, `server/src/index.js`, `server/src/qaTools.js`, and `server/test/qaTools.test.js`.
- Used the configured production QA tools secret provided by the user in chat. The secret was not written to this file.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/`.
- Exercised the new active QA-character targeting path against visible `QA Smoke`.
- Completed the React Level Up modal and Apply flow visually in the in-app browser.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `454/454`.
- `git diff --check 7ee9848^ 7ee9848`: PASS.

Verified fixed / passed in production:

- Active QA character endpoint after visible reload: PASS. `POST /qa/level-up-ready` with `characterName: QA Smoke` returned `200 OK`, XP `300`, threshold `300`, current level `1`, next level `2`, `canApply: true`, blockers `[]`.
- Guard behavior before visible reload: PASS/NOTE. The same endpoint initially returned `409 That QA character is not active in a visible session`, then succeeded after reloading the visible app. This confirms the live-socket guard works, but also means QA may need to reload/reselect before using name targeting.
- Character Sheet readiness UI: PASS. Visible sheet showed `XP 300/300`, `Level Up Available`, and enabled `Level Up`.
- React Level Up preview modal: PASS. Modal showed `Fighter Level 2`, status `Ready`, HP Gain `+10`, PB `+2 -> +2`, Apply `Unlocked`, features `Action Surge` and `Tactical Mind`, and no blockers.
- Apply Level Up from UI: PASS. Clicking `Apply Level Up` closed the preview and updated the sheet to `Human Fighter - Level 2`, HP `24/24`, XP `300/900`.
- New features on sheet: PASS. Sheet lists `Action Surge` and `Tactical Mind`.
- Post-level Action Surge guard: PASS. `I use Action Surge.` outside combat returned the expected out-of-combat refusal.
- Action Surge resource count after refusal: PASS. DM2 answered `Action Surge: 1/1 uses left`, so the out-of-combat refusal did not spend the resource.
- Production console: PASS. No warn/error logs observed during this pass.

Current recommendation:

- Fighter level 2 readiness, visual modal, UI apply, and basic post-level Action Surge behavior are production-passed. No blocker for continuing the 4D build. Next QA target should be Tactical Mind in a real failed ability-check flow and Action Surge inside an actual combat turn, because the shiny button now works and naturally wants to be stress-tested.

## Latest QA Pass - 2026-06-12 QA Secret Follow-Up / Level-Up Apply E2E

Scope:

- Used the configured production QA tools secret provided by the user in chat. The secret was not written to this file.
- Created a fresh temporary QA-controlled production socket session and valid Fighter character named `QA Leveler`.
- Called production `POST /qa/level-up-ready` for that temporary session.
- Exercised the production socket level-up preview and apply events.
- Rechecked the visible production `QA Smoke` session stayed stable.

Production verified / passed:

- Temporary socket session creation: PASS.
- Temporary Fighter save: PASS. `QA Leveler` started Level 1, XP 0, HP 13/13.
- QA endpoint with valid secret: PASS. Returned `200 OK`, XP `300`, threshold `300`, current level `1`, next level `2`, `canApply: true`, blockers `[]`.
- Level-up availability emit: PASS. Socket received `level_up_available`.
- Level-up preview socket event: PASS. Preview returned `canLevelUp: true`, `canApply: true`, HP increase `+9`, features `Action Surge` and `Tactical Mind`, blockers `[]`.
- Level-up apply socket event: PASS. `level_up_result` returned Level 2, XP `300`, next threshold `900`, HP `22/22`, Action Surge resource `{ remaining: 1, max: 1, reset: short_rest }`, and progression history recorded fixed HP increase `9`.
- Visible `QA Smoke` session stability: PASS. It remains Level 1 at `25/300 XP`; no below-threshold Level Up controls are shown.

Open QA note:

- The production server-side and socket level-up flow is now proven. The only remaining unverified piece is the literal React Level Up modal in the visible browser, because the browser automation surface cannot safely extract or replace the current session token, and a blocked browser security policy prevented the temporary in-page storage inspection path. To test the modal visually, QA needs either the visible session moved to 300 XP by the QA endpoint using its current session credentials, or an approved UI/deep-link route to open the temporary QA session in the browser.

Current recommendation:

- Treat Fighter level 2 backend/apply flow as production-passed. DEV can either proceed with the next 4D slice or add a QA-safe way to open/select a specific test session in the frontend so the React modal can be visually verified too. The engine crossed the bridge; now we just need to look at the bridge toll booth.

## Latest QA Pass - 2026-06-12 Gated QA Level-Up Readiness Tool `efcf3ae`

Scope:

- Verified latest app-code commit under test: `efcf3ae Add gated QA level-up readiness tool`; current `HEAD` is `7ea3ec5 Update QA_HANDOFF.md` and only changes `QA_HANDOFF.md`.
- Inspected changed surface: `README.md`, `server/src/index.js`, `server/src/progressionEngine.js`, `server/src/qaTools.js`, `server/test/progressionEngine.test.js`, and `server/test/qaTools.test.js`.
- Rechecked production frontend at `https://hallucinated-dungeons.vercel.app/`.
- Probed production backend health and the new QA endpoint at `https://hallucinated-dungeons-production.up.railway.app`.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `453/453`.
- `git diff --check efcf3ae^ efcf3ae`: PASS.

Verified fixed / passed in production:

- Backend health: PASS. `GET /health` returned `200 OK`.
- QA endpoint default safety: PASS. `POST /qa/level-up-ready` with no secret/body returned `404 {"ok":false,"error":"Not found."}`. This indicates the tool is not publicly exposed when `QA_TOOLS_SECRET` is absent.
- Frontend smoke: PASS. App loaded connected.
- Character Sheet: PASS. `QA Smoke` remains `Human Fighter - Level 1` with `XP 25/300`.
- Below-threshold Level Up affordance: PASS. No `Level Up Available` badge and no `Level Up` button are visible at `25/300`.
- Production console: PASS. No warn/error logs observed during this pass.

Verified by local automated coverage:

- QA tools stay disabled unless a server secret is configured.
- QA tools accept either `x-qa-tools-secret` or Bearer auth when the secret matches.
- `buildLevelUpReadySheet` raises the active character to the next threshold.
- Explicit high QA XP targets are not lowered.
- `setCharacterXp` recalculates level-up readiness and records a QA/manual award.
- `setCharacterXp` clears readiness when XP is below the next threshold.

Open QA note:

- The new QA readiness tool cannot yet be used in production from QA because the live backend appears to have no `QA_TOOLS_SECRET` configured, and QA does not have a secret to send. That is good from a security standpoint, but it leaves the original above-threshold Level Up modal/apply production test still blocked.

Current recommendation:

- Configure `QA_TOOLS_SECRET` in production and provide QA the secret through the agreed secure channel, or provide another controlled XP-ready test character. Then QA can call `/qa/level-up-ready`, verify the Level Up badge/button, open the preview modal, apply Fighter level 2, and test Action Surge/Tactical Mind as an actual level 2 character. Right now the key exists, but it is sitting in a locked drawer with no label.

## Latest QA Pass - 2026-06-12 Fighter Leveling `97bd4b8`

Scope:

- Verified latest app-code commit under test: `97bd4b8 Enable fighter level 2 mechanics`; current `HEAD` is `99113b7 Fighter leveling` and only changes `QA_HANDOFF.md`.
- Inspected changed surface: `server/src/actionEconomy.js`, `server/src/classFeatureEngine.js`, `server/src/index.js`, `server/src/levelUpEngine.js`, `server/src/refereeCore.js`, `server/src/resourceEngine.js`, and related tests.
- Rechecked production at `https://hallucinated-dungeons.vercel.app/` using the existing `QA Smoke` session.
- Checked normal player flows only; did not mutate production data outside gameplay.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `447/447`.
- `git diff --check 97bd4b8^ 97bd4b8`: PASS.

Verified fixed / passed in production:

- Character availability: PASS. Normal Switch flow only exposed `QA Smoke`, a Level 1 Human Fighter with `XP 0` at test start; no hidden XP-ready character was available.
- Level-1 Action Surge guard: PASS. Player action `I use Action Surge.` returned `Action Surge is a level 2 Fighter feature. At level 1, the tactical lightning has not been installed yet.` No resource was invented and no console errors appeared.
- Generic action submission: PASS. `I look around for anyone nearby.` produced a normal DC 20 Wisdom (Perception) roll prompt.
- Roll resolution and XP award: PASS. Successful Perception roll awarded `XP: +25 ... Total: 25/300 XP.`
- Character Sheet after XP: PASS. Sheet showed `XP 25/300`, stayed Level 1, and still showed no `Level Up Available` badge or `Level Up` button below threshold.
- Production console: PASS. No warn/error logs observed during this pass.

Verified by local automated coverage:

- Fighter level 2 preview is apply-ready.
- Applying Fighter level 2 updates level, HP, hit dice, features, and Action Surge resource.
- Action Surge grants one extra non-Magic action after the regular action is spent.
- Action Surge spends its level 2 resource.
- Magic actions are blocked from the Action Surge extra action path.
- Tactical Mind can convert a failed ability check into success and spends Second Wind only on success.
- Tactical Mind does not spend Second Wind when the added d10 still fails.
- Tactical Mind decline paths resolve the original failed check without spending the feature.
- Resource defaults build Fighter Action Surge starting at level 2.

Open QA note:

- The actual above-threshold production Level Up modal and Apply Level Up button still were not tested because the only available production character is now `25/300 XP`, not 300+. Local tests cover the path, but QA still needs an XP-ready character or reliable XP-award route to verify the visible preview/apply flow in production.

Current recommendation:

- No blocker found for this push. DEV can continue 4D work, but should provide or create a controlled way for QA to reach/test 300 XP in production. Otherwise QA can only prove the below-threshold guard and local apply logic, which is a bit like inspecting the drawbridge from the parking lot.

## Latest QA Pass - 2026-06-12 Guarded Level-Up Preview `f18c036`

Scope:

- Verified latest app-code commit under test: `f18c036 Add guarded level-up preview flow`; current `HEAD` is `023ea19 Update QA_HANDOFF.md`.
- Inspected changed surface: `client/src/App.jsx`, `client/src/App.css`, `server/src/index.js`, `server/src/levelUpEngine.js`, `server/src/contentData.js`, `server/data/class_level_advancement.json`, and `server/test/levelUpEngine.test.js`.
- Rechecked production at `https://hallucinated-dungeons.vercel.app/` using the existing `QA Smoke` session.
- Checked desktop and mobile sheet behavior for the below-threshold player state.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `439/439`.

Verified fixed / passed in production:

- Character Sheet progression guard: PASS. `QA Smoke` remains `Human Fighter - Level 1` with `XP 0`.
- Below-threshold Level Up affordance: PASS. At XP 0, the Character Sheet shows only `Close`; no `Level Up Available` badge and no `Level Up` button are exposed.
- DM2 progression answer: PASS. Natural player question `Can I level up yet, and how much XP do I have?` answered that XP is `0` and the character cannot level up yet.
- Mobile sheet layout: PASS at `390x844`. Sheet header/stat strip did not horizontally overflow, XP showed `0`, and no hidden/broken Level Up action appeared.
- Production console: PASS. No warn/error logs observed during this pass.

Verified by local automated coverage:

- Level-up preview stays unavailable below the XP threshold.
- Fighter level 2 preview uses fixed HP and blocks unsupported mechanics.
- Applying a blocked level returns a preview and does not mutate the sheet.
- Fixed HP increase includes per-level HP bonuses such as Tough.
- `applyLevelUp` can apply an unblocked advancement record.
- Proficiency bonus follows the SRD advancement table cadence.

Open QA note:

- I did not production-test the above-threshold preview modal because the active production character has XP 0 and there is no safe player-realistic way in this session to force 300 XP. Local tests cover the ready/blocked/apply paths, but production still needs a controlled XP-ready character or a reliable award scenario to verify the visible preview modal and `Rules Work Needed` blocked-apply state.

Current recommendation:

- No blocker found in the below-threshold guard. DEV can continue 4D build-out, but before calling level-up production-proven, QA needs an XP-ready state to test the actual preview modal and blocked/apply behavior end to end. The lever is there; we still need a character heavy enough to pull it.

## Latest QA Pass - 2026-06-07 First 4D Push `3490ab6`

Scope:

- Verified local `main` equals `origin/main` at `58d28d5 Update QA_HANDOFF.md`; latest app-code fix is `3490ab6 Add server-owned XP award foundation`.
- Inspected changed surface: `client/src/App.jsx`, `client/src/CharacterSelect.jsx`, `server/src/progressionEngine.js`, `server/src/index.js`, `server/src/rulesSheetSummary.js`, `server/test/progressionEngine.test.js`, and related validator/UI updates.
- Rechecked production at `https://hallucinated-dungeons.vercel.app/` using existing `QA Smoke` session.
- Rechecked local automation after the push.

Automated checks:

- Client `npm.cmd run lint`: PASS.
- Server `npm.cmd test`: PASS, `433/433`.

Verified fixed / passed in production:

- Character Sheet progression display: PASS. Sheet now shows `XP 0` for `QA Smoke`.
- DM2 progression awareness: PASS. `how much xp do i have and when do i level up?` answered `XP 0` and identified level 2 threshold as `300 XP`.
- Failed challenge stability: PASS. A failed Athletics check after `i secure the rope and climb safely back onto the bridge` resolved normally, unlocked input, and did not corrupt XP display.
- Production console: PASS. No warn/error logs observed during this pass.

Verified by local automated coverage:

- Combat ending awards server-owned XP and marks level-up availability at threshold.
- Progression awards dedupe by source id.
- Successful discovery awards exploration XP.
- Successful social influence awards social XP.
- Combat XP fallback uses simple HP bands when no stat-card XP exists.
- XP thresholds load from the 2024 progression table.
- DM2 sheet summary includes progression text such as `Progression: XP 125/300`.

Open QA note:

- I did not force a successful XP-awarding event in production during this pass. The existing `QA Smoke` session was in a difficult bridge/water state, and the natural challenge attempted failed. XP remained at 0, which is reasonable for a failed challenge. A fresh scenario that can deliberately produce a new successful discovery/social/combat award should be tested before declaring the full progression loop production-proven.

Current recommendation:

- First 4D foundation is safe to continue building on. Next QA should target a controlled XP award path in production, then check sheet display, DM2 progression summary, dedupe behavior, reload persistence, and level-up-ready display near/over 300 XP.

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
