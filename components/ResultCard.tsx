interface ResultCardProps {
  fileName: string;
  pageCount: number;
  originalSize: number;
  processedSize: number;
  reduction: number;
  processingTime: number;
  mode: string;
  /** Only meaningful when mode === "custom"; the target the user asked for. */
  targetSizeMb?: number;
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

/**
 * Formats a byte count with one consistent unit scale (B/KB/MB) used across
 * the whole Compress PDF experience — both the pre-upload file size and the
 * post-compression result stats read from this single helper.
 */
export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/** Below this magnitude a size change isn't meaningfully a "reduction" or an "increase". */
const NEGLIGIBLE_CHANGE_PERCENT = 1;

/**
 * Describes the actual measured size change truthfully. A real compression
 * engine sometimes produces almost no change, or (rarely) a larger file —
 * this must never be presented as a reduction when it isn't one.
 */
function describeReduction(reductionPercent: number): {
  label: string;
  value: string;
  tone: "positive" | "neutral" | "warning";
} {
  if (reductionPercent > NEGLIGIBLE_CHANGE_PERCENT) {
    return {
      label: "Reduced by",
      value: `${reductionPercent.toFixed(1)}%`,
      tone: "positive",
    };
  }

  if (reductionPercent < -NEGLIGIBLE_CHANGE_PERCENT) {
    return {
      label: "Size increased by",
      value: `${Math.abs(reductionPercent).toFixed(1)}%`,
      tone: "warning",
    };
  }

  return {
    label: "Reduction",
    value: "Not significantly reduced",
    tone: "neutral",
  };
}

export default function ResultCard({
  fileName,
  pageCount,
  originalSize,
  processedSize,
  reduction,
  processingTime,
  mode,
  targetSizeMb,
  onDownload,
  onCompressAnother,
}: ResultCardProps) {
  const reductionInfo = describeReduction(reduction);
  const targetBytes =
    mode === "custom" && targetSizeMb && Number.isFinite(targetSizeMb)
      ? targetSizeMb * 1024 * 1024
      : undefined;
  const targetMissed = targetBytes !== undefined && processedSize > targetBytes;

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
          value={formatFileSize(originalSize)}
        />

        <Stat
          title="📦 Compressed Size"
          value={formatFileSize(processedSize)}
        />

        <Stat
          title={`📉 ${reductionInfo.label}`}
          value={reductionInfo.value}
          tone={reductionInfo.tone}
        />

        <Stat
          title="⚡ Processing Time"
          value={`${processingTime.toFixed(2)} sec`}
        />

        <Stat title="⚙️ Mode" value={formatModeLabel(mode)} />

        {targetBytes !== undefined && (
          <Stat title="🎯 Target Size" value={formatFileSize(targetBytes)} />
        )}
      </div>

      {targetMissed && (
        <p className="mt-4 text-sm font-medium text-amber-600">
          The target size couldn&apos;t be reached for this file — this is the
          smallest DocFlow could produce.
        </p>
      )}

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
  tone?: "positive" | "neutral" | "warning";
}

function Stat({ title, value, tone }: StatProps) {
  const valueClass =
    tone === "positive"
      ? "text-green-700"
      : tone === "warning"
        ? "text-amber-600"
        : "text-gray-900";

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
      <p className="text-sm text-gray-500">{title}</p>

      <p className={`mt-1 break-all text-lg font-semibold ${valueClass}`}>
        {value}
      </p>
    </div>
  );
}