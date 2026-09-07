# Lead Story design QA

final result: passed

## Findings

No actionable P0, P1, or P2 findings remain. This is a responsive implementation of the user's selected “焦點頭條 / Lead Story” image in the existing ETF application, not a change to its collection pipeline.

## Visual truth and evidence

- Source visual truth: `outputs/dragonfly-directions/selected-lead-story-reference.png` (retained locally; generated references and QA captures are not published to GitHub).
- Source dimensions: 1487 × 1058 pixels, desktop content without browser chrome.
- Implementation: `http://127.0.0.1:3002/`, using the isolated, development-only public-dashboard snapshot preview in `outputs/dragonfly-directions/vite.design-preview.mjs`.
- Implementation screenshot: `outputs/dragonfly-directions/desktop-final.jpg`.
- CSS viewport: 1488 × 1056, desktop, device scale factor 1. Browser capture exports 1473 × 1045 pixels; both images were normalized to 1488 × 1056 for comparison. The small capture scale/scrollbar difference is not treated as a design defect.
- State: latest Top 5, no search, menu or dialog open, page at top; public September 7 snapshot with the first story “我的投资组合”, index 94 and 21 indexed discussion samples.
- Full-view combined evidence, source left and implementation right: `outputs/dragonfly-directions/comparison-final.png`.
- Focused combined evidence: `outputs/dragonfly-directions/comparison-detail-headline.png` and `outputs/dragonfly-directions/comparison-detail-stories.png`. These were inspected because the full comparison is downscaled by the viewer.
- Supporting captures: `mobile-final-320.jpg`, `mobile-375.jpg`, `mobile-final-768.jpg`, `detail-desktop.jpg`, `status-mobile.jpg`, and `stale-data-desktop.jpg`, all under `outputs/dragonfly-directions/`.

## Comparison history

1. **P1, typography:** the initial browser render used a heavier fallback face because font custom properties were scoped below the tokens that consumed them. Moved the generated font-variable classes to the root HTML element and loaded Noto Sans SC, including weight 100. `desktop-pass2.png` and later focused headline comparisons confirm the thin Chinese display face, separate readable body weight, and intended single-line title.
2. **P2, composition:** the initial edition strip pushed the right-hand list and daily panel too far down. Scoped a compact edition placement to an unobstructed, populated Top 5 view; adjusted hero and row spacing. `desktop-pass3.png`, `comparison-pass3.png`, and `comparison-final.png` confirm the 55/45 split, aligned divider, and daily panel within the reference's first-screen composition.
3. **P2, navigation:** changing views through the bottom daily or status controls could leave the viewport at the previous scroll position. Reset scroll on navigation/view changes. Browser testing confirmed the daily view opens at `scrollY: 0`; repeated brand navigation also returns to the top.
4. **P2, exceptional state:** the compact edition strip could overlap a collection or refresh warning. Disabled compact placement for errors, warnings, delayed/cooldown states, empty data, and search. `stale-data-desktop.jpg` confirms the edition ends at y=136, the delay alert starts at y=136 and ends at y=238, and the hero starts at y=258. A long untranslated title also wraps without clipping.

## Required fidelity surfaces

- **Fonts and typography:** Noto Sans SC's thin display weight reproduces the selected oversized orange headline; body and navigation use readable regular/medium weights. Fallback scope verified in-browser. Title sizing adapts to longer Chinese or English content. Metadata can wrap on narrow screens; detailed content remains available in the modal.
- **Spacing and layout:** black editorial canvas, 72 px desktop navigation, 32 px page gutters, 55/45 lead/list split, restrained separators, and a compact bottom report strip. The desktop daily panel begins at approximately y=880. Mobile stacks the lead story and remaining discussions without concealing controls.
- **Colors and tokens:** black/charcoal surfaces, off-white foreground, muted gray metadata, and orange-red emphasis are centralized in `tokens.css`. Focus indicators are visible and status colors remain semantic. The primary orange button intentionally has dark text for stronger contrast than the mock's white text.
- **Image quality and assets:** the generated 1024 × 1024 WebP particle field is approximately 68 KB and is a real raster asset, not CSS/SVG art. Its flowing point-cloud subject, monochrome palette, black integration, and lower-right placement match the selected direction. It is decorative with empty alt text. Existing product Radio branding and matched library icons are retained rather than adopting the mock's invented mark. No placeholder imagery remains.
- **Copy and content:** titles, author/community metadata, dates, summaries, metrics, and original Reddit links come from existing data. The fifth story's real author/date replace erroneous generated-image text. “Discussion samples” are not represented as total traffic or official KOL authority. The report strip names the actual report date and links to history; an older report is not presented as a newly generated report. Missing translation and unavailable metrics are explicit.

## Interaction and responsive verification

- Opened the first story, read highlights, expanded translated content, closed with Escape, and confirmed focus restoration to the invoking control.
- Searched an author to obtain one result while retaining its original rank; verified the no-match state and clearing the query.
- Tested Top 5, 24-hour tracking, daily, weekly, authors, and status navigation, including the mobile menu and bottom report control.
- Verified canonical original Reddit URLs in the rendered links. No external post or account mutations were performed.
- Refresh completes; the design preview deliberately returns the same frozen real-data snapshot. The production API and collectors are not overridden by this ignored development harness.
- A single observation displays an honest “待累积趋势” message instead of the old large, misleading orange trend block.
- At 320, 375, 414, and 768 CSS-pixel widths, document scroll width equals available content width and inspected controls/headlines have no horizontal overflow. Full visual captures at 320, 375, and 768 confirm legible stacking, metadata wrapping, accessible actions, and report placement.
- The browser capture surface occasionally lagged an immediately preceding viewport change; stale loop captures were excluded from visual conclusions and 320/768 were recaptured after confirming viewport state.
- Search and menu controls have accessible names and state; primary navigation uses `aria-current`; there is a skip link, semantic h1, accessible dialog title/description, focus styling, and reduced-motion support.
- Final browser error/warning log check returned an empty list.

## Engineering checks

- `npm run typecheck`: passed.
- `npx oxlint components/dashboard-app.tsx components/lead-topics.tsx app/layout.tsx`: passed.
- `npm test`: 49 passed, 0 failed.
- `npm run build`: passed with existing Vinext/Cloudflare routes preserved.
- `git diff --check`: passed (only informational Windows line-ending warnings).
- Independent read-only frontend review found no additional P0/P1/P2 regressions.

## Open questions and limits

- The source is a desktop mock; mobile and exceptional states are responsive adaptations, not claimed pixel-for-pixel source matches.
- This verifies the frontend, not live collection health or deployment credentials. No D1 records, collector logic, workflow, or production hosting configuration were changed.
- The preview uses a real September 7 snapshot for stable visual review. `http://localhost:3001/` also runs the standard app against existing older local data; its delay warning was checked separately.
- Formal screen-reader auditing and browser text zoom beyond the tested responsive widths were not performed.

## Follow-up polish

- P3 only: the regenerated particle folds, font rasterization, and some micro-spacing differ from the raster mock. These do not alter layout, readability, or interaction and are not release blockers.

## Implementation checklist

- [x] Resolve and inspect the exact selected visual.
- [x] Generate and place the decorative asset.
- [x] Integrate with existing data and interactions.
- [x] Fix all P0/P1/P2 findings and compare revised captures.
- [x] Check mobile layouts, exceptional states, console, tests, types, lint, and build.
- [x] Keep a working local preview available.
- [x] User approved publishing this version to the existing public site and pushing it to GitHub after the local QA handoff.
