# Synpeer Design System

The design system is dark-first, mobile-first, and inspired by restrained 80s neon interfaces. It provides visual primitives only: no social, identity, network, storage, or domain behavior belongs here.

## Tokens

Tokens live in `src/styles/tokens` and are exported from `src/styles/tokens/index.ts`.

- `colors`: dark and light palette structure. Dark is the default.
- `typography`: system font sizes, line heights, and weights.
- `spacing`: numeric spacing scale.
- `radius`: border radius scale.
- `shadows`: soft and neon shadow presets.
- `zIndex`: layering scale.
- `animation`: shared durations and easing names.

## Theme

`ThemeProvider` lives in `src/styles/theme`. It uses dark mode by default and accepts `colorScheme="light"` only as a prepared structure.

## UI Components

Reusable UI components live in `src/components/ui` and are exported from `src/components/ui/index.ts`.

Current components:

- `Avatar`
- `Button`
- `Card`
- `Divider`
- `Header`
- `Input`
- `Loading`
- `Modal`
- `Screen`
- `Skeleton`
- `Text`

These components must stay independent from business logic.
