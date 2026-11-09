import { describe, expect, it } from "vitest";

import { panelsAfterElevationSelect, panelsAfterHighlightDrill } from "./panel-state";

describe("panelsAfterElevationSelect", () => {
  it("reopens a closed details pane when an elevation is selected", () => {
    expect(panelsAfterElevationSelect({ list: true, details: false })).toEqual({
      list: true,
      details: true,
    });
  });

  it("keeps an open details pane open", () => {
    expect(panelsAfterElevationSelect({ list: true, details: true })).toEqual({
      list: true,
      details: true,
    });
  });

  it("does not force the list pane open (the click already happened there)", () => {
    expect(panelsAfterElevationSelect({ list: false, details: false })).toEqual({
      list: false,
      details: true,
    });
  });
});

describe("panelsAfterHighlightDrill", () => {
  it("reopens both panes from a highlight click", () => {
    expect(panelsAfterHighlightDrill({ list: false, details: false })).toEqual({
      list: true,
      details: true,
    });
  });

  it("keeps both panes open when they already are", () => {
    expect(panelsAfterHighlightDrill({ list: true, details: true })).toEqual({
      list: true,
      details: true,
    });
  });

  it("reopens the list pane even when only the details pane was closed", () => {
    expect(panelsAfterHighlightDrill({ list: true, details: false })).toEqual({
      list: true,
      details: true,
    });
  });
});
