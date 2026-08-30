// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import UnlockPdfCard from "./UnlockPdfCard";

/**
 * SEC-05 — Honest password-handling copy on Unlock PDF, matching the
 * guarantee already disclosed on Protect PDF (SEC-04): the password typed
 * here is used only in-browser (services/pdf/unlock.ts never transmits it
 * anywhere) and is never stored by DocFlow. Rendered-copy assertion only.
 */
describe("UnlockPdfCard password-handling disclosure", () => {
  afterEach(() => {
    cleanup();
  });

  it("tells the user DocFlow doesn't store the unlock password, once a file is selected", async () => {
    render(<UnlockPdfCard />);

    const file = new File(["%PDF-1.4 fixture"], "report.pdf", {
      type: "application/pdf",
    });
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    expect(
      await screen.findByText(/doesn.t store the password/i),
    ).toBeInTheDocument();
  });
});
