@AGENTS.md

# Project Rules (MANDATORY — apply to every request)

These rules apply to every change in this project. If a request conflicts with a rule, stop and ask before acting.

## 1. Before changing anything
- Read the files involved and any related files first. Never edit a file you have not read.
- Briefly state what will change and which files will be touched before making large or multi-file changes.
- Change only what was asked. No unrequested refactors, renames, reformatting, or "cleanups".
- If the request is ambiguous, ask a question instead of guessing.

## 2. CSS / styling (preserve the existing design)
- Always reuse the existing styles first: existing classes, CSS variables/tokens, colors, fonts, spacing, border radius, shadows, and breakpoints.
- Never introduce new colors, font families, font sizes, or spacing values that are not already used in the project, unless explicitly asked.
- Match the existing naming convention for classes (e.g. BEM, kebab-case) and the existing file/organization pattern.
- Do not use inline styles or `!important` unless the existing code already does so in that place.
- Do not change global styles (resets, `body`, `:root`, shared components) to fix a local issue — scope the change.
- Keep existing responsive behavior and dark/light theme behavior working.
- New UI elements must look like they already belong to the site (same buttons, cards, inputs, headings).

## 3. Documentation structure (frozen)
- Do not change the documentation structure — folder layout, file names, heading hierarchy, section order, numbering, templates, or formatting style — unless the user explicitly says to.
- When updating content, edit inside the existing sections only. Do not add, remove, merge, rename, or reorder sections without permission.
- Keep the existing tone, terminology, and format (tables stay tables, lists stay lists).

## 4. Files and structure
- Do not create, delete, move, or rename files/folders unless asked.
- Never delete content or files without explicit confirmation.
- Do not add new libraries, dependencies, CDNs, or frameworks without approval.

## 5. Code consistency
- Follow the existing code style: indentation, quotes, naming, comment style, and patterns.
- Do not change working behavior that is unrelated to the request.
- Keep HTML semantic and accessible (alt text, labels, contrast) at least to the level already present.

## 6. Verification and reporting
- After changes, check the result (open/preview the page when possible) and confirm nothing else broke.
- At the end, report: which files changed, what changed, and anything not done or not verified.
- Be honest about failures — never claim something works without checking.

## 7. Safety
- Ask before any irreversible action (deleting, overwriting large sections, publishing, sending).
- Do not touch credentials, keys, or config secrets.
