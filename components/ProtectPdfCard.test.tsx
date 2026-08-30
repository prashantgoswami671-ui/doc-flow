// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ProtectPdfCard from "./ProtectPdfCard";

/**
 * SEC-04 — Honest password/protection UX copy.
 *
 * Guards the forgotten-password disclosure added for SEC-04: once a file
 * is selected (which is when the password fields — and this helper text
 * next to them — become visible), the user must be told DocFlow cannot
 * recover a forgotten password. Rendered-copy assertion only.
 */
describe("ProtectPdfCard forgotten-password disclosure", () => {
  afterEach(() => {
    cleanup();
  });

  it("tells the user a forgotten password cannot be recovered, once a file is selected", async () => {
    render(<ProtectPdfCard />);

    const file = new File(["%PDF-1.4 fixture"], "report.pdf", {
      type: "application/pdf",
    });
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    expect(
      await screen.findByText(
        /no way to recover a forgotten password/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/DocFlow doesn.t store it/i),
    ).toBeInTheDocument();
  });
});
