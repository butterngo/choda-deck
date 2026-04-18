# Design System (Tailwind-based)

## Spacing

- Use Tailwind spacing: `p-2`, `p-4`, `p-6`, `p-8`
- Section gaps: `space-y-6` or `gap-6`
- Component internal padding: `p-4` standard

## Typography

- 1 font family max. System font stack preferred
- Size hierarchy: `text-sm` (secondary), `text-base` (body), `text-lg` (heading), `text-xl`+ (title)
- Max 3 font sizes per screen

## Color

- Neutral base: grays for backgrounds, borders, text
- 1 primary accent for CTAs and active states
- Semantic: green (success), red (error), yellow (warning), blue (info)
- No color as sole indicator — pair with icon or text

## Components

- Buttons: primary (filled), secondary (outlined), ghost (text only). Max 1 primary per section
- Cards: `rounded-lg border bg-white p-4 shadow-sm`
- Inputs: consistent height, visible focus ring, clear label
- Tables: `divide-y`, hover state, compact rows
- Modals: overlay + centered card, close on escape/overlay click
