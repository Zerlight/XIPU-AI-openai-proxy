# coss ui adaptation

The popup and settings page adapt the official coss ui component styles. Semantic HTML, local JavaScript, and checked-in CSS provide the controls and their interaction states. The tables below identify the source components and the adaptations maintained in this repository.

## Source snapshot

Component styles are adapted from cosscom/coss commit [`e937becd2d5ffb5c621eed6f8b1f223cbb6051e7`](https://github.com/cosscom/coss/tree/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7). Only the MIT-licensed `apps/ui` sources were adapted. The upstream [licensing declaration](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/LICENSING.md) explicitly identifies that directory as MIT. No `packages/ui` implementation is included.

| Local primitive | Pinned upstream source | Adapted behavior and styles |
| --- | --- | --- |
| Button | [button.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/button.tsx) | Default and outline variants, default and icon sizes, inset edge, shadow, hover/pressed/disabled states, focus ring, touch target |
| Input | [input.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/input.tsx) | Native input branch, surrounding control, border and edge shadow, focus-within ring, default size |
| Card | [card.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/card.tsx) | Card root, rounded border, background clipping, shallow shadow and inset edge |
| Badge | [badge.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/badge.tsx) | Secondary, success, info, warning variants; default size |
| Alert | [alert.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/alert.tsx) | Error variant, border, background, spacing, radius, alert semantics |
| Switch | [switch.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/switch.tsx) | Responsive track/thumb sizes, primary checked track, background-colored thumb, checked translation, pressed stretch, disabled opacity, focus ring and transitions |
| Select | [select.tsx](https://github.com/cosscom/coss/blob/e937becd2d5ffb5c621eed6f8b1f223cbb6051e7/apps/ui/registry/default/ui/select.tsx) | Default trigger size, border and inset edge, focus/error states, value truncation, popup surface and padding, item grid, selected indicator, highlighted and disabled states |

Switch uses a labelled native checkbox with `role="switch"`; its track is 38×22 px with a 20 px thumb, changing to 30×18 px with a 16 px thumb at the upstream 640 px breakpoint. Select uses a button combobox and a separate listbox. Local JavaScript manages keyboard navigation, selection, focus, and viewport placement. Its popup combines the upstream surface and list into one scrollable element; native scrolling replaces the upstream scroll-arrow controls. The trigger is at least 36 px high, changing to 32 px at 640 px; items change from 32 px to 28 px. Forced-color styles use system colors, and reduced-motion preferences disable transitions.

Theme tokens follow the official [coss styling documentation](https://coss.com/ui/docs/styling.md). Its light/dark neutral palette, alpha borders, semantic colors, radius scale, and shadow treatment are expanded into browser-ready CSS. Palette variables are resolved to their corresponding OKLCH values. The font uses the documented system fallback to avoid external font requests.

The settings layout adapts [Frame](https://coss.com/ui/docs/components/frame) from the official [`apps/ui` Frame source](https://github.com/cosscom/coss/blob/main/apps/ui/registry/default/ui/frame.tsx). Frame is referenced from `main`; no immutable revision is recorded for this component. The adaptation preserves its muted 72% shell, 4px inset and panel spacing, panel borders and inset edges, radius tokens, and exact `frame` / `frame-panel` / `frame-panel-header` / `frame-panel-title` / `frame-panel-description` slot names. This is a static layout primitive, with no animation dependency. Setting rows and the compact Appearance panel customize content spacing; native tab buttons provide keyboard navigation between General, Connection, and Advanced.

## Deliberate adaptations

- Utility declarations are expanded by hand into ordinary CSS in `extension/styles/coss.css`; this is the source of truth, not an output requiring regeneration.
- Component `data-slot` names are preserved, with local slots for the Select item text and indicator. Only variants used by the popup and settings page are included.
- Dark mode follows the operating system via `prefers-color-scheme` by default. The settings page can persist a light or dark override, shared with the popup through `data-theme`. Reduced motion is respected.
- `extension/styles/popup.css` and `extension/styles/options.css` contain page layout and typography adjustments. Component colors, borders, radii, and focus treatments remain in the shared stylesheet.
- Input content uses a monospace system font for connection values. Labels, feedback, and status text are accessible; icon-only controls have names.
- The popup's arrow, copy, eye, and reconnect icons use original inline SVG geometry. Select uses inline chevrons and a selected-item check indicator.

The adapted styles are maintained by this project without upstream endorsement. The MIT notice is shipped with the extension in `styles/LICENSE.coss.txt`.

## Updating

Review the listed MIT component files and styling documentation at a new pinned commit. Apply the declarations used by the popup and settings page, update this document, and run the JavaScript tests. Visually inspect both light and dark themes, including keyboard focus, open Select popups, checked and unchecked switches, unavailable native host, absent tab, running request, long error text, and clipboard failure.
