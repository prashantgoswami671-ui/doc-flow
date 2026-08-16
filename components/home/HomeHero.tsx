/**
 * DocFlow homepage hero. Presentation only — communicates the workspace
 * value proposition and links into the existing upload/compression
 * workflow under the Enhance section. Must not own PDF/document state or
 * duplicate upload logic; the actual upload lives in UploadCard.
 */
export default function HomeHero() {
  return (
    <section className="border-b border-gray-200 bg-white">
      <div className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6 sm:py-20">
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
          Document Workspace
        </p>

        <h1 className="mt-4 text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
          Your documents, one workspace.
        </h1>

        <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-600">
          Organize, create, convert, enhance, and protect your documents from
          one place.
        </p>

        <div className="mt-8 flex items-center justify-center">
          <a
            href="#enhance"
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Upload a PDF
          </a>
        </div>
      </div>
    </section>
  );
}
