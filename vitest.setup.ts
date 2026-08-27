// Registers jest-dom's DOM matchers (toBeInTheDocument, toHaveAttribute,
// toBeDisabled, toBeEmptyDOMElement, etc.) on vitest's `expect`. Harmless
// for non-DOM (node-environment) test files — it only extends the
// matcher set, it does not require a DOM to load.
import "@testing-library/jest-dom/vitest";

// jsdom does not implement DataTransfer — provide a minimal polyfill so any
// test that (reasonably) does `new DataTransfer()` keeps working. The only
// contract exercised by DocFlow's tests is `dt.items.add(file)` + `dt.files`.
if (typeof globalThis.DataTransfer === "undefined") {
  class DataTransferPolyfill {
    private _files: File[] = [];
    items = {
      add: (file: File) => {
        this._files.push(file);
      },
    };
    get files(): FileList {
      const files = this._files;
      return {
        length: files.length,
        item: (index: number) => files[index] ?? null,
        ...Object.fromEntries(files.map((f, i) => [i, f] as const)),
        [Symbol.iterator]: () => files[Symbol.iterator](),
      } as unknown as FileList;
    }
  }
  (globalThis as unknown as Record<string, unknown>).DataTransfer =
    DataTransferPolyfill as unknown as typeof DataTransfer;
}
