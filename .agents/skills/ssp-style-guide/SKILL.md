---
name: ssp-website-style
description: Apply the Software Solutions Pfatrisch website's visual design system to pages, components, and interfaces. Use when building or restyling UI to match the SSP website, its dark engineering portfolio aesthetic, or existing site components, even if the user does not explicitly mention a skill.
---

# SSP website style

Recreate the restrained, technical look of the Software Solutions Pfatrisch website: near-black layered surfaces, crisp square edges, thin zinc borders, a single violet accent, geometric bold headings, and monospaced interface text. Favor clear structure and generous section spacing over decoration. Adapt the patterns to the requested content rather than copying the site's personal details.

## Workflow

1. Inspect the target project's existing components, styling conventions and dependencies. If working in the original website, use `src/styles/main.scss`, `index.html` and the components in `src/components/` as the current source of truth; reuse their classes and components rather than introducing a parallel system.
2. For another project, translate the tokens and patterns below into its existing framework. Keep the visual language, but do not assume Vue or SCSS is required. Load the fonts only if the project permits external fonts; otherwise use the fallbacks.
3. Implement responsive layouts and interaction states, then check mobile and desktop widths, keyboard navigation, contrast, and reduced-motion behavior. Preserve existing functionality and avoid unrelated redesigns.

## Design tokens

| Purpose | Value |
| --- | --- |
| Main background / card fill | `#0f0f10` |
| Alternate section / logo background | `#18181b` |
| Border | `#27272a`, typically 1px |
| Accent / accent hover | `#8b5cf6` / `#a78bfa` |
| Primary text | `#fafafa` |
| Body text | `#a1a1aa` |
| Secondary text | `#71717a` |
| Dim metadata | `#52525b` |
| Availability dot, when relevant | `#22c55e` |

Use the low-contrast secondary and dim colors sparingly. Check contrast against the actual background, particularly for small text and violet button text; lighten foregrounds or darken surfaces as needed for accessibility instead of blindly reproducing low-contrast combinations.

**Fonts:** JetBrains Mono (400, 600, 700) for body, navigation, labels and buttons; Space Grotesk (700) for headings. Fallbacks are `monospace` and `sans-serif`. The original font URL is `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@700&display=swap` (with preconnects to `fonts.googleapis.com` and `fonts.gstatic.com`). Body defaults to `0.875rem/1.7`; headings use `line-height: 1.15` and `letter-spacing: -0.02em`.

**Shape and effects:** Square corners on cards, buttons and badges; no generic rounded SaaS cards, large shadows or colorful gradients. Use restrained background gradients and subtle violet borders on hover. Small circular dots and nodes are appropriate.

## Layout and typography

- Center a full-width container at `max-width: 1440px`. Horizontal padding is `1.25rem`, `2rem` at 768px, `3rem` at 1024px, and `5rem` at 1440px.
- Build mobile-first. Main content sections have vertical padding of `3rem`, `4rem` at 768px and `6.25rem` at 1024px. The hero uses `3rem`, `4rem`, then `7.5rem` respectively.
- Headings: hero `1.75rem`, `2.5rem` at 768px, `3.5rem` at 1024px. Section titles start at `1.75rem` and become `2.5rem` at 1024px. Highlight a meaningful second hero line in violet, not every heading.
- Section eyebrow: violet uppercase mono, `0.75rem`, weight 600, `0.1875rem` tracking. The site uses numbered labels such as `01 — SERVICES`. Smaller category labels use `0.625rem`, weight 700 and `0.125rem` tracking.
- Alternate main and alternate backgrounds across sections. Use generous empty space, left-aligned text, grid alignment and fine dividers to create hierarchy.
- Service cards form one column on mobile and two at 768px; a featured card may span the grid. Technology cards use one, two at 768px and four at 1024px. Bio/timeline columns become two at 768px. Card gaps range from `1rem` to `1.5rem`.

## Components and states

- **Header:** sticky dark bar with a bottom border, terminal-inspired violet mark and understated navigation. Show the desktop navigation and CTA at 1024px; below that, use a hamburger and full-screen dark navigation overlay. The original shows the brand text from 768px onward.
- **Buttons:** inline-flex, square, bold mono `0.8125rem`, `0.875rem 1.75rem` padding, `0.5rem` gap. Primary is violet with light text; secondary is transparent with a 1px border. On hover, lighten primary or turn the secondary border and text violet. Stack full-width buttons on mobile; arrange inline from 768px.
- **Cards:** near-black fill on the alternate section, 1px zinc border, `1.5rem` padding on mobile and `2rem` on desktop for service cards. Use violet line icons, a bold Space Grotesk title and small muted mono description. Border subtly shifts violet on hover. Compact tech cards use uppercase violet category labels and simple text lists.
- **Hero:** dark vertical gradient (`#0f0f10` to `#18181b` to `#1a1a1f`), optional outlined availability badge, two-line headline, concise supporting text and primary/secondary CTAs. A subdued, decorative SVG network of violet lines and nodes can add the engineering motif; keep text legible and mark it `aria-hidden`.
- **Timeline and footer:** thin horizontal rules, small mono metadata and generous separation. Highlight the current timeline period in violet. Footer navigation uses small uppercase tracked text.
- **Motion:** use subtle 150ms color/border transitions. If using the network, keep the node pulse slow (original: 5s) and decorative. The original mobile overlay slides in over 300ms with staggered items. Respect `prefers-reduced-motion`: disable or greatly shorten transitions and animation, and do not start animated network packets.

## Accessibility and verification

Use semantic landmarks and heading order, a skip link, visible keyboard focus (the original uses a 2px violet outline with 3px offset), and descriptive link/button labels. A mobile menu should expose expanded state, keep its closed contents inert, manage and restore focus, support Escape, and prevent background scrolling when open. Do not rely on color alone for meaning. Test text and interactive-state contrast against their actual backgrounds, including hover/focus, and adjust colors where necessary. Check that layouts do not overflow at narrow widths and that reduced motion works.
