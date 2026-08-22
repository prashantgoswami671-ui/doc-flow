import AppShell from "../components/AppShell";
import HomeHero from "../components/home/HomeHero";
import ToolCategoryGrid from "../components/home/ToolCategoryGrid";
import OrganizePagesCard from "../components/OrganizePagesCard";
import ExtractPagesCard from "../components/ExtractPagesCard";
import SplitPdfCard from "../components/SplitPdfCard";
import InsertPagesCard from "../components/InsertPagesCard";
import MergePdfCard from "../components/MergePdfCard";
import ImageToPdfCard from "../components/ImageToPdfCard";
import PdfToImageCard from "../components/PdfToImageCard";
import CompressPdfCard from "../components/CompressPdfCard";
import FixPageOrientationCard from "../components/FixPageOrientationCard";
import RepairValidatePdfCard from "../components/RepairValidatePdfCard";
import MetadataEditorCard from "../components/MetadataEditorCard";
import WatermarkPdfCard from "../components/WatermarkPdfCard";
import ProtectPdfCard from "../components/ProtectPdfCard";
import UnlockPdfCard from "../components/UnlockPdfCard";

export default function Home() {
  return (
    <AppShell>
      <HomeHero />
      <ToolCategoryGrid />

      <section id="organize" className="pb-20 pt-16">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Organize
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Delete, rotate, reorder, extract, split, and insert pages.
          </p>
        </div>
        <div className="mt-10 space-y-12">
          <OrganizePagesCard />
          <ExtractPagesCard />
          <SplitPdfCard />
          <InsertPagesCard />
        </div>
      </section>

      <section id="create" className="border-t border-gray-200 pb-20 pt-16">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Create
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Merge PDFs and turn images into PDFs.
          </p>
        </div>
        <div className="mt-10 space-y-12">
          <MergePdfCard />
          <ImageToPdfCard />
        </div>
      </section>

      <section id="convert" className="border-t border-gray-200 pb-20 pt-16">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Convert
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Convert PDF pages into images.
          </p>
        </div>
        <div className="mt-10">
          <PdfToImageCard />
        </div>
      </section>

      <section id="enhance" className="border-t border-gray-200 pb-20 pt-16">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Enhance
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Compress, repair, validate, fix orientation, and add finishing
            touches.
          </p>
        </div>
        <div className="mt-10 space-y-12">
          <CompressPdfCard />
          <FixPageOrientationCard />
          <RepairValidatePdfCard />
          <MetadataEditorCard />
          <WatermarkPdfCard />
        </div>
      </section>

      <section id="protect" className="border-t border-gray-200 pb-20 pt-16">
        <div className="mx-auto max-w-2xl px-4 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">
            Protect
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Password-protect and unlock PDFs.
          </p>
        </div>
        <div className="mt-10 space-y-12">
          <ProtectPdfCard />
          <UnlockPdfCard />
        </div>
      </section>
    </AppShell>
  );
}
