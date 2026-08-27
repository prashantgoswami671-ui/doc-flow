// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PageThumbnailGrid, { type PageThumbnailItem } from "./PageThumbnailGrid";

/**
 * Focused contract tests for PageThumbnailGrid — the shared page picker
 * used by Organize Pages, Extract Pages, Split, and others. Covers the
 * selection/click contract and the accessibility labeling those tools
 * depend on, plus the missing-preview fallback.
 */

const pages: PageThumbnailItem[] = [
  { pageNumber: 1, dataUrl: "data:image/png;base64,aaa" },
  { pageNumber: 2, dataUrl: null },
];

afterEach(() => {
  cleanup();
});

describe("PageThumbnailGrid", () => {
  it("renders one button per page with a page-numbered accessible label", () => {
    render(<PageThumbnailGrid pages={pages} />);
    expect(screen.getByRole("button", { name: "Page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 2" })).toBeInTheDocument();
  });

  it("reflects isSelected in aria-pressed and the accessible label", () => {
    render(
      <PageThumbnailGrid pages={pages} isSelected={(page) => page.pageNumber === 1} />,
    );

    const selected = screen.getByRole("button", { name: "Page 1, selected" });
    expect(selected).toHaveAttribute("aria-pressed", "true");

    const unselected = screen.getByRole("button", { name: "Page 2" });
    expect(unselected).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onPageClick with the clicked page", () => {
    const onPageClick = vi.fn();
    render(<PageThumbnailGrid pages={pages} onPageClick={onPageClick} />);

    screen.getByRole("button", { name: "Page 2" }).click();

    expect(onPageClick).toHaveBeenCalledTimes(1);
    expect(onPageClick).toHaveBeenCalledWith(pages[1]);
  });

  it("disables every thumbnail button when disabled", () => {
    render(<PageThumbnailGrid pages={pages} disabled />);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("shows the 'Preview off' fallback when a page has no dataUrl", () => {
    render(<PageThumbnailGrid pages={[{ pageNumber: 3, dataUrl: null }]} />);
    expect(screen.getByText("Preview off")).toBeInTheDocument();
  });

  it("renders an image with a page-numbered alt text when dataUrl is present", () => {
    render(<PageThumbnailGrid pages={[pages[0]]} />);
    expect(screen.getByAltText("Page 1 preview")).toBeInTheDocument();
  });
});
