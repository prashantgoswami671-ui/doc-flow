// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CompressPdfCard from "./CompressPdfCard";

/**
 * CMP-08 — Compression Quality Explanation UX.
 *
 * Guards the Custom-compression help copy so a normal user can understand
 * that Custom targets a file size, that the target is not guaranteed, and
 * that a smaller target requires stronger compression which can lower
 * visual quality. Rendered-copy assertions only — no implementation
 * details.
 */
describe("CompressPdfCard custom compression explanation", () => {
  afterEach(() => {
    cleanup();
  });

  it("explains the target is not guaranteed and that a smaller target means stronger compression and lower quality", () => {
    render(<CompressPdfCard />);

    fireEvent.click(screen.getByRole("radio", { name: /custom size/i }));

    expect(
      screen.getByText(
        /It's a target, not a guarantee.*A smaller target means stronger compression, so the output may look noticeably lower quality/i,
      ),
    ).toBeInTheDocument();
  });
});