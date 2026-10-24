# coss-ui style adaptation

The extension popup, setup guide, and settings page use component styles adapted from [coss-ui](https://coss.com/ui), paired with semantic HTML, plain JavaScript, and standalone CSS. The tables below list the upstream primitives and how they were adapted for this repository.

## Source snapshot

Component styles are based on `cosscom/coss` commit [`e937becd2d5ffb5c621eed6f8b1f223cbb6051e7`](https://github.com/cosscom/coss/tree/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7). Only files from the MIT-licensed `apps/ui` directory were used (per the upstream [licensing declaration](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/LICENSING.md)); no code from `packages/ui` is included.

| Local primitive | Upstream source | Adapted behavior and styles |
| --- | --- | --- |
| Button | [button.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/button.tsx) | Default and outline variants, default and icon sizes, inset borders, shadows, hover/active/disabled states, focus ring, and touch targets |
| Input | [input.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/input.tsx) | Native input wrapper, border and inset shadow, `focus-within` ring, and default sizing |
| Card | [card.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/card.tsx) | Card container, rounded border, background clipping, subtle shadow, and inset border |
| Badge | [badge.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/badge.tsx) | Secondary, success, info, and warning variants at default size |
| Alert | [alert.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/alert.tsx) | Default, error, info, success, and warning variants; optional icon, title, description, and responsive action slots |
| Switch | [switch.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/switch.tsx) | Responsive track and thumb sizing, checked translation, active press stretch, disabled opacity, focus ring, and transitions |
| Select | [select.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/select.tsx) | Trigger sizing, border and focus/error states, label truncation, dropdown surface, option grid, check indicator, and highlighted/disabled states |

- **Switch** wraps a native `<input type="checkbox" role="switch">`. The track measures 38×22 px (20 px thumb) on mobile viewports and scales down to 30×18 px (16 px thumb) at the 640 px breakpoint.
- **Select** pairs a `<button role="combobox">` trigger with a `<div role="listbox">` menu. `extension/ui-controls.js` handles keyboard navigation, typeahead, focus management, and viewport clamping. The dropdown merges the upstream surface and list into a single natively scrollable container instead of using scroll-arrow buttons. Triggers are 36 px tall (32 px at `>=640px`), and option rows are 32 px tall (28 px at `>=640px`).
- **Alert** follows the [upstream slot layout](https://coss.com/ui/docs/components/alert) (`alert-title`, `alert-description`, and `alert-action`, plus an optional leading SVG icon). Action buttons sit inline at `>=640px` and stack below the message on narrower viewports, while simple single-line alerts remain single-column. Status notices use `role="status"` and errors use `role="alert"`.
- **Theme tokens** follow the [coss styling specification](https://coss.com/ui/docs/styling.md), with light/dark neutral palettes, alpha borders, semantic colors, border radii, and shadows compiled directly to OKLCH values in CSS. System font stacks are used throughout so the extension makes no external font requests.
- **Frame** is adapted from the [`apps/ui` Frame component](https://github.com/cosscom/coss/blob/main/apps/ui/registry/default/ui/frame.tsx) (`main` branch). It retains the 72% muted outer shell, 4 px inset and panel spacing, panel borders, radius tokens, and `frame` / `frame-panel` / `frame-panel-header` / `frame-panel-title` / `frame-panel-description` `data-slot` attributes.

## Local customizations

- Tailwind utility classes from the upstream React components were hand-translated into plain CSS in `extension/styles/coss.css`, which serves as the single source of truth (no CSS build step required).
- Upstream `data-slot` names are kept intact, supplemented by `select-item-text` and `select-item-indicator` for the custom Select widget. Only variants actually used by the extension are included.
- Dark mode follows `prefers-color-scheme` by default and can be overridden via `data-theme="light|dark"` on `<html>`. Both Forced Colors (`forced-colors: active`) and Reduced Motion (`prefers-reduced-motion: reduce`) are supported.
- Page-specific layout and typography live in `popup.css`, `options.css`, and `setup.css`, while shared component tokens and states stay in `coss.css`.
- Connection endpoints and API keys use a monospace font stack, icon-only buttons include `aria-label` and `title` attributes, and inline SVGs are used for icons and indicators.

These adapted styles are maintained by this project without upstream endorsement, and the MIT license notice is bundled at `styles/LICENSE.coss.txt`.

## Updating styles

To pull in upstream design updates, compare the component sources and styling docs at the new commit against `extension/styles/coss.css`, update this file, and run the test suite (`devenv shell -- bridge-check`). Visually verify both light and dark themes across `popup-preview.cjs` and `options-preview.cjs`, checking keyboard focus rings, open Select menus, switches, offline/busy states, and long error messages.
