/** Panel visibility rules for the three-column layout.
 *
 * One place decides which panes must be (re)opened after an interaction, so
 * the UI can never again swallow a click because the user had closed a pane:
 *
 * - selecting an elevation (list row, book accordion entry, detail pager)
 *   always reveals the details pane
 * - drilling down from a document highlight reveals BOTH panes (the list
 *   shows the drill-down scope, the details pane the strongest match)
 */

export type PanelOpenState = {
  list: boolean;
  details: boolean;
};

/** Panels after the user selected an elevation from the middle column. */
export function panelsAfterElevationSelect(current: PanelOpenState): PanelOpenState {
  return { ...current, details: true };
}

/** Panels after the user clicked a highlight in the document text. */
export function panelsAfterHighlightDrill(_current: PanelOpenState): PanelOpenState {
  return { list: true, details: true };
}
