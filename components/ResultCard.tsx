interface ResultCardProps {
  fileName: string;
  pageCount: number;
  originalSize: number;
  processedSize: number;
  reduction: number;
  processingTime: number;
  mode: string;
  onDownload: () => void;
  onCompressAnother: () => void;
}

function formatModeLabel(mode: string): string {
  switch (mode) {
    case "light":
      return "Light Compression";
    case "heavy":
      return "Heavy Compression";
    case "custom":
      return "Custom Compression";
    default:
      return mode;
  }
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export default function ResultCard({
  fileName,
  pageCount,
  originalSize,
  processedSize,
  reduction,
  processingTime,
  mode,
  onDownload,
  onCompressAnother,
}: ResultCardProps) {
  return (
    <div className="mt-8 w-full max-w-2xl rounded-2xl border border-gray-200 bg-white p-8 shadow-lg">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl">
          ✅
        </div>

        <div>
          <h2 className="text-2xl font-bold text-gray-900">
            Compression Complete
          </h2>

          <p className="text-sm text-gray-500">
            Your PDF has been processed successfully.
          </p>
        </div>
      </div>

      {/* Statistics */}
      <div className="grid grid-cols-2 gap-5">

        <Stat title="📄 File Name" value={fileName} />

        <Stat title="📑 Pages" value={pageCount.toString()} />

        <Stat
          title="📦 Original Size"
          value={formatSize(originalSize)}
        />

        <Stat
          title="📦 Processed Size"
          value={formatSize(processedSize)}
        />

        <Stat
          title="📉 Reduction"
          value={`${reduction.toFixed(1)} %`}
        />

        <Stat
          title="⚡ Processing Time"
          value={`${processingTime.toFixed(2)} sec`}
        />

        <Stat title="⚙️ Mode" value={formatModeLabel(mode)} />
      </div>

      {/* Download Button */}
      <button
        onClick={onDownload}
        className="mt-8 w-full rounded-xl bg-blue-600 py-3 text-lg font-semibold text-white transition hover:bg-blue-700"
      >
        Download PDF Again
      </button>

      <button
        type="button"
        onClick={onCompressAnother}
        className="mt-3 w-full rounded-xl border border-gray-300 bg-white py-3 text-lg font-semibold text-gray-700 transition hover:bg-gray-50"
      >
        Compress another PDF
      </button>
    </div>
  );
}

interface StatProps {
  title: string;
  value: string;
}

function Stat({ title, value }: StatProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <p className="text-sm text-gray-500">{title}</p>

      <p className="mt-1 break-all text-lg font-semibold text-gray-900">
        {value}
      </p>
    </div>
  );
}