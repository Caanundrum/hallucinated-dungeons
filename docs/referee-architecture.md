# Referee Architecture

Hallucinated Dungeons separates mechanical truth from storytelling.

The AI Game Master narrates the world, improvises characters and situations, and proposes checks when a player tries something uncertain. The deterministic referee owns rules resolution and persisted mechanical state. A confident paragraph is not a spell slot, a map coordinate, or permission to fly.

## Core Flow

```text
player intent
  -> referee classifies the mechanical action
  -> referee validates entities, resources, targets, and timing
  -> referee resolves rolls and authoritative state transitions
  -> Game Master narrates from the resulting state
```

The Game Master can improvise inside the rules. It cannot silently override the rules.

## Shared Contracts

`server/src/refereeContracts.js` defines the vocabulary shared by referee modules:

- Reaction trigger families
- Reaction resume stages and persisted continuation types
- Entity types used by scene, combat, map, and multiplayer adapters
- Deterministic rules-effect primitives
- Validators for Reaction windows, resume frames, entities, rules effects, and authoritative state

New mechanics should extend these contracts before adding a new branch in an engine.

## Entities

`server/src/rulesContext.js` adapts current scene and combat data into one entity model.

Every entity has:

- a stable `id`
- a registered `type`
- a readable `name`
- optional aliases
- optional position
- visibility state
- allowed interactions

The same model is used for player characters, NPCs, creatures, objects, hazards, exits, known nearby locations, and active effects. Future hex maps and multiplayer presence extend this model rather than create parallel rule islands.

## Reactions And Interrupts

A Reaction window is a persisted transaction:

```js
{
  trigger: "attack_hit",
  resume_stage: "before_attack",
  options: [{ id: "shield", type: "cast_spell", label: "Cast Shield" }],
  resume: {
    type: "combat_movement",
    stage: "before_attack",
    // original movement and continuation state
  }
}
```

The window pauses the original action. After the player chooses a Reaction or declines, the referee resumes from the stored stage. This prevents double damage, lost movement, skipped turns, and other small disasters with excellent narrative confidence.

Current registered examples:

- `attack_hit`: Shield resolves before damage.
- `damage_taken`: Hellish Rebuke resolves after damage.

Planned trigger families include creatures leaving reach, falling creatures, and Magic Missile targeting. They remain inactive until their underlying state exists.

## Rules Effects

Spells, features, species traits, and future items should express repeatable mechanics as registered effect primitives:

```js
{ target: "armor_class_bonus", value: 2, label: "Protective shimmer" }
{ target: "weapon_damage_bonus_die", die: "1d4", damage_type: "radiant" }
```

Narration remains free-form. Mechanical effects do not.

## State Ownership

The referee owns:

- action economy, initiative, rounds, rests, and durations
- dice, DCs, advantage, disadvantage, and rerolls
- HP, temporary HP, damage, healing, saves, and conditions
- spell slots, limited uses, equipment math, and active effects
- combatant positions, visibility, reach, and map movement
- pending rolls and pending Reaction windows

The Game Master owns:

- description, dialogue, NPC motives, and atmosphere
- story branches, secrets, rumors, and pacing
- improvised fictional details consistent with entity state
- proposals for uncertain actions that the referee resolves

## Extension Rule

When adding a mechanic:

1. Model the reusable state or trigger.
2. Add or reuse a contract primitive.
3. Resolve it in the referee.
4. Persist the resulting state.
5. Expose the state to narration.
6. Add deterministic regression tests.

Avoid player-phrase patches. If a rule only works when the player says one exact sentence, it is not a rule yet.
