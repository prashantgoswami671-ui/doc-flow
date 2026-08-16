import AppShell from "../components/AppShell";
import Hero from "../components/Hero";
import ExtractPagesCard from "../components/ExtractPagesCard";
import OrganizePagesCard from "../components/OrganizePagesCard";
import FixPageOrientationCard from "../components/FixPageOrientationCard";
import MergePdfCard from "../components/MergePdfCard";
import ImageToPdfCard from "../components/ImageToPdfCard";
import PdfToImageCard from "../components/PdfToImageCard";
import SplitPdfCard from "../components/SplitPdfCard";
import InsertPagesCard from "../components/InsertPagesCard";
import MetadataEditorCard from "../components/MetadataEditorCard";
import WatermarkPdfCard from "../components/WatermarkPdfCard";
import ProtectPdfCard from "../components/ProtectPdfCard";
import UnlockPdfCard from "../components/UnlockPdfCard";
import RepairValidatePdfCard from "../components/RepairValidatePdfCard";
import UploadCard from "../components/UploadCard";

export default function Home() {
  return (
    <AppShell>
      <Hero />
      <section id="enhance" className="pb-20 -mt-8">
        <UploadCard />
      </section>
      <section className="pb-20">
        <ExtractPagesCard />
      </section>
      <section id="organize" className="pb-20">
        <OrganizePagesCard />
      </section>
      <section id="create" className="pb-20">
        <MergePdfCard />
      </section>
      <section className="pb-20">
        <ImageToPdfCard />
      </section>
      <section id="convert" className="pb-20">
        <PdfToImageCard />
      </section>
      <section className="pb-20">
        <SplitPdfCard />
      </section>
      <section className="pb-20">
        <InsertPagesCard />
      </section>
      <section className="pb-20">
        <MetadataEditorCard />
      </section>
      <section className="pb-20">
        <FixPageOrientationCard />
      </section>
      <section className="pb-20">
        <WatermarkPdfCard />
      </section>
      <section id="protect" className="pb-20">
        <ProtectPdfCard />
      </section>
      <section className="pb-20">
        <UnlockPdfCard />
      </section>
      <section className="pb-20">
        <RepairValidatePdfCard />
      </section>
    </AppShell>
  );
}
