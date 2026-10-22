# Designing mobile-first applets

Use for new applet interfaces and requested visual changes. Preserve the owner's explicit style and working workflows. Design a daily-use tool: put the current task and its next action on the first screen; omit promotional heroes, feature tours and decorative dashboards.

Before coding, choose a compact visual direction suited to the subject: surface and text colors, one accent, a type hierarchy and spacing scale. Use these consistently. Give the app character through its content and one deliberate visual feature, not a collection of competing effects. Use available system fonts and supported CSS; the sandbox does not load external fonts, packages or assets. Follow read_sdk for Preact/HTM and backend calls.

At phone size, the main action must be visible without scrolling through summary cards or guidance. Keep the daily summary compact and put detailed comparisons and optional advice below the working controls or behind disclosure. Choose a short, clear navigation scheme; several desktop tabs should not turn into a clipped row with no indication that more destinations exist. Let date controls and headers wrap, use min-width:0 for shrinking grid/flex children, and constrain form controls to their container.

Start with a 390px-wide phone and make the layout work at 320px. Use a single primary column, readable 16px form text, short labels and clear units. Keep frequent controls near the content they affect. Aim for 44px touch targets with separation. Do not depend on hover. Wrap long names and errors; never hide essential values behind ellipses. Avoid page-wide horizontal scrolling. For genuinely tabular comparisons, use a labeled scrolling table region; otherwise use compact rows with secondary detail on demand. Expand the layout on larger screens only where it helps the task.

Make priority visible: one main action per task, quiet secondary actions, and destructive actions separated from routine controls. Group related content with spacing and headings before adding cards. Align numeric values and keep precision consistent. For a tracker, show the selected date, useful totals and recent entries, with a direct way to add or edit an entry; move occasional settings out of the daily flow. Adapt this structure to the actual brief rather than repeating it for every app.

Include initial loading, useful empty states, populated views, saving feedback and recoverable errors. Keep entered values after a failed save. Use visible field labels, semantic buttons, keyboard focus and adequate contrast; convey status in words as well as color. Sticky elements must leave the final row and focused inputs reachable. Respect reduced motion.

Verify the main journey with frontend interaction tests using realistic content, including long names and nonempty data. Check add/edit/save and the resulting values, not just a heading. Use the available browser diagnostics to inspect overflow, clipped controls and console errors. If screenshots can be viewed with the provided tools, review phone and wide layouts and fix visible defects. Do not claim visual review from a filename alone or invent screenshot tools. Release only after the SDK's required backend and frontend checks pass.

## Design references

Original applet-specific guidance informed by [Anthropic's frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md), [W3C reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) and [W3C enhanced target size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html). The 44px target is our design preference, not a claim of complete WCAG conformance.
